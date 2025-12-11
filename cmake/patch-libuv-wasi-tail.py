#!/usr/bin/env python3
"""Fix up the WASI stub in libuv by restoring the missing UTF-16/WT-F8 helpers.

Some upstream archives we patch for WASI ship a truncated stub.c. This script
rewrites the tail so the wasm build can proceed.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path


EXTRA_BLOCK = """\
// Extra stubs injected for WASI build (single-threaded, no TLS).
void uv_once(uv_once_t* guard, void (*callback)(void)) {
  if (guard && *guard) {
    return;
  }
  if (callback) {
    callback();
  }
  if (guard) {
    *guard = 1;
  }
}

int uv_key_create(uv_key_t* key) {
  if (key) {
    memset(key, 0, sizeof(*key));
  }
  return 0;
}

void uv_key_delete(uv_key_t* key) {
  UV__UNUSED(key);
}

void* uv_key_get(uv_key_t* key) {
  UV__UNUSED(key);
  return NULL;
}

void uv_key_set(uv_key_t* key, void* value) {
  UV__UNUSED(key);
  UV__UNUSED(value);
}

int uv_gettimeofday(uv_timeval64_t* tv) {
  if (!tv) {
    return UV_EINVAL;
  }
  struct timespec ts;
  if (clock_gettime(CLOCK_REALTIME, &ts) != 0) {
    return -errno;
  }
  tv->tv_sec = ts.tv_sec;
  tv->tv_usec = ts.tv_nsec / 1000;
  return 0;
}

int uv_thread_create(uv_thread_t* tid, uv_thread_cb entry, void* arg) {
  UV__UNUSED(tid);
  UV__UNUSED(entry);
  UV__UNUSED(arg);
  return UV_ENOSYS;
}

int uv_thread_detach(uv_thread_t* tid) {
  UV__UNUSED(tid);
  return UV_ENOSYS;
}

int uv_thread_create_ex(uv_thread_t* tid, const uv_thread_options_t* params, uv_thread_cb entry, void* arg) {
  UV__UNUSED(tid);
  UV__UNUSED(params);
  UV__UNUSED(entry);
  UV__UNUSED(arg);
  return UV_ENOSYS;
}

int uv_thread_setaffinity(uv_thread_t* tid, char* cpumask, char* oldmask, size_t mask_size) {
  UV__UNUSED(tid);
  UV__UNUSED(cpumask);
  UV__UNUSED(oldmask);
  UV__UNUSED(mask_size);
  return UV_ENOSYS;
}

int uv_thread_getaffinity(uv_thread_t* tid, char* cpumask, size_t mask_size) {
  UV__UNUSED(tid);
  UV__UNUSED(cpumask);
  UV__UNUSED(mask_size);
  return UV_ENOSYS;
}

int uv_thread_getcpu(void) {
  return UV_ENOSYS;
}

uv_thread_t uv_thread_self(void) {
  uv_thread_t out; memset(&out, 0, sizeof(out)); return out;
}

int uv_thread_join(uv_thread_t *tid) {
  UV__UNUSED(tid);
  return UV_ENOSYS;
}

int uv_thread_equal(const uv_thread_t* t1, const uv_thread_t* t2) {
  UV__UNUSED(t1);
  UV__UNUSED(t2);
  return UV_ENOSYS;
}

int uv_thread_setname(const char* name) {
  UV__UNUSED(name);
  return UV_ENOSYS;
}

int uv_thread_getname(uv_thread_t* tid, char* name, size_t size) {
  UV__UNUSED(tid);
  UV__UNUSED(name);
  UV__UNUSED(size);
  return UV_ENOSYS;
}

void* uv_loop_get_data(const uv_loop_t* arg0) {
  UV__UNUSED(arg0);
  return NULL;
}

void uv_loop_set_data(uv_loop_t* arg0, void* data) {
  UV__UNUSED(arg0);
  UV__UNUSED(data);
}
"""


def main(argv: list[str]) -> int:
  if len(argv) != 2:
    print("usage: patch-libuv-wasi-tail.py <libuv-source-dir>", file=sys.stderr)
    return 1

  src_dir = Path(argv[1])
  stub = src_dir / "src" / "wasi" / "stub.c"
  if not stub.exists():
    print(f"stub.c not found: {stub}", file=sys.stderr)
    return 1

  snippet = """int uv_utf16_to_wtf8(const uint16_t* utf16, ssize_t utf16_len, char** wtf8_ptr, size_t* wtf8_len_ptr) {
  UV__UNUSED(utf16);
  UV__UNUSED(utf16_len);
  UV__UNUSED(wtf8_ptr);
  UV__UNUSED(wtf8_len_ptr);
  return UV_ENOSYS;
}

ssize_t uv_wtf8_length_as_utf16(const char* wtf8) {
  UV__UNUSED(wtf8);
  return 0;
}

void uv_wtf8_to_utf16(const char* wtf8, uint16_t* utf16, size_t utf16_len) {
  UV__UNUSED(wtf8);
  UV__UNUSED(utf16);
  UV__UNUSED(utf16_len);
}
"""

  text = stub.read_text()
  text = re.sub(r"int uv_utf16_to_wtf8[\s\S]*\Z", snippet, text, flags=re.S)
  if "uv_gettimeofday" not in text or "uv_thread_self" not in text:
    if not text.endswith("\n"):
      text += "\n"
    text += EXTRA_BLOCK
    if "uv_utf16_to_wtf8" not in text:
      text += "\n" + snippet
  stub.write_text(text)
  return 0


if __name__ == "__main__":
  raise SystemExit(main(sys.argv))
