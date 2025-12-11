import { encode } from "./msgpack.js";

const statusEl = document.getElementById("status");
const gridEl = document.getElementById("grid");
const stderrEl = document.getElementById("stderr");
const copyStderrBtn = document.getElementById("copy-stderr");
const startBtn = document.getElementById("start");
const resetBtn = document.getElementById("reset");
const quitBtn = document.getElementById("quit");
const dumpBtn = document.getElementById("dump");
const stopBtn = document.getElementById("stop");
const modeEl = document.getElementById("mode");
const docTextEl = document.getElementById("doc-text");
const docPathEl = document.getElementById("doc-path");
const loadDocBtn = document.getElementById("load-doc");
const saveDocBtn = document.getElementById("save-doc");
const clearDocBtn = document.getElementById("clear-doc");
// Bump this to bust browser caches when worker/main are updated.
const WORKER_VERSION = "v30-redraw-grid";

let worker = null;
let ring = null;
let reqId = 0;
let running = false;
const cols = 96;
const rows = 32;
let primeTimer = null;
let primeInterval = null;
let primeSent = false;
let drawSeen = false;
let handshakeSeen = false;
let resendBudget = 12;
// デバッグ用に worker を覗けるように保持
window.__nvimWorker = null;

class SharedInputWriter {
  constructor(capacity = 262144) {
    this.capacity = capacity;
    this.buffer = new SharedArrayBuffer(8 + capacity);
    this.ctrl = new Int32Array(this.buffer, 0, 2);
    this.data = new Uint8Array(this.buffer, 8);
    Atomics.store(this.ctrl, 0, 0);
    Atomics.store(this.ctrl, 1, 0);
  }

  push(bytes) {
    const src = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let head = Atomics.load(this.ctrl, 0);
    let tail = Atomics.load(this.ctrl, 1);
    for (let i = 0; i < src.length; i += 1) {
      const next = (tail + 1) % this.capacity;
      if (next === head) break; // drop if full
      this.data[tail] = src[i];
      tail = next;
    }
    Atomics.store(this.ctrl, 1, tail);
    Atomics.notify(this.ctrl, 1);
  }
}

startBtn.addEventListener("click", () => startSession());
resetBtn.addEventListener("click", () => {
  stopSession();
  startSession();
  // 直前の描画スナップショットを復元
  if (renderGrid.lastSnapshot) {
    gridEl.textContent = renderGrid.lastSnapshot;
  }
});
quitBtn.addEventListener("click", () => sendRpc("nvim_command", ["qa!"]));
dumpBtn?.addEventListener("click", () => dumpNvimLog());
stopBtn?.addEventListener("click", () => stopNvim());
loadDocBtn?.addEventListener("click", () => loadScratchToNvim());
saveDocBtn?.addEventListener("click", () => saveScratchFromNvim());
clearDocBtn?.addEventListener("click", () => {
  if (docTextEl) docTextEl.value = "";
});
// デバッグ用: ブラウザコンソールから window.dumpNvimLog(), window.stopNvim() を叩けるようにする。
window.dumpNvimLog = () => {
  if (worker) {
    appendLog(stderrEl, "[local] dump request sent (stream always on)");
    // RPC 経由で Neovim に自分でログを読ませて通知させる（1回のみ）
    requestLogDump();
    // 補助: worker 側が応答する場合のみ readfile を試す（イベントループに依存）
    worker.postMessage({ type: "readfile", path: "tmp/nvim.log" });
    worker.postMessage({ type: "readfile", path: "nvim/tmp/nvim.log" });
  } else {
    appendLog(stderrEl, "[local] no worker");
  }
};
// RPC を直接叩くためのデバッグ用フック
window.sendRpc = (method, params = []) => sendRpc(method, params);
window.stopNvim = () => {
  if (worker) {
    appendLog(stderrEl, "[local] stop request sent");
    worker.postMessage({ type: "stop" });
  } else {
    appendLog(stderrEl, "[local] no worker");
  }
};

copyStderrBtn?.addEventListener("click", async () => {
  const text = stderrEl.textContent || "";
  if (!text) return;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const area = document.createElement("textarea");
      area.value = text;
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      document.body.removeChild(area);
    }
    setStatus("stderr copied to clipboard");
  } catch (err) {
    appendLog(stderrEl, `[local] copy failed: ${err}`);
    setStatus("copy failed", true);
  }
});

gridEl.addEventListener("click", () => gridEl.focus());
gridEl.addEventListener("keydown", (ev) => {
  const keys = translateKey(ev);
  if (!keys) return;
  ev.preventDefault();
  sendInput(keys);
});

function startSession() {
  if (!window.crossOriginIsolated) {
    setStatus("SharedArrayBuffer not available. Serve with COOP/COEP (run python examples/browser/serve.py).", true);
    return;
  }

  stopSession();
  ring = new SharedInputWriter();
  reqId = 0;
  primeSent = false;
  drawSeen = false;
  handshakeSeen = false;
  resendBudget = 12;
  worker = new Worker(`./nvim-worker.js?${WORKER_VERSION}`, { type: "module" });
  window.__nvimWorker = worker;
  globalThis.__nvimWorker = worker;
  worker.onmessage = handleWorkerMessage;
  worker.postMessage({ type: "start", inputBuffer: ring.buffer, cols, rows });
  running = true;
  setStatus("Starting nvim…");
}

function stopSession() {
  clearTimeout(primeTimer);
  if (primeInterval) {
    clearInterval(primeInterval);
    primeInterval = null;
  }
  if (worker) {
    worker.terminate();
    worker = null;
  }
  running = false;
}

function primeRpc() {
  // 最小限の attach のみ送る (ext_linegrid オフで切り分け)
  sendRpc("nvim_ui_attach", [
    cols,
    rows,
    // ext_linegrid を有効化して linegrid 経路に統一
    { rgb: true, ext_linegrid: true, ext_hlstate: false, ext_cmdline: false, ext_messages: false, ext_popupmenu: false },
  ]);
  sendRpc("nvim_ui_try_resize", [cols, rows]);
  sendRpc("nvim_command", ["redraw!"]);
  sendRpc("nvim_command", ["call setline(1,'wasm ready (ui attach)') | redraw!"]);
  // NVIM_LOG_FILE への書き込みを強制して内容を確認できるようにする
  sendRpc("nvim_command", ["lua pcall(vim.fn.writefile, {'ui-attach log'}, vim.env.NVIM_LOG_FILE, 'a')"]);
  // 不要な grid_clear を避けるため nvim_list_uis は送らない
  sendRpc("nvim_command", ["redraw!"]);
}

function sendRpc(method, params = []) {
  if (!ring) return;
  const msg = encode([0, reqId++, method, params]);
  ring.push(msg);
  appendLog(stderrEl, `[rpc-send] id=${reqId - 1} ${method}`);
}

function sendInput(keys) {
  sendRpc("nvim_input", [keys]);
}

function loadScratchToNvim() {
  if (!ring) {
    appendLog(stderrEl, "[local] worker not running");
    return;
  }
  const text = (docTextEl?.value || "").replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  const path = (docPathEl?.value || "/nvim/tmp/wasm-scratch.txt").trim();
  const escapedPath = path.replace(/'/g, "''");
  const lua = `
    local lines = ...
    vim.cmd('enew')
    local buf = vim.api.nvim_get_current_buf()
    vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
    vim.bo[buf].buftype = ''
    vim.bo[buf].swapfile = false
    vim.bo[buf].bufhidden = 'hide'
    vim.bo[buf].modifiable = true
    vim.bo[buf].modified = true
    vim.api.nvim_buf_set_name(buf, '${escapedPath}')
  `;
  sendRpc("nvim_exec_lua", [lua, lines]);
  appendLog(stderrEl, `[local] scratch loaded into Neovim (${lines.length} lines) -> ${path}`);
}

function saveScratchFromNvim() {
  if (!ring) {
    appendLog(stderrEl, "[local] worker not running");
    return;
  }
  const path = (docPathEl?.value || "/nvim/tmp/wasm-scratch.txt").trim();
  const lua = `
    local path = ...
    local ok, err = pcall(vim.fn.writefile, vim.api.nvim_buf_get_lines(0, 0, -1, false), path)
    if ok then
      vim.api.nvim_echo({{'wrote '..path, 'MoreMsg'}}, false, {})
    else
      vim.api.nvim_err_writeln('write failed: '..tostring(err))
    end
  `;
  sendRpc("nvim_exec_lua", [lua, [path]]);
  appendLog(stderrEl, `[local] save request sent -> ${path}`);
}

let dumpSeq = 0;

function requestLogDump() {
  // Neovim 自身に NVIM_LOG_FILE を読ませて rpcnotify させる（1回のみ、シーケンス付き）
  const seq = ++dumpSeq;
  const lua = `
    local payload = { seq = tonumber(...) or 0 }
    local f = vim.env.NVIM_LOG_FILE or "/nvim/tmp/nvim.log"
    payload.path = f
    local ok, lines = pcall(vim.fn.readfile, f)
    if ok then
      payload.text = table.concat(lines, '\\n')
      vim.rpcnotify(0, 'log-dump', {payload})
      vim.api.nvim_err_writeln(string.format("log-dump seq=%s size=%d (rpcnotify sent)", payload.seq, #payload.text))
    else
      payload.err = tostring(lines)
      vim.rpcnotify(0, 'log-dump-error', {payload})
      vim.api.nvim_err_writeln(string.format("log-dump seq=%s readfile failed: %s", payload.seq, payload.err))
    end
  `;
  sendRpc("nvim_exec_lua", [lua, [String(seq)]]);
}

function handleWorkerMessage(event) {
  const { type } = event.data || {};
  if (type === "status") {
    setStatus(event.data.message, event.data.error);
    // RPC 受け付け準備メッセージを受けた後にまとめて初期 RPC を送る
  if (!primeSent && typeof event.data.message === "string"
      && event.data.message.includes("waiting for RPC")) {
    primeSent = true;
    clearTimeout(primeTimer);
    primeRpc();
  }
  } else if (type === "stderr") {
    appendLog(stderrEl, event.data.text);
  } else if (type === "log") {
    appendLog(stderrEl, `== ${event.data.path} ==\n${event.data.text}\n== end log ==`);
  } else if (type === "fsdump") {
    appendLog(stderrEl, `== fsdump ==\n${JSON.stringify(event.data.tree, null, 2)}\n== end fsdump ==`);
  } else if (type === "console") {
    appendLog(stderrEl, `[${event.data.level}] ${event.data.args.join(" ")}`);
    if (!handshakeSeen && event.data.args.some((s) => typeof s === "string" && s.includes("init-ping"))) {
      handshakeSeen = true;
    }
  } else if (type === "draw") {
    drawSeen = true;
    const lines = Array.isArray(event.data.lines) ? event.data.lines : [];
    const mode = event.data.mode || "-";
    renderGrid(lines, event.data.cursor, mode);
  } else if (type === "notify") {
    const method = event.data.method;
    const params = event.data.params;
    appendLog(stderrEl, `[notify] ${method} ${JSON.stringify(params)}`);
    if (method === "init-ping" || method === "init-ping-late") {
      handshakeSeen = true;
    } else if (method === "log-dump") {
      // params: {seq=<number>, path=<string>, text=<string>}
      const payload = Array.isArray(params) && params.length ? params[0] : {};
      const seq = payload.seq ?? "?";
      const path = payload.path || "(unknown)";
      const text = payload.text || "";
      appendLog(stderrEl, `== ${path} (rpc seq=${seq}) ==\n${text}\n== end ==`);
    } else if (method === "log-dump-error") {
      const payload = Array.isArray(params) && params.length ? params[0] : {};
      const seq = payload.seq ?? "?";
      const path = payload.path || "(unknown)";
      const err = payload.err || "(error)";
      appendLog(stderrEl, `[log-dump-error seq=${seq}] ${path}: ${err}`);
    }
  } else if (type === "draw-text") {
    const lines = Array.isArray(event.data.lines) ? event.data.lines : [];
    const text = (lines && lines.length ? lines : [""]).join("\n");
    gridEl.textContent = text;
    renderGrid.lastSnapshot = text;
  } else if (type === "log") {
    const path = event.data.path || "(unknown)";
    const text = event.data.text || "";
    appendLog(stderrEl, `== ${path} ==\n${text}\n== end ==`);
  } else if (type === "exit") {
    setStatus(`nvim exited with code ${event.data.code}`);
    running = false;
  }
}

function renderGrid(lines = [], cursor) {
  gridEl.textContent = (lines && lines.length ? lines : [""]).join("\n");
}

function appendLog(el, text) {
  el.textContent += `${text}\n`;
  el.scrollTop = el.scrollHeight;
}

function setStatus(text, error = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", !!error);
}

function escapeHtml(str) {
  return (str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function translateKey(ev) {
  const key = ev.key;
  const isCtrl = ev.ctrlKey || ev.metaKey;
  const isAlt = ev.altKey;

  switch (key) {
    case "Backspace":
      return "<BS>";
    case "Enter":
      return "<CR>";
    case "Escape":
      return "<Esc>";
    case "Tab":
      return "<Tab>";
    case "ArrowUp":
      return "<Up>";
    case "ArrowDown":
      return "<Down>";
    case "ArrowLeft":
      return "<Left>";
    case "ArrowRight":
      return "<Right>";
    case "Delete":
      return "<Del>";
    case "Home":
      return "<Home>";
    case "End":
      return "<End>";
    case "PageUp":
      return "<PageUp>";
    case "PageDown":
      return "<PageDown>";
    case "Insert":
      return "<Insert>";
    default:
      break;
  }

  if (key.length === 1) {
    const char = ev.shiftKey ? key : key.toLowerCase();
    if (!isCtrl && !isAlt) return char;
    let mod = "";
    if (isCtrl) mod += "C-";
    if (isAlt) mod += "A-";
    return `<${mod}${char}>`;
  }
  return null;
}

if (!window.crossOriginIsolated) {
  setStatus("SharedArrayBuffer unavailable. Serve with COOP/COEP headers (python examples/browser/serve.py).", true);
}
