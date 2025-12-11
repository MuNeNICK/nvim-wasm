#!/usr/bin/env python3
"""
Patch the bundled Lua (PUC 5.1) tree for WASI without touching the upstream
Neovim submodule.

Expected environment variables (set by cmake/wasm-overrides.cmake):
  DEPS_BUILD_DIR    - deps build root (contains src/lua)
  DEPS_INSTALL_DIR  - deps install prefix
  LUA_WASM_CC       - compiler path
  LUA_WASM_CFLAGS   - compiler flags to apply
  LUA_WASM_LDFLAGS  - linker flags to apply (used for MYLIBS/MYLDFLAGS)
"""

from __future__ import annotations

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


def main() -> int:
    env = os.environ
    build_dir = Path(env["DEPS_BUILD_DIR"])
    install_dir = env["DEPS_INSTALL_DIR"]
    cc = env["LUA_WASM_CC"]
    cflags = env.get("LUA_WASM_CFLAGS", "")
    ldflags = env.get("LUA_WASM_LDFLAGS", "")

    src_dir = build_dir / "src/lua"
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
    sys.exit(main())
