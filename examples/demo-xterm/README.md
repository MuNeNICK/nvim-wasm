# Neovim WASM + xterm.js Demo (ghostty-web backend)

Neovim in a Web Worker (WASI), rendered via an xterm.js-compatible terminal API (powered by `ghostty-web`) by converting Neovim's `ext_linegrid` UI updates into ANSI.

## Run
- Serve with COOP/COEP so `SharedArrayBuffer` works (e.g. `python serve.py` on localhost:8765).
- Open the page, click the terminal, and type.
