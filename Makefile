# Wrapper Makefile (root) that drives wasm32-wasi build of the ./neovim submodule
# without modifying files inside the submodule.

NEOVIM_DIR ?= neovim
TOOLCHAIN_DIR := $(PWD)/.toolchains
PATCH_DIR := $(PWD)/patches

# Lua interpreter for wrapper scripts (prefer Lua 5.1-compatible).
LUA ?= $(shell (command -v luajit >/dev/null 2>&1 && echo luajit) || (command -v lua5.1 >/dev/null 2>&1 && echo lua5.1) || (command -v lua >/dev/null 2>&1 && echo lua) || true)
ifeq ($(strip $(LUA)),)
$(error "Lua interpreter not found (need luajit or lua)")
endif

# Common flags to enable wasm exception handling and unwind info so that
# setjmp/longjmp do not escape as env imports.
WASM_EH_FLAGS := -fwasm-exceptions -fexceptions -funwind-tables -mllvm -wasm-enable-sjlj
WASM_DEPS_PREFIX := $(PWD)/build-wasm-deps/usr
WASM_LIB_DIR := $(WASM_DEPS_PREFIX)/lib
WASM_INCLUDE_DIR := $(WASM_DEPS_PREFIX)/include

WASI_SDK_VER ?= 29.0
WASI_SDK_ARCH ?= $(shell uname -m | sed -e 's/x86_64/x86_64/' -e 's/aarch64/arm64/' -e 's/arm64/arm64/')
WASI_SDK_OS ?= linux
WASI_SDK_TAG := wasi-sdk-$(basename $(WASI_SDK_VER))
WASI_SDK_TAR := wasi-sdk-$(WASI_SDK_VER)-$(WASI_SDK_ARCH)-$(WASI_SDK_OS).tar.gz
WASI_SDK_URL ?= https://github.com/WebAssembly/wasi-sdk/releases/download/$(WASI_SDK_TAG)/$(WASI_SDK_TAR)
WASI_SDK_ROOT := $(TOOLCHAIN_DIR)/wasi-sdk-$(WASI_SDK_VER)-$(WASI_SDK_ARCH)-$(WASI_SDK_OS)

CMAKE_BUILD_JOBS ?= 1
# Parallelism for deps build (pin to 1 to save memory); override via env
WASM_DEPS_JOBS ?= 1
# Optimization level for deps build (kept low because tree-sitter bundles are large)
WASM_DEPS_OPTFLAGS ?= -O0 -g0

CMAKE_VERSION ?= 3.29.6
CMAKE_TAR := cmake-$(CMAKE_VERSION)-$(WASI_SDK_OS)-$(WASI_SDK_ARCH).tar.gz
CMAKE_URL ?= https://github.com/Kitware/CMake/releases/download/v$(CMAKE_VERSION)/$(CMAKE_TAR)
CMAKE_ROOT := $(TOOLCHAIN_DIR)/cmake-$(CMAKE_VERSION)-$(WASI_SDK_OS)-$(WASI_SDK_ARCH)
CMAKE := $(CMAKE_ROOT)/bin/cmake
CMAKE_GENERATOR ?= "Unix Makefiles"

BINARYEN_VERSION ?= 125
BINARYEN_OS ?= $(shell uname -s | tr '[:upper:]' '[:lower:]' | sed -e 's/darwin/macos/')
BINARYEN_ARCH ?= $(shell uname -m | sed -e 's/x86_64/x86_64/' -e 's/aarch64/aarch64/' -e 's/arm64/aarch64/')
BINARYEN_TAR := binaryen-version_$(BINARYEN_VERSION)-$(BINARYEN_ARCH)-$(BINARYEN_OS).tar.gz
BINARYEN_URL ?= https://github.com/WebAssembly/binaryen/releases/download/version_$(BINARYEN_VERSION)/$(BINARYEN_TAR)
BINARYEN_ROOT := $(TOOLCHAIN_DIR)/binaryen-version_$(BINARYEN_VERSION)
BINARYEN_WASM_OPT ?= $(BINARYEN_ROOT)/bin/wasm-opt

# Binaryen Asyncify post-processing (for SAB-free browser demo).
#
# Notes:
# - `ASYNCIFY_IMPORTS` is a comma-separated list of `module.name` imports.
# - `ASYNCIFY_ADDLIST` / `ASYNCIFY_REMOVELIST` are comma-separated wasm
#   function names (use `make wasm-asyncify ASYNCIFY_VERBOSE=1` to inspect).
ASYNCIFY_IMPORTS ?= wasi_snapshot_preview1.poll_oneoff
ASYNCIFY_ADDLIST ?=
ASYNCIFY_REMOVELIST ?=
ASYNCIFY_IGNORE_INDIRECT ?= 0
ASYNCIFY_VERBOSE ?= 0
ASYNCIFY_ASSERTS ?= 0
ASYNCIFY_OPT ?= -O2
ASYNCIFY_STRIP_DEBUG ?= 1
ASYNCIFY_STRIP_PRODUCERS ?= 1

ASYNCIFY_PASS_ARGS := --pass-arg=asyncify-imports@$(ASYNCIFY_IMPORTS)
ifneq ($(strip $(ASYNCIFY_ADDLIST)),)
ASYNCIFY_PASS_ARGS += --pass-arg=asyncify-addlist@$(ASYNCIFY_ADDLIST) --pass-arg=asyncify-propagate-addlist
endif
ifneq ($(strip $(ASYNCIFY_REMOVELIST)),)
ASYNCIFY_PASS_ARGS += --pass-arg=asyncify-removelist@$(ASYNCIFY_REMOVELIST)
endif
ifneq ($(ASYNCIFY_IGNORE_INDIRECT),0)
ASYNCIFY_PASS_ARGS += --pass-arg=asyncify-ignore-indirect
endif
ifneq ($(ASYNCIFY_VERBOSE),0)
ASYNCIFY_PASS_ARGS += --pass-arg=asyncify-verbose
endif
ifneq ($(ASYNCIFY_ASSERTS),0)
ASYNCIFY_PASS_ARGS += --pass-arg=asyncify-asserts
endif
ASYNCIFY_POST_OPTS := $(ASYNCIFY_OPT)
ifneq ($(ASYNCIFY_STRIP_DEBUG),0)
ASYNCIFY_POST_OPTS += --strip-debug
endif
ifneq ($(ASYNCIFY_STRIP_PRODUCERS),0)
ASYNCIFY_POST_OPTS += --strip-producers
endif

WASM_LINK_FLAGS = $(shell $(LUA) $(PWD)/scripts/config/wasm_flags.lua --field ldflags-common --sysroot $(WASI_SDK_ROOT)/share/wasi-sysroot --eh "$(WASM_EH_FLAGS)")
WASM_CFLAGS_COMMON = $(shell $(LUA) $(PWD)/scripts/config/wasm_flags.lua --field cflags-common --patch-dir $(PATCH_DIR) --eh "$(WASM_EH_FLAGS)")
WASM_LUA_CFLAGS = $(shell $(LUA) $(PWD)/scripts/config/wasm_flags.lua --field lua-cflags --patch-dir $(PATCH_DIR) --eh "$(WASM_EH_FLAGS)")
WASM_LUA_LDFLAGS = $(shell $(LUA) $(PWD)/scripts/config/wasm_flags.lua --field lua-ldflags --sysroot $(WASI_SDK_ROOT)/share/wasi-sysroot --eh "$(WASM_EH_FLAGS)")

WASM_DEPS_BUILD := $(PWD)/build-wasm-deps
WASM_DEPS_DOWNLOAD := $(TOOLCHAIN_DIR)/.deps-download-wasm
WASM_BUILD := $(PWD)/build-wasm
HOST_BUILD_DIR := $(PWD)/build-host
HOST_PREFIX := $(HOST_BUILD_DIR)/.deps/usr
# Host-side Lua used for Neovim code generation during cross-compilation.
# Neovim's build typically produces these under build-host/lua-src/.
HOST_LUA_PRG_DEFAULT := $(HOST_BUILD_DIR)/lua-src/src/lua
HOST_LUAC_DEFAULT := $(HOST_BUILD_DIR)/lua-src/src/luac
HOST_NLUA0_DEFAULT := $(HOST_BUILD_DIR)/libnlua0-host.so
LIBUV_PATCHED_TAR := $(TOOLCHAIN_DIR)/libuv-wasi.tar.gz
LIBUV_ORIG_TAR := $(TOOLCHAIN_DIR)/libuv-1.51.0.tar.gz
LIBUV_ORIG_URL := https://github.com/libuv/libuv/archive/v1.51.0.tar.gz
LIBUV_SRC_DIR := $(WASM_DEPS_BUILD)/src/libuv-1.51.0
LIBUV_BUILD_DIR := $(WASM_DEPS_BUILD)/build-libuv
LUV_VERSION ?= 1.51.0-1
LUV_TAR := luv-$(LUV_VERSION).tar.gz
LUV_ORIG_TAR := $(TOOLCHAIN_DIR)/$(LUV_TAR)
LUV_ORIG_URL ?= https://github.com/luvit/luv/archive/$(LUV_VERSION).tar.gz
LUV_SRC_DIR := $(WASM_DEPS_BUILD)/src/luv
LUV_BUILD_DIR := $(WASM_DEPS_BUILD)/build-luv
LUA_COMPAT53_VERSION ?= v0.13
LUA_COMPAT53_TAR := lua-compat-5.3-$(LUA_COMPAT53_VERSION).tar.gz
LUA_COMPAT53_ORIG_TAR := $(TOOLCHAIN_DIR)/$(LUA_COMPAT53_TAR)
LUA_COMPAT53_ORIG_URL ?= https://github.com/lunarmodules/lua-compat-5.3/archive/$(LUA_COMPAT53_VERSION).tar.gz
LUA_COMPAT53_SRC_DIR := $(WASM_DEPS_BUILD)/src/lua_compat53

LUA_VERSION ?= 5.1.5
LUA_TAR := lua-$(LUA_VERSION).tar.gz
LUA_ORIG_TAR := $(TOOLCHAIN_DIR)/$(LUA_TAR)
LUA_ORIG_URL ?= https://www.lua.org/ftp/$(LUA_TAR)
LUA_SRC_DIR := $(WASM_DEPS_BUILD)/src/lua

.PHONY: wasm wasm-configure wasm-deps wasm-toolchain wasm-build-tools binaryen-toolchain wasm-clean libuv-patched wasm-libs libuv-wasm lua-wasm luv-wasm host-lua host-lua-configure wasm-jspi wasm-asyncify demo-asyncify

HOST_LUA_PRG ?= $(HOST_LUA_PRG_DEFAULT)
HOST_LUAC ?= $(HOST_LUAC_DEFAULT)
HOST_NLUA0 ?= $(HOST_NLUA0_DEFAULT)
HOST_LUA_GEN_WRAPPER ?= $(PWD)/scripts/build/host_lua_gen.lua

host-lua:
	@if [ -x "$(HOST_LUA_PRG)" ] && [ -f "$(HOST_NLUA0)" ]; then \
	  echo "host-lua: reusing existing host lua at $(HOST_LUA_PRG)"; \
	else \
	  set -e; \
	  $(MAKE) host-lua-configure; \
	  $(CMAKE) --build $(HOST_BUILD_DIR) --target nlua0 -- -j$(CMAKE_BUILD_JOBS); \
	  if [ -f "$(HOST_BUILD_DIR)/libnlua0.so" ]; then \
	    cp "$(HOST_BUILD_DIR)/libnlua0.so" "$(HOST_NLUA0_DEFAULT)"; \
	  elif [ -f "$(HOST_BUILD_DIR)/libnlua0.dylib" ]; then \
	    cp "$(HOST_BUILD_DIR)/libnlua0.dylib" "$(HOST_NLUA0_DEFAULT)"; \
	  elif [ -f "$(HOST_BUILD_DIR)/nlua0.dll" ]; then \
	    cp "$(HOST_BUILD_DIR)/nlua0.dll" "$(HOST_NLUA0_DEFAULT)"; \
	  fi; \
	fi

host-lua-configure: wasm-build-tools
	$(CMAKE) -S $(NEOVIM_DIR) -B $(HOST_BUILD_DIR) -G $(CMAKE_GENERATOR) \
		-DCMAKE_BUILD_TYPE=Release \
		-DUSE_BUNDLED=ON \
		-DPREFER_LUA=ON -DUSE_BUNDLED_LUA=ON -DUSE_BUNDLED_LUAJIT=OFF \
		-DUSE_BUNDLED_LUV=ON -DUSE_BUNDLED_LIBUV=ON \
		-DUSE_BUNDLED_MSGPACK=ON -DUSE_BUNDLED_LIBTERMKEY=ON \
		-DUSE_BUNDLED_LIBVTERM=ON -DUSE_BUNDLED_TS=ON -DUSE_BUNDLED_TREESITTER=ON \
		-DUSE_BUNDLED_UNIBILIUM=ON -DENABLE_WASMTIME=OFF -DENABLE_LTO=OFF

wasm-configure: host-lua

wasm: wasm-configure
	$(CMAKE) --build $(WASM_BUILD) --target nvim_bin -- -j$(CMAKE_BUILD_JOBS)

wasm-jspi: binaryen-toolchain
	@test -f "$(WASM_BUILD)/bin/nvim" || (echo "missing $(WASM_BUILD)/bin/nvim; run: make wasm" && exit 1)
	$(BINARYEN_WASM_OPT) $(WASM_BUILD)/bin/nvim --jspi -o $(WASM_BUILD)/bin/nvim-jspi.wasm

wasm-asyncify: binaryen-toolchain
	@test -f "$(WASM_BUILD)/bin/nvim" || (echo "missing $(WASM_BUILD)/bin/nvim; run: make wasm" && exit 1)
	$(BINARYEN_WASM_OPT) $(WASM_BUILD)/bin/nvim \
	  --asyncify \
	  $(ASYNCIFY_PASS_ARGS) \
	  $(ASYNCIFY_POST_OPTS) \
	  -o $(WASM_BUILD)/bin/nvim-asyncify.wasm

demo-asyncify: wasm-asyncify
	@mkdir -p examples/demo-asyncify
	cp -f $(WASM_BUILD)/bin/nvim-asyncify.wasm examples/demo-asyncify/nvim-asyncify.wasm

wasm-configure: wasm-deps
	$(CMAKE) -S $(NEOVIM_DIR) -B $(WASM_BUILD) -G $(CMAKE_GENERATOR) \
		-DCMAKE_PROJECT_INCLUDE=$(PWD)/cmake/wasm-overrides.cmake \
		-DCMAKE_TOOLCHAIN_FILE=$(PWD)/cmake/toolchain-wasi.cmake \
		-DWASI_SDK_ROOT=$(WASI_SDK_ROOT) \
		-DCMAKE_C_COMPILER_TARGET=wasm32-wasi \
		-DFEATURES=normal \
		-DCMAKE_C_FLAGS="$(WASM_CFLAGS_COMMON)" \
		-DCMAKE_C_FLAGS_RELEASE="-O0" \
		-DCMAKE_C_FLAGS_RELWITHDEBINFO="-O0" \
		-DWASI_SHIM_DIR=$(PWD)/patches/wasi-shim/include \
		-DCMAKE_PREFIX_PATH=$(WASM_DEPS_PREFIX) \
		-DLUV_LIBRARY=$(WASM_LIB_DIR)/libluv.a \
		-DLUV_INCLUDE_DIR=$(WASM_INCLUDE_DIR) \
		-DLIBUV_LIBRARY=$(WASM_LIB_DIR)/libuv.a \
		-DLIBUV_INCLUDE_DIR=$(WASM_INCLUDE_DIR) \
		-DLPEG_LIBRARY=$(WASM_LIB_DIR)/liblpeg.a \
		-DLPEG_INCLUDE_DIR=$(WASM_INCLUDE_DIR) \
		-DUTF8PROC_LIBRARY=$(WASM_LIB_DIR)/libutf8proc.a \
		-DUTF8PROC_INCLUDE_DIR=$(WASM_INCLUDE_DIR) \
		-DTREESITTER_LIBRARY=$(WASM_LIB_DIR)/libtree-sitter.a \
		-DTREESITTER_INCLUDE_DIR=$(WASM_INCLUDE_DIR) \
		-DUNIBILIUM_LIBRARY=$(WASM_LIB_DIR)/libunibilium.a \
		-DUNIBILIUM_INCLUDE_DIR=$(WASM_INCLUDE_DIR) \
		-DLUA_LIBRARY=$(WASM_LIB_DIR)/liblua.a \
		-DLUA_INCLUDE_DIR=$(WASM_INCLUDE_DIR) \
		-DLUA_PRG=$(HOST_LUA_PRG) \
		-DLUA_EXECUTABLE=$(HOST_LUA_PRG) \
		-DLUA_GEN_PRG="$(LUA);$(HOST_LUA_GEN_WRAPPER)" \
		-DLUAC_PRG= \
		-DICONV_INCLUDE_DIR=$(PWD)/patches/wasi-shim/include \
		-DICONV_LIBRARY=$(PWD)/patches/wasi-shim/lib/libiconv.a \
		-DLIBINTL_INCLUDE_DIR=$(PWD)/patches/wasi-shim/include \
		-DLIBINTL_LIBRARY=$(PWD)/patches/wasi-shim/lib/libintl.a \
		-DCMAKE_SYSROOT=$(WASI_SDK_ROOT)/share/wasi-sysroot \
		-DCMAKE_BUILD_TYPE=RelWithDebInfo \
		-DUSE_BUNDLED=ON \
		-DUSE_BUNDLED_LUAJIT=OFF -DPREFER_LUA=ON \
		-DUSE_BUNDLED_LUA=ON -DUSE_BUNDLED_LUV=OFF -DUSE_BUNDLED_LIBUV=OFF \
		-DUSE_BUNDLED_MSGPACK=ON -DUSE_BUNDLED_LIBTERMKEY=ON \
		-DUSE_BUNDLED_LIBVTERM=ON -DUSE_BUNDLED_TS=ON \
		-DUSE_BUNDLED_TREESITTER=ON -DUSE_BUNDLED_UNIBILIUM=ON \
		-DENABLE_JEMALLOC=OFF -DENABLE_WASMTIME=OFF \
		-DENABLE_LTO=OFF \
		-DDEPS_BUILD_DIR=$(WASM_DEPS_BUILD) \
		-DCMAKE_EXE_LINKER_FLAGS="$(WASM_LINK_FLAGS)" \
		-DCMAKE_SHARED_LINKER_FLAGS="$(WASM_LINK_FLAGS)"

wasm-deps: wasm-toolchain wasm-build-tools wasm-libs
	$(CMAKE) -S $(NEOVIM_DIR)/cmake.deps -B $(WASM_DEPS_BUILD) -G $(CMAKE_GENERATOR) \
		-DCMAKE_PROJECT_INCLUDE=$(PWD)/cmake/wasm-overrides.cmake \
		-DCMAKE_TOOLCHAIN_FILE=$(PWD)/cmake/toolchain-wasi.cmake \
		-DWASI_SDK_ROOT=$(WASI_SDK_ROOT) \
		-DCMAKE_C_COMPILER_TARGET=wasm32-wasi \
		-DCMAKE_C_FLAGS="$(WASM_CFLAGS_COMMON)" \
		-DCMAKE_C_FLAGS_RELEASE="$(WASM_DEPS_OPTFLAGS)" \
		-DCMAKE_CXX_FLAGS_RELEASE="$(WASM_DEPS_OPTFLAGS)" \
		-DWASI_SHIM_DIR=$(PWD)/patches/wasi-shim/include \
		-DCMAKE_SYSROOT=$(WASI_SDK_ROOT)/share/wasi-sysroot \
		-DCMAKE_BUILD_TYPE=Release \
		-DCMAKE_PREFIX_PATH=$(WASM_DEPS_PREFIX) \
		-DUSE_BUNDLED_LUAJIT=OFF -DPREFER_LUA=ON -DUSE_BUNDLED_LUA=OFF -DUSE_BUNDLED_LIBUV=OFF -DUSE_BUNDLED_LUV=OFF \
		-DLUA_LIBRARY=$(WASM_LIB_DIR)/liblua.a \
		-DLUA_INCLUDE_DIR=$(WASM_INCLUDE_DIR) \
		-DLUV_LIBRARY=$(WASM_LIB_DIR)/libluv.a \
		-DLUV_INCLUDE_DIR=$(WASM_INCLUDE_DIR) \
		-DLIBUV_LIBRARY=$(WASM_LIB_DIR)/libuv.a \
		-DLIBUV_INCLUDE_DIR=$(WASM_INCLUDE_DIR) \
		-DDEPS_DOWNLOAD_DIR=$(WASM_DEPS_DOWNLOAD) \
	-DCMAKE_EXE_LINKER_FLAGS="$(WASM_LINK_FLAGS)" \
	-DCMAKE_SHARED_LINKER_FLAGS="$(WASM_LINK_FLAGS)"
	CMAKE_BUILD_PARALLEL_LEVEL=$(WASM_DEPS_JOBS) $(CMAKE) --build $(WASM_DEPS_BUILD) -- -j$(WASM_DEPS_JOBS)

wasm-toolchain:
	@$(LUA) $(PWD)/scripts/toolchain/fetch.lua \
	  --url "$(WASI_SDK_URL)" \
	  --archive "$(TOOLCHAIN_DIR)/$(WASI_SDK_TAR)" \
	  --dest "$(TOOLCHAIN_DIR)" \
	  --expected "$(WASI_SDK_ROOT)"

wasm-build-tools:
	@$(LUA) $(PWD)/scripts/toolchain/fetch.lua \
	  --url "$(CMAKE_URL)" \
	  --archive "$(TOOLCHAIN_DIR)/$(CMAKE_TAR)" \
	  --dest "$(TOOLCHAIN_DIR)" \
	  --expected "$(CMAKE_ROOT)"

binaryen-toolchain:
	@$(LUA) $(PWD)/scripts/toolchain/fetch.lua \
	  --url "$(BINARYEN_URL)" \
	  --archive "$(TOOLCHAIN_DIR)/$(BINARYEN_TAR)" \
	  --dest "$(TOOLCHAIN_DIR)" \
	  --expected "$(BINARYEN_ROOT)"

wasm-libs: wasm-toolchain wasm-build-tools libuv-wasm lua-wasm luv-wasm

libuv-wasm: wasm-toolchain wasm-build-tools libuv-patched
	@mkdir -p $(WASM_DEPS_BUILD)/src
	@rm -rf $(LIBUV_SRC_DIR) $(LIBUV_BUILD_DIR)
	tar -C $(WASM_DEPS_BUILD)/src -xf $(LIBUV_PATCHED_TAR)
	@$(LUA) $(PWD)/scripts/patch/libuv_wasi_tail.lua $(LIBUV_SRC_DIR)
	$(CMAKE) -S $(LIBUV_SRC_DIR) -B $(LIBUV_BUILD_DIR) -G $(CMAKE_GENERATOR) \
		-DCMAKE_PROJECT_INCLUDE=$(PWD)/cmake/wasm-overrides.cmake \
		-DCMAKE_TOOLCHAIN_FILE=$(PWD)/cmake/toolchain-wasi.cmake \
		-DWASI_SDK_ROOT=$(WASI_SDK_ROOT) \
		-DCMAKE_BUILD_TYPE=Release \
	-DBUILD_TESTING=OFF \
	-DBUILD_SHARED_LIBS=OFF \
	-DCMAKE_INSTALL_PREFIX=$(WASM_DEPS_PREFIX) \
	-DCMAKE_C_FLAGS="$(WASM_EH_FLAGS) -D_WASI_EMULATED_SIGNAL -DNDEBUG -O0" \
		-DCMAKE_EXE_LINKER_FLAGS="$(WASM_LINK_FLAGS)" \
		-DCMAKE_SHARED_LINKER_FLAGS="$(WASM_LINK_FLAGS)"
	$(CMAKE) --build $(LIBUV_BUILD_DIR) -- -j$(CMAKE_BUILD_JOBS)
	$(CMAKE) --install $(LIBUV_BUILD_DIR)

lua-wasm: wasm-toolchain
	@mkdir -p $(TOOLCHAIN_DIR) $(WASM_DEPS_BUILD)/src
	@if [ ! -f "$(LUA_ORIG_TAR)" ]; then \
	  echo "Downloading Lua $(LUA_VERSION) ..."; \
	  curl -L "$(LUA_ORIG_URL)" -o "$(LUA_ORIG_TAR)"; \
	fi
	@rm -rf $(LUA_SRC_DIR) $(WASM_DEPS_BUILD)/src/lua-$(LUA_VERSION)
	tar -C $(WASM_DEPS_BUILD)/src -xf $(LUA_ORIG_TAR)
	mv $(WASM_DEPS_BUILD)/src/lua-$(LUA_VERSION) $(LUA_SRC_DIR)
	@$(LUA) $(PWD)/scripts/patch/lua_wasi.lua \
	  --build-dir $(WASM_DEPS_BUILD) \
	  --install-dir $(WASM_DEPS_PREFIX) \
	  --cc "$(WASI_SDK_ROOT)/bin/clang --target=wasm32-wasi" \
	  --cflags "$(WASM_LUA_CFLAGS)" \
	  --ldflags "$(WASM_LUA_LDFLAGS)"
	$(MAKE) -C $(LUA_SRC_DIR)/src \
	  AR="$(WASI_SDK_ROOT)/bin/ar rcu" \
	  RANLIB="$(WASI_SDK_ROOT)/bin/ranlib" \
	  INSTALL_TOP=$(WASM_DEPS_PREFIX) \
	  all
	$(MAKE) -C $(LUA_SRC_DIR) \
	  INSTALL_TOP=$(WASM_DEPS_PREFIX) \
	  install

luv-wasm: wasm-toolchain libuv-wasm lua-wasm
	@mkdir -p $(TOOLCHAIN_DIR) $(WASM_DEPS_BUILD)/src
	@if [ ! -d "$(LUA_COMPAT53_SRC_DIR)" ]; then \
	  if [ ! -f "$(LUA_COMPAT53_ORIG_TAR)" ]; then \
	    echo "Downloading lua-compat-5.3 $(LUA_COMPAT53_VERSION) ..."; \
	    curl -L "$(LUA_COMPAT53_ORIG_URL)" -o "$(LUA_COMPAT53_ORIG_TAR)"; \
	  fi; \
	  tmpdir=$$(mktemp -d); \
	    tar -C $$tmpdir -xf "$(LUA_COMPAT53_ORIG_TAR)"; \
	    rm -rf "$(LUA_COMPAT53_SRC_DIR)"; \
	    mv $$tmpdir/lua-compat-5.3-* "$(LUA_COMPAT53_SRC_DIR)"; \
	    rm -rf $$tmpdir; \
	fi
	@if [ ! -f "$(LUV_ORIG_TAR)" ]; then \
	  echo "Downloading luv $(LUV_VERSION) ..."; \
	  curl -L "$(LUV_ORIG_URL)" -o "$(LUV_ORIG_TAR)"; \
	fi
	@rm -rf $(LUV_SRC_DIR) $(WASM_DEPS_BUILD)/src/luv-$(LUV_VERSION) $(LUV_BUILD_DIR)
	tar -C $(WASM_DEPS_BUILD)/src -xf $(LUV_ORIG_TAR)
	mv $(WASM_DEPS_BUILD)/src/luv-$(LUV_VERSION) $(LUV_SRC_DIR)
	@$(LUA) $(PWD)/scripts/patch/luv_wasi.lua --build-dir $(WASM_DEPS_BUILD)
	$(CMAKE) -S $(LUV_SRC_DIR) -B $(LUV_BUILD_DIR) -G $(CMAKE_GENERATOR) \
		-DCMAKE_TOOLCHAIN_FILE=$(PWD)/cmake/toolchain-wasi.cmake \
		-DWASI_SDK_ROOT=$(WASI_SDK_ROOT) \
		-DCMAKE_BUILD_TYPE=Release \
		-DCMAKE_INSTALL_PREFIX=$(WASM_DEPS_PREFIX) \
		-DCMAKE_PREFIX_PATH=$(WASM_DEPS_PREFIX) \
		-DLUA_BUILD_TYPE=System \
		-DWITH_LUA_ENGINE=Lua \
		-DWITH_SHARED_LIBUV=ON \
		-DBUILD_STATIC_LIBS=ON \
		-DBUILD_MODULE=OFF \
		-DLUA_COMPAT53_DIR=$(LUA_COMPAT53_SRC_DIR) \
		-DLIBUV_LIBRARY=$(WASM_LIB_DIR)/libuv.a \
		-DLIBUV_LIBRARIES=$(WASM_LIB_DIR)/libuv.a \
		-DLIBUV_INCLUDE_DIR=$(WASM_INCLUDE_DIR) \
		-DLUA_LIBRARY=$(WASM_LIB_DIR)/liblua.a \
		-DLUA_INCLUDE_DIR=$(WASM_INCLUDE_DIR) \
		-DCMAKE_C_FLAGS="$(WASM_EH_FLAGS) -D_WASI_EMULATED_SIGNAL -DNDEBUG -O0 -I$(PATCH_DIR)/wasi-shim/include -include $(PATCH_DIR)/wasi-shim/wasi_env_shim.h" \
		-DCMAKE_EXE_LINKER_FLAGS="$(WASM_LINK_FLAGS)" \
		-DCMAKE_SHARED_LINKER_FLAGS="$(WASM_LINK_FLAGS)"
	$(CMAKE) --build $(LUV_BUILD_DIR) -- -j$(CMAKE_BUILD_JOBS)
	$(CMAKE) --install $(LUV_BUILD_DIR)

wasm-clean:
	$(RM) -r $(WASM_BUILD) $(WASM_DEPS_BUILD) $(TOOLCHAIN_DIR)/libuv-wasi.tar.gz

libuv-patched: $(LIBUV_PATCHED_TAR)

$(LIBUV_PATCHED_TAR): $(PATCH_DIR)/libuv-wasi.patch
	@mkdir -p $(TOOLCHAIN_DIR) $(PATCH_DIR)
	@if [ ! -f "$(LIBUV_ORIG_TAR)" ]; then \
	  echo "Downloading libuv orig ..."; \
	  curl -L "$(LIBUV_ORIG_URL)" -o "$(LIBUV_ORIG_TAR)"; \
	fi
	@tmpdir=$$(mktemp -d); \
	  tar -C $$tmpdir -xf "$(LIBUV_ORIG_TAR)" || exit $$?; \
	  cd $$tmpdir/libuv-1.51.0 && patch -p1 < "$(PATCH_DIR)/libuv-wasi.patch"; \
	  tar -C $$tmpdir -czf "$(LIBUV_PATCHED_TAR)" libuv-1.51.0; \
	  rm -rf $$tmpdir
