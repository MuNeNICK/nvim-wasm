#!/usr/bin/env lua
-- Download and extract toolchain archives idempotently.
--
-- Usage:
--   fetch.lua --url <tarball-url> --archive <path/to/archive.tar.gz> \
--            --dest <extract_dir> --expected <dir_created_by_extract>

local function sh_quote(s)
  return "'" .. tostring(s):gsub("'", [['"'"']]) .. "'"
end

local function exec_checked(cmd)
  io.stdout:write(cmd .. "\n")
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

local function mkdir_p(dir)
  exec_checked("mkdir -p " .. sh_quote(dir))
end

local function dirname(path)
  local d = tostring(path):match("^(.*)/[^/]+$") or ""
  if d == "" then
    return "."
  end
  return d
end

local function parse_args(argv)
  local out = {}
  local i = 1
  while i <= #argv do
    local a = argv[i]
    if a == "--url" or a == "--archive" or a == "--dest" or a == "--expected" then
      local v = argv[i + 1]
      if not v then
        error("missing value for " .. a)
      end
      out[a:sub(3)] = v
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
usage: fetch.lua --url <url> --archive <path> --dest <dir> --expected <path>
]])
end

local function main(argv)
  local args = parse_args(argv)
  if args.help then
    usage()
    return 0
  end
  if not args.url or not args.archive or not args.dest or not args.expected then
    usage()
    return 2
  end

  local archive = args.archive
  local dest = args.dest
  local expected = args.expected

  mkdir_p(dirname(archive))
  if path_exists(archive) then
    io.stdout:write("[fetch] archive already present: " .. archive .. "\n")
  else
    io.stdout:write(("[fetch] downloading %s -> %s\n"):format(args.url, archive))
    exec_checked("curl -L " .. sh_quote(args.url) .. " -o " .. sh_quote(archive))
  end

  if path_exists(expected) then
    io.stdout:write("[fetch] extract skipped (found " .. expected .. ")\n")
  else
    io.stdout:write(("[fetch] extracting %s -> %s\n"):format(archive, dest))
    mkdir_p(dest)
    exec_checked("tar -C " .. sh_quote(dest) .. " -xf " .. sh_quote(archive))
  end
  return 0
end

local ok, err = pcall(function()
  os.exit(main(arg))
end)
if not ok then
  io.stderr:write("[fetch] error: " .. tostring(err) .. "\n")
  os.exit(1)
end
