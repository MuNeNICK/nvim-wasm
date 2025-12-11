// Shim to keep Neovim's channel stdio duplication from failing under WASI.
// For embedded UI mode, channel_from_stdio() duplicates/redirects stdio using
// fcntl/dup2, which are not available in wasi-libc. Here we turn them into
// harmless passthroughs so the original stdio fds are reused.
#pragma once

#ifdef __wasi__

#ifndef F_DUPFD_CLOEXEC
#  define F_DUPFD_CLOEXEC 0
#endif

static inline int nvim_wasi_fcntl_passthrough(int fd, int cmd, ...)
{
  (void)cmd;
  // Pretend dup returns the same fd, but ensure we never hand back negative.
  return fd < 0 ? -1 : fd;
}

static inline int nvim_wasi_dup2_passthrough(int oldfd, int newfd)
{
  (void)oldfd;
  // Keep the original fd numbers stable; just return target.
  return newfd < 0 ? -1 : newfd;
}

#define fcntl(fd, cmd, ...) nvim_wasi_fcntl_passthrough((fd), (cmd), ##__VA_ARGS__)
#define dup2(oldfd, newfd) nvim_wasi_dup2_passthrough((oldfd), (newfd))

// Force libuv to treat all FDs as regular files (uv_fs + idle path).
#include <uv.h>
#define uv_guess_handle(fd) UV_FILE

#endif  // __wasi__
