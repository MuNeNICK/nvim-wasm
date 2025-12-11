#!/usr/bin/env python3
"""
Host Lua wrapper used during code generation to force the native (host) Lua +
nlua stack even when cross-compiling to wasm.

Mirrors the old Bash script interface:
  host-lua-gen.py <preload> <srcdir> <nlua-arg> <gendir> [extra args...]
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


def _resolve_paths() -> tuple[Path, Path]:
    repo_root = Path(__file__).resolve().parents[2]
    host_lua = Path(os.environ.get("HOST_LUA_PRG", repo_root / "build-host/lua-src/src/lua"))
    host_nlua = Path(os.environ.get("HOST_NLUA0", repo_root / "build-host/libnlua0-host.so"))
    return host_lua, host_nlua


def main(argv: list[str]) -> int:
    if len(argv) < 5:
        print("usage: host-lua-gen.py <preload> <srcdir> <nlua-arg> <gendir> [extra args...]", file=sys.stderr)
        return 1

    preload, srcdir, nlua_arg, gendir, *rest = argv[1:]
    host_lua, host_nlua = _resolve_paths()

    if not host_lua.exists():
        print(f"host Lua not found: {host_lua}", file=sys.stderr)
        return 1

    nlua_path = host_nlua if host_nlua.exists() else Path(nlua_arg)
    cmd = [str(host_lua), preload, srcdir, str(nlua_path), gendir, *rest]
    subprocess.run(cmd, check=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
