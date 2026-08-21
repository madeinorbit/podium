/* Spike-only Darwin util.h for zig cc cross-compiles (POD-2501).
 * Real macOS SDK provides this; zig's libc headers do not.
 * forkpty/openpty/login_tty are exported from libSystem. */
#ifndef PODIUM_SPIKE_DARWIN_UTIL_H
#define PODIUM_SPIKE_DARWIN_UTIL_H

#include <sys/types.h>
#include <termios.h>
#include <sys/ioctl.h> /* struct winsize */

pid_t forkpty(int *amaster, char *name, struct termios *termp, struct winsize *winp);
int openpty(int *amaster, int *aslave, char *name, struct termios *termp, struct winsize *winp);
int login_tty(int fd);

#endif
