#pragma once

#include <errno.h>

typedef unsigned char cc_t;
typedef unsigned int speed_t;
typedef unsigned int tcflag_t;

#ifndef NCCS
#  define NCCS 20
#endif

#ifndef VINTR
#  define VINTR 0
#endif
#ifndef VQUIT
#  define VQUIT 1
#endif
#ifndef VERASE
#  define VERASE 2
#endif
#ifndef VKILL
#  define VKILL 3
#endif
#ifndef VEOF
#  define VEOF 4
#endif
#ifndef VTIME
#  define VTIME 5
#endif
#ifndef VMIN
#  define VMIN 6
#endif
#ifndef VSTART
#  define VSTART 8
#endif
#ifndef VSTOP
#  define VSTOP 9
#endif
#ifndef VSUSP
#  define VSUSP 10
#endif
#ifndef VWERASE
#  define VWERASE 14
#endif

#ifndef IXON
#  define IXON 0
#endif
#ifndef INLCR
#  define INLCR 0
#endif
#ifndef ICRNL
#  define ICRNL 0
#endif
#ifndef ICANON
#  define ICANON 0
#endif
#ifndef ECHO
#  define ECHO 0
#endif
#ifndef ISIG
#  define ISIG 0
#endif
#ifndef _POSIX_VDISABLE
#  define _POSIX_VDISABLE 0
#endif
#ifndef TCSANOW
#  define TCSANOW 0
#endif

struct termios {
  tcflag_t c_iflag;
  tcflag_t c_oflag;
  tcflag_t c_cflag;
  tcflag_t c_lflag;
  cc_t c_cc[NCCS];
};

#ifndef TCSAFLUSH
#  define TCSAFLUSH 0
#endif

static inline int tcsetattr(int fd, int optional_actions, const struct termios *termios_p)
{
  (void)fd;
  (void)optional_actions;
  (void)termios_p;
  errno = ENOSYS;
  return -1;
}

static inline int tcgetattr(int fd, struct termios *termios_p)
{
  (void)fd;
  (void)termios_p;
  errno = ENOSYS;
  return -1;
}

static inline speed_t cfgetospeed(const struct termios *t)
{
  (void)t;
  return 0;
}

static inline speed_t cfgetispeed(const struct termios *t)
{
  (void)t;
  return 0;
}

static inline int cfsetospeed(struct termios *t, speed_t s)
{
  (void)t;
  (void)s;
  return 0;
}

static inline int cfsetispeed(struct termios *t, speed_t s)
{
  (void)t;
  (void)s;
  return 0;
}
