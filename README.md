# nvim-wasm wrapper

This repository is a build wrapper that produces a WebAssembly (WASI) binary of the Neovim submodule without modifying Neovim itself. All WASI-specific shims and patches live outside the submodule.

Try Demo: https://nvim-wasm.pages.dev

https://github.com/user-attachments/assets/524ccf71-1cc4-4b65-aea1-e3f6c893263e

## Prerequisites
- Lua interpreter (prefer Lua 5.1-compatible like `luajit`) and `curl`/`tar` (toolchain/deps downloads)
- No system installs needed; everything is fetched into `.toolchains/`

## Build
- Build host Lua (codegen):
  - `make host-lua`
- Build deps (fetch toolchains, build bundled deps):
  - `make wasm-deps`
- Build wasm (configure + build nvim):
  - `make wasm`
- Clean:
  - `make wasm-clean`

## Notes
- `neovim/` stays untouched; WASI changes live outside the submodule.
- Output `build-wasm/bin/nvim` is a WASI module (not runnable on the host directly).

## Browser demo
- Build wasm: `make wasm`
- Pick a demo:
  - [`examples/demo/`](examples/demo/) — DOM grid (`SharedArrayBuffer`; requires COOP/COEP)
  - [`examples/demo-asyncify/`](examples/demo-asyncify/) — SAB-free (Asyncify + `postMessage`; no COOP/COEP)
  - [`examples/demo-monaco/`](examples/demo-monaco/) — Monaco UI (`SharedArrayBuffer`; requires COOP/COEP)
  - [`examples/demo-xterm/`](examples/demo-xterm/) — xterm.js UI (`SharedArrayBuffer`; requires COOP/COEP)
- Assets:
  - `tar -czf examples/<demo>/nvim-runtime.tar.gz -C neovim/.. runtime -C build-wasm usr nvim_version.lua`
  - SAB demos: `cp build-wasm/bin/nvim examples/<demo>/nvim.wasm`
  - SAB-free demo: `make demo-asyncify` (copies `build-wasm/bin/nvim-asyncify.wasm` into `examples/demo-asyncify/nvim-asyncify.wasm`)

## Asyncify build
### Why
`SharedArrayBuffer` requires COOP/COEP headers. If you want a browser demo that works without those headers, use the Asyncify build and the SAB-free demo.

### Difference vs normal build
- Normal build (`build-wasm/bin/nvim`): designed for demos that use a `SharedArrayBuffer` ring for stdin (needs COOP/COEP).
- Asyncify build (`build-wasm/bin/nvim-asyncify.wasm`): post-processed with Binaryen Asyncify (no Neovim source changes) so `wasi_snapshot_preview1.poll_oneoff` can suspend, letting the Worker receive `postMessage` input without SAB.
- Tradeoffs: larger wasm and some overhead from Asyncify.

### Build
- Build the base wasm first: `make host-lua && make wasm-deps && make wasm`
- Generate the Asyncify wasm:
  - `make wasm-asyncify`
