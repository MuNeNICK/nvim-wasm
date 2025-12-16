import { encode } from "./msgpack.js";
import { init as initGhostty, Terminal, FitAddon } from "https://cdn.jsdelivr.net/npm/ghostty-web@0.4.0/+esm";

const statusEl = document.getElementById("status");
const modeEl = document.getElementById("mode");
const sizeEl = document.getElementById("size");
const terminalHost = document.getElementById("terminal");

const WORKER_VERSION = "v1";

let term = null;
let fit = null;
let worker = null;
let ring = null;
let reqId = 0;
let primeSent = false;
let lastClipboard = "";
let queuedWrite = "";
let ready = false;

let ghosttyReady = null;
let writeScheduled = false;
let terminalDesignHeightPx = 0;
let lastCursorStyle = null;

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
      if (next === head) break;
      this.data[tail] = src[i];
      tail = next;
    }
    Atomics.store(this.ctrl, 1, tail);
    Atomics.notify(this.ctrl, 1);
  }
}

async function initTerminal() {
  if (!ghosttyReady) ghosttyReady = initGhostty();
  await ghosttyReady;
  term = new Terminal({
    fontSize: 14,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    scrollback: 0,
    convertEol: false,
    cursorBlink: true,
  });
  fit = new FitAddon();
  term.loadAddon(fit);
  term.open(terminalHost);
  terminalDesignHeightPx = Math.max(1, Math.floor(terminalHost.getBoundingClientRect().height || 520));
  fitAndSnap();

  term.onData(handleTermData);
  term.onResize(({ cols, rows }) => {
    updateSizeLabel(cols, rows);
    sendRpc("nvim_ui_try_resize", [cols, rows]);
  });

  terminalHost.addEventListener("click", () => {
    term.focus();
    warmupClipboard();
  });
}

function updateSizeLabel(cols = term?.cols, rows = term?.rows) {
  if (!cols || !rows) {
    sizeEl.textContent = "size: -";
    return;
  }
  sizeEl.textContent = `size: ${cols}x${rows}`;
}

function setStatus(text, warn = false) {
  statusEl.textContent = text;
  statusEl.style.color = warn ? "#ff9ea2" : "#e8edf5";
}

async function startSession() {
  if (!window.crossOriginIsolated) {
    setStatus("Serve with COOP/COEP so SharedArrayBuffer works", true);
    return;
  }

  warmupClipboard();
  stopSession();
  try {
    if (!term) await initTerminal();
  } catch (err) {
    setStatus(`ghostty-web init failed: ${err?.message || err}`, true);
    return;
  }
  fitAndSnap();

  ring = new SharedInputWriter();
  reqId = 0;
  primeSent = false;
  ready = false;

  worker = new Worker(`./nvim-worker.js?${WORKER_VERSION}`, { type: "module" });
  worker.onmessage = handleWorkerMessage;
  worker.postMessage({ type: "start", inputBuffer: ring.buffer, cols: term.cols, rows: term.rows });
  setStatus("Starting Neovim...");
  setTimeout(() => { if (!primeSent) primeRpc(); }, 500);
}

function stopSession() {
  if (worker) {
    worker.terminate();
    worker = null;
  }
  ring = null;
  primeSent = false;
}

function sendRpc(method, params = []) {
  if (!ring) return;
  ring.push(encode([0, reqId++, method, params]));
}

function sendRpcResponse(msgid, error, result) {
  if (!ring) return;
  ring.push(encode([1, msgid, error, result]));
}

function sendInput(keys) { sendRpc("nvim_input", [keys]); }

function primeRpc() {
  if (!term) return;
  sendRpc("nvim_ui_attach", [term.cols, term.rows, { rgb: true, ext_linegrid: true, ext_hlstate: true }]);
  sendRpc("nvim_ui_try_resize", [term.cols, term.rows]);
  sendRpc("nvim_command", ["set noswapfile"]);
  sendRpc("nvim_command", ["set number"]);
  sendRpc("nvim_command", ["set fillchars=eob:~"]);
  sendRpc("nvim_command", ["set mouse=a"]);

  const clipboardLua = `
    local function setup_clipboard()
      local ui_chan = (vim.api.nvim_get_api_info() or {})[1]
      if not ui_chan then return end
      local function copy(lines, regtype)
        vim.rpcnotify(ui_chan, 'wasm-clipboard-copy', lines, regtype)
      end
      local function paste()
        local ok, res = pcall(vim.rpcrequest, ui_chan, 'wasm-clipboard-paste')
        if not ok then return {}, 'v' end
        local lines = res and res[1] or {}
        local regtype = res and res[2] or 'v'
        return lines, regtype
      end
      vim.g.clipboard = {
        name = 'wasm',
        copy = { ['+'] = copy, ['*'] = copy },
        paste = { ['+'] = paste, ['*'] = paste },
      }
      vim.cmd('set clipboard=unnamedplus')
    end
    setup_clipboard()
  `;
  sendRpc("nvim_exec_lua", [clipboardLua, []]);

  const seedLua = `
    local lines = {...}
    vim.cmd('enew')
    local buf = vim.api.nvim_get_current_buf()
    vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
    vim.bo[buf].buftype = ''
    vim.bo[buf].modifiable = true
    vim.bo[buf].modified = true
    vim.api.nvim_buf_set_name(buf, 'demo-xterm.txt')
    vim.cmd('redraw!')
  `;
  sendRpc("nvim_exec_lua", [seedLua, [
    "Neovim WASM + xterm.js demo (ghostty backend)",
    "",
    "- click the terminal and type",
    "- press i for insert mode",
    "- :q to quit",
    "",
    "This demo renders Neovim's UI grid into an xterm.js-compatible terminal (ghostty-web).",
  ]]);
  sendRpc("nvim_command", ["redraw!"]);
  primeSent = true;
}

function handleWorkerMessage(event) {
  const { type } = event.data || {};
  if (type === "draw-text") {
    const cells = event.data.cells && event.data.cells.length ? event.data.cells : linesToCells(event.data.lines);
    renderFrame(cells, event.data.cursor, event.data.mode, event.data.hls);
    if (!ready) {
      ready = true;
      setStatus("Ready");
    }
  } else if (type === "exit") {
    setStatus(`nvim exited (${event.data.code})`, event.data.code !== 0);
  } else if (type === "clipboard-copy") {
    const text = (event.data.lines || []).join("\n");
    if (!navigator.clipboard?.writeText) return;
    lastClipboard = text;
    navigator.clipboard.writeText(text).catch(() => { lastClipboard = text; });
  } else if (type === "clipboard-paste") {
    doClipboardPaste(event.data.requestId);
  }
}

function renderFrame(cells = [], cursor = null, mode = "-", hls = {}) {
  if (!term) return;
  const rows = Array.isArray(cells) ? cells : [];
  const height = rows.length || term.rows || 0;
  const width = (rows[0] && rows[0].length) || term.cols || 0;
  if (!height || !width) return;

  const cur = cursor || { row: 0, col: 0 };
  const cursorRow = clamp(cur.row || 0, 0, height - 1);
  const cursorCol = clamp(cur.col || 0, 0, width - 1);
  const frame = frameToAnsi(rows, hls, width, height);

  applyCursorStyleForMode(mode);
  enqueueWrite(frame + `\u001b[0m\u001b[${cursorRow + 1};${cursorCol + 1}H\u001b[?25h`);
  modeEl.textContent = `mode: ${mode || "-"}`;
}

function applyCursorStyleForMode(mode) {
  if (!term) return;
  const m = typeof mode === "string" ? mode : "";
  const head = m ? m[0] : "n";
  let style = "block";
  if (head === "i") style = "bar";
  else if (head === "R" || head === "c") style = "underline";
  if (style === lastCursorStyle) return;
  lastCursorStyle = style;
  term.options.cursorStyle = style;
}

function enqueueWrite(data) {
  if (!term) return;
  queuedWrite = data;
  if (writeScheduled) return;
  writeScheduled = true;
  requestAnimationFrame(() => {
    writeScheduled = false;
    const next = queuedWrite;
    queuedWrite = "";
    if (!term || !next) return;
    term.write(next);
  });
}

function fitAndSnap() {
  if (!term || !fit) return;
  if (terminalDesignHeightPx > 0) terminalHost.style.height = `${terminalDesignHeightPx}px`;
  fit.fit();
  snapTerminalHeightToRows();
  updateSizeLabel();
}

function snapTerminalHeightToRows() {
  if (!term) return;
  const metrics = term.renderer?.getMetrics?.();
  if (!metrics?.height) return;
  const h = Math.max(1, Math.floor((term.rows || 1) * metrics.height));
  if (terminalDesignHeightPx > 0) {
    terminalHost.style.height = `${Math.min(terminalDesignHeightPx, h)}px`;
  } else {
    terminalHost.style.height = `${h}px`;
  }
}

function frameToAnsi(rows, hls, width, height) {
  const out = [];
  out.push("\u001b[?25l");
  out.push("\u001b[H");

  let currentStyle = "";
  for (let r = 0; r < height; r += 1) {
    const rowCells = Array.isArray(rows[r]) ? rows[r] : [];
    out.push(`\u001b[${r + 1};1H`);
    currentStyle = "";
    for (let c = 0; c < width; c += 1) {
      const cell = rowCells[c] || { ch: " ", hl: 0 };
      const ch = sanitizeCellChar(cell.ch);
      const hl = getHl(hls, cell.hl);
      const style = sgrFromHl(hl);
      if (style !== currentStyle) {
        if (style) out.push(style);
        else out.push("\u001b[0m");
        currentStyle = style;
      }
      out.push(ch);
    }
    out.push("\u001b[0m\u001b[K");
  }
  return out.join("");
}

function sgrFromHl(hl) {
  if (!hl) return "";
  const fgRgb = hexToRgb(hl.foreground);
  const bgRgb = hexToRgb(hl.background);
  const parts = ["\u001b[0m"];
  if (hl.reverse) {
    if (!fgRgb && !bgRgb) {
      parts.push("\u001b[7m");
      return parts.join("");
    }
    if (bgRgb) parts.push(`\u001b[38;2;${bgRgb[0]};${bgRgb[1]};${bgRgb[2]}m`);
    if (fgRgb) parts.push(`\u001b[48;2;${fgRgb[0]};${fgRgb[1]};${fgRgb[2]}m`);
    return parts.join("");
  }
  if (fgRgb) parts.push(`\u001b[38;2;${fgRgb[0]};${fgRgb[1]};${fgRgb[2]}m`);
  if (bgRgb) parts.push(`\u001b[48;2;${bgRgb[0]};${bgRgb[1]};${bgRgb[2]}m`);
  return parts.join("");
}

function getHl(map, id) {
  const key = id != null && map[id] !== undefined ? id : String(id);
  return (key != null && map[key] !== undefined ? map[key] : null) || map[0] || map["0"] || null;
}

function hexToRgb(hex) {
  if (typeof hex !== "string") return null;
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function sanitizeCellChar(ch) {
  if (typeof ch !== "string" || ch.length === 0) return " ";
  if (ch === "\u001b") return " ";
  const code = ch.codePointAt(0);
  if (code < 0x20) return " ";
  return ch;
}

function clamp(value, min, max) { return Math.min(Math.max(value, min), max); }

function linesToCells(lines = []) {
  const data = lines && lines.length ? lines : [""];
  return data.map((line) => Array.from(line || "").map((ch) => ({ ch, hl: 0 })));
}

function warmupClipboard() {
  if (!navigator.clipboard?.readText) return;
  navigator.clipboard.readText().then((txt) => { if (txt) lastClipboard = txt; }).catch(() => {});
}

function doClipboardPaste(req) {
  const fallback = () => {
    if (lastClipboard !== "") {
      sendRpcResponse(req, null, [lastClipboard.split(/\r?\n/), "v"]);
      return;
    }
    const manual = window.prompt("Paste text");
    if (manual !== null) {
      lastClipboard = manual;
      sendRpcResponse(req, null, [manual.split(/\r?\n/), "v"]);
      return;
    }
    sendRpcResponse(req, null, [[""], "v"]);
  };

  if (!navigator.clipboard?.readText) {
    fallback();
    return;
  }
  navigator.clipboard.readText()
    .then((text) => {
      const effective = text || lastClipboard;
      if (!effective) { fallback(); return; }
      lastClipboard = effective;
      sendRpcResponse(req, null, [effective.split(/\r?\n/), "v"]);
    })
    .catch(() => fallback());
}

function handleTermData(data) {
  if (!data) return;
  const segments = terminalDataToNvimKeys(data);
  for (const seg of segments) sendInput(seg);
}

function terminalDataToNvimKeys(data) {
  const out = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push(buf);
    buf = "";
  };

  for (let i = 0; i < data.length; i += 1) {
    const code = data.charCodeAt(i);
    if (code === 0x1b) { // ESC
      flush();
      if (data.startsWith("\u001b[A", i)) { out.push("<Up>"); i += 2; continue; }
      if (data.startsWith("\u001b[B", i)) { out.push("<Down>"); i += 2; continue; }
      if (data.startsWith("\u001b[C", i)) { out.push("<Right>"); i += 2; continue; }
      if (data.startsWith("\u001b[D", i)) { out.push("<Left>"); i += 2; continue; }
      if (data.startsWith("\u001b[H", i)) { out.push("<Home>"); i += 2; continue; }
      if (data.startsWith("\u001b[F", i)) { out.push("<End>"); i += 2; continue; }
      if (data.startsWith("\u001b[2~", i)) { out.push("<Insert>"); i += 3; continue; }
      if (data.startsWith("\u001b[3~", i)) { out.push("<Del>"); i += 3; continue; }
      if (data.startsWith("\u001b[5~", i)) { out.push("<PageUp>"); i += 3; continue; }
      if (data.startsWith("\u001b[6~", i)) { out.push("<PageDown>"); i += 3; continue; }
      if (data.startsWith("\u001b[Z", i)) { out.push("<S-Tab>"); i += 2; continue; }
      if (data.startsWith("\u001bOP", i)) { out.push("<F1>"); i += 2; continue; }
      if (data.startsWith("\u001bOQ", i)) { out.push("<F2>"); i += 2; continue; }
      if (data.startsWith("\u001bOR", i)) { out.push("<F3>"); i += 2; continue; }
      if (data.startsWith("\u001bOS", i)) { out.push("<F4>"); i += 2; continue; }
      // Alt+key often arrives as ESC + <char>.
      const next = data[i + 1];
      if (next && next.length === 1 && next !== "[" && next !== "O") {
        out.push(`<A-${next.toLowerCase()}>`);
        i += 1;
        continue;
      }
      out.push("<Esc>");
      continue;
    }
    if (code === 0x7f) { flush(); out.push("<BS>"); continue; }
    if (code === 0x0d || code === 0x0a) { flush(); out.push("<CR>"); continue; }
    if (code === 0x09) { flush(); out.push("<Tab>"); continue; }
    if (code >= 0x01 && code <= 0x1a) {
      flush();
      const letter = String.fromCharCode(code + 0x40).toLowerCase();
      out.push(`<C-${letter}>`);
      continue;
    }
    buf += data[i];
  }

  flush();
  return out;
}

function handleResize() {
  if (!term) return;
  fitAndSnap();
}

window.addEventListener("resize", () => handleResize());

startSession().catch((err) => setStatus(`start failed: ${err?.message || err}`, true));
