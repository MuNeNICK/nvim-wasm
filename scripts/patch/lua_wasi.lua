#!/usr/bin/env lua
-- Patch the bundled Lua (PUC 5.1) tree for WASI without touching upstream sources.

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

local function split_lines(s)
  local out = {}
  s = s:gsub("\r\n", "\n")
  for line in (s .. "\n"):gmatch("(.-)\n") do
    out[#out + 1] = line
  end
  return out
end

local function join_lines(lines)
  return table.concat(lines, "\n") .. "\n"
end

local function replace_make_var(lines, key, value)
  local prefix = key .. "%s*="
  for i = 1, #lines do
    if lines[i]:match("^" .. prefix) then
      lines[i] = key .. " = " .. value
      return true
    end
  end
  return false
end

local function rewrite_lua_src_makefile(src_dir, cc, cflags, ldflags)
  local mf = src_dir .. "/src/Makefile"
  local text = readfile(mf)
  local lines = split_lines(text)
  local lua_cflags = (cflags or "") .. " -O2 -g3 -fPIC -DLUA_TMPNAMBUFSIZE=32 -D_WASI_EMULATED_PROCESS_CLOCKS"

  replace_make_var(lines, "CC", cc)
  replace_make_var(lines, "CFLAGS", lua_cflags)
  replace_make_var(lines, "MYCFLAGS", lua_cflags)
  if ldflags and ldflags ~= "" then
    replace_make_var(lines, "MYLDFLAGS", ldflags)
    replace_make_var(lines, "MYLIBS", ldflags)
  end

  replace_make_var(lines, "ALL_T", "$(LUA_A)")
  writefile(mf, join_lines(lines))
end

local function rewrite_lua_root_makefile(src_dir)
  local mf = src_dir .. "/Makefile"
  local lines = split_lines(readfile(mf))

  for i = 1, #lines do
    if lines[i]:match("^TO_BIN%s*=") then lines[i] = "TO_BIN =" end
    if lines[i]:match("^TO_MAN%s*=") then lines[i] = "TO_MAN =" end
  end

  local start = nil
  for i = 1, #lines do
    if lines[i] == "install: dummy" then
      start = i
      break
    end
  end

  if start then
    local stop = #lines + 1
    for i = start + 1, #lines do
      if lines[i]:match("^[%w_][%w_%-]*:") then
        stop = i
        break
      end
    end
    local repl = {
      "install: dummy",
      "\tcd src && $(MKDIR) $(INSTALL_INC) $(INSTALL_LIB) $(INSTALL_LMOD) $(INSTALL_CMOD)",
      "\tcd src && $(INSTALL_DATA) $(TO_INC) $(INSTALL_INC)",
      "\tcd src && $(INSTALL_DATA) $(TO_LIB) $(INSTALL_LIB)",
    }
    local out = {}
    for i = 1, start - 1 do out[#out + 1] = lines[i] end
    for i = 1, #repl do out[#out + 1] = repl[i] end
    for i = stop, #lines do out[#out + 1] = lines[i] end
    lines = out
  end

  writefile(mf, join_lines(lines))
end

local function rewrite_luaconf(src_dir, install_dir)
  local cfg = src_dir .. "/src/luaconf.h"
  local lines = split_lines(readfile(cfg))
  local out = {}
  for i = 1, #lines do
    local l = lines[i]
    if l:match("^#define%s+LUA_USE_READLINE") then
      -- drop
    else
      l = l:gsub('^#define%s+LUA_ROOT%s+".-"', '#define LUA_ROOT "' .. install_dir .. '"')
      l = l:gsub("^#define%s+LUA_TMPNAMBUFSIZE.*$", "#define LUA_TMPNAMBUFSIZE 32")
      l = l:gsub("^#define%s+lua_tmpnam%([^)]*%)%s+.*$", "#define lua_tmpnam(b,e) { e = 1; }")
      out[#out + 1] = l
    end
  end
  writefile(cfg, join_lines(out))
end

local function replace_c_function(text, signature, replacement)
  local start = text:find(signature, 1, true)
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

local function patch_loslib(src_dir)
  local p = src_dir .. "/src/loslib.c"
  local text = readfile(p)
  local repl = 'static int os_execute (lua_State *L) {\n'
    .. '  return luaL_error(L, "os.execute is not supported on WASI");\n'
    .. '}\n'
  local out, ok = replace_c_function(text, "static int os_execute", repl)
  if ok then writefile(p, out) end
end

local function patch_liolib(src_dir)
  local p = src_dir .. "/src/liolib.c"
  local text = readfile(p)
  local repl = 'static int io_tmpfile (lua_State *L) {\n'
    .. '  return luaL_error(L, "io.tmpfile is not supported on WASI");\n'
    .. '}\n'
  local out, ok = replace_c_function(text, "static int io_tmpfile", repl)
  if ok then writefile(p, out) end
end

local function patch_lua_cli(src_dir)
  local p = src_dir .. "/src/lua.c"
  local text = readfile(p)
  local guard = "#if defined(__wasi__)\n#define signal(a,b) ((void)0)\n#endif\n"
  if not text:find(guard, 1, true) then
    local needle = "#include <signal.h>\n"
    local idx = text:find(needle, 1, true)
    if idx then
      text = text:gsub(needle, needle .. guard, 1)
      writefile(p, text)
    end
  end
end

local function parse_args(argv)
  local out = { cflags = "", ldflags = "" }
  local i = 1
  while i <= #argv do
    local a = argv[i]
    if a == "--build-dir" or a == "--install-dir" or a == "--cc" or a == "--cflags" or a == "--ldflags" or a == "--src" then
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
  io.stderr:write([[
usage: lua_wasi.lua --build-dir <dir> --install-dir <dir> --cc "<cc>" [--cflags "<cflags>"] [--ldflags "<ldflags>"] [--src <dir>]
]])
end

local function main(argv)
  local args = parse_args(argv)
  if args.help then
    usage()
    return 0
  end

  local build_dir = args.build_dir or os.getenv("DEPS_BUILD_DIR") or ""
  local install_dir = args.install_dir or os.getenv("DEPS_INSTALL_DIR") or ""
  local cc = args.cc or os.getenv("LUA_WASM_CC") or ""
  local cflags = args.cflags ~= "" and args.cflags or (os.getenv("LUA_WASM_CFLAGS") or "")
  local ldflags = args.ldflags ~= "" and args.ldflags or (os.getenv("LUA_WASM_LDFLAGS") or "")

  if build_dir == "" then error("build dir not provided (use --build-dir or DEPS_BUILD_DIR)") end
  if install_dir == "" then error("install dir not provided (use --install-dir or DEPS_INSTALL_DIR)") end
  if cc == "" then error("compiler not provided (use --cc or LUA_WASM_CC)") end

  local src_dir = args.src or (build_dir .. "/src/lua")
  rewrite_lua_src_makefile(src_dir, cc, cflags, ldflags)
  rewrite_lua_root_makefile(src_dir)
  rewrite_luaconf(src_dir, install_dir)
  patch_loslib(src_dir)
  patch_liolib(src_dir)
  patch_lua_cli(src_dir)
  return 0
end

local ok, err = pcall(function()
  os.exit(main(arg))
end)
if not ok then
  io.stderr:write("[lua_wasi] error: " .. tostring(err) .. "\n")
  os.exit(1)
end
