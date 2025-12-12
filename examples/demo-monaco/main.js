import { encode } from "./msgpack.js";

const statusEl = document.getElementById("status");
const modeEl = document.getElementById("mode");
const cursorEl = document.getElementById("cursor");
const bufferEl = document.getElementById("buffer");
const logEl = document.getElementById("log");
const editorHost = document.getElementById("editor");

const WORKER_VERSION = "v1";
const cols = 140;
const rows = 60;

let monaco = null;
let editor = null;
let worker = null;
let ring = null;
let reqId = 1;
let bufHandle = null; // numeric buffer id
let suppressRemote = false;
let pending = new Map();
let primeSent = false;
let lastCursorStyle = null;
let lastCursorBlink = null;
let lastCursorWidth = null;
let initialCursorWidth = 0;
let typicalFullWidth = 2;
let cursorRefreshInFlight = false;
let cursorRefreshPending = false;
let cursorRefreshTimer = null;

const monacoReady = loadMonaco();

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

function init() {
  setStatus("waiting", true);
  if (!window.crossOriginIsolated) {
    log("Serve with COOP/COEP headers so SharedArrayBuffer works.");
  }
  startSession().catch((err) => log(`start failed: ${err?.message || err}`));
}

async function startSession() {
  if (!window.crossOriginIsolated) {
    setStatus("COOP/COEP required", true);
    return;
  }
  stopSession(true);
  await monacoReady;
  if (!editor) createEditor();

  ring = new SharedInputWriter();
  worker = new Worker(`./nvim-worker.js?${WORKER_VERSION}`, { type: "module" });
  worker.onmessage = handleWorkerMessage;
  worker.postMessage({ type: "start", inputBuffer: ring.buffer, cols, rows });
  setStatus("starting...");
  primeSent = false;
  setTimeout(() => { if (!primeSent) primeSession(); }, 400);
}

function stopSession(silent = false) {
  if (worker) {
    worker.terminate();
    worker = null;
  }
  ring = null;
  pending.clear();
  bufHandle = null;
  primeSent = false;
  if (!silent) setStatus("stopped", true);
}

async function primeSession() {
  if (!ring) return;
  primeSent = true;
  try {
    await waitForApi();
    sendRpc("nvim_command", ["set noswapfile signcolumn=no number norelativenumber"]);
    sendRpc("nvim_command", ["set nowrap laststatus=0 cmdheight=1"]);
    sendRpc("nvim_command", ["set shortmess+=F"]);
    sendRpc("nvim_command", ["set clipboard=unnamedplus"]);

    const buf = await rpcCall("nvim_get_current_buf", []);
    log(`buf handle raw: ${describeHandle(buf)}`);
    const id = extractBufId(buf) ?? 1;
    bufHandle = id; // set early so initial buf_events are not dropped
    bufferEl.textContent = `buf: ${id}`;
    const attached = await rpcCall("nvim_buf_attach", [id, true, {}]);
    if (attached !== true) throw new Error("nvim_buf_attach failed");
    const lines = await rpcCall("nvim_buf_get_lines", [id, 0, -1, false]);
    applyBuffer(lines || [""]);
    setStatus("ready");
    const seededOk = await seedBuffer(id);
    const seeded = await rpcCall("nvim_buf_get_lines", [id, 0, -1, false]);
    applyBuffer(seeded || lines || [""]);
    bufHandle = id;
    await refreshCursorMode();
    if (!seededOk) {
      applyBuffer(["-- Monaco + Neovim (WASM)", "-- Seed failed; using fallback text"]);
      updateCursor(1, 1);
    }
  } catch (err) {
    log(`prime failed: ${err?.message || err}`);
    setStatus("failed to attach", true);
  }
}

function createEditor() {
  editor = monaco.editor.create(editorHost, {
    value: "",
    language: "lua",
    theme: "vs-dark",
    fontSize: 14,
    fontFamily: "Berkeley Mono, JetBrains Mono, ui-monospace, SFMono-Regular",
    readOnly: true,
    minimap: { enabled: false },
    lineNumbers: "on",
    automaticLayout: true,
    scrollBeyondLastLine: false,
    smoothScrolling: true,
    contextmenu: false,
    padding: { top: 12, bottom: 12 },
    cursorSmoothCaretAnimation: true,
    renderWhitespace: "none",
  });
  try {
    const EditorOption = monaco.editor.EditorOption;
    const fontInfo = editor.getOption(EditorOption.fontInfo);
    initialCursorWidth = editor.getOption(EditorOption.cursorWidth) || 0;
    typicalFullWidth = fontInfo?.typicalFullwidthCharacterWidth || 2;
  } catch (_) {
    initialCursorWidth = 0;
    typicalFullWidth = 2;
  }

  editor.onKeyDown(handleMonacoKey);

  editor.onMouseDown((ev) => {
    if (!bufHandle || !ev.target?.position) return;
    const { lineNumber, column } = ev.target.position;
    sendRpc("nvim_win_set_cursor", [0, [lineNumber, column]]);
  });
}

function sendInput(keys) {
  sendRpc("nvim_input", [keys]);
  scheduleCursorRefresh();
}

function handleMonacoKey(ev) {
  const key = translateKey(ev.browserEvent);
  if (!key) return;
  ev.preventDefault();
  sendInput(key);
}

function sendRpc(method, params = []) {
  if (!ring) return;
  const msg = encode([0, reqId++, method, params]);
  ring.push(msg);
}

function sendRpcResponse(msgid, error, result) {
  if (!ring) return;
  const msg = encode([1, msgid, error, result]);
  ring.push(msg);
}

function rpcCall(method, params = []) {
  return new Promise((resolve, reject) => {
    if (!ring) { reject(new Error("session not started")); return; }
    const id = reqId++;
    pending.set(id, { resolve, reject, ts: Date.now() });
    ring.push(encode([0, id, method, params]));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`rpc timeout: ${method}`));
      }
    }, 8000);
  });
}

function handleWorkerMessage(event) {
  const { type } = event.data || {};
  if (type === "rpc-response") {
    const { msgid, error, result } = event.data;
    const entry = pending.get(msgid);
    if (!entry) return;
    pending.delete(msgid);
    if (error) entry.reject(new Error(String(error)));
    else entry.resolve(result);
  } else if (type === "rpc-notify") {
    void handleNotify(event.data.method, event.data.params || []);
  } else if (type === "rpc-request") {
    handleRequest(event.data.msgid, event.data.method, event.data.params || []);
  } else if (type === "clipboard-copy") {
    const text = (event.data.lines || []).join("\n");
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).catch(() => {});
  } else if (type === "clipboard-paste") {
    doClipboardPaste(event.data.msgid);
  } else if (type === "start-error") {
    setStatus(`start failed: ${event.data?.message || "unknown"}`, true);
  } else if (type === "exit") {
    setStatus(`nvim exited (${event.data.code})`, event.data.code !== 0);
  }
}

function handleRequest(msgid, method, params) {
  if (method === "wasm-clipboard-paste") {
    doClipboardPaste(msgid);
  } else {
    // Unknown request: respond with nil to keep nvim moving.
    sendRpcResponse(msgid, null, null);
  }
}

async function handleNotify(method, params) {
  if (method === "nvim_buf_lines_event") {
    const [buf] = params;
    const id = extractBufId(buf);
    if (bufHandle != null && id === bufHandle) {
      try {
        const allLines = await rpcCall("nvim_buf_get_lines", [id, 0, -1, false]);
        applyBuffer(allLines || [""]);
      } catch (_) {
        // ignore
      }
      void refreshCursorMode();
    }
  } else if (method === "nvim_buf_detach_event") {
    bufHandle = null;
    bufferEl.textContent = "buf: -";
  }
}

function applyBuffer(lines = [""]) {
  if (!editor) return;
  const current = editor.getModel().getValue();
  const joined = (lines && lines.length ? lines : [""]).join("\n");
  suppressRemote = true;
  editor.getModel().setValue(joined);
  suppressRemote = false;
}

function translateKey(ev) {
  const key = ev.key;
  const isCtrl = ev.ctrlKey || ev.metaKey;
  const isAlt = ev.altKey;
  switch (key) {
    case "Backspace": return "<BS>";
    case "Enter": return "<CR>";
    case "Escape": return "<Esc>";
    case "Tab": return "<Tab>";
    case "ArrowUp": return "<Up>";
    case "ArrowDown": return "<Down>";
    case "ArrowLeft": return "<Left>";
    case "ArrowRight": return "<Right>";
    case "Delete": return "<Del>";
    case "Home": return "<Home>";
    case "End": return "<End>";
    case "PageUp": return "<PageUp>";
    case "PageDown": return "<PageDown>";
    case "Insert": return "<Insert>";
    default: break;
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

function doClipboardPaste(msgid) {
  const fallback = (text) => {
    const lines = (text || "").split(/\r?\n/);
    sendRpcResponse(msgid, null, [lines, "v"]);
  };
  if (!navigator.clipboard?.readText) {
    const manual = window.prompt("Paste text");
    fallback(manual || "");
    return;
  }
  navigator.clipboard.readText()
    .then((text) => fallback(text || ""))
    .catch(() => fallback(""));
}

function updateCursor(line, col) {
  if (!editor) return;
  const pos = clampCursor(line, col - 1); // clamp expects 0-based col
  const ln = pos.line;
  const cl = pos.col;
  cursorEl.textContent = `cursor: ${ln}:${cl}`;
  const monacoPos = { lineNumber: ln, column: cl };
  const current = editor.getPosition();
  const same = current && current.lineNumber === ln && current.column === cl;
  if (!same) {
    editor.setPosition(monacoPos);
    editor.revealPositionInCenterIfOutsideViewport(monacoPos);
  }
}

function setStatus(text, warn = false) {
  statusEl.textContent = text;
  statusEl.className = warn ? "pill warn" : "pill ok";
}

function log(text) {
  const current = logEl.textContent.split("\n").filter(Boolean);
  current.push(`[${new Date().toLocaleTimeString()}] ${text}`);
  while (current.length > 12) current.shift();
  logEl.textContent = current.join("\n");
}

async function seedBuffer(bufHandle) {
  const buf = extractBufId(bufHandle);
  if (!buf || buf <= 0) return false;
  const seedLines = [
    "-- Monaco + Neovim (WASM)",
    "-- Click here, press i, and start typing.",
    "",
    "local function greet(name)",
    "  return 'hello ' .. name",
    "end",
    "",
    "print(greet('monaco'))",
  ];
  try {
    await rpcCall("nvim_buf_set_lines", [buf, 0, -1, false, seedLines]);
    await rpcCall("nvim_buf_set_option", [buf, "modifiable", true]);
    await rpcCall("nvim_buf_set_option", [buf, "modified", true]);
    await rpcCall("nvim_buf_set_option", [buf, "buftype", ""]);
    await rpcCall("nvim_buf_set_option", [buf, "filetype", "lua"]);
    await rpcCall("nvim_buf_set_name", [buf, "monaco-demo.lua"]);
    return true;
  } catch (_) {
    return false;
  }
}

function loadMonaco() {
  return new Promise((resolve, reject) => {
    if (!window.require) {
      reject(new Error("monaco loader missing"));
      return;
    }
    window.require.config({ paths: { vs: "https://cdn.jsdelivr.net/npm/monaco-editor@0.44.0/min/vs" } });
    window.require(["vs/editor/editor.main"], () => {
      monaco = window.monaco;
      resolve(monaco);
    }, reject);
  });
}

async function waitForApi(retries = 5, delay = 300) {
  for (let i = 0; i < retries; i += 1) {
    try {
      await rpcCall("nvim_get_api_info", []);
      return;
    } catch (_) {
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("nvim_get_api_info timed out");
}

function decodeHandleId(data) {
  if (!data || data.length === 0) return null;
  const t = data[0];
  if (data.length === 1) {
    return t <= 0x7f ? t : (t - 0x100);
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  switch (t) {
    case 0xcc: return view.getUint8(1);
    case 0xcd: return view.getUint16(1);
    case 0xce: return view.getUint32(1);
    case 0xcf: return Number(view.getBigUint64(1));
    case 0xd0: return view.getInt8(1);
    case 0xd1: return view.getInt16(1);
    case 0xd2: return view.getInt32(1);
    case 0xd3: return Number(view.getBigInt64(1));
    default: return t;
  }
}

function toUint8(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return new Uint8Array(data);
  if (Number.isInteger(data)) return new Uint8Array([data & 0xff]);
  if (data && data.type === "Buffer" && Array.isArray(data.data)) return new Uint8Array(data.data);
  return null;
}

function describeHandle(val) {
  if (val && typeof val === "object" && typeof val.type === "number") {
    const data = toUint8(val.data);
    return `ext(type=${val.type},len=${data ? data.length : 0})`;
  }
  return String(val);
}

function extractBufId(val) {
  if (val && typeof val === "object" && typeof val.type === "number") {
    const data = toUint8(val.data);
    if (data) {
      const id = decodeHandleId(data);
      if (id != null && id > 0) return id;
    }
  }
  const num = Number(val);
  if (Number.isInteger(num) && num > 0) return num;
  return null;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function scheduleCursorRefresh() {
  if (cursorRefreshTimer) return;
  cursorRefreshTimer = setTimeout(() => {
    cursorRefreshTimer = null;
    void refreshCursorMode();
  }, 30);
}

function clampCursor(ln, col0) {
  const model = editor?.getModel();
  if (!model) {
    return { line: Math.max(1, Number(ln) || 1), col: Math.max(1, Number(col0) || 1) };
  }
  const lineCount = model.getLineCount();
  const line = clamp(Math.max(1, Number(ln) || 1), 1, lineCount);
  const text = model.getLineContent(line) ?? "";
  const maxCol0 = Math.max(0, text.length);
  const col = clamp(Number(col0) || 0, 0, maxCol0) + 1; // convert to 1-based for Monaco
  return { line, col };
}

async function refreshCursorMode() {
  if (cursorRefreshInFlight) {
    cursorRefreshPending = true;
    return;
  }
  cursorRefreshInFlight = true;
  try {
    const [cursor, mode] = await Promise.all([
      rpcCall("nvim_win_get_cursor", [0]),
      rpcCall("nvim_get_mode", []),
    ]);
    if (Array.isArray(cursor) && cursor.length >= 2) {
      // nvim_win_get_cursor returns 1-based line, 0-based col (bytes)
      const ln = cursor[0];
      const col0 = cursor[1];
      const clamped = clampCursor(ln, col0);
      updateCursor(clamped.line, clamped.col);
    }
    if (mode && typeof mode.mode === "string") {
      modeEl.textContent = `mode: ${mode.mode}`;
      applyCursorStyle(mode.mode);
    }
  } catch (err) {
    // swallow errors during rapid input
  } finally {
    cursorRefreshInFlight = false;
    if (cursorRefreshPending) {
      cursorRefreshPending = false;
      void refreshCursorMode();
    }
  }
}

function applyCursorStyle(mode) {
  if (!editor) return;
  const m = typeof mode === "string" ? mode : "";
  const isInsert = m.startsWith("i") || m.startsWith("R");
  const style = isInsert ? "line" : "block";
  const blink = isInsert ? "blink" : "solid";
  const width = isInsert ? (initialCursorWidth || 1) : typicalFullWidth;
  if (style === lastCursorStyle && blink === lastCursorBlink && width === lastCursorWidth) return;
  editor.updateOptions({ cursorStyle: style, cursorBlinking: blink, cursorWidth: width });
  lastCursorStyle = style;
  lastCursorBlink = blink;
  lastCursorWidth = width;
}

init();
