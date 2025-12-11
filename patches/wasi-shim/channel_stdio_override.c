// Linker wrap override for channel_from_stdio on WASI.
// Avoids dup/redirect tricks so stdio keeps the original RPC fds.

#include "nvim/channel.h"
#include "nvim/channel_defs.h"
#include "nvim/event/loop.h"
#include "nvim/event/stream.h"
#include "nvim/event/rstream.h"
#include "nvim/event/wstream.h"
#include "nvim/gettext_defs.h"
#include "nvim/globals.h"
#include "nvim/main.h"
#include "nvim/msgpack_rpc/channel.h"
#include "nvim/os/os.h"
#include <inttypes.h>

// Forward declaration lives in channel.c.
void callback_reader_start(CallbackReader *reader, const char *type);
size_t on_channel_data(RStream *stream, const char *buf, size_t count, void *data, bool eof);

uint64_t __wrap_channel_from_stdio(bool rpc, CallbackReader on_output, const char **error)
{
  fputs("[wasm] channel_from_stdio override active (wrap)\n", stderr);

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
  // Do NOT dup/redirect. Use original fd 0/1 so the browser-side pipe stays intact.
  rstream_init_fd(&main_loop, &channel->stream.stdio.in, STDIN_FILENO);
  wstream_init_fd(&main_loop, &channel->stream.stdio.out, STDOUT_FILENO, 0);

  if (rpc) {
    rpc_start(channel);
  } else {
  channel->on_data = on_output;
  callback_reader_start(&channel->on_data, "stdin");
  rstream_start(&channel->stream.stdio.in, on_channel_data, channel);
  }

  fprintf(stderr, "[wasm] channel_from_stdio rpc=%d headless=%d embedded=%d id=%" PRIu64 "\n",
          (int)rpc, (int)headless_mode, (int)embedded_mode, channel->id);
  return channel->id;
}
