# Neovim WASM Demo

Minimal linegrid demo that runs Neovim in a Web Worker (WASI) and renders the UI in the browser.

## Demo
Try it: https://nvim-wasm.pages.dev/



https://github.com/user-attachments/assets/3a280ba5-e890-4f99-8467-67da0fa5e3e2



## How it works
- Neovim runs in a Worker; the main thread attaches with `nvim_ui_attach` (linegrid).
- Input is sent through a SharedArrayBuffer ring; Neovim replies with msgpack-RPC for grid, cursor, and mode.
- The DOM grid renders those events directly (no editor framework).

## Run
- Serve with COOP/COEP so `SharedArrayBuffer` works (e.g. `python serve.py` on localhost:3000).
- Open the page, click the grid, and type. Keys go to Neovim; the grid reflects its state.
