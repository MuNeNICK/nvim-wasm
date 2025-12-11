# nvim-wasm wrapper

This repository is a build wrapper that produces a WebAssembly (WASI) binary of the Neovim submodule without modifying Neovim itself. All WASI-specific shims and patches live outside the submodule.

## Layout
- `neovim/` – upstream Neovim submodule (kept clean).
- `cmake/` – toolchain and build overrides for WASI.
- `patches/wasi-shim/` – header and source stubs for missing POSIX pieces (pty, signal, fcntl, termios, etc.).
- `patches/libuv-wasi.patch` – minimal libuv patch applied to the downloaded tarball.
- `build-wasm-deps/` – out-of-tree dependency build (luv, libuv, lua, treesitter, etc.).
- `build-wasm/` – Neovim build tree targeting wasm32-wasi.
- `.toolchains/` – downloaded wasi-sdk and portable CMake archives.

## Prerequisites
- Python 3 and curl available on the host (for toolchain/deps downloads).
- No system-level installations are required; everything is fetched into `.toolchains/`.

## Build
1) Fetch toolchains and build bundled dependencies (luv/treesitter/etc.). libuv and PUC Lua are built first as standalone wasm static libs, then the remaining deps reuse them:
```sh
make wasm-deps
```

2) Configure and build Neovim for wasm32-wasi:
```sh
make wasm
```
This emits `build-wasm/bin/nvim`, which is a WASI module (not runnable directly on the host). Runtime helptags are intentionally skipped because the wasm binary cannot execute during the build.

3) Clean build artifacts if needed:
```sh
make wasm-clean
```

## Notes
- Submodule contents must remain untouched; any WASI adjustments belong under `patches/` and are injected via `cmake/wasm-overrides.cmake`.
- `Makefile` pins CMake and wasi-sdk versions, and passes all dependency paths explicitly to avoid Neovim-side edits.
- The produced wasm binary relies on stubbed POSIX features (pty/signal/socket emulation). It is intended for embedding in a WASI runtime, not for feature parity with native Neovim.
- `make wasm-libs` only rebuilds the external libuv/Lua artifacts if you need to refresh them without rebuilding the rest of the deps tree.

## Browser demo
- Build wasm: `make wasm`
- Prepare assets: `./examples/browser/prepare.sh`
- Serve with COOP/COEP so SharedArrayBuffer works: `python examples/browser/serve.py`
- Open http://localhost:8000 to load the msgpack-RPC UI demo (click the canvas, then type). UI is minimal (linegrid only).
