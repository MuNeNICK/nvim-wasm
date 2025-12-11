#!/usr/bin/env python3
"""
Download and extract toolchain archives idempotently.

Usage:
  fetch.py --url <tarball-url> --archive <path/to/archive.tar.gz> \
           --dest <extract_dir> --expected <dir_created_by_extract>
"""

from __future__ import annotations

import argparse
import sys
import tarfile
import urllib.request
from pathlib import Path


def _parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Fetch and extract toolchain archive")
    p.add_argument("--url", required=True, help="URL to download")
    p.add_argument("--archive", required=True, help="Local archive path")
    p.add_argument("--dest", required=True, help="Directory to extract into")
    p.add_argument("--expected", required=True, help="Directory that should exist after extraction")
    return p.parse_args(argv[1:])


def _download(url: str, archive: Path) -> None:
    archive.parent.mkdir(parents=True, exist_ok=True)
    if archive.exists():
        print(f"[fetch] archive already present: {archive}")
        return
    print(f"[fetch] downloading {url} -> {archive}")
    with urllib.request.urlopen(url) as resp, archive.open("wb") as out:
        chunk = resp.read(8192)
        while chunk:
            out.write(chunk)
            chunk = resp.read(8192)


def _extract(archive: Path, dest: Path, expected: Path) -> None:
    if expected.exists():
        print(f"[fetch] extract skipped (found {expected})")
        return
    print(f"[fetch] extracting {archive} -> {dest}")
    dest.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive, "r:*") as tar:
        tar.extractall(dest)


def main(argv: list[str]) -> int:
    args = _parse_args(argv)
    archive = Path(args.archive)
    dest = Path(args.dest)
    expected = Path(args.expected)

    _download(args.url, archive)
    _extract(archive, dest, expected)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
