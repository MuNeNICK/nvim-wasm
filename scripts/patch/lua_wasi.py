#!/usr/bin/env python3
"""
Patch the bundled Lua (PUC 5.1) tree for WASI without touching the upstream
Neovim submodule.

CLI (env vars allowed as fallback for compatibility):
  --build-dir /path/to/deps/build
  --install-dir /path/to/deps/prefix
  --cc <compiler>
  --cflags "<cflags>"
  --ldflags "<ldflags>"
  [--src /path/to/lua/src/root]  # defaults to <build-dir>/src/lua
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path


def _rewrite_makefile(src_dir: Path, cc: str, cflags: str, ldflags: str) -> None:
    mf = src_dir / "src/Makefile"
    text = mf.read_text()

    lua_cflags = f"{cflags} -O2 -g3 -fPIC -DLUA_TMPNAMBUFSIZE=32 -D_WASI_EMULATED_PROCESS_CLOCKS"

    text = re.sub(r"^(CC\s*=).*$", rf"\1 {cc}", text, flags=re.M)
    text = re.sub(r"^(CFLAGS\s*=).*$", rf"\1 {lua_cflags}", text, flags=re.M)
    text = re.sub(r"^(MYCFLAGS\s*=).*$", rf"\1 {lua_cflags}", text, flags=re.M)
    if ldflags:
        text = re.sub(r"^(MYLDFLAGS\s*=).*$", rf"\1 {ldflags}", text, flags=re.M)
        text = re.sub(r"^(MYLIBS\s*=).*$", rf"\1 {ldflags}", text, flags=re.M)

    # Only build the static library; skip lua/luac executables which would fail to link on WASI.
    text = re.sub(r"^(ALL_T\s*=).*$", r"\1 $(LUA_A)", text, flags=re.M)
    mf.write_text(text)


def _rewrite_root_makefile(src_dir: Path) -> None:
    mf = src_dir / "Makefile"
    text = mf.read_text()
    text = re.sub(r"^(TO_BIN\s*=).*$", r"\1", text, flags=re.M)
    text = re.sub(r"^(TO_MAN\s*=).*$", r"\1", text, flags=re.M)
    text = re.sub(
        r"(?ms)^install: dummy\n.*?(?=^\w)",
        "install: dummy\n"
        "\tcd src && $(MKDIR) $(INSTALL_INC) $(INSTALL_LIB) $(INSTALL_LMOD) $(INSTALL_CMOD)\n"
        "\tcd src && $(INSTALL_DATA) $(TO_INC) $(INSTALL_INC)\n"
        "\tcd src && $(INSTALL_DATA) $(TO_LIB) $(INSTALL_LIB)\n",
        text,
    )
    mf.write_text(text)


def _rewrite_luaconf(src_dir: Path, install_dir: str) -> None:
    cfg = src_dir / "src/luaconf.h"
    text = cfg.read_text()
    text = re.sub(r"^#define LUA_USE_READLINE.*\n", "", text, flags=re.M)
    text = re.sub(r'^#define LUA_ROOT[ \t]*".*?"', f'#define LUA_ROOT "{install_dir}"', text, flags=re.M)
    text = re.sub(r"^#define LUA_TMPNAMBUFSIZE.*", "#define LUA_TMPNAMBUFSIZE 32", text, flags=re.M)
    text = re.sub(r"^#define lua_tmpnam\(b,e\).*", "#define lua_tmpnam(b,e) { e = 1; }", text, flags=re.M)
    cfg.write_text(text)


def _patch_loslib(src_dir: Path) -> None:
    path = src_dir / "src/loslib.c"
    text = path.read_text()
    text = re.sub(
        r"static int os_execute .*?return 1;\s*}\n",
        'static int os_execute (lua_State *L) {\n'
        '  return luaL_error(L, "os.execute is not supported on WASI");\n'
        "}\n",
        text,
        flags=re.S,
    )
    path.write_text(text)


def _patch_liolib(src_dir: Path) -> None:
    path = src_dir / "src/liolib.c"
    text = path.read_text()
    text = re.sub(
        r"static int io_tmpfile \(lua_State \*L\) \{.*?\n}\n",
        'static int io_tmpfile (lua_State *L) {\n'
        '  return luaL_error(L, "io.tmpfile is not supported on WASI");\n'
        "}\n",
        text,
        flags=re.S,
    )
    path.write_text(text)


def _patch_lua_cli(src_dir: Path) -> None:
    path = src_dir / "src/lua.c"
    text = path.read_text()
    guard = "#if defined(__wasi__)\n#define signal(a,b) ((void)0)\n#endif\n"
    if guard not in text:
        text = text.replace("#include <signal.h>\n", f"#include <signal.h>\n{guard}", 1)
    path.write_text(text)


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Patch Lua sources for WASI")
    parser.add_argument("--build-dir", help="deps build root (contains src/lua)")
    parser.add_argument("--install-dir", help="deps install prefix")
    parser.add_argument("--cc", help="compiler path")
    parser.add_argument("--cflags", default="", help="compiler flags to apply")
    parser.add_argument("--ldflags", default="", help="linker flags to apply")
    parser.add_argument("--src", help="Lua source dir (defaults to <build-dir>/src/lua)")
    return parser.parse_args(argv[1:])


def main(argv: list[str]) -> int:
    args = _parse_args(argv)
    env = os.environ

    build_dir = Path(args.build_dir or env.get("DEPS_BUILD_DIR", ""))
    install_dir = args.install_dir or env.get("DEPS_INSTALL_DIR", "")
    cc = args.cc or env.get("LUA_WASM_CC", "")
    cflags = args.cflags or env.get("LUA_WASM_CFLAGS", "")
    ldflags = args.ldflags or env.get("LUA_WASM_LDFLAGS", "")

    if not build_dir:
        raise SystemExit("build dir not provided (use --build-dir or DEPS_BUILD_DIR)")
    if not install_dir:
        raise SystemExit("install dir not provided (use --install-dir or DEPS_INSTALL_DIR)")
    if not cc:
        raise SystemExit("compiler not provided (use --cc or LUA_WASM_CC)")

    src_dir = Path(args.src) if args.src else build_dir / "src" / "lua"
    if not src_dir.exists():
        raise SystemExit(f"Lua source dir not found: {src_dir}")

    _rewrite_makefile(src_dir, cc, cflags, ldflags)
    _rewrite_root_makefile(src_dir)
    _rewrite_luaconf(src_dir, install_dir)
    _patch_loslib(src_dir)
    _patch_liolib(src_dir)
    _patch_lua_cli(src_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
