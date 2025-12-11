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

let ringReader = null;
let uiState = null;
let fsRoot = null;
let logPoll = null;
let startupDumpTimer = null;
let rpcMsgCount = 0;
let ioStats = {
  fdReadCalls: 0,
  fdReadBytes: 0,
  stdoutWrites: 0,
  stdoutBytes: 0,
  stderrWrites: 0,
  stderrBytes: 0,
};
let ioStatsTimer = null;
let killTimer = null;
let autoDumpTimers = [];
let flushDebugCount = 0;
let redrawSummaryCount = 0;
let putLogCount = 0;
let redrawLogCount = 0;
// Bump to invalidate caches between UI/worker when behavior changes.
const WORKER_VERSION = "v30-redraw-grid";
const SEND_FSDUMP = false;  // fsdump disabled unless explicitly needed
// Force-stop after a delay to ship logs (hang detection). Off by default to allow editing.
const AUTO_TIMEOUT_MS = 0;
const FORWARD_CONSOLE = false;  // when true, forward console.* to the main thread
const DEBUG_PATH_OPEN = false;
// Keep log streaming enabled (NVIM_LOG_FILE only).
const LOG_STREAM_REGEX = /(nvim\.log)$/;
let enableLogStream = false; // Disable when DEBUG_REDRAW is on to reduce noise
let logStreamTimer = null;
const DEBUG_RPC = true;
const DEBUG_RPC_ERRORS = true;
const DEBUG_IO_STATS = false;
const DEBUG_REDRAW = true;
let rpcDecoder = null;
let rpcChunkCount = 0;
let wasmMemory = null;
let pendingLogRead = null;
let preopenTmp = null;
const fdInfo = new Map();  // fd -> {path, writes}
let logDumpTimer = null;

self.onmessage = (event) => {
  const { type } = event.data || {};
  if (type === "start") {
    startNvim(event.data).catch((err) => {
      postStatus(`worker failed: ${err?.message || err}`, true);
    });
  } else if (type === "dump") {
    postMessage({ type: "console", level: "log", args: ["dump request received"] });
    postMessage({ type: "stderr", text: "[dump-ack] worker received dump request\n" });
    try {
      dumpNow("manual");
    } catch (err) {
      postMessage({ type: "stderr", text: `dump error: ${safeToString(err)}\n` });
    }
  } else if (type === "stop") {
    postMessage({ type: "console", level: "log", args: ["stop request received"] });
    try {
      if (wasi && wasi.wasiImport && wasi.wasiImport.proc_exit) {
        wasi.wasiImport.proc_exit(1);
      }
    } catch (_) {
      // ignore
    }
  } else if (type === "readfile") {
    const p = (event.data.path || "").replace(/^\/+/, "");
    if (!fsRoot) {
      postMessage({ type: "stderr", text: `[readfile-ack] ${p}: no fsRoot\n` });
      return;
    }
    const node = readNode(fsRoot, p);
    if (!node || !isFile(node)) {
      postMessage({ type: "stderr", text: `[readfile-ack] ${p}: not found\n` });
      return;
    }
    try {
      const text = trimLog(decodeFile(node));
      postMessage({ type: "stderr", text: `[readfile-ack] ${p}: size=${text.length}\n== ${p} ==\n${text}\n== end ==\n` });
    } catch (err) {
      postMessage({ type: "stderr", text: `[readfile-ack] ${p}: error ${safeToString(err)}\n` });
    }
  }
};

// Forward console logs only when explicitly enabled (reduce noise by default).
if (FORWARD_CONSOLE) {
  const _origConsoleLog = console.log.bind(console);
  const _origConsoleError = console.error.bind(console);
  const _origConsoleWarn = console.warn.bind(console);
  console.log = (...args) => {
    _origConsoleLog(...args);
    postMessage({ type: "console", level: "log", args: args.map(safeToString) });
  };
  console.error = (...args) => {
    _origConsoleError(...args);
    postMessage({ type: "console", level: "error", args: args.map(safeToString) });
  };
  console.warn = (...args) => {
    _origConsoleWarn(...args);
    postMessage({ type: "console", level: "warn", args: args.map(safeToString) });
  };
}

class RingFd extends Fd {
  constructor(buffer) {
    super();
    this.ctrl = new Int32Array(buffer, 0, 2);
    this.data = new Uint8Array(buffer, 8);
    this.capacity = this.data.length;
    this.readCount = 0;
    this.debugCount = 0;
  }

  fd_fdstat_get() {
    // Regular file so libuv uses fs idle read path.
    const fdstat = new wasi.Fdstat(wasi.FILETYPE_REGULAR_FILE, 0);
    fdstat.fs_rights_base = BigInt(wasi.RIGHTS_FD_READ | wasi.RIGHTS_FD_WRITE);
    return { ret: wasi.ERRNO_SUCCESS, fdstat };
  }

  fd_close() {
    return wasi.ERRNO_SUCCESS;
  }

  fd_read(size) {
    if (this.debugCount < 4) {
      postMessage({ type: "console", level: "log", args: [`fd_read called size=${size}`] });
      this.debugCount += 1;
    }
    if (!this.ctrl) return { ret: wasi.ERRNO_BADF, data: new Uint8Array() };
    const out = new Uint8Array(Math.min(size, this.capacity));
    let written = 0;

    while (written === 0) {
      let head = Atomics.load(this.ctrl, 0);
      let tail = Atomics.load(this.ctrl, 1);
      if (head === tail) {
        return { ret: wasi.ERRNO_AGAIN, data: new Uint8Array() };
      }
      while (head !== tail && written < size) {
        out[written++] = this.data[head];
        head = (head + 1) % this.capacity;
      }
      Atomics.store(this.ctrl, 0, head);
    }

    const chunk = out.slice(0, written);
    if (this.readCount < 8) {
      const hex = toHex(chunk, 64);
      postMessage({ type: "console", level: "log", args: [`stdin fd_read bytes=${written} data=${hex}`] });
      this.readCount += 1;
    }
    ioStats.fdReadCalls += 1;
    ioStats.fdReadBytes += chunk.byteLength;
    return { ret: wasi.ERRNO_SUCCESS, data: chunk };
  }

  fd_write() {
    return { ret: wasi.ERRNO_BADF, nwritten: 0 };
  }

  fd_seek() {
    return { ret: wasi.ERRNO_BADF, offset: 0n };
  }

  fd_tell() {
    return { ret: wasi.ERRNO_BADF, offset: 0n };
  }

  fd_pread() {
    return { ret: wasi.ERRNO_BADF, data: new Uint8Array() };
  }

  fd_pwrite() {
    return { ret: wasi.ERRNO_BADF, nwritten: 0 };
  }
}

class SinkFd extends Fd {
  constructor(onWrite) {
    super();
    this.onWrite = onWrite;
  }

  fd_fdstat_get() {
    // Regular file paired with fs write path.
    const fdstat = new wasi.Fdstat(wasi.FILETYPE_REGULAR_FILE, 0);
    fdstat.fs_rights_base = BigInt(wasi.RIGHTS_FD_WRITE);
    return { ret: wasi.ERRNO_SUCCESS, fdstat };
  }

  fd_write(data) {
    try {
      this.onWrite(new Uint8Array(data));
    } catch (err) {
      postStatus(`stderr handler error: ${err?.message || err}`, true);
    }
    const len = data.byteLength;
    if (this.onWrite === handleStdout) {
      ioStats.stdoutWrites += 1;
      ioStats.stdoutBytes += len;
    } else {
      ioStats.stderrWrites += 1;
      ioStats.stderrBytes += len;
    }
    return { ret: wasi.ERRNO_SUCCESS, nwritten: data.byteLength };
  }

  fd_close() {
    return wasi.ERRNO_SUCCESS;
  }
}

async function startNvim({ inputBuffer, cols, rows }) {
  if (!inputBuffer) {
    postStatus("input buffer missing", true);
    return;
  }

  ringReader = new RingFd(inputBuffer);
  uiState = new UiState(cols || 80, rows || 24);

  postStatus("fetching wasm + runtime…");
  const [wasmBytes, runtimeArchive] = await Promise.all([
    fetchBytes("./nvim.wasm"),
    fetchBytes("./nvim-runtime.tar.gz"),
  ]);

  postMessage({ type: "stderr", text: `worker start ${WORKER_VERSION}\n` });
  const tarBytes = gunzipSync(runtimeArchive);
  const entries = untar(tarBytes);
  const root = buildFs(entries);
  fsRoot = root;
  ensureDir(root, "tmp");
  ensureDir(root, "home");
  ensureDir(root, "home/.config");
  ensureDir(root, "home/.local/share");
  ensureDir(root, "home/.local/state");
  ensureDir(root, "tmp");
  // Create placeholder log files up front to detect whether writes succeed later
  ensureFile(root, "tmp/nvim.log");
  ensureFile(root, "tmp/startuptime.log");
  ensureFile(root, "tmp/verbose.log");
  const preopen = new RootedPreopenDirectory("nvim", root.contents);
  // Map /tmp to the nvim root tmp so TMPDIR=/tmp works
  preopenTmp = new RootedPreopenDirectory("tmp", root.contents.get("tmp")?.contents ?? new Map());

  const stdoutFd = new SinkFd(handleStdout);
  const stderrFd = new SinkFd((chunk) => {
    const text = safeDecode(chunk);
    // Forward wasi_dbg lines to main thread
    if (text && text.includes("wasi:")) {
      postMessage({ type: "console", level: "warn", args: [text.trim()] });
    }
    postMessage({ type: "stderr", text });
    // Do NOT feed stderr into RPC decoder; stderr carries logs, not msgpack.
  });

  dumpNow("pre-start");

  // Run in embedded mode (no --headless) so UI redraw events are produced for the remote client.
  const args = ["nvim", "--embed", "-u", "NORC", "--noplugin", "-i", "NONE", "-n"];
  args.push("-V1/nvim/tmp/verbose.log");
  // Force verbosefile early and log exists('ui') to stderr at startup
  args.push("-c", "set verbosefile=/nvim/tmp/verbose.log | set verbose=15");
  args.push("-c", "lua io.stderr:write('exists_ui='..vim.fn.exists('ui')..'\\n')");
  // Record NVIM_LOG_FILE and append once to verify we can write to it
  args.push("-c", "lua io.stderr:write('NVIM_LOG_FILE='..tostring(vim.env.NVIM_LOG_FILE)..'\\n'); local f=vim.env.NVIM_LOG_FILE or '/nvim/tmp/nvim.log'; pcall(vim.fn.writefile, {'log-test'}, f, 'a')");
  // Write an initial line to avoid a blank screen and force a redraw
  args.push("-c", "set fillchars=eob:~");
  args.push("-c", "call setline(1,'wasm ready') | redraw!");
  // send a ping notification to confirm RPC channel (msgpack only; avoid stdout noise)
  args.push("-c", "lua vim.rpcnotify(0,'init-ping',123)");
  // Force file output early by writing /nvim/tmp/startuptime.log
  args.push("--startuptime");
  args.push("/nvim/tmp/startuptime.log");
  const env = [
    "VIMRUNTIME=/nvim/runtime",
    "HOME=/nvim/home",
    "PWD=/nvim",
    "XDG_CONFIG_HOME=/nvim/home/.config",
    "XDG_DATA_HOME=/nvim/home/.local/share",
    "XDG_STATE_HOME=/nvim/home/.local/state",
    "PATH=/usr/bin:/bin",
    // /nvim/tmp is writable under the preopen root.
    "TMPDIR=/nvim/tmp",
    "LANG=en_US.UTF-8",
    "LC_ALL=en_US.UTF-8",
    // Explicit absolute path (CWD=/nvim)
    "NVIM_LOG_FILE=/nvim/tmp/nvim.log",
    "NVIM_LOG_LEVEL=TRACE",
  ];
  postMessage({
    type: "console",
    level: "log",
    args: ["env", env.filter((s) => /(NVIM_LOG|XDG_|VIMRUNTIME|TMPDIR)/.test(s))],
  });

  const wasi = new WASI(args, env, [ringReader, stdoutFd, stderrFd, preopen, preopenTmp], { debug: false });
  // Force expected fd numbers: 0=stdin (ring), 1=stdout, 2=stderr, 3=preopen root, 4=/tmp.
  wasi.fds[0] = ringReader;
  wasi.fds[1] = stdoutFd;
  wasi.fds[2] = stderrFd;
  wasi.fds[3] = preopen;
  wasi.fds[4] = preopenTmp;
  wasi.preopens = { "/nvim": preopen, "/tmp": preopenTmp };
  const wasiImport = wasi.wasiImport;
  // Log fd_read/fd_write invocation counts to see if stdin/stdout are touched.
  if (DEBUG_IO_STATS) {
    let rd = 0;
    const orig = wasiImport.fd_read;
    wasiImport.fd_read = (...args) => {
      if (rd < 4) {
        postMessage({ type: "console", level: "log", args: [`fd_read wasi import args=${JSON.stringify(args[0])}`] });
      }
      rd += 1;
      return orig(...args);
    };
  }
  const origProcExit = wasiImport.proc_exit;
  wasiImport.proc_exit = (code) => {
    postMessage({ type: "console", level: "error", args: [`proc_exit(${code})`] });
    origProcExit(code);
  };
  // Hook path_open to record fd -> path and emit logs when useful
  {
    let count = 0;
    const origPathOpen = wasiImport.path_open;
    wasiImport.path_open = (...args) => {
      const retObj = origPathOpen(...args);
      const retCode = typeof retObj === "number" ? retObj : retObj?.ret;
      const fdVal = typeof retObj === "object" && retObj ? (retObj.fd ?? retObj.opened_fd ?? "-") : "-";
      let pathStr = null;
      try {
        const pathPtr = Number(args[2] || 0);
        const pathLen = Number(args[3] || 0);
        if (wasmMemory && pathPtr && pathLen) {
          pathStr = new TextDecoder().decode(new Uint8Array(wasmMemory.buffer, pathPtr, pathLen)).replace(/\0+$/, "");
        }
      } catch (_) {
        // ignore decode errors
      }
      let openedFd = null;
      try {
        const openedFdPtr = Number(args[8] || 0);  // opened_fd_ptr is the 9th arg
        if (wasmMemory && openedFdPtr) {
          openedFd = new DataView(wasmMemory.buffer).getUint32(openedFdPtr, true);
        }
      } catch (_) {
        // ignore
      }
      if (openedFd != null && openedFd !== 0) {
        fdInfo.set(openedFd, { path: pathStr || "<unknown>", writes: 0 });
      }
      if (DEBUG_PATH_OPEN && pathStr && /(nvim\.log|tmp|state|home|NVIM_LOG_FILE)/.test(pathStr) && count < 80) {
        postMessage({
          type: "console",
          level: "log",
          args: [`path_open path=${pathStr} ret=${retCode} fd=${fdVal} openedFd=${openedFd ?? "-"} oflags=${JSON.stringify(args[4])}`],
        });
        count += 1;
        // For log files, wait briefly then force a read
        if (retCode === 0 && /nvim\.log/.test(pathStr)) {
          scheduleLogRead();
        }
      }
      return retObj;
    };
  }
  // Trace fd_write to see which fd receives data
  {
    const origFdWrite = wasiImport.fd_write;
    wasiImport.fd_write = (...args) => {
      const fd = Number(args[0]);
      const res = origFdWrite(...args);
      if (enableLogStream && fd > 2 && fd < 256 && fsRoot) {
        const info = fdInfo.get(fd);
        if (info) {
          info.writes = (info.writes || 0) + 1;
          fdInfo.set(fd, info);
        }
        const label = info?.path || `fd${fd}`;
        if (info && LOG_STREAM_REGEX.test(label)) {
          const text = readFileFromFs(label);
          if (text != null) {
            const head = trimLog(text);
            postMessage({
              type: "stderr",
              text: `[log-stream] ${label} writes=${info?.writes ?? 0} size=${text.length}\n${head}\n== end ==\n`,
            });
          } else {
            postMessage({ type: "stderr", text: `[log-stream] ${label} missing\n` });
          }
        }
      }
      return res;
    };
  }

  let instance;
  let module;
  try {
    const env = makeEnv(() => wasi.wasiImport.proc_exit(1));
    ({ module, instance } = await WebAssembly.instantiate(wasmBytes, {
      wasi_snapshot_preview1: wasi.wasiImport,
      env,
    }));
    postMessage({ type: "console", level: "log", args: ["instantiate ok"] });
    wasmMemory = instance.exports.memory || null;
  } catch (err) {
    postStatus(`instantiate failed: ${formatExc(err)}`, true);
    postMessage({ type: "console", level: "error", args: [safeToString(err)] });
    throw err;
  }

  postStatus("nvim starting (waiting for RPC commands)…");
  startLogPolling();
  scheduleStartupDump();
  scheduleAutoDumps();
  // Force a dump shortly after startup to capture nvim.log/verbose.log
  setTimeout(() => {
    try {
      dumpNow("force-auto");
      forceLogDump("startup-force");
    } catch (err) {
      postMessage({ type: "stderr", text: `force-auto dump error: ${safeToString(err)}\n` });
    }
  }, 800);
  startIoStatsTicker();
  // Ensure logs are flushed by forcing a stop after the timeout
  startKillTimer(() => {
    postStatus("nvim timeout kill (log dump)", true);
    emitIoStats("timeout-kill");
    try {
      dumpNow("timeout-before-exit");
      wasi.wasiImport.proc_exit(1);
    } catch (err) {
      postMessage({ type: "stderr", text: `timeout kill error: ${safeToString(err)}\n` });
    }
  }, AUTO_TIMEOUT_MS);
  // Emit initial IO stats so we know the loop started.
  emitIoStats("init");
  let exitCode = 0;
  try {
    exitCode = wasi.start(instance);
  } catch (err) {
    if (err && typeof err.code === "number") {
      exitCode = err.code;
    } else {
      exitCode = 1;
    }
    postStatus(`nvim exited with exception: ${formatExc(err)}`, true);
    postMessage({ type: "console", level: "error", args: [safeToString(err)] });
  }
  stopLogPolling();
  clearStartupDump();
  stopIoStatsTicker();
  stopKillTimer();
  emitIoStats("exit");
  // Try to dump log file if present.
  const logText = readFileUtf8(root, "tmp/nvim.log");
  if (logText != null) {
    postMessage({ type: "log", path: "/nvim/tmp/nvim.log", text: logText });
  } else {
    const verboseText = readFileUtf8(root, "tmp/verbose.log");
    postMessage({
      type: "log",
      path: "/nvim/tmp/nvim.log (missing)",
      text: verboseText ?? "<no log file found>",
    });
  }
  postMessage({
    type: "console",
    level: "log",
    args: [
      "log-dump-status",
      {
        hasNvimLog: logText != null,
        nvimLogLen: logText ? logText.length : 0,
        hasVerbose: readFileUtf8(root, "tmp/verbose.log") != null,
      },
    ],
  });
  if (SEND_FSDUMP) {
    postMessage({ type: "fsdump", tree: dumpDir(root) });
  }
  postMessage({ type: "exit", code: exitCode });
}

function scheduleAutoDumps() {
  clearAutoDumps();
  const tags = ["auto-1", "auto-2", "auto-3"];
  const delays = [1500, 4000, 7000];
  autoDumpTimers = tags.map((tag, idx) => setTimeout(() => {
    dumpNow(tag);
  }, delays[idx]));
  // Late fallback
  autoDumpTimers.push(setTimeout(() => dumpNow("auto-4"), 10000));
}

function clearAutoDumps() {
  for (const t of autoDumpTimers) {
    clearTimeout(t);
  }
  autoDumpTimers = [];
}

function dumpNow(tag = "manual-dump") {
  postMessage({ type: "stderr", text: `${tag}: dumping logs...\n` });
  emitIoStats(tag);
  if (!fsRoot) {
    postMessage({ type: "stderr", text: `${tag}: no fsRoot yet\n` });
    return;
  }
  const tryPaths = [
    "/nvim.log",
    "/nvim/nvim.log",
    "/nvim/tmp/nvim.log",
    "/nvim/tmp/startuptime.log",
    "/nvim/tmp/verbose.log",
    "/home/.local/state/nvim/log",
    "/tmp/startuptime.log",
    "/tmp/nvim.log",
  ];
  // Also try paths from recently opened fds (same as log-stream paths)
  for (const info of fdInfo.values()) {
    if (info?.path && !tryPaths.includes(info.path)) {
      tryPaths.push(info.path);
    }
  }
  let found = false;
  const listing = {};
  for (const p of tryPaths) {
    const node = readNode(fsRoot, p);
    if (!node) continue;
    listing[p] = summarizeDir(node);
    if (isDir(node)) {
      for (const [name, child] of node.contents.entries()) {
        if (isFile(child) && name.startsWith("nvim") && name.endsWith(".log")) {
          const text = decodeFile(child);
          const head = trimLog(text);
          const size = child.data?.length ?? 0;
          const path = `/nvim/${p}/${name}`.replace(/\/+/g, "/");
          postMessage({ type: "log", path, text: head });
          // Also log the size to stderr for visibility
          postMessage({ type: "stderr", text: `${tag}: log head ${path} size=${size}\n${head}\n== end ==\n` });
          found = true;
        }
      }
    } else if (isFile(node)) {
      const text = decodeFile(node);
      const head = trimLog(text);
      const size = node.data?.length ?? 0;
      const path = `/nvim/${p}`.replace(/\/+/g, "/");
      postMessage({ type: "log", path, text: head });
      postMessage({ type: "stderr", text: `${tag}: log head ${path} size=${size}\n${head}\n== end ==\n` });
      found = true;
    }
  }
  // Fallback: scan the FS for any *.log if known paths failed.
  if (!found) {
    const logs = collectLogFiles(fsRoot, 12, 20000);
    if (logs.length) {
      found = true;
      for (const entry of logs) {
        postMessage({ type: "log", path: entry.path, text: entry.head });
        postMessage({ type: "stderr", text: `${tag}: auto-log ${entry.path} size=${entry.size}\n${entry.head}\n== end ==\n` });
      }
      postMessage({
        type: "console",
        level: "log",
        args: ["log-auto-scan", logs.map((l) => ({ path: l.path, size: l.size }))],
      });
    }
  }
  if (!found) {
    postMessage({ type: "stderr", text: `${tag}: no log files found. listings=${JSON.stringify(listing)}\n` });
  }
  // Send minimal directory listings to the console (keep noise low)
  postMessage({
    type: "console",
    level: "log",
    args: ["log-dump-status", { tag, found, listings: listing }],
  });
  if (SEND_FSDUMP) {
    postMessage({ type: "fsdump", tree: dumpDir(fsRoot) });
  }
}

function forceLogDump(tag = "force-dump") {
  // Best-effort: dump known log paths; if nothing is found, dump dir listings.
  if (!fsRoot) {
    postMessage({ type: "stderr", text: `${tag}: no fsRoot\n` });
    return;
  }
  const tryPaths = [
    "/nvim/tmp/nvim.log",
    "/nvim/tmp/verbose.log",
    "/nvim/tmp/startuptime.log",
    "/tmp/nvim.log",
    "/tmp/verbose.log",
    "/tmp/startuptime.log",
  ];
  let found = false;
  for (const p of tryPaths) {
    const node = readNode(fsRoot, p);
    if (node && isFile(node)) {
      const text = trimLog(decodeFile(node));
      postMessage({ type: "stderr", text: `${tag}: ${p}\n${text}\n== end ==\n` });
      found = true;
    }
  }
  if (!found) {
    postMessage({ type: "stderr", text: `${tag}: no log files found\n` });
    try {
      postMessage({ type: "stderr", text: `${tag}: fsdump=${JSON.stringify(dumpDir(fsRoot))}\n` });
    } catch (_) {
      // ignore
    }
  }
}

function summarizeDir(node) {
  if (isFile(node)) return null;
  if (!isDir(node)) return null;
  const out = [];
  for (const [name, child] of node.contents.entries()) {
    if (isFile(child)) {
      out.push(`${name}:${child.data?.byteLength ?? 0}`);
    } else if (isDir(child)) {
      out.push(`${name}/`);
    }
    if (out.length > 40) break;
  }
  return out;
}

function scheduleLogRead() {
  if (pendingLogRead) {
    clearTimeout(pendingLogRead);
    pendingLogRead = null;
  }
  pendingLogRead = setTimeout(() => {
    pendingLogRead = null;
    try {
      dumpNow("auto-logread");
    } catch (err) {
      postMessage({ type: "stderr", text: `auto-logread error: ${safeToString(err)}\n` });
    }
  }, 400);
}

function trimLog(text) {
  const maxChars = 4000;   // reduce noise
  const maxLines = 120;    // reduce noise
  const lines = text.split(/\r?\n/);
  const head = lines.slice(0, maxLines).join("\n");
  if (head.length <= maxChars && lines.length <= maxLines) {
    return head;
  }
  const truncated = head.slice(0, maxChars);
  return `${truncated}\n... <truncated, total lines=${lines.length} chars=${text.length}>`;
}

function readFileFromFs(path) {
  if (!fsRoot || !path) return null;
  const base = path.replace(/^\/+/, "");
  const variants = [base];
  if (!base.startsWith("nvim/")) {
    variants.push(`nvim/${base}`);
  }
  for (const p of variants) {
    const node = readNode(fsRoot, p);
    if (node && isFile(node)) {
      return decodeFile(node);
    }
  }
  return null;
}

function readNode(root, path) {
  const parts = path.replace(/^\/+/, "").split("/").filter(Boolean);
  let node = root;
  for (const part of parts) {
    if (!(node instanceof Directory)) return null;
    // Paths may be given with leading "nvim" from the mountpoint. Skip that.
    if (node.contents.has(part)) {
      node = node.contents.get(part);
    } else if (part === "nvim") {
      continue;
    } else {
      return null;
    }
  }
  return node;
}

function isDir(node) {
  return node instanceof Directory;
}

function isFile(node) {
  return node instanceof File;
}

function decodeFile(file) {
  if (!(file instanceof File)) return "";
  const data = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data || []);
  try {
    return new TextDecoder().decode(data);
  } catch (_) {
    return `[binary ${data.length} bytes]`;
  }
}

function handleStdout(chunk) {
  // Emit raw received data as short hex on stderr
  if (DEBUG_RPC) {
    const hex = toHex(chunk, 64);
    postMessage({ type: "stderr", text: `stdout raw (${chunk.byteLength}b): ${hex}\n` });
  }
  handleRpcChunk(chunk, "stdout");
}

function handleRpcChunk(chunk, source) {
  if (!rpcDecoder) {
    rpcDecoder = new Decoder(handleMessage);
    rpcChunkCount = 0;
  }
  try {
    rpcDecoder.push(chunk);
    if (DEBUG_RPC && rpcChunkCount < 8) {
      postMessage({ type: "console", level: "log", args: [`rpc chunk from ${source} bytes=${chunk.byteLength}`] });
      rpcChunkCount += 1;
    }
  } catch (err) {
    if (DEBUG_RPC_ERRORS) {
      postMessage({ type: "stderr", text: `[rpc-decode-error] ${safeToString(err)} (chunk bytes=${chunk?.byteLength ?? "?"})\n` });
    }
    // Reset the decoder if its internal state may be broken
    rpcDecoder = new Decoder(handleMessage);
    rpcChunkCount = 0;
  }
}

function handleMessage(msg) {
  rpcMsgCount += 1;
  if (DEBUG_RPC && rpcMsgCount <= 60) {
    postMessage({ type: "console", level: "log", args: [`rpc#${rpcMsgCount} ${summarizeMsg(msg)}`] });
  }
  if (!Array.isArray(msg) || msg.length < 1) return;
  const kind = msg[0];
  if (kind === 1) {
    // response: ignore
    try {
      const resStr = JSON.stringify(msg[3]);
      postMessage({ type: "console", level: "log", args: [`resp id=${msg[1]} err=${JSON.stringify(msg[2])} result=${resStr}`] });
    } catch (_) {
      // ignore
    }
    return;
  }
  if (kind === 2) {
    const [, method, params] = msg;
    if (method === "redraw") {
      handleRedraw(params);
    } else {
      postMessage({ type: "notify", method, params });
    }
    return;
  }
  if (kind === 0) {
    // Request from nvim -> respond with error to unblock
    const [, id] = msg;
    const resp = [1, id, "client does not handle requests", null];
    // Send back via stdout? No, must go to stdin; but the client is the producer.
    // We can't push bytes here because stdin is fed externally. Just drop.
    return;
  }
}

function handleRedraw(events) {
  // Collect counts for debugging (how many of each event type arrived)
  const counts = {};
  // Debug counters for grid events
  let logGridLine = 0;
  let logGridClear = 0;
  for (const ev of events) {
    const name = ev[0];
    counts[name] = (counts[name] || 0) + 1;
  }
  // Dump raw event payloads to stderr for debugging
  if (DEBUG_REDRAW && redrawLogCount < 4) {
    try {
      postMessage({ type: "stderr", text: `redraw raw: ${JSON.stringify(events)}\n` });
    } catch (_) {
      // ignore
    }
    // Debug: report how many events were received
    postMessage({ type: "console", level: "log", args: [`draw events=${events.length}`] });
    redrawLogCount += 1;
  }
  let didFlush = false;
  for (const ev of events) {
    const [name, ...args] = ev;
    switch (name) {
      case "put": {
        // Simple handling: concatenate put chars on the current cursor row
        const payload = Array.isArray(args[0]) ? args[0] : args;
        const glyphs = payload.map((c) => {
          if (typeof c === "string") return c;
          if (typeof c === "number") return String.fromCodePoint(c);
          if (Array.isArray(c) && c.length) {
            const v = c[0];
            if (typeof v === "string") return v;
            if (typeof v === "number") return String.fromCodePoint(v);
          }
          return "";
        }).join("");
        if (putLogCount < 2 && glyphs.trim()) {
          putLogCount += 1;
          postMessage({ type: "stderr", text: `[put sample] row=${uiState.cursor.row} col=${uiState.cursor.col} text='${glyphs.slice(0, 40)}'` });
        }
        const row = uiState.cursor.row;
        const col = uiState.cursor.col;
        const cells = Array.from(glyphs).map((ch) => [ch || " ", 0, 1]);
        uiState.line(1, row, col, cells);
        uiState.setCursor(1, row, col + glyphs.length);
        uiState.flush();
        break;
      }
      case "raw_line": {
        // Format: grid, row, startcol, endcol, clearcol, clearattr, flags, chunk, attrs
        const grid = args[0];
        const row = args[1];
        const startcol = args[2];
        const endcol = args[3];
        const clearcol = args[4];
        const chunk = args[7];  // args[6]=flags, args[7]=chunk per ui_events.in.h
        const width = Math.max(0, endcol - startcol);
        const toChar = (c) => {
          if (typeof c === "string") return c;
          if (typeof c === "number") return String.fromCodePoint(c);
          if (Array.isArray(c) && c.length) {
            const v = c[0];
            if (typeof v === "string") return v;
            if (typeof v === "number") return String.fromCodePoint(v);
          }
          return " ";
        };

        if (DEBUG_REDRAW && redrawLogCount < 4) {
          const chunkInfo = Array.isArray(chunk)
            ? `array len=${chunk.length}`
            : chunk instanceof Uint8Array
              ? `u8 len=${chunk.byteLength}`
              : `${typeof chunk}`;
          postMessage({
            type: "stderr",
            text: `[raw_line dbg] grid=${grid} row=${row} start=${startcol} end=${endcol} clear=${clearcol} chunk=${chunkInfo}\n`,
          });
        }

        const cells = [];
        if (Array.isArray(chunk)) {
          for (const item of chunk) {
            if (!Array.isArray(item) || item.length === 0) continue;
            const glyph = toChar(item[0]);
            const repeat = Math.max(1, Number(item[2]) || 1);
            for (let r = 0; r < repeat; r += 1) {
              for (const ch of glyph) {
                cells.push([ch || " ", 0, 1]);
              }
            }
          }
        } else if (typeof chunk === "string") {
          for (const ch of chunk) {
            cells.push([ch || " ", 0, 1]);
          }
        } else if (chunk instanceof Uint8Array || (chunk && chunk.buffer)) {
          try {
            for (const ch of new TextDecoder().decode(chunk)) {
              cells.push([ch || " ", 0, 1]);
            }
          } catch (_) {
            // ignore decode failures
          }
        }

        if (cells.length < width) {
          const pad = width - cells.length;
          for (let i = 0; i < pad; i += 1) {
            cells.push([" ", 0, 1]);
          }
        }

        uiState.line(grid, row, startcol, cells.slice(0, width));
        if (clearcol > endcol) {
          const pad = clearcol - endcol;
          const blanks = Array.from({ length: pad }, () => [" ", 0, 1]);
          uiState.line(grid, row, endcol, blanks);
        }
        try {
          const bypassLines = uiState.grid.cells.map((r) => r.join(""));
          postMessage({ type: "draw-text", lines: bypassLines });
        } catch (_) {
          // ignore
        }
        break;
      }
      case "grid_resize": {
        // args shape: ["grid_resize", grid, cols, rows] or ["grid_resize", [grid, cols, rows]]
        let cols;
        let rows;
        if (Array.isArray(args[0])) {
          [, cols, rows] = args[0];
        } else {
          cols = args[1];
          rows = args[2];
        }
        uiState.resize(cols, rows);
        postMessage({
          type: "console",
          level: "log",
          args: [`grid_resize cols=${cols} rows=${rows} rowsCount=${uiState.grid.cells.length}`],
        });
        break;
      }
      case "resize": {
        const cols = args[0];
        const rows = args[1];
        uiState.resize(cols, rows);
        // Update immediately even when ext_linegrid=false
        uiState.flush();
        break;
      }
      case "grid_clear":
        uiState.clear(args[0]);
        break;
      case "grid_line": {
        const entries = Array.isArray(args[0]) ? args : [args];
        for (const entry of entries) {
          let grid; let row; let col; let cells;
          if (Array.isArray(entry)) {
            [grid, row, col, cells] = entry;
          } else {
            [grid, row, col, cells] = args;
          }
          if (logGridLine < 4) {
            const sample = (cells || []).slice(0, 4);
            postMessage({
              type: "console",
              level: "log",
              args: [`grid_line grid=${grid} row=${row} col=${col} cells=${JSON.stringify(sample)}`],
            });
            logGridLine += 1;
          }
          uiState.line(grid, row, col, cells || []);
        }
        break;
      }
      case "grid_cursor_goto":
        if (Array.isArray(args[0])) {
          uiState.setCursor(args[0][0], args[0][1], args[0][2]);
        } else {
          uiState.setCursor(args[0], args[1], args[2]);
        }
        break;
      case "grid_scroll":
        if (Array.isArray(args[0])) {
          uiState.scroll(args[0][0], args[0][1], args[0][2], args[0][3], args[0][4], args[0][5], args[0][6]);
        } else {
          uiState.scroll(args[0], args[1], args[2], args[3], args[4], args[5], args[6]);
        }
        break;
      case "cursor_goto": {
        // Legacy UI event when ext_linegrid=false
        const [row, col] = Array.isArray(args[0]) ? args[0] : [args[0], args[1]];
        uiState.setCursor(1, row, col);
        break;
      }
      case "scroll": {
        // Legacy scroll event when ext_linegrid=false
        let top; let bot; let left; let right; let rows; let cols;
        if (Array.isArray(args[0])) {
          [top, bot, left, right, rows, cols] = args[0];
        } else {
          [top, bot, left, right, rows, cols] = args;
        }
        uiState.scroll(1, top, bot, left, right, rows, cols);
        break;
      }
      case "clear":
        uiState.clear(1);
        break;
      case "flush":
        uiState.flush();
        didFlush = true;
        break;
      case "grid_destroy":
        uiState.destroy(args[0]);
        break;
      case "mode_change":
        uiState.setMode(args[0], args[1]);
        break;
      case "default_colors_set":
        uiState.setColors(args);
        break;
      case "hl_attr_define":
        uiState.defineHl(args[0], args[1]);
        break;
      default:
        break;
    }
  }
  // Flush even if no explicit flush event arrives (send the grid as-is)
  uiState.flush();

  // Emit a brief summary to stderr a few times to confirm grid events are flowing
  if (redrawSummaryCount < 6) {
    redrawSummaryCount += 1;
    const names = Object.keys(counts).filter(Boolean);
    const gl = counts.grid_line || 0;
    const rl = counts.raw_line || 0;
    const gc = counts.grid_clear || 0;
    const gr = counts.grid_resize || 0;
    postMessage({
      type: "stderr",
      text: `[redraw summary] events=${events.length} names=${names.join(",")} grid_line=${gl} raw_line=${rl} grid_clear=${gc} grid_resize=${gr}\n`,
    });
  }
}

class UiState {
  constructor(cols, rows) {
    this.grid = {
      width: cols,
      height: rows,
      cells: Array.from({ length: rows }, () => Array(cols).fill(" ")),
    };
    this.cursor = { row: 0, col: 0 };
    this.mode = "normal";
    this.hl = {};
  }

  resize(width, height) {
    const w = Number(width) || 0;
    const h = Number(height) || 0;
    this.grid.width = w;
    this.grid.height = h;
    this.grid.cells = Array.from({ length: h }, () => Array(w).fill(" "));
  }

  clear(_grid) {
    this.grid.cells = Array.from({ length: this.grid.height }, () =>
      Array(this.grid.width).fill(" ")
    );
  }

  line(_grid, row, colStart, cells) {
    const rowCells = this.grid.cells[row] || (this.grid.cells[row] = Array(this.grid.width).fill(" "));
    let col = colStart;
    for (const cell of cells) {
      const [text, _hlId, rep] = cell;
      const repeat = rep || 1;
      const glyph = text && text.length ? text : " ";
      for (let r = 0; r < repeat; r += 1) {
        for (let i = 0; i < glyph.length && col < this.grid.width; i += 1) {
          rowCells[col++] = glyph[i];
        }
      }
    }
  }

  scroll(_grid, top, bot, left, right, rows, cols) {
    const height = bot - top;
    const width = right - left;
    const emptyRow = Array(width).fill(" ");

    const slice = [];
    for (let r = 0; r < height; r += 1) {
      const row = this.grid.cells[top + r] || [];
      slice.push(row.slice(left, right));
    }

    if (rows > 0) {
      for (let r = 0; r < height - rows; r += 1) {
        this.grid.cells[top + r].splice(left, width, ...slice[r + rows]);
      }
      for (let r = height - rows; r < height; r += 1) {
        this.grid.cells[top + r].splice(left, width, ...emptyRow);
      }
    } else if (rows < 0) {
      for (let r = height - 1; r >= -rows; r -= 1) {
        this.grid.cells[top + r].splice(left, width, ...slice[r + rows]);
      }
      for (let r = 0; r < -rows; r += 1) {
        this.grid.cells[top + r].splice(left, width, ...emptyRow);
      }
    }

    if (cols !== 0) {
      // Column scrolling is rare; just clear when it happens.
      for (let r = top; r < bot; r += 1) {
        for (let c = left; c < right; c += 1) {
          this.grid.cells[r][c] = " ";
        }
      }
    }
  }

  destroy(_grid) {}

  setMode(mode) {
    this.mode = mode;
  }

  setCursor(_grid, row, col) {
    this.cursor = { row, col };
  }

  setColors(_args) {}

  defineHl(_id, _attrs) {}

  flush() {
    const lines = this.grid.cells.map((row) => row.join(""));
    // Always send draw-text so the UI can render reliably
    if (DEBUG_REDRAW && flushDebugCount < 3) {
      flushDebugCount += 1;
      const preview = lines.slice(0, 6).map((l, i) => `${i}:${l}`).join("\n");
      postMessage({
        type: "stderr",
        text: `[flush dbg] lines=${lines.length} width=${this.grid.width} height=${this.grid.height} cursor=(${this.cursor.row},${this.cursor.col})\n${preview}\n`,
      });
    }
    postMessage({
      type: "draw-text",
      lines,
      cursor: this.cursor,
      mode: this.mode,
    });
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

function ensureDir(root, path) {
  const parts = path.split("/").filter(Boolean);
  let node = root;
  for (const p of parts) {
    if (!node.contents.has(p)) {
      node.contents.set(p, new Directory(new Map()));
    }
    const next = node.contents.get(p);
    if (!(next instanceof Directory)) {
      throw new Error(`Path collision at ${p}`);
    }
    node = next;
  }
}

function ensureFile(root, path) {
  const parts = path.split("/").filter(Boolean);
  if (parts.length === 0) return;
  const filename = parts.pop();
  const dirPath = parts.join("/");
  ensureDir(root, dirPath);
  const dir = parts.length
    ? parts.reduce((acc, p) => acc.contents.get(p), root)
    : root;
  if (!(dir instanceof Directory)) {
    throw new Error(`ensureFile: ${dirPath} is not a directory`);
  }
  if (!dir.contents.has(filename)) {
    dir.contents.set(filename, new File(new Uint8Array(), { readonly: false }));
    postMessage({ type: "console", level: "log", args: ["ensureFile", path, "created placeholder"] });
  }
}

function decodeTarString(decoder, data, start, length) {
  let end = start;
  const max = start + length;
  while (end < max && data[end] !== 0) end += 1;
  return decoder.decode(data.subarray(start, end)).trim();
}

function collectLogFiles(root, limit = 10, headLimit = 12000) {
  const out = [];
  const isLog = (name) => /\.log$/i.test(name);
  const visit = (dir, prefix) => {
    for (const [name, node] of dir.contents.entries()) {
      const path = `${prefix}/${name}`;
      if (node instanceof Directory) {
        visit(node, path);
        if (out.length >= limit) return;
        continue;
      }
      if (!(node instanceof File)) continue;
      // Only consider *.log files to avoid noise from ChangeLog and similar
      if (!isLog(name)) continue;
      const text = decodeFile(node);
      const head = trimLog(text).slice(0, headLimit);
      out.push({ path, size: node.data?.length ?? 0, head });
      if (out.length >= limit) return;
    }
  };
  if (root instanceof Directory) {
    visit(root, "");
  }
  return out;
}

function buildFs(entries) {
  const root = new Directory(new Map());
  for (const entry of entries) {
    const clean = entry.name.replace(/^\.\/?/, "");
    if (!clean) continue;
    const parts = clean.split("/").filter(Boolean);
    if (parts.length === 0) continue;

    let dir = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i];
      if (!dir.contents.has(part)) {
        dir.contents.set(part, new Directory(new Map()));
      }
      const next = dir.contents.get(part);
      if (!(next instanceof Directory)) {
        throw new Error(`Path collision at ${part}`);
      }
      dir = next;
    }

    const leaf = parts[parts.length - 1];
    if (entry.type === "dir") {
      if (!dir.contents.has(leaf)) {
        dir.contents.set(leaf, new Directory(new Map()));
      }
    } else {
      dir.contents.set(leaf, new File(entry.data, { readonly: true }));
    }
  }

  if (!root.contents.has("home")) {
    root.contents.set("home", new Directory(new Map()));
  }
  if (!root.contents.has("tmp")) {
    root.contents.set("tmp", new Directory(new Map()));
  }
  return root;
}

function safeDecode(chunk) {
  try {
    return new TextDecoder().decode(chunk);
  } catch (err) {
    return `[binary ${chunk.length} bytes]`;
  }
}

function toHex(bytes, max = 32) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const slice = view.slice(0, max);
  return Array.from(slice).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function postStatus(message, error = false) {
  postMessage({ type: "status", message, error });
}

function safeToString(x) {
  if (x instanceof WebAssembly.Exception) return "WebAssembly.Exception";
  if (x && x.stack) return x.stack;
  try {
    return String(x);
  } catch (_) {
    return "[unprintable]";
  }
}

function formatExc(err) {
  if (err instanceof WebAssembly.Exception) return "WebAssembly.Exception";
  if (err && err.message) return err.message;
  return String(err);
}

function summarizeMsg(msg) {
  if (!Array.isArray(msg) || msg.length === 0) return "invalid msg";
  const kind = Number(msg[0]);
  if (kind === 1) {
    const id = msg[1];
    const hasErr = msg[2] ? "err" : "ok";
    return `resp id=${id} ${hasErr}`;
  }
  if (kind === 2) {
    const method = msg[1];
    if (method === "redraw") {
      const events = Array.isArray(msg[2]) ? msg[2].length : "?";
      return `notify redraw events=${events}`;
    }
    return `notify ${method}`;
  }
  if (kind === 0) {
    return `request id=${msg[1]}`;
  }
  return `kind=${String(msg[0])}`;
}

function readFileUtf8(root, path) {
  const parts = path.replace(/^\/+/, "").split("/").filter(Boolean);
  let node = root;
  for (let i = 0; i < parts.length; i += 1) {
    if (!(node instanceof Directory)) return null;
    node = node.contents.get(parts[i]);
    if (!node) return null;
  }
  if (node instanceof File) {
    try {
      return new TextDecoder().decode(node.data);
    } catch (e) {
      return null;
    }
  }
  return null;
}

function startLogPolling() {
  stopLogPolling();
  if (!fsRoot) return;
  let lastNvim = "";
  let lastVerbose = "";
  logPoll = setInterval(() => {
    const text = readFileUtf8(fsRoot, "tmp/nvim.log");
    if (text && text !== lastNvim) {
      lastNvim = text;
      const head = trimLog(text);
      // Log events meant for the UI
      postMessage({ type: "log", path: "/nvim/tmp/nvim.log", text: head });
      // Also send to stderr when a change is detected in case the Dump button path is broken
      postMessage({
        type: "stderr",
        text: `[log-watch] /nvim/tmp/nvim.log size=${text.length}\n${head}\n== end ==\n`,
      });
    }
    const vtext = readFileUtf8(fsRoot, "tmp/verbose.log");
    if (vtext && vtext !== lastVerbose) {
      lastVerbose = vtext;
      const head = trimLog(vtext);
      postMessage({ type: "log", path: "/nvim/tmp/verbose.log", text: head });
      postMessage({
        type: "stderr",
        text: `[log-watch] /nvim/tmp/verbose.log size=${vtext.length}\n${head}\n== end ==\n`,
      });
    }
  }, 1000);
}

function stopLogPolling() {
  if (logPoll) {
    clearInterval(logPoll);
    logPoll = null;
  }
}

function scheduleStartupDump() {
  clearStartupDump();
  // Give nvim a moment to start; then dump log once even if still running.
  startupDumpTimer = setTimeout(() => {
    emitIoStats("startup");
    if (!fsRoot) return;
    const text = readFileUtf8(fsRoot, "tmp/nvim.log");
    if (text) {
      postMessage({ type: "log", path: "/nvim/tmp/nvim.log", text });
    }
    const vtext = readFileUtf8(fsRoot, "tmp/verbose.log");
    if (vtext) {
      postMessage({ type: "log", path: "/nvim/tmp/verbose.log", text: vtext });
    }
  }, 3000);
}

function clearStartupDump() {
  if (startupDumpTimer) {
    clearTimeout(startupDumpTimer);
    startupDumpTimer = null;
  }
}

function emitIoStats(tag) {
  postMessage({
    type: "console",
    level: "log",
    args: [
      `io-stats[${tag}]`,
      JSON.stringify({
        fdReadCalls: ioStats.fdReadCalls,
        fdReadBytes: ioStats.fdReadBytes,
        stdoutWrites: ioStats.stdoutWrites,
        stdoutBytes: ioStats.stdoutBytes,
        stderrWrites: ioStats.stderrWrites,
        stderrBytes: ioStats.stderrBytes,
      }),
    ],
  });
}

function startIoStatsTicker() {
  stopIoStatsTicker();
  ioStatsTimer = setInterval(() => emitIoStats("tick"), 1000);
}

function stopIoStatsTicker() {
  if (ioStatsTimer) {
    clearInterval(ioStatsTimer);
    ioStatsTimer = null;
  }
}

function startKillTimer(fn, ms) {
  if (!ms || ms <= 0) return;
  stopKillTimer();
  killTimer = setTimeout(fn, ms);
}

function stopKillTimer() {
  if (killTimer) {
    clearTimeout(killTimer);
    killTimer = null;
  }
}

function makeEnv(procExit) {
  // __c_longjmp uses a single i32 param in this build.
  const cLongjmp = new WebAssembly.Tag({ parameters: ["i32"], results: [] });
  const env = {
    flock: () => 0,
    getpid: () => 1,
    // Signature: (const char* wtf8, uint16_t* utf16, size_t utf16_len)
    uv_wtf8_to_utf16: (_wtf8, _utf16, _len) => {},
    // libuv utf16/wtf8 helpers stubbed out for WASI build (avoid import errors).
    // See patches/libuv-wasi.patch where these return ENOSYS/0 on native side.
    uv_utf16_length_as_wtf8: (_utf16, _len) => 0,
    uv_utf16_to_wtf8: (_utf16, _len, _wtf8_ptr, _wtf8_len_ptr) => -38 /* UV_ENOSYS */,
    uv_wtf8_length_as_utf16: (_wtf8) => 0,
    __wasm_longjmp: (ptr, _val) => {
      // In wasm32-wasi without EH support, just exit with failure.
      const p = ptr ?? 0;
      postMessage({ type: "console", level: "warn", args: ["__wasm_longjmp", p, "-> proc_exit(1)"] });
      if (procExit) procExit(1);
      throw new WebAssembly.Exception(cLongjmp, [p]);
    },
    __wasm_setjmp: () => 0,
    __wasm_setjmp_test: () => 0,
    tmpfile: () => 0,
    clock: () => 0,
    system: () => -1,
    tmpnam: () => 0,
    __c_longjmp: cLongjmp,
  };
  // Defensive: ensure uv_random is always a callable stub.
  env.uv_random = () => -38;
  postMessage({
    type: "console",
    level: "log",
    args: [
      "makeEnv exports",
      { uv_random: typeof env.uv_random, hasTag: !!cLongjmp },
    ],
  });
  return env;
}

class RootedPreopenDirectory extends PreopenDirectory {
  #strip(path) {
    return path.replace(/^\/+/, "");
  }
  path_open(dirflags, path_str, ...rest) {
    return super.path_open(dirflags, this.#strip(path_str), ...rest);
  }
  path_filestat_get(flags, path_str) {
    return super.path_filestat_get(flags, this.#strip(path_str));
  }
  path_create_directory(path_str) {
    return super.path_create_directory(this.#strip(path_str));
  }
  path_unlink_file(path_str) {
    return super.path_unlink_file(this.#strip(path_str));
  }
  path_remove_directory(path_str) {
    return super.path_remove_directory(this.#strip(path_str));
  }
  path_link(path_str, inode, allow_dir) {
    return super.path_link(this.#strip(path_str), inode, allow_dir);
  }
  path_readlink(path_str) {
    return super.path_readlink(this.#strip(path_str));
  }
  path_symlink(old_path, new_path) {
    return super.path_symlink(this.#strip(old_path), this.#strip(new_path));
  }
}

function dumpDir(dir, prefix = "") {
  const entries = [];
  for (const [name, node] of dir.contents.entries()) {
    const path = `${prefix}/${name}`;
    if (node instanceof Directory) {
      entries.push({ path, kind: "dir", children: dumpDir(node, path) });
    } else if (node instanceof File) {
      entries.push({ path, kind: "file", size: node.data.length });
    }
  }
  return entries;
}

// For debugging: expose fd map to the main thread
function snapshotFdInfo() {
  const out = [];
  for (const [fd, info] of fdInfo.entries()) {
    out.push({ fd, path: info.path, writes: info.writes });
  }
  return out;
}
