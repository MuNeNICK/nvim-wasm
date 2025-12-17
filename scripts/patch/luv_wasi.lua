#!/usr/bin/env lua
-- Patch luv for WASI without touching upstream sources.

local function readfile(p)
  local f = assert(io.open(p, "rb"))
  local s = f:read("*a")
  f:close()
  return s
end

local function writefile(p, s)
  local f = assert(io.open(p, "wb"))
  f:write(s)
  f:close()
end

local function parse_args(argv)
  local out = {}
  local i = 1
  while i <= #argv do
    local a = argv[i]
    if a == "--build-dir" or a == "--src" then
      local v = argv[i + 1]
      if not v then error("missing value for " .. a) end
      out[a:sub(3):gsub("%-", "_")] = v
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

local function usage()
  io.stderr:write("usage: luv_wasi.lua --build-dir <dir> [--src <dir>]\n")
end

local function replace_c_function(text, name, replacement)
  local start = text:find(name, 1, true)
  if not start then
    return text, false
  end

  local brace_start = text:find("{", start, true)
  if not brace_start then
    return text, false
  end

  local i = brace_start
  local depth = 0
  local in_string = nil
  local in_line_comment = false
  local in_block_comment = false

  while i <= #text do
    local c = text:sub(i, i)
    local two = text:sub(i, i + 1)

    if in_line_comment then
      if c == "\n" then
        in_line_comment = false
      end
      i = i + 1
    elseif in_block_comment then
      if two == "*/" then
        in_block_comment = false
        i = i + 2
      else
        i = i + 1
      end
    elseif in_string then
      if c == "\\" then
        i = i + 2
      elseif c == in_string then
        in_string = nil
        i = i + 1
      else
        i = i + 1
      end
    else
      if two == "//" then
        in_line_comment = true
        i = i + 2
      elseif two == "/*" then
        in_block_comment = true
        i = i + 2
      elseif c == "\"" or c == "'" then
        in_string = c
        i = i + 1
      elseif c == "{" then
        depth = depth + 1
        i = i + 1
      elseif c == "}" then
        depth = depth - 1
        i = i + 1
        if depth == 0 then
          local end_pos = i - 1
          if text:sub(i, i) == "\n" then
            end_pos = i
          end
          local new_text = text:sub(1, start - 1) .. replacement .. text:sub(end_pos + 1)
          return new_text, true
        end
      else
        i = i + 1
      end
    end
  end

  return text, false
end

local function patch_luv_h(src_dir)
  local p = src_dir .. "/src/luv.h"
  local text = readfile(p)
  local guard = "#if defined(__wasi__)\n#define _WASI_EMULATED_SIGNAL 1\n#endif\n"
  local needle = '#include "uv.h"\n'
  if not text:find(guard, 1, true) then
    text = text:gsub(needle, guard .. needle, 1)
    writefile(p, text)
  end
end

local function patch_constants(src_dir)
  local p = src_dir .. "/src/constants.c"
  local text = readfile(p)
  local r1 = "static int luv_proto_string_to_num(const char* string) {\n  (void)string;\n  return -1;\n}\n\n"
  local r2 = "static const char* luv_proto_num_to_string(int num) {\n  (void)num;\n  return NULL;\n}\n\n"
  local out, ok1 = replace_c_function(text, "static int luv_proto_string_to_num", r1)
  out, _ = replace_c_function(out, "static const char* luv_proto_num_to_string", r2)
  if ok1 then writefile(p, out) end
end

local function patch_misc(src_dir)
  local p = src_dir .. "/src/misc.c"
  local text = readfile(p)
  local replacements = {
    ["static int luv_getuid"] = "static int luv_getuid(lua_State* L){ return luv_error(L, UV_ENOSYS); }\n\n",
    ["static int luv_getgid"] = "static int luv_getgid(lua_State* L){ return luv_error(L, UV_ENOSYS); }\n\n",
    ["static int luv_setuid"] = "static int luv_setuid(lua_State* L){ return luv_error(L, UV_ENOSYS); }\n\n",
    ["static int luv_setgid"] = "static int luv_setgid(lua_State* L){ return luv_error(L, UV_ENOSYS); }\n\n",
  }
  local changed = false
  for name, repl in pairs(replacements) do
    local out, ok = replace_c_function(text, name, repl)
    if ok then
      text = out
      changed = true
    end
  end
  if changed then writefile(p, text) end
end

local function patch_work(src_dir)
  local p = src_dir .. "/src/work.c"
  local text = readfile(p)
  local repl = "static int luv_queue_work(lua_State* L) {\n  (void)L;\n  return luv_error(L, UV_ENOSYS);\n}\n\n"
  local out, ok = replace_c_function(text, "static int luv_queue_work", repl)
  if ok then writefile(p, out) end
end

local function patch_dns(src_dir)
  local p = src_dir .. "/src/dns.c"
  writefile(p,
    "/* WASI stub: DNS resolution is not available. */\n"
    .. "#include \"private.h\"\n\n"
    .. "int luv_getaddrinfo(lua_State* L) { return luv_error(L, UV_ENOSYS); }\n"
    .. "int luv_getnameinfo(lua_State* L) { return luv_error(L, UV_ENOSYS); }\n")
end

local function main(argv)
  local args = parse_args(argv)
  if args.help then
    usage()
    return 0
  end
  local build_dir = args.build_dir or os.getenv("DEPS_BUILD_DIR") or ""
  if build_dir == "" then
    error("build dir not provided (use --build-dir or DEPS_BUILD_DIR)")
  end
  local src_dir = args.src or (build_dir .. "/src/luv")
  patch_luv_h(src_dir)
  patch_constants(src_dir)
  patch_misc(src_dir)
  patch_work(src_dir)
  patch_dns(src_dir)
  return 0
end

local ok, err = pcall(function()
  os.exit(main(arg))
end)
if not ok then
  io.stderr:write("[luv_wasi] error: " .. tostring(err) .. "\n")
  os.exit(1)
end
