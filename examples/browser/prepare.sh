#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BUILD_DIR="$REPO_ROOT/build-wasm"
RUNTIME_SRC="$REPO_ROOT/neovim/runtime"
PUBLIC_DIR="$SCRIPT_DIR/public"

if [ ! -f "$BUILD_DIR/bin/nvim" ]; then
  echo "Missing wasm binary at $BUILD_DIR/bin/nvim."
  echo "Run 'make wasm' first so the demo has something to load."
  exit 1
fi

mkdir -p "$PUBLIC_DIR"

echo "Copying nvim.wasm -> $PUBLIC_DIR"
cp "$BUILD_DIR/bin/nvim" "$PUBLIC_DIR/nvim.wasm"

echo "Packing runtime payload -> $PUBLIC_DIR/nvim-runtime.tar.gz"
rm -f "$PUBLIC_DIR/nvim-runtime.tar.gz"

EXTRA_FILES=()
if [ -f "$BUILD_DIR/nlua0.lua" ]; then
  EXTRA_FILES+=("nlua0.lua")
else
  echo "note: $BUILD_DIR/nlua0.lua not found; skipping (only needed if present)."
fi

# Pack runtime from source tree (scripts), plus wasm-built deps under usr.
tar -czf "$PUBLIC_DIR/nvim-runtime.tar.gz" \
  -C "$RUNTIME_SRC/.." runtime \
  -C "$BUILD_DIR" usr nvim_version.lua "${EXTRA_FILES[@]}"

echo "Done. Serve $PUBLIC_DIR with any static server (e.g. python -m http.server)."
