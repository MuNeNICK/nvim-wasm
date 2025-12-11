#!/usr/bin/env bash
set -euo pipefail

# Wrapper used during code generation to force a native (host) Lua +
# nlua0/mpack/lpeg stack even when cross-compiling to wasm.
preload="$1"; shift
srcdir="$1"; shift
nlua_arg="$1"; shift
gendir="$1"; shift

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
host_lua="${HOST_LUA_PRG:-${root_dir}/build-host/lua-src/src/lua}"
host_nlua="${HOST_NLUA0:-${root_dir}/build-host/libnlua0-host.so}"

if [[ ! -x "${host_lua}" ]]; then
  echo "host Lua not found: ${host_lua}" >&2
  exit 1
fi

# Prefer the native nlua0 we built for the host; fall back to the argument if
# it is missing so the wrapper behaves like the original command.
nlua_path="${host_nlua}"
if [[ ! -f "${nlua_path}" ]]; then
  nlua_path="${nlua_arg}"
fi

exec "${host_lua}" "${preload}" "${srcdir}" "${nlua_path}" "${gendir}" "$@"
