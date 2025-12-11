#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDK="$ROOT/.toolchains/wasi-sdk-29.0-x86_64-linux"
CMAKE="$ROOT/.toolchains/cmake-3.29.6-linux-x86_64/bin/cmake"
HOST_LUA="$ROOT/build-host/lua-src/src/lua"
HOST_LUA_GEN="$ROOT/cmake/host-lua-gen.sh"

export WASI_SDK_ROOT="$SDK"

CFLAGS="-O0 -fwasm-exceptions -fexceptions -funwind-tables -mllvm -wasm-enable-sjlj -D_WASI_EMULATED_SIGNAL -DNDEBUG -I$ROOT/patches/wasi-shim/include -include $ROOT/patches/wasi-shim/wasi_env_shim.h"
LDFLAGS="--target=wasm32-wasi --sysroot=$SDK/share/wasi-sysroot -Wl,--allow-undefined -lwasi-emulated-signal -lsetjmp"

echo "[info] configuring build-wasm (Debug, -O0, no threads)"
rm -rf "$ROOT/build-wasm"
CMAKE_BUILD_PARALLEL_LEVEL=1 MAKEFLAGS=-j1 "$CMAKE" -S "$ROOT/neovim" -B "$ROOT/build-wasm" \
  -DCMAKE_PROJECT_INCLUDE="$ROOT/cmake/wasm-overrides.cmake" \
  -DCMAKE_TOOLCHAIN_FILE="$ROOT/cmake/toolchain-wasi.cmake" \
  -DWASI_SDK_ROOT="$SDK" \
  -DCMAKE_BUILD_TYPE=Debug \
  -DCMAKE_C_FLAGS="$CFLAGS" \
  -DCMAKE_EXE_LINKER_FLAGS="$LDFLAGS" \
  -DCMAKE_SHARED_LINKER_FLAGS="$LDFLAGS" \
  -DICONV_INCLUDE_DIR="$ROOT/patches/wasi-shim/include" \
  -DICONV_LIBRARY="$ROOT/patches/wasi-shim/lib/libiconv.a" \
  -DLIBINTL_INCLUDE_DIR="$ROOT/patches/wasi-shim/include" \
  -DLIBINTL_LIBRARY="$ROOT/patches/wasi-shim/lib/libintl.a" \
  -DCMAKE_PREFIX_PATH="$ROOT/build-wasm-deps/usr" \
  -DLUA_LIBRARY="$ROOT/build-wasm-deps/usr/lib/liblua.a" \
  -DLUA_INCLUDE_DIR="$ROOT/build-wasm-deps/usr/include" \
  -DLPEG_LIBRARY="$ROOT/build-wasm-deps/usr/lib/liblpeg.a" \
  -DLPEG_INCLUDE_DIR="$ROOT/build-wasm-deps/usr/include" \
  -DLUV_LIBRARY="$ROOT/build-wasm-deps/usr/lib/libluv.a" \
  -DLUV_INCLUDE_DIR="$ROOT/build-wasm-deps/usr/include" \
  -DLIBUV_LIBRARY="$ROOT/build-wasm-deps/usr/lib/libuv.a" \
  -DLIBUV_INCLUDE_DIR="$ROOT/build-wasm-deps/usr/include" \
  -DUNIBILIUM_LIBRARY="$ROOT/build-wasm-deps/usr/lib/libunibilium.a" \
  -DUNIBILIUM_INCLUDE_DIR="$ROOT/build-wasm-deps/usr/include" \
  -DUTF8PROC_LIBRARY="$ROOT/build-wasm-deps/usr/lib/libutf8proc.a" \
  -DUTF8PROC_INCLUDE_DIR="$ROOT/build-wasm-deps/usr/include" \
  -DTREESITTER_LIBRARY="$ROOT/build-wasm-deps/usr/lib/libtree-sitter.a" \
  -DTREESITTER_INCLUDE_DIR="$ROOT/build-wasm-deps/usr/include" \
  -DUSE_BUNDLED_LUAJIT=OFF -DPREFER_LUA=ON -DUSE_BUNDLED_LUA=OFF -DUSE_BUNDLED_LUV=OFF -DUSE_BUNDLED_LIBUV=OFF \
  -DLUA_PRG="$HOST_LUA" -DLUA_EXECUTABLE="$HOST_LUA" -DLUA_GEN_PRG="$HOST_LUA_GEN" -DLUAC_PRG=

echo "[info] building nvim_bin (low parallelism)"
CMAKE_BUILD_JOBS=1 CMAKE_BUILD_PARALLEL_LEVEL=1 MAKEFLAGS=-j1 \
  "$CMAKE" --build "$ROOT/build-wasm" --target nvim_bin -- -j1 VERBOSE=1

echo "[info] done"
