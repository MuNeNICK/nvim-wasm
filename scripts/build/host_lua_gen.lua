#!/usr/bin/env lua
-- Host Lua wrapper used during code generation to force the native (host) Lua
-- + nlua stack even when cross-compiling to wasm.
--
-- Interface:
--   host_lua_gen.lua <preload> <srcdir> <nlua-arg> <gendir> [extra args...]

local function sh_quote(s)
  return "'" .. tostring(s):gsub("'", [['"'"']]) .. "'"
end

local function exec_checked(cmd)
  local ok, why, code = os.execute(cmd)
  if type(ok) == "number" then
    code = ok
    ok = (code == 0)
  elseif ok == true then
    code = 0
  elseif code == nil then
    code = 1
  end
  if not ok then
    error(("command failed (%s): %s"):format(tostring(code), cmd))
  end
end

local function path_exists(path)
  local cmd = "test -e " .. sh_quote(path)
  local ok, _, code = os.execute(cmd)
  if type(ok) == "number" then
    return ok == 0
  end
  return ok == true and (code == 0 or code == nil)
end

local function script_dir()
  local p = arg[0] or ""
  if p:sub(1, 1) == "@" then
    p = p:sub(2)
  end
  return p:match("^(.*)/[^/]+$") or "."
end

local function join(a, b)
  if a:sub(-1) == "/" then
    return a .. b
  end
  return a .. "/" .. b
end

local function resolve_paths()
  local repo_root = join(script_dir(), "../..")
  local host_lua = os.getenv("HOST_LUA_PRG")
  if not host_lua or host_lua == "" then
    local c1 = join(repo_root, "build-host/.deps/usr/bin/lua")
    local c2 = join(repo_root, "build-host/lua-src/src/lua")
    host_lua = path_exists(c1) and c1 or c2
  end

  local host_nlua = os.getenv("HOST_NLUA0")
  if not host_nlua or host_nlua == "" then
    local c1 = join(repo_root, "build-host/libnlua0-host.so")
    local c2 = join(repo_root, "build-host/libnlua0.so")
    host_nlua = path_exists(c1) and c1 or c2
  end
  return host_lua, host_nlua
end

local function usage()
  io.stderr:write("usage: host_lua_gen.lua <preload> <srcdir> <nlua-arg> <gendir> [extra args...]\n")
end

local function main(argv)
  if #argv < 4 then
    usage()
    return 1
  end

  local preload = argv[1]
  local srcdir = argv[2]
  local nlua_arg = argv[3]
  local gendir = argv[4]

  local host_lua, host_nlua = resolve_paths()
  if not host_lua or host_lua == "" or not path_exists(host_lua) then
    io.stderr:write("host Lua not found: " .. tostring(host_lua) .. "\n")
    return 1
  end

  local nlua_path = (host_nlua and host_nlua ~= "" and path_exists(host_nlua)) and host_nlua or nlua_arg

  local parts = {
    sh_quote(host_lua),
    sh_quote(preload),
    sh_quote(srcdir),
    sh_quote(nlua_path),
    sh_quote(gendir),
  }
  for i = 5, #argv do
    parts[#parts + 1] = sh_quote(argv[i])
  end
  exec_checked(table.concat(parts, " "))
  return 0
end

local ok, err = pcall(function()
  os.exit(main(arg))
end)
if not ok then
  io.stderr:write("[host_lua_gen] error: " .. tostring(err) .. "\n")
  os.exit(1)
end
