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

let rpcDecoder = null;
let activeWasi = null;

self.onmessage = (event) => {
  const { type } = event.data || {};
  if (type === "start") {
    startNvim(event.data).catch(() => {
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

  rpcDecoder = null;
  const [wasmBytes, runtimeArchive] = await Promise.all([
    fetchBytes("./nvim.wasm"),
    fetchBytes("./nvim-runtime.tar.gz"),
  ]);

  const fsRoot = buildFs(untar(gunzipSync(runtimeArchive)));

  const stdinFd = new RingFd(inputBuffer);
  const stdoutFd = new SinkFd(handleStdout);
  const stderrFd = new SinkFd(() => {});

  const preopen = new RootedPreopenDirectory("nvim", fsRoot.contents);
  const tmp = fsRoot.contents.get("tmp")?.contents || new Map();
  const preopenTmp = new RootedPreopenDirectory("tmp", tmp);

  // Headless embed: stdin/stdout RPC only (no UI attach).
  const args = ["nvim", "--headless", "--embed", "-u", "NORC", "--noplugin", "-i", "NONE", "-n"];
  const env = [
    "VIMRUNTIME=/nvim/runtime",
    "HOME=/nvim/home",
    "PWD=/nvim",
    "XDG_CONFIG_HOME=/nvim/home/.config",
    "XDG_DATA_HOME=/nvim/home/.local/share",
    "XDG_STATE_HOME=/nvim/home/.local/state",
    "PATH=/usr/bin:/bin",
    "TMPDIR=/nvim/tmp",
    `COLUMNS=${cols || 120}`,
    `LINES=${rows || 40}`,
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
  } catch (_) {
    rpcDecoder = new Decoder(handleMessage);
  }
}

function handleMessage(msg) {
  if (!Array.isArray(msg) || msg.length < 1) return;
  const kind = msg[0];
  if (kind === 0) {
    const [, msgid, method, params] = msg;
    if (method === "wasm-clipboard-paste") {
      postMessage({ type: "clipboard-paste", msgid });
    } else {
      postMessage({ type: "rpc-request", msgid, method, params });
    }
  } else if (kind === 1) {
    const [, msgid, error, result] = msg;
    postMessage({ type: "rpc-response", msgid, error, result });
  } else if (kind === 2) {
    const [, method, params] = msg;
    if (method === "wasm-clipboard-copy") {
      const lines = Array.isArray(params?.[0]) ? params[0] : [];
      const regtype = typeof params?.[1] === "string" ? params[1] : "v";
      postMessage({ type: "clipboard-copy", lines, regtype });
    } else if (method === "redraw") {
      postMessage({ type: "redraw", events: params || [] });
    } else {
      postMessage({ type: "rpc-notify", method, params });
    }
  }
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
