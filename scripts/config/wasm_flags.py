#!/usr/bin/env python3
"""
Emit shared WASI build flags so they live in one place.

CLI:
  --field {cflags-common,lua-cflags,ldflags-common,lua-ldflags}
  [--patch-dir <path>]  [--sysroot <path>] [--eh "<flags>"]

As a module, use compute_flags(patch_dir, sysroot, eh_flags) -> dict.
"""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Dict


def compute_flags(patch_dir: Path, sysroot: Path, eh_flags: str) -> Dict[str, str]:
    patch_dir = patch_dir.resolve()
    # Link step does not consume "-mllvm -wasm-enable-sjlj"; drop them to avoid
    # clang's "argument unused during compilation" warning.
    eh_ld = eh_flags.replace("-mllvm -wasm-enable-sjlj", "").strip()
    cflags_common = (
        f"{eh_flags} -D_WASI_EMULATED_SIGNAL -DNDEBUG -DNVIM_LOG_DEBUG "
        f"-I{patch_dir}/wasi-shim/include -include {patch_dir}/wasi-shim/wasi_env_shim.h"
    )
    lua_cflags = (
        f"{eh_flags} -D_WASI_EMULATED_SIGNAL "
        f"-I{patch_dir}/wasi-shim/include -include {patch_dir}/wasi-shim/wasi_env_shim.h"
    )
    ldflags_common = (
        f"--target=wasm32-wasi --sysroot={sysroot} {eh_ld} "
        "-Wl,--allow-undefined -lwasi-emulated-signal -lsetjmp -Qunused-arguments"
    )
    lua_ldflags = ldflags_common
    return {
        "cflags-common": cflags_common,
        "lua-cflags": lua_cflags,
        "ldflags-common": ldflags_common,
        "lua-ldflags": lua_ldflags,
    }


def _parse_args(argv):
    parser = argparse.ArgumentParser(description="Emit WASI flag presets")
    parser.add_argument("--field", required=True, choices=["cflags-common", "lua-cflags", "ldflags-common", "lua-ldflags"])
    parser.add_argument("--patch-dir", default=None, help="Path to patches (default: repo_root/patches)")
    parser.add_argument("--sysroot", default=None, help="WASI sysroot path (required for ldflags)")
    parser.add_argument("--eh", default="", help="Exception/unwind flags to prepend")
    return parser.parse_args(argv[1:])


def main(argv) -> int:
    args = _parse_args(argv)
    repo_root = Path(__file__).resolve().parents[2]
    patch_dir = Path(args.patch_dir) if args.patch_dir else repo_root / "patches"
    sysroot = Path(args.sysroot) if args.sysroot else repo_root / ".toolchains" / "wasi-sdk" / "share" / "wasi-sysroot"
    flags = compute_flags(patch_dir, sysroot, args.eh)
    print(flags[args.field])
    return 0


if __name__ == "__main__":
    import sys
    raise SystemExit(main(sys.argv))
