// Override channel_from_stdio for WASI to avoid dup/redirect shenanigans.
// Keeps stdin/stdout unchanged so the RPC UI channel stays on the original fds.
#pragma once

#if defined(__wasi__) && defined(WASM_CHANNEL_STDIO_OVERRIDE) && defined(CHANNEL_STDIO_OVERRIDE_IMPL)
// Only channel.c is compiled with CHANNEL_STDIO_OVERRIDE_IMPL. We rename the
// original symbol in that TU and provide our own channel_from_stdio below.
#pragma push_macro("channel_from_stdio")
#define channel_from_stdio channel_from_stdio_original

#include "nvim/channel.h"
#include "nvim/channel_defs.h"
#include "nvim/event/loop.h"
#include "nvim/event/stream.h"
#include "nvim/msgpack_rpc/channel.h"
#include "nvim/os/os.h"

// Weak override
uint64_t channel_from_stdio(bool rpc, CallbackReader on_output, const char **error)
{
  // Mark clearly in stderr so we know this override was compiled in.
  fputs("[wasm] channel_from_stdio override active\n", stderr);
  static bool did_stdio = false;
  if (!headless_mode && !embedded_mode) {
    *error = _("can only be opened in headless mode");
    return 0;
  }
  if (did_stdio) {
    *error = _("channel was already open");
    return 0;
  }
  did_stdio = true;

  Channel *channel = channel_alloc(kChannelStreamStdio);
  // Do NOT dup/redirect. Use original fds 0/1.
  rstream_init_fd(&main_loop, &channel->stream.stdio.in, STDIN_FILENO);
  wstream_init_fd(&main_loop, &channel->stream.stdio.out, STDOUT_FILENO, 0);

  if (rpc) {
    rpc_start(channel);
  } else {
    channel->on_data = on_output;
    callback_reader_start(&channel->on_data, "stdin");
    rstream_start(&channel->stream.stdio.in, on_channel_data, channel);
  }

  return channel->id;
}

#pragma pop_macro("channel_from_stdio")
#endif  // defined(__wasi__) && defined(WASM_CHANNEL_STDIO_OVERRIDE) && defined(CHANNEL_STDIO_OVERRIDE_IMPL)
