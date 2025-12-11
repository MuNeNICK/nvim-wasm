#!/usr/bin/env python3
"""
Patch luv for WASI without touching the Neovim submodule sources.
"""

from __future__ import annotations

import os
import re
from pathlib import Path


def _patch_luv_h(src_dir: Path) -> None:
    path = src_dir / "src/luv.h"
    text = path.read_text()
    guard = "#if defined(__wasi__)\n#define _WASI_EMULATED_SIGNAL 1\n#endif\n"
    needle = '#include "uv.h"\n'
    if guard not in text:
        text = text.replace(needle, guard + needle, 1)
        path.write_text(text)


def _patch_constants(src_dir: Path) -> None:
    path = src_dir / "src/constants.c"
    text = path.read_text()
    text = re.sub(
        r"static int luv_proto_string_to_num\(.*?\n}\n",
        "static int luv_proto_string_to_num(const char* string) {\n"
        "  (void)string;\n"
        "  return -1;\n"
        "}\n\n",
        text,
        flags=re.S,
    )
    text = re.sub(
        r"static const char\* luv_proto_num_to_string\(.*?\n}\n",
        "static const char* luv_proto_num_to_string(int num) {\n"
        "  (void)num;\n"
        "  return NULL;\n"
        "}\n\n",
        text,
        flags=re.S,
    )
    path.write_text(text)


def _patch_misc(src_dir: Path) -> None:
    path = src_dir / "src/misc.c"
    text = path.read_text()
    replacements = {
        r"static int luv_getuid\(lua_State\* L\)\s*\{.*?\n}\n":
            'static int luv_getuid(lua_State* L){ return luv_error(L, UV_ENOSYS); }\n\n',
        r"static int luv_getgid\(lua_State\* L\)\s*\{.*?\n}\n":
            'static int luv_getgid(lua_State* L){ return luv_error(L, UV_ENOSYS); }\n\n',
        r"static int luv_setuid\(lua_State\* L\)\s*\{.*?\n}\n":
            'static int luv_setuid(lua_State* L){ return luv_error(L, UV_ENOSYS); }\n\n',
        r"static int luv_setgid\(lua_State\* L\)\s*\{.*?\n}\n":
            'static int luv_setgid(lua_State* L){ return luv_error(L, UV_ENOSYS); }\n\n',
    }
    for pattern, repl in replacements.items():
        text = re.sub(pattern, repl, text, flags=re.S)
    path.write_text(text)


def _patch_work(src_dir: Path) -> None:
    path = src_dir / "src/work.c"
    text = path.read_text()
    text = re.sub(
        r"static int luv_queue_work\(lua_State\* L\)\s*\{.*?\n}\n",
        "static int luv_queue_work(lua_State* L) {\n"
        "  (void)L;\n"
        "  return luv_error(L, UV_ENOSYS);\n"
        "}\n\n",
        text,
        flags=re.S,
    )
    path.write_text(text)


def _patch_dns(src_dir: Path) -> None:
    path = src_dir / "src/dns.c"
    path.write_text(
        "/* WASI stub: DNS resolution is not available. */\n"
        "#include \"private.h\"\n\n"
        "int luv_getaddrinfo(lua_State* L) { return luv_error(L, UV_ENOSYS); }\n"
        "int luv_getnameinfo(lua_State* L) { return luv_error(L, UV_ENOSYS); }\n"
    )


def main() -> int:
    build_dir = Path(os.environ["DEPS_BUILD_DIR"])
    src_dir = build_dir / "src/luv"
    if not src_dir.exists():
        raise SystemExit(f"luv source dir not found: {src_dir}")

    _patch_luv_h(src_dir)
    _patch_constants(src_dir)
    _patch_misc(src_dir)
    _patch_work(src_dir)
    _patch_dns(src_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
