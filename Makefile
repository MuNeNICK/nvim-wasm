# Wrapper Makefile (root) that drives wasm32-wasi build of the ./neovim submodule
# without modifying files inside the submodule.

NEOVIM_DIR ?= neovim
TOOLCHAIN_DIR := $(PWD)/.toolchains
PATCH_DIR := $(PWD)/patches

# Common flags to enable wasm exception handling and unwind info so that
# setjmp/longjmp do not escape as env imports.
WASM_EH_FLAGS := -fwasm-exceptions -fexceptions -funwind-tables -mllvm -wasm-enable-sjlj
# wasm-ld in wasi-sdk 29 does not accept --no-threads; omit it to avoid link failure.
# Use lazy expansion so that WASI_SDK_ROOT is resolved after its definition below.
WASM_LINK_FLAGS = --target=wasm32-wasi --sysroot=$(abspath $(WASI_SDK_ROOT))/share/wasi-sysroot $(WASM_EH_FLAGS) -Wl,--allow-undefined -lwasi-emulated-signal -lsetjmp
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
# depsビルド用の並列（メモリ節約したい場合はここを 1 に固定）。環境で上書き可。
WASM_DEPS_JOBS ?= 1
# depsビルドの最適化レベル（tree-sitter系が大きいためデフォルトは低め）。
WASM_DEPS_OPTFLAGS ?= -O0 -g0

CMAKE_VERSION ?= 3.29.6
CMAKE_TAR := cmake-$(CMAKE_VERSION)-$(WASI_SDK_OS)-$(WASI_SDK_ARCH).tar.gz
CMAKE_URL ?= https://github.com/Kitware/CMake/releases/download/v$(CMAKE_VERSION)/$(CMAKE_TAR)
CMAKE_ROOT := $(TOOLCHAIN_DIR)/cmake-$(CMAKE_VERSION)-$(WASI_SDK_OS)-$(WASI_SDK_ARCH)
CMAKE := $(CMAKE_ROOT)/bin/cmake
CMAKE_GENERATOR ?= "Unix Makefiles"

WASM_DEPS_BUILD := $(PWD)/build-wasm-deps
WASM_DEPS_DOWNLOAD := $(TOOLCHAIN_DIR)/.deps-download-wasm
WASM_BUILD := $(PWD)/build-wasm
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

.PHONY: wasm wasm-configure wasm-deps wasm-toolchain wasm-build-tools wasm-clean libuv-patched wasm-libs libuv-wasm lua-wasm luv-wasm

HOST_LUA_PRG ?= $(PWD)/build-host/lua-src/src/lua
HOST_LUAC ?= $(PWD)/build-host/lua-src/src/luac
HOST_LUA_GEN_WRAPPER ?= $(PWD)/cmake/host-lua-gen.sh

wasm: wasm-configure
	$(CMAKE) --build $(WASM_BUILD) --target nvim_bin -- -j$(CMAKE_BUILD_JOBS)

wasm-configure: wasm-deps
	$(CMAKE) -S $(NEOVIM_DIR) -B $(WASM_BUILD) -G $(CMAKE_GENERATOR) \
		-DCMAKE_PROJECT_INCLUDE=$(PWD)/cmake/wasm-overrides.cmake \
		-DCMAKE_TOOLCHAIN_FILE=$(PWD)/cmake/toolchain-wasi.cmake \
		-DWASI_SDK_ROOT=$(WASI_SDK_ROOT) \
		-DCMAKE_C_COMPILER_TARGET=wasm32-wasi \
		-DFEATURES=normal \
		-DCMAKE_C_FLAGS="$(WASM_EH_FLAGS) -D_WASI_EMULATED_SIGNAL -DNDEBUG -DNVIM_LOG_DEBUG -I$(PATCH_DIR)/wasi-shim/include -include $(PATCH_DIR)/wasi-shim/wasi_env_shim.h" \
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
		-DLUA_GEN_PRG=$(HOST_LUA_GEN_WRAPPER) \
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
		-DCMAKE_C_FLAGS="$(WASM_EH_FLAGS) -D_WASI_EMULATED_SIGNAL -DNDEBUG -DNVIM_LOG_DEBUG -I$(PATCH_DIR)/wasi-shim/include -include $(PATCH_DIR)/wasi-shim/wasi_env_shim.h" \
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
	CMAKE_BUILD_PARALLEL_LEVEL=$(WASM_DEPS_JOBS) $(CMAKE) --build $(WASM_DEPS_BUILD)

wasm-toolchain:
	@mkdir -p $(TOOLCHAIN_DIR)
	@if [ ! -d "$(WASI_SDK_ROOT)" ]; then \
	  echo "Downloading wasi-sdk $(WASI_SDK_VER) ..."; \
	  curl -L "$(WASI_SDK_URL)" -o "$(TOOLCHAIN_DIR)/$(WASI_SDK_TAR)"; \
	  tar -C "$(TOOLCHAIN_DIR)" -xf "$(TOOLCHAIN_DIR)/$(WASI_SDK_TAR)"; \
	fi

wasm-build-tools:
	@mkdir -p $(TOOLCHAIN_DIR)
	@if [ ! -x "$(CMAKE)" ]; then \
	  echo "Downloading CMake $(CMAKE_VERSION) ..."; \
	  curl -L "$(CMAKE_URL)" -o "$(TOOLCHAIN_DIR)/$(CMAKE_TAR)"; \
	  tar -C "$(TOOLCHAIN_DIR)" -xf "$(TOOLCHAIN_DIR)/$(CMAKE_TAR)"; \
	fi

wasm-libs: wasm-toolchain wasm-build-tools libuv-wasm lua-wasm luv-wasm

libuv-wasm: wasm-toolchain wasm-build-tools libuv-patched
	@mkdir -p $(WASM_DEPS_BUILD)/src
	@rm -rf $(LIBUV_SRC_DIR) $(LIBUV_BUILD_DIR)
	tar -C $(WASM_DEPS_BUILD)/src -xf $(LIBUV_PATCHED_TAR)
	@python3 $(PWD)/cmake/patch-libuv-wasi-tail.py $(LIBUV_SRC_DIR)
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
	@DEPS_BUILD_DIR=$(WASM_DEPS_BUILD) \
	  DEPS_INSTALL_DIR=$(WASM_DEPS_PREFIX) \
	  LUA_WASM_CC="$(WASI_SDK_ROOT)/bin/clang --target=wasm32-wasi" \
	  LUA_WASM_CFLAGS="$(WASM_EH_FLAGS) -D_WASI_EMULATED_SIGNAL -I$(PATCH_DIR)/wasi-shim/include -include $(PATCH_DIR)/wasi-shim/wasi_env_shim.h" \
	  LUA_WASM_LDFLAGS="--target=wasm32-wasi --sysroot=$(WASI_SDK_ROOT)/share/wasi-sysroot $(WASM_EH_FLAGS) -Wl,--allow-undefined -lwasi-emulated-signal -lsetjmp" \
	  python3 $(PWD)/cmake/patch-lua-wasi.py
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
	@DEPS_BUILD_DIR=$(WASM_DEPS_BUILD) \
	  python3 $(PWD)/cmake/patch-luv-wasi.py
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
