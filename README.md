# nvim-wasm wrapper

This repository is a build wrapper that produces a WebAssembly (WASI) binary of the Neovim submodule without modifying Neovim itself. All WASI-specific shims and patches live outside the submodule.

Try Demo: https://nvim-wasm.pages.dev

https://github.com/user-attachments/assets/524ccf71-1cc4-4b65-aea1-e3f6c893263e

## Layout
- `neovim/` – upstream Neovim submodule (kept clean).
- `cmake/` – toolchain and build overrides for WASI.
- `scripts/patch/` – Python patch helpers applied to Lua/luv/libuv during the wasm build.
- `scripts/build/` – Python helpers invoked during codegen (host Lua wrapper).
- `scripts/toolchain/` – Python fetch helpers for wasi-sdk/CMake archives.
- `scripts/config/` – shared flag presets for the wasm build.
- `patches/wasi-shim/` – header and source stubs for missing POSIX pieces (pty, signal, fcntl, termios, etc.).
- `patches/libuv-wasi.patch` – minimal libuv patch applied to the downloaded tarball.
- `build-wasm-deps/` – out-of-tree dependency build (luv, libuv, lua, treesitter, etc.).
- `build-wasm/` – Neovim build tree targeting wasm32-wasi.
- `.toolchains/` – downloaded wasi-sdk and portable CMake archives.

## Prerequisites
- Python 3 and curl available on the host (for toolchain/deps downloads).
- No system-level installations are required; everything is fetched into `.toolchains/`.

## Build
1) Build host Lua + nlua0 used during codegen (skipped if you point `HOST_LUA_PRG`/`HOST_NLUA0` elsewhere):
```sh
make host-lua
```
Artifacts land in `build-host/.deps/usr/bin/lua` and `build-host/libnlua0-host.so`; `make wasm` will automatically build them when using the defaults.

2) Fetch toolchains and build bundled dependencies (luv/treesitter/etc.). libuv and PUC Lua are built first as standalone wasm static libs, then the remaining deps reuse them:
```sh
make wasm-deps
```

3) Configure and build Neovim for wasm32-wasi:
```sh
make wasm
```
This emits `build-wasm/bin/nvim`, which is a WASI module (not runnable directly on the host). Runtime helptags are intentionally skipped because the wasm binary cannot execute during the build.

4) Clean build artifacts if needed:
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
- Pick a demo directory: `examples/demo/` (DOM grid), `examples/demo-monaco/`, or `examples/demo-xterm/`.
- Copy assets into it:
  - `cp build-wasm/bin/nvim examples/<demo>/nvim.wasm`
  - `tar -czf examples/<demo>/nvim-runtime.tar.gz -C neovim/.. runtime -C build-wasm usr nvim_version.lua`
- Serve that directory with COOP/COEP headers (any static server is fine; ensure SharedArrayBuffer is enabled).
- Open http://localhost:8765 (or your chosen port). Neovim starts automatically; click the editor/terminal area to focus.
