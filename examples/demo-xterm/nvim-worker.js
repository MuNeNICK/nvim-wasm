import {
  WASI,
  wasi,
  Directory,
  File,
  PreopenDirectory,
  Fd,
} from "https://unpkg.com/@bjorn3/browser_wasi_shim@0.4.2/dist/index.js";
import { gunzipSync } from "https://cdn.jsdelivr.net/npm/fflate@0.8.2/+esm";
import { Decoder } from "./msgpack.js";

let uiState = null;
let rpcDecoder = null;
let fsRoot = null;
let activeWasi = null;

self.onmessage = (event) => {
  const { type } = event.data || {};
  if (type === "start") {
    startNvim(event.data).catch((err) => {
      postMessage({ type: "exit", code: 1 });
    });
  } else if (type === "stop") {
    try {
      activeWasi?.wasiImport?.proc_exit?.(0);
    } catch (_) {
      // ignore
    }
  }
};

class RingFd extends Fd {
  constructor(buffer) {
    super();
    this.ctrl = new Int32Array(buffer, 0, 2);
    this.data = new Uint8Array(buffer, 8);
    this.capacity = this.data.length;
  }

  fd_fdstat_get() {
    const fdstat = new wasi.Fdstat(wasi.FILETYPE_REGULAR_FILE, 0);
    fdstat.fs_rights_base = BigInt(wasi.RIGHTS_FD_READ | wasi.RIGHTS_FD_WRITE);
    return { ret: wasi.ERRNO_SUCCESS, fdstat };
  }

  fd_close() { return wasi.ERRNO_SUCCESS; }

  fd_read(size) {
    if (!this.ctrl) return { ret: wasi.ERRNO_BADF, data: new Uint8Array() };
    const max = Math.min(Number(size) || 0, this.capacity);
    const out = new Uint8Array(max);
    let written = 0;
    let head = Atomics.load(this.ctrl, 0);
    let tail = Atomics.load(this.ctrl, 1);
    if (head === tail) return { ret: wasi.ERRNO_AGAIN, data: new Uint8Array() };
    while (head !== tail && written < max) {
      out[written++] = this.data[head];
      head = (head + 1) % this.capacity;
    }
    Atomics.store(this.ctrl, 0, head);
    return { ret: wasi.ERRNO_SUCCESS, data: out.slice(0, written) };
  }

  fd_write() { return { ret: wasi.ERRNO_BADF, nwritten: 0 }; }
  fd_seek() { return { ret: wasi.ERRNO_BADF, offset: 0n }; }
  fd_tell() { return { ret: wasi.ERRNO_BADF, offset: 0n }; }
  fd_pread() { return { ret: wasi.ERRNO_BADF, data: new Uint8Array() }; }
  fd_pwrite() { return { ret: wasi.ERRNO_BADF, nwritten: 0 }; }
}

class SinkFd extends Fd {
  constructor(onWrite) {
    super();
    this.onWrite = onWrite;
  }

  fd_fdstat_get() {
    const fdstat = new wasi.Fdstat(wasi.FILETYPE_REGULAR_FILE, 0);
    fdstat.fs_rights_base = BigInt(wasi.RIGHTS_FD_WRITE);
    return { ret: wasi.ERRNO_SUCCESS, fdstat };
  }

  fd_write(data) {
    this.onWrite(new Uint8Array(data));
    return { ret: wasi.ERRNO_SUCCESS, nwritten: data.byteLength };
  }

  fd_close() { return wasi.ERRNO_SUCCESS; }
}

async function startNvim({ inputBuffer, cols, rows }) {
  if (!inputBuffer) {
    postMessage({ type: "exit", code: 1 });
    return;
  }

  uiState = new UiState(cols || 80, rows || 24);
  rpcDecoder = null;

  const [wasmBytes, runtimeArchive] = await Promise.all([
    fetchBytes("./nvim.wasm"),
    fetchBytes("./nvim-runtime.tar.gz"),
  ]);

  const tarBytes = gunzipSync(runtimeArchive);
  fsRoot = buildFs(untar(tarBytes));

  const stdinFd = new RingFd(inputBuffer);
  const stdoutFd = new SinkFd(handleStdout);
  const stderrFd = new SinkFd(() => {});

  const preopen = new RootedPreopenDirectory("nvim", fsRoot.contents);
  const tmp = fsRoot.contents.get("tmp")?.contents || new Map();
  const preopenTmp = new RootedPreopenDirectory("tmp", tmp);

  const args = ["nvim", "--embed", "-u", "NORC", "--noplugin", "-i", "NONE", "-n"];
  const env = [
    "VIMRUNTIME=/nvim/runtime",
    "HOME=/nvim/home",
    "PWD=/nvim",
    "XDG_CONFIG_HOME=/nvim/home/.config",
    "XDG_DATA_HOME=/nvim/home/.local/share",
    "XDG_STATE_HOME=/nvim/home/.local/state",
    "PATH=/usr/bin:/bin",
    "TMPDIR=/nvim/tmp",
  ];

  activeWasi = new WASI(args, env, [stdinFd, stdoutFd, stderrFd, preopen, preopenTmp], { debug: false });
  activeWasi.fds[0] = stdinFd;
  activeWasi.fds[1] = stdoutFd;
  activeWasi.fds[2] = stderrFd;
  activeWasi.fds[3] = preopen;
  activeWasi.fds[4] = preopenTmp;
  activeWasi.preopens = { "/nvim": preopen, "/tmp": preopenTmp };

  const envImports = makeEnv(() => activeWasi.wasiImport.proc_exit(1));
  let exitCode = 0;
  try {
    const { instance } = await WebAssembly.instantiate(wasmBytes, {
      wasi_snapshot_preview1: activeWasi.wasiImport,
      env: envImports,
    });
    exitCode = activeWasi.start(instance);
  } catch (err) {
    exitCode = typeof err?.code === "number" ? err.code : 1;
  }

  postMessage({ type: "exit", code: exitCode });
}

function handleStdout(chunk) {
  if (!rpcDecoder) {
    rpcDecoder = new Decoder(handleMessage);
  }
  try {
    rpcDecoder.push(chunk);
  } catch (err) {
    rpcDecoder = new Decoder(handleMessage);
  }
}

function handleMessage(msg) {
  if (!Array.isArray(msg) || msg.length < 1) return;
  const kind = msg[0];
  if (kind === 0) {
    const [, msgid, method, params] = msg;
    if (method === "wasm-clipboard-paste") {
      postMessage({ type: "clipboard-paste", requestId: msgid });
    }
  } else if (kind === 2) {
    const [, method, params] = msg;
    if (method === "redraw") {
      handleRedraw(params || []);
    } else if (method === "wasm-clipboard-copy") {
      const lines = Array.isArray(params?.[0]) ? params[0] : [];
      const regtype = typeof params?.[1] === "string" ? params[1] : "v";
      postMessage({ type: "clipboard-copy", lines, regtype });
    }
  }
}

function handleRedraw(events) {
  if (!uiState) return;
  let dirty = false;

  for (const ev of events) {
    const [name, ...args] = ev;
    switch (name) {
      case "grid_resize": {
        const value = Array.isArray(args[0]) ? args[0] : args;
        uiState.resize(value[0], value[1], value[2]);
        dirty = true;
        break;
      }
      case "grid_clear": {
        const value = Array.isArray(args[0]) ? args[0] : args;
        uiState.clear(value[0]);
        dirty = true;
        break;
      }
      case "grid_destroy": {
        const value = Array.isArray(args[0]) ? args[0] : args;
        uiState.destroy(value[0]);
        dirty = true;
        break;
      }
      case "grid_line": {
        let entries = [];
        if (args.length === 1 && Array.isArray(args[0]) && Array.isArray(args[0][0])) {
          entries = args[0];
        } else {
          for (const entry of args) {
            if (Array.isArray(entry)) entries.push(entry);
          }
        }
        if (!entries.length && Array.isArray(args[0])) entries.push(args[0]);
        for (const entry of entries) {
          const [grid, row, col, cells] = entry;
          uiState.line(grid, row, col, cells || []);
        }
        dirty = true;
        break;
      }
      case "grid_scroll": {
        const value = Array.isArray(args[0]) ? args[0] : args;
        uiState.scroll(value[0], value[1], value[2], value[3], value[4], value[5], value[6]);
        dirty = true;
        break;
      }
      case "grid_cursor_goto": {
        const value = Array.isArray(args[0]) ? args[0] : args;
        uiState.setCursor(value[0], value[1], value[2]);
        dirty = true;
        break;
      }
      case "cursor_goto": {
        const value = Array.isArray(args[0]) ? args[0] : args;
        uiState.setCursor(uiState.activeGrid, value[0], value[1]);
        dirty = true;
        break;
      }
      case "mode_info_set": {
        const value = Array.isArray(args[0]) ? args[0] : args;
        uiState.setModeInfo(value[0], value[1]);
        dirty = true;
        break;
      }
      case "hl_attr_define": {
        for (const entry of args) {
          if (!Array.isArray(entry)) continue;
          const [id, rgbAttr] = entry;
          uiState.defineHl(id, rgbAttr || {});
        }
        break;
      }
      case "mode_change": {
        const value = Array.isArray(args[0]) ? args[0] : args;
        uiState.setMode(value[0], value[1]);
        dirty = true;
        break;
      }
      case "flush":
        sendDraw();
        dirty = false;
        break;
      default:
        break;
    }
  }

  if (dirty) sendDraw();
}

function sendDraw() {
  if (!uiState) return;
  const snapshot = uiState.snapshot();
  postMessage({
    type: "draw-text",
    lines: snapshot.lines,
    cells: snapshot.cells,
    cursor: snapshot.cursor,
    mode: snapshot.mode,
    hls: snapshot.hls,
  });
}

class UiState {
  constructor(cols, rows) {
    this.defaultWidth = Math.max(1, Number(cols) || 0);
    this.defaultHeight = Math.max(1, Number(rows) || 0);
    this.defaultGrid = 1;
    this.activeGrid = this.defaultGrid;
    this.grids = new Map();
    this.grids.set(this.defaultGrid, this.#createGrid(this.defaultWidth, this.defaultHeight));
    this.cursor = { grid: this.defaultGrid, row: 0, col: 0 };
    this.mode = "-";
    this.modeIdx = 0;
    this.cursorStyleEnabled = false;
    this.modeInfo = [];
    this.cursorHlId = 0;
    this.hls = new Map();
    this.hls.set(0, { foreground: null, background: null, reverse: false, blend: 0 });
  }

  resize(gridId, width, height) {
    const grid = this.#ensureGrid(gridId);
    const w = Math.max(1, Number(width) || 0);
    const h = Math.max(1, Number(height) || 0);
    grid.width = w;
    grid.height = h;
    grid.cells = Array.from({ length: h }, () => this.#blankRow(w));
  }

  clear(gridId) {
    const grid = this.#ensureGrid(gridId);
    grid.cells = Array.from({ length: grid.height }, () => this.#blankRow(grid.width));
  }

  destroy(gridId) {
    const id = Number(gridId);
    this.grids.delete(id);
    if (this.activeGrid === id) this.activeGrid = this.defaultGrid;
  }

  line(gridId, row, colStart, cells) {
    const grid = this.#ensureGrid(gridId);
    const rowIdx = Number(row) || 0;
    const col0 = Number(colStart) || 0;
    if (rowIdx < 0 || rowIdx >= grid.height) return;
    const rowCells = grid.cells[rowIdx] || (grid.cells[rowIdx] = this.#blankRow(grid.width));
    let col = col0;
    let currentHl = 0;
    for (const cell of cells) {
      const text = cell[0];
      const hlId = cell.length > 1 && cell[1] !== undefined ? cell[1] : currentHl;
      currentHl = hlId;
      const repeat = cell[2] || 1;
      const glyph = normalizeGlyph(text);
      const glyphChars = glyph === "" ? [""] : Array.from(glyph);
      for (let r = 0; r < repeat && col < grid.width; r += 1) {
        for (const ch of glyphChars) {
          if (col >= grid.width) break;
          rowCells[col] = this.#makeCell(ch ?? " ", hlId);
          col += 1;
        }
      }
    }
  }

  scroll(gridId, top, bot, left, right, rows, cols) {
    const grid = this.#ensureGrid(gridId);
    const t = Number(top) || 0;
    const b = Number(bot) || 0;
    const l = Number(left) || 0;
    const r = Number(right) || 0;
    const rowDelta = Number(rows) || 0;
    const colDelta = Number(cols) || 0;
    const height = b - t;
    const width = r - l;
    const emptyRow = this.#blankRow(width);
    const slice = [];
    for (let i = t; i < b; i += 1) {
      if (!grid.cells[i]) grid.cells[i] = this.#blankRow(grid.width);
    }
    for (let i = 0; i < height; i += 1) {
      const row = grid.cells[t + i] || this.#blankRow(grid.width);
      slice.push(row.slice(l, r));
    }

    if (rowDelta > 0) {
      for (let i = 0; i < height - rowDelta; i += 1) {
        grid.cells[t + i].splice(l, width, ...slice[i + rowDelta]);
      }
      for (let i = height - rowDelta; i < height; i += 1) {
        grid.cells[t + i].splice(l, width, ...emptyRow);
      }
    } else if (rowDelta < 0) {
      for (let i = height - 1; i >= -rowDelta; i -= 1) {
        grid.cells[t + i].splice(l, width, ...slice[i + rowDelta]);
      }
      for (let i = 0; i < -rowDelta; i += 1) {
        grid.cells[t + i].splice(l, width, ...emptyRow);
      }
    }

    if (colDelta !== 0) {
      for (let i = t; i < b; i += 1) {
        for (let j = l; j < r; j += 1) {
          grid.cells[i][j] = this.#makeCell(" ", 0);
        }
      }
    }
  }

  setCursor(gridId, row, col) {
    const gid = Number.isFinite(Number(gridId)) ? Number(gridId) : this.defaultGrid;
    this.activeGrid = gid;
    this.#ensureGrid(gid);
    this.cursor = { grid: gid, row: Number(row) || 0, col: Number(col) || 0 };
  }

  setMode(mode, modeIdx) {
    this.mode = mode || "-";
    if (Number.isInteger(modeIdx)) this.modeIdx = modeIdx;
    this.#updateCursorHl();
  }

  setModeInfo(cursorStyleEnabled, modeInfo) {
    this.cursorStyleEnabled = Boolean(cursorStyleEnabled);
    this.modeInfo = Array.isArray(modeInfo) ? modeInfo : [];
    this.#updateCursorHl();
  }

  defineHl(id, rgbAttr = {}) {
    const hlId = Number(id);
    this.hls.set(hlId, {
      foreground: toHex(rgbAttr.foreground),
      background: toHex(rgbAttr.background),
      reverse: Boolean(rgbAttr.reverse),
      blend: Number(rgbAttr.blend) || 0,
    });
  }

  snapshot() {
    const grid = this.grids.get(this.activeGrid) || this.grids.get(this.defaultGrid) || this.grids.values().next().value;
    if (!grid) {
      return {
        lines: [""],
        cells: [[{ ch: " ", hl: 0 }]],
        cursor: { grid: this.defaultGrid, row: 0, col: 0 },
        mode: this.mode,
        cursorHlId: this.cursorHlId,
        hls: Object.fromEntries(this.hls),
      };
    }

    const row = clamp(Math.floor(this.cursor.row || 0), 0, grid.height - 1);
    const col = clamp(Math.floor(this.cursor.col || 0), 0, grid.width - 1);
    const cells = grid.cells.map((r) => r.map((cell) => ({ ch: cell?.ch ?? " ", hl: cell?.hl ?? 0 })));
    return {
      lines: cells.map((r) => r.map((c) => c.ch || " ").join("")),
      cells,
      cursor: { grid: this.cursor.grid, row, col },
      mode: this.mode,
      cursorHlId: this.cursorHlId,
      hls: Object.fromEntries(this.hls),
    };
  }

  #ensureGrid(gridId) {
    const gid = Number.isFinite(Number(gridId)) ? Number(gridId) : this.defaultGrid;
    if (!this.grids.has(gid)) this.grids.set(gid, this.#createGrid(this.defaultWidth, this.defaultHeight));
    return this.grids.get(gid);
  }

  #createGrid(width, height) {
    const w = Math.max(1, Number(width) || 0);
    const h = Math.max(1, Number(height) || 0);
    return { width: w, height: h, cells: Array.from({ length: h }, () => this.#blankRow(w)) };
  }

  #blankRow(width, hl = 0) { return Array.from({ length: width }, () => this.#makeCell(" ", hl)); }

  #makeCell(ch, hl) { return { ch, hl: Number.isFinite(Number(hl)) ? Number(hl) : 0 }; }

  #updateCursorHl() {
    if (!this.cursorStyleEnabled || !Array.isArray(this.modeInfo)) {
      this.cursorHlId = 0;
      return;
    }
    const info = this.modeInfo[this.modeIdx] || null;
    const attrId = info && info.attr_id !== undefined ? info.attr_id : 0;
    this.cursorHlId = Number.isFinite(Number(attrId)) ? Number(attrId) : 0;
  }
}

function clamp(value, min, max) { return Math.min(Math.max(value, min), max); }

function toHex(value) {
  if (value === undefined || value === null || Number.isNaN(Number(value))) return null;
  const numVal = Number(value);
  if (numVal < 0) return null;
  const num = numVal >>> 0;
  return `#${num.toString(16).padStart(6, "0").slice(-6)}`;
}

function normalizeGlyph(val) {
  if (typeof val === "string") return val;
  if (typeof val === "number") return String.fromCodePoint(val);
  if (Array.isArray(val) && val.length) {
    const first = val[0];
    if (typeof first === "string") return first;
    if (typeof first === "number") return String.fromCodePoint(first);
  }
  return " ";
}

async function fetchBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} failed (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

function untar(bytes) {
  const files = [];
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let offset = 0;
  const decoder = new TextDecoder();

  while (offset + 512 <= data.length) {
    const name = decodeTarString(decoder, data, offset, 100);
    const sizeText = decodeTarString(decoder, data, offset + 124, 12);
    const typeflag = data[offset + 156];
    const prefix = decodeTarString(decoder, data, offset + 345, 155);
    if (!name && !prefix) break;
    const size = parseInt(sizeText.trim() || "0", 8) || 0;
    const fullName = prefix ? `${prefix}/${name}` : name;
    const bodyStart = offset + 512;
    const bodyEnd = bodyStart + size;
    const payload = data.slice(bodyStart, bodyEnd);
    files.push({ name: fullName, type: typeflag === 53 ? "dir" : "file", data: payload });
    const blocks = Math.ceil(size / 512);
    offset = bodyStart + blocks * 512;
  }
  return files;
}

function decodeTarString(decoder, data, start, length) {
  let end = start;
  const max = start + length;
  while (end < max && data[end] !== 0) end += 1;
  return decoder.decode(data.subarray(start, end)).trim();
}

function buildFs(entries) {
  const root = new Directory(new Map());
  for (const entry of entries) {
    const clean = entry.name.replace(/^\.\/?/, "");
    if (!clean) continue;
    const parts = clean.split("/").filter(Boolean);
    if (!parts.length) continue;

    let dir = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i];
      if (!dir.contents.has(part)) dir.contents.set(part, new Directory(new Map()));
      dir = dir.contents.get(part);
    }

    const leaf = parts[parts.length - 1];
    if (entry.type === "dir") {
      if (!dir.contents.has(leaf)) dir.contents.set(leaf, new Directory(new Map()));
    } else {
      dir.contents.set(leaf, new File(entry.data, { readonly: true }));
    }
  }

  ensureDir(root, "home");
  ensureDir(root, "tmp");
  ensureDir(root, "home/.config");
  ensureDir(root, "home/.local/share");
  ensureDir(root, "home/.local/state");

  return root;
}

function ensureDir(root, path) {
  const parts = path.split("/").filter(Boolean);
  let node = root;
  for (const p of parts) {
    if (!node.contents.has(p)) node.contents.set(p, new Directory(new Map()));
    node = node.contents.get(p);
  }
}

function makeEnv(procExit) {
  const cLongjmp = new WebAssembly.Tag({ parameters: ["i32"], results: [] });
  return {
    flock: () => 0,
    getpid: () => 1,
    uv_random: () => -38,
    uv_wtf8_to_utf16: () => {},
    uv_utf16_length_as_wtf8: () => 0,
    uv_utf16_to_wtf8: () => -38,
    uv_wtf8_length_as_utf16: () => 0,
    __wasm_longjmp: (ptr) => {
      if (procExit) procExit(1);
      throw new WebAssembly.Exception(cLongjmp, [ptr ?? 0]);
    },
    __wasm_setjmp: () => 0,
    __wasm_setjmp_test: () => 0,
    tmpfile: () => 0,
    clock: () => 0,
    system: () => -1,
    tmpnam: () => 0,
    __c_longjmp: cLongjmp,
  };
}

class RootedPreopenDirectory extends PreopenDirectory {
  #strip(path) { return path.replace(/^\/+/, ""); }
  path_open(dirflags, path_str, ...rest) { return super.path_open(dirflags, this.#strip(path_str), ...rest); }
  path_filestat_get(flags, path_str) { return super.path_filestat_get(flags, this.#strip(path_str)); }
  path_create_directory(path_str) { return super.path_create_directory(this.#strip(path_str)); }
  path_unlink_file(path_str) { return super.path_unlink_file(this.#strip(path_str)); }
  path_remove_directory(path_str) { return super.path_remove_directory(this.#strip(path_str)); }
  path_link(path_str, inode, allow_dir) { return super.path_link(this.#strip(path_str), inode, allow_dir); }
  path_readlink(path_str) { return super.path_readlink(this.#strip(path_str)); }
  path_symlink(old_path, new_path) { return super.path_symlink(this.#strip(old_path), this.#strip(new_path)); }
}
