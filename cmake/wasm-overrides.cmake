# Injected via -DCMAKE_PROJECT_INCLUDE for wasm builds.
# Removes Unix PTY sources that rely on unsupported APIs under WASI and
# replaces them with a small stub implementation that just reports ENOSYS.

get_filename_component(_nvim_wrap_source_name "${CMAKE_SOURCE_DIR}" NAME)

# When configuring deps (cmake.deps), patch the bundled Lua without touching
# the Neovim submodule.
if(_nvim_wrap_source_name STREQUAL "cmake.deps")
  include(ExternalProject)
  function(_nvim_wasm_forward_sysdeps)
    get_filename_component(_wrap_root "${CMAKE_SOURCE_DIR}/../.." ABSOLUTE)
    set(_prefix "${_wrap_root}/build-wasm-deps/usr")
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
    get_filename_component(_wrap_root "${CMAKE_SOURCE_DIR}/../.." ABSOLUTE)
    set(_script "${_wrap_root}/cmake/patch-lua-wasi.py")
    if(NOT EXISTS "${_script}")
      message(FATAL_ERROR "Lua WASI patch script not found: ${_script}")
    endif()
    ExternalProject_Add_Step(lua wasm_patch_lua
      COMMAND ${CMAKE_COMMAND} -E env
        DEPS_BUILD_DIR=${DEPS_BUILD_DIR}
        DEPS_INSTALL_DIR=${DEPS_INSTALL_DIR}
        LUA_WASM_CC=${CMAKE_C_COMPILER}
        LUA_WASM_CFLAGS=${CMAKE_C_FLAGS}
        LUA_WASM_LDFLAGS=${CMAKE_EXE_LINKER_FLAGS}
        python3 ${_script}
      DEPENDEES configure
      DEPENDERS build
      COMMENT "Patching Lua sources for WASI")

    if(TARGET luv)
      set(_luv_script "${_wrap_root}/cmake/patch-luv-wasi.py")
      if(EXISTS "${_luv_script}")
        ExternalProject_Add_Step(luv wasm_patch_luv
          COMMAND ${CMAKE_COMMAND} -E env
            DEPS_BUILD_DIR=${DEPS_BUILD_DIR}
            python3 ${_luv_script}
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
    get_filename_component(_wrap_root "${CMAKE_SOURCE_DIR}/../.." ABSOLUTE)
    set(_prefix "${_wrap_root}/build-wasm-deps/usr")
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
  return()
endif()

if(NOT CMAKE_SOURCE_DIR MATCHES "/neovim$")
  return()
endif()

# Ensure UI/features are enabled for WASM (needed for msgpack UI attach).
if(NOT DEFINED FEATURES)
  set(FEATURES normal CACHE STRING "Neovim feature level for WASM (tiny/small/normal/huge)")
endif()

function(_nvim_wasm_disable_pty)
  get_filename_component(_wrap_root "${CMAKE_SOURCE_DIR}/.." ABSOLUTE)
  set(_deps_libdir "${_wrap_root}/build-wasm-deps/usr/lib")
  set(_stub_srcs
    "${_wrap_root}/patches/wasi-shim/pty_stub.c"
    "${_wrap_root}/patches/wasi-shim/signal_stub.c")
  foreach(_stub IN LISTS _stub_srcs)
    if(NOT EXISTS "${_stub}")
      message(FATAL_ERROR "wasm stub source not found: ${_stub}")
    endif()
  endforeach()

  set(_remove_srcs
    "${CMAKE_SOURCE_DIR}/src/nvim/os/pty_proc_unix.c"
    "${CMAKE_SOURCE_DIR}/src/nvim/os/signal.c")

  # Drop unsupported PTY sources and add our stub replacement.
  if(TARGET main_lib)
    get_target_property(_iface main_lib INTERFACE_SOURCES)
    if(_iface STREQUAL "_iface-NOTFOUND")
      set(_iface "")
    endif()
    list(REMOVE_ITEM _iface ${_remove_srcs})
    list(APPEND _iface ${_stub_srcs})
    set_property(TARGET main_lib PROPERTY INTERFACE_SOURCES "${_iface}")
    target_include_directories(main_lib INTERFACE "${_wrap_root}/patches/wasi-shim/include")
    # main_lib is only used locally, so drop any system libraries from its interface.
    set_property(TARGET main_lib PROPERTY INTERFACE_LINK_LIBRARIES "")
  endif()

  if(TARGET nvim_bin)
    get_target_property(_srcs nvim_bin SOURCES)
    if(_srcs STREQUAL "_srcs-NOTFOUND")
      set(_srcs "")
    endif()
    list(REMOVE_ITEM _srcs ${_remove_srcs})
    set_property(TARGET nvim_bin PROPERTY SOURCES "${_srcs}")
    target_sources(nvim_bin PRIVATE ${_stub_srcs})
    target_include_directories(nvim_bin BEFORE PRIVATE
      "${_wrap_root}/patches/wasi-shim/include")

    # Drop Unix-only linker flags/libs that fail on wasm-ld.
    get_target_property(_opts nvim_bin LINK_OPTIONS)
    if(NOT _opts STREQUAL "_opts-NOTFOUND")
      list(REMOVE_ITEM _opts "-Wl,--no-undefined")
      set_property(TARGET nvim_bin PROPERTY LINK_OPTIONS "${_opts}")
    endif()

    # Rebind to only the wasm-friendly static libs we built.
    set_property(TARGET nvim_bin PROPERTY LINK_LIBRARIES "")
    target_link_libraries(nvim_bin PRIVATE
      main_lib
      "${_deps_libdir}/libluv.a"
      "${_deps_libdir}/liblpeg.a"
      "${_deps_libdir}/libtree-sitter.a"
      "${_deps_libdir}/libutf8proc.a"
      "${_deps_libdir}/libunibilium.a"
      "${_deps_libdir}/liblua.a"
      "${_deps_libdir}/libuv.a")
  endif()

  # Skip helptags generation which would try to run the wasm binary.
  if(TARGET nvim_runtime)
    set_property(TARGET nvim_runtime PROPERTY EXCLUDE_FROM_ALL TRUE)
    set_property(TARGET nvim_runtime PROPERTY EXCLUDE_FROM_DEFAULT_BUILD TRUE)
  endif()

endfunction()

cmake_language(DEFER DIRECTORY "${CMAKE_SOURCE_DIR}" CALL _nvim_wasm_disable_pty)

# Inject WASI-specific shims for channel stdio duplication without touching the
# upstream source tree.
function(_nvim_wasm_patch_stdio)
  if(NOT TARGET nvim_bin)
    message(STATUS "wasm overrides: nvim_bin target not available; skipping stdio patch")
    return()
  endif()

  get_target_property(_srcs nvim_bin SOURCES)
  if(_srcs STREQUAL "_srcs-NOTFOUND")
    message(STATUS "wasm overrides: nvim_bin sources not found; skipping stdio patch")
    return()
  endif()

  set(_patched 0)
  get_filename_component(_channel_abs "${CMAKE_SOURCE_DIR}/src/nvim/channel.c" ABSOLUTE)
  list(APPEND _srcs "${_channel_abs}" "src/nvim/channel.c" "channel.c")

  foreach(_src IN LISTS _srcs)
    if(_src MATCHES "/channel\\.c$" OR _src STREQUAL "channel.c" OR _src STREQUAL "src/nvim/channel.c")
      message(STATUS "wasm overrides: applying stdio override flags to ${_src}")
      set_source_files_properties("${_src}"
        PROPERTIES COMPILE_DEFINITIONS "WASM_CHANNEL_STDIO_OVERRIDE=1;CHANNEL_STDIO_OVERRIDE_IMPL=1")
      set_source_files_properties("${_src}" APPEND_STRING PROPERTY COMPILE_FLAGS
        " -DWASM_CHANNEL_STDIO_OVERRIDE=1 -DCHANNEL_STDIO_OVERRIDE_IMPL=1")
      set_property(SOURCE "${_src}" APPEND PROPERTY COMPILE_OPTIONS
        "-DWASM_CHANNEL_STDIO_OVERRIDE=1" "-DCHANNEL_STDIO_OVERRIDE_IMPL=1")
      math(EXPR _patched "${_patched} + 1")
    endif()
  endforeach()

  if(_patched EQUAL 0)
    message(STATUS "wasm overrides: channel.c not found in nvim_bin sources; stdio patch not applied")
  endif()
endfunction()

function(_nvim_wasm_relax_stream_asserts)
  if(NOT CMAKE_SOURCE_DIR MATCHES "/neovim$")
    return()
  endif()
  set(_stream "${CMAKE_SOURCE_DIR}/src/nvim/event/stream.c")
  if(EXISTS "${_stream}")
    # Disable asserts in stream.c for WASI where fd/uvstream invariants do not hold.
    set_source_files_properties("${_stream}" PROPERTIES COMPILE_DEFINITIONS "NDEBUG")
  endif()
endfunction()

function(_nvim_wasm_env_shim)
  get_filename_component(_wrap_root "${CMAKE_SOURCE_DIR}/.." ABSOLUTE)
  set(_shim "${_wrap_root}/patches/wasi-shim/wasi_env_shim.h")
  if(EXISTS "${_shim}")
    set(_env "${CMAKE_SOURCE_DIR}/src/nvim/os/env.c")
    if(EXISTS "${_env}")
      set_source_files_properties("${_env}" PROPERTIES COMPILE_FLAGS "-include ${_shim}")
    endif()
  endif()
endfunction()

function(_nvim_wasm_wrap_stdio)
  if(NOT TARGET nvim_bin)
    return()
  endif()
  get_filename_component(_wrap_root "${CMAKE_SOURCE_DIR}/.." ABSOLUTE)
  set(_src "${_wrap_root}/patches/wasi-shim/channel_stdio_override.c")
  if(EXISTS "${_src}")
    target_sources(nvim_bin PRIVATE "${_src}")
    target_link_options(nvim_bin PRIVATE "-Wl,--wrap=channel_from_stdio")
  endif()
endfunction()

cmake_language(DEFER DIRECTORY "${CMAKE_SOURCE_DIR}" CALL _nvim_wasm_patch_stdio)
_nvim_wasm_relax_stream_asserts()
_nvim_wasm_env_shim()
cmake_language(DEFER DIRECTORY "${CMAKE_SOURCE_DIR}" CALL _nvim_wasm_wrap_stdio)
