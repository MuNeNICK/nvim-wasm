#!/usr/bin/env lua
-- Emit shared WASI build flags so they live in one place.
--
-- CLI:
--   --field {cflags-common,lua-cflags,ldflags-common,lua-ldflags}
--   [--patch-dir <path>]  [--sysroot <path>] [--eh "<flags>"]

local function script_dir()
  local p = arg[0] or ""
  if p:sub(1, 1) == "@" then
    p = p:sub(2)
  end
  local dir = p:match("^(.*)/[^/]+$") or "."
  return dir
end

local function join(a, b)
  if a:sub(-1) == "/" then
    return a .. b
  end
  return a .. "/" .. b
end

local function usage()
  io.stderr:write([[
usage: wasm_flags.lua --field <name> [--patch-dir <path>] [--sysroot <path>] [--eh "<flags>"]
  field: cflags-common | lua-cflags | ldflags-common | lua-ldflags
]])
end

local function parse_args(argv)
  local out = { eh = "" }
  local i = 1
  while i <= #argv do
    local a = argv[i]
    if a == "--field" or a == "--patch-dir" or a == "--sysroot" or a == "--eh" then
      local v = argv[i + 1]
      if not v then
        error("missing value for " .. a)
      end
      if a == "--patch-dir" then out.patch_dir = v end
      if a == "--sysroot" then out.sysroot = v end
      if a == "--field" then out.field = v end
      if a == "--eh" then out.eh = v end
      i = i + 2
    elseif a == "-h" or a == "--help" then
      out.help = true
      i = i + 1
    else
      error("unknown arg: " .. tostring(a))
    end
  end
  return out
end

local function compute_flags(patch_dir, sysroot, eh_flags)
  local eh_ld = (eh_flags or ""):gsub("%-mllvm%s+%-wasm%-enable%-sjlj", ""):gsub("^%s+", ""):gsub("%s+$", "")
  local cflags_common = (eh_flags or "")
    .. " -D_WASI_EMULATED_SIGNAL -DNDEBUG -DNVIM_LOG_DEBUG"
    .. " -I" .. join(patch_dir, "wasi-shim/include")
    .. " -include " .. join(patch_dir, "wasi-shim/wasi_env_shim.h")
  local lua_cflags = (eh_flags or "")
    .. " -D_WASI_EMULATED_SIGNAL"
    .. " -I" .. join(patch_dir, "wasi-shim/include")
    .. " -include " .. join(patch_dir, "wasi-shim/wasi_env_shim.h")
  local ldflags_common = "--target=wasm32-wasi --sysroot=" .. sysroot .. " " .. eh_ld
    .. " -Wl,--allow-undefined -lwasi-emulated-signal -lsetjmp -Qunused-arguments"
  return {
    ["cflags-common"] = cflags_common,
    ["lua-cflags"] = lua_cflags,
    ["ldflags-common"] = ldflags_common,
    ["lua-ldflags"] = ldflags_common,
  }
end

local function main(argv)
  local args = parse_args(argv)
  if args.help then
    usage()
    return 0
  end
  if not args.field then
    usage()
    return 2
  end

  local repo_root = join(script_dir(), "../..")
  local patch_dir = args.patch_dir or join(repo_root, "patches")
  local sysroot = args.sysroot or join(repo_root, ".toolchains/wasi-sdk/share/wasi-sysroot")
  local flags = compute_flags(patch_dir, sysroot, args.eh or "")
  local out = flags[args.field]
  if not out then
    error("unknown field: " .. tostring(args.field))
  end
  io.stdout:write(out .. "\n")
  return 0
end

local ok, err = pcall(function()
  os.exit(main(arg))
end)
if not ok then
  io.stderr:write("[wasm_flags] error: " .. tostring(err) .. "\n")
  os.exit(1)
end
