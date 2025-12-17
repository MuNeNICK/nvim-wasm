# Shared hooks for cmake.deps: patch bundled deps for WASI.

if(NOT DEFINED _nvim_wrap_root)
  message(FATAL_ERROR "_nvim_wrap_root must be set before including wasm-patch-hooks.cmake")
endif()

include(ExternalProject)

find_program(NVIM_WASM_LUA_PRG NAMES luajit lua5.1 lua)
if(NOT NVIM_WASM_LUA_PRG)
  message(FATAL_ERROR "Lua interpreter not found (need luajit or lua) for WASI patch scripts")
endif()

function(_nvim_wasm_forward_sysdeps)
  set(_prefix "${_nvim_wrap_root}/build-wasm-deps/usr")
  list(APPEND DEPS_CMAKE_ARGS
    "-DCMAKE_PREFIX_PATH=${_prefix}"
    "-DLUA_LIBRARY=${_prefix}/lib/liblua.a"
    "-DLUA_INCLUDE_DIR=${_prefix}/include"
    "-DLIBUV_LIBRARY=${_prefix}/lib/libuv.a"
    "-DLIBUV_INCLUDE_DIR=${_prefix}/include"
    "-DCMAKE_C_FLAGS=${CMAKE_C_FLAGS} -O0"
    "-DCMAKE_EXE_LINKER_FLAGS=${CMAKE_EXE_LINKER_FLAGS}"
    "-DCMAKE_SHARED_LINKER_FLAGS=${CMAKE_SHARED_LINKER_FLAGS}")
  set(DEPS_CMAKE_ARGS "${DEPS_CMAKE_ARGS}" PARENT_SCOPE)
endfunction()

function(_nvim_wasm_patch_lua_dep)
  if(NOT TARGET lua)
    return()
  endif()
  set(_script "${_nvim_wrap_root}/scripts/patch/lua_wasi.lua")
  if(NOT EXISTS "${_script}")
    message(FATAL_ERROR "Lua WASI patch script not found: ${_script}")
  endif()
  ExternalProject_Add_Step(lua wasm_patch_lua
    COMMAND ${NVIM_WASM_LUA_PRG} ${_script}
      --build-dir ${DEPS_BUILD_DIR}
      --install-dir ${DEPS_INSTALL_DIR}
      --cc ${CMAKE_C_COMPILER}
      --cflags "${CMAKE_C_FLAGS}"
      --ldflags "${CMAKE_EXE_LINKER_FLAGS}"
    DEPENDEES configure
    DEPENDERS build
    COMMENT "Patching Lua sources for WASI")

  if(TARGET luv)
    set(_luv_script "${_nvim_wrap_root}/scripts/patch/luv_wasi.lua")
    if(EXISTS "${_luv_script}")
      ExternalProject_Add_Step(luv wasm_patch_luv
        COMMAND ${NVIM_WASM_LUA_PRG} ${_luv_script}
          --build-dir ${DEPS_BUILD_DIR}
        DEPENDEES download
        DEPENDERS configure
        COMMENT "Patching luv sources for WASI")
    endif()
  endif()
endfunction()

function(_nvim_wasm_tweak_luv_dep)
  if(NOT TARGET luv)
    return()
  endif()
  set(_prefix "${_nvim_wrap_root}/build-wasm-deps/usr")
  list(APPEND LUV_CMAKE_ARGS
    "-DCMAKE_PREFIX_PATH=${_prefix}"
    "-DLIBUV_LIBRARY=${_prefix}/lib/libuv.a"
    "-DLIBUV_INCLUDE_DIR=${_prefix}/include"
    "-DLUA_LIBRARY=${_prefix}/lib/liblua.a"
    "-DLUA_INCLUDE_DIR=${_prefix}/include")
  set(LUV_CMAKE_ARGS "${LUV_CMAKE_ARGS}" PARENT_SCOPE)
endfunction()

cmake_language(DEFER DIRECTORY "${CMAKE_SOURCE_DIR}" CALL _nvim_wasm_forward_sysdeps)
cmake_language(DEFER DIRECTORY "${CMAKE_SOURCE_DIR}" CALL _nvim_wasm_patch_lua_dep)
cmake_language(DEFER DIRECTORY "${CMAKE_SOURCE_DIR}" CALL _nvim_wasm_tweak_luv_dep)
