/*
 * podium-host — a small durable process host.
 *
 * One process per session. It owns a child (through a pty, or through pipes with
 * --no-pty), keeps a bounded ring of the child's output addressed by a monotonic
 * byte sequence number, serves a framed protocol on one unix socket, grants one
 * writer lease at a time, applies resizes itself and answers with the size the
 * kernel now reports, reports the child's real exit status, lingers briefly so a
 * late client can read it, then unlinks its socket and exits.
 *
 * It knows nothing about podium. The protocol is SPEC-6 (POD-3190 artifact #31).
 *
 * C11, POSIX, Linux and macOS. Single translation unit, libc (+ libutil) only.
 */
#if defined(__linux__)
#define _GNU_SOURCE 1
#endif

#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/types.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>

#if defined(__APPLE__)
#include <sys/ucred.h>
#include <util.h>
#else
#include <pty.h>
#endif

#ifndef VERSION
#define VERSION "1-podium"
#endif
#define HOST_FEATURES 1
#define PROTO_VERSION 1

/* ---- protocol ------------------------------------------------------------ */

enum {
  C_HELLO = 0x01,
  C_WRITE = 0x02,
  C_RESIZE = 0x03,
  C_SIZE = 0x04,
  C_STATUS = 0x05,
  C_SIGNAL = 0x06,
  C_DETACH = 0x07,
  C_KILL = 0x08,
  C_REPLAY = 0x09,

  H_WELCOME = 0x81,
  H_DATA = 0x82,
  H_GAP = 0x83,
  H_RESIZED = 0x84,
  H_SIZE = 0x85,
  H_STATUS = 0x86,
  H_WRITTEN = 0x87,
  H_EXITED = 0x88,
  H_LEASE_LOST = 0x89,
  H_REPLAYING = 0x8A,
  H_REPLAYED = 0x8B,
  H_ERR = 0x8F,
};

enum { ERR_NOT_WRITER = 1, ERR_NO_PTY = 2, ERR_BAD_FRAME = 3, ERR_EXITED = 4 };

enum { MODE_WRITER = 1, MODE_READER = 2 };

#define MAX_FRAME (1u << 20)      /* a client frame larger than this is malformed */
#define DATA_CHUNK (32u * 1024u)   /* bytes per DATA frame */
/* A client whose control queue holds more than a whole ring replay plus slack is not reading. */
#define MAX_OUTBUF_SLACK (1u << 20)
#define MAX_CLIENTS 64
#define KILL_GRACE_MS 5000
#define TAIL_ONLY UINT64_MAX

/* ---- small helpers -------------------------------------------------------- */

static void die(const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  fputs("podium-host: ", stderr);
  vfprintf(stderr, fmt, ap);
  fputc('\n', stderr);
  va_end(ap);
  exit(1);
}

static int64_t now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

static void set_nonblock(int fd) {
  int fl = fcntl(fd, F_GETFL);
  if (fl >= 0) fcntl(fd, F_SETFL, fl | O_NONBLOCK);
}

static void set_cloexec(int fd) {
  int fl = fcntl(fd, F_GETFD);
  if (fl >= 0) fcntl(fd, F_SETFD, fl | FD_CLOEXEC);
}

/* A growable byte buffer. */
typedef struct {
  uint8_t *p;
  size_t len, cap;
} buf_t;

static void buf_reserve(buf_t *b, size_t extra) {
  if (b->len + extra <= b->cap) return;
  size_t cap = b->cap ? b->cap : 256;
  while (cap < b->len + extra) cap *= 2;
  uint8_t *np = realloc(b->p, cap);
  if (!np) die("out of memory");
  b->p = np;
  b->cap = cap;
}
static void buf_put(buf_t *b, const void *d, size_t n) {
  buf_reserve(b, n);
  memcpy(b->p + b->len, d, n);
  b->len += n;
}
static void buf_u8(buf_t *b, uint8_t v) { buf_put(b, &v, 1); }
static void buf_u16(buf_t *b, uint16_t v) {
  uint8_t d[2] = {(uint8_t)(v >> 8), (uint8_t)v};
  buf_put(b, d, 2);
}
static void buf_u32(buf_t *b, uint32_t v) {
  uint8_t d[4] = {(uint8_t)(v >> 24), (uint8_t)(v >> 16), (uint8_t)(v >> 8), (uint8_t)v};
  buf_put(b, d, 4);
}
static void buf_u64(buf_t *b, uint64_t v) {
  buf_u32(b, (uint32_t)(v >> 32));
  buf_u32(b, (uint32_t)v);
}
static void buf_i32(buf_t *b, int32_t v) { buf_u32(b, (uint32_t)v); }
static void buf_consume(buf_t *b, size_t n) {
  if (n >= b->len) {
    b->len = 0;
    return;
  }
  memmove(b->p, b->p + n, b->len - n);
  b->len -= n;
}

static uint16_t rd_u16(const uint8_t *p) { return (uint16_t)((p[0] << 8) | p[1]); }
static uint32_t rd_u32(const uint8_t *p) {
  return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3];
}
static uint64_t rd_u64(const uint8_t *p) { return ((uint64_t)rd_u32(p) << 32) | rd_u32(p + 4); }

/* Begin a frame in `b`; returns the offset of its length word. */
static size_t frame_begin(buf_t *b, uint8_t type) {
  size_t at = b->len;
  buf_u32(b, 0);
  buf_u8(b, type);
  return at;
}
static void frame_end(buf_t *b, size_t at) {
  uint32_t n = (uint32_t)(b->len - at - 4);
  b->p[at] = (uint8_t)(n >> 24);
  b->p[at + 1] = (uint8_t)(n >> 16);
  b->p[at + 2] = (uint8_t)(n >> 8);
  b->p[at + 3] = (uint8_t)n;
}

/* ---- host state ----------------------------------------------------------- */

typedef struct pending_write {
  struct pending_write *next;
  uint32_t client_id; /* 0 = the client is gone, no ack owed */
  uint32_t write_id;
  uint32_t len, off;
  uint8_t *data;
} pending_write_t;

typedef struct client {
  int fd;
  uint32_t id;
  bool hello_done;
  bool writer;      /* holds the lease */
  bool exit_owed;   /* EXITED not yet queued for this client */
  bool closing;     /* flush outbuf then close (DETACH) */
  uint64_t next_seq; /* data cursor into the ring */
  buf_t in;         /* partial frames */
  buf_t out;        /* control frames + the DATA frame being sent */
} client_t;

static struct {
  const char *sock_path;
  int listen_fd;
  int io_fd;        /* pty master, or the child's stdout+stderr pipe */
  int in_fd;        /* pty master again, or the child's stdin pipe; -1 once closed */
  bool has_pty;
  pid_t child;
  bool child_exited; /* waitpid collected */
  bool io_closed;    /* output drained and closed */
  bool exit_announced;
  int exit_code;   /* -1 while alive */
  int exit_signal; /* 0 unless killed by a signal */
  struct winsize ws;

  uint8_t *ring;
  size_t ring_size;
  uint64_t seq_high; /* bytes ever appended */

  client_t *clients[MAX_CLIENTS];
  int nclients;
  uint32_t next_client_id;
  client_t *writer;

  pending_write_t *wq_head, *wq_tail;

  int sig_pipe[2];
  int64_t kill_deadline_ms;   /* SIGKILL the child at this time; 0 = none */
  bool kill_requested;
  int64_t linger_deadline_ms; /* unlink + exit at this time; 0 = not yet */
  int linger_secs;
} H;

static uint64_t seq_low(void) {
  return H.seq_high > H.ring_size ? H.seq_high - H.ring_size : 0;
}

static void ring_append(const uint8_t *d, size_t n) {
  size_t total = n; /* every byte gets a number, kept or not */
  if (n >= H.ring_size) {
    d += n - H.ring_size;
    n = H.ring_size;
  }
  size_t at = (size_t)(H.seq_high % H.ring_size);
  size_t first = H.ring_size - at;
  if (first > n) first = n;
  memcpy(H.ring + at, d, first);
  if (n > first) memcpy(H.ring, d + first, n - first);
  H.seq_high += total;
}

static void ring_copy(uint64_t seq, uint8_t *dst, size_t n) {
  size_t at = (size_t)(seq % H.ring_size);
  size_t first = H.ring_size - at;
  if (first > n) first = n;
  memcpy(dst, H.ring + at, first);
  if (n > first) memcpy(dst + first, H.ring, n - first);
}

/* ---- signals ---------------------------------------------------------------- */

static volatile sig_atomic_t got_term = 0;

static void on_signal(int signo) {
  uint8_t b = (uint8_t)signo;
  if (signo == SIGTERM || signo == SIGINT || signo == SIGHUP) got_term = 1;
  ssize_t r = write(H.sig_pipe[1], &b, 1);
  (void)r;
}

static void install_signals(void) {
  if (pipe(H.sig_pipe) != 0) die("pipe: %s", strerror(errno));
  set_nonblock(H.sig_pipe[0]);
  set_nonblock(H.sig_pipe[1]);
  set_cloexec(H.sig_pipe[0]);
  set_cloexec(H.sig_pipe[1]);
  struct sigaction sa;
  memset(&sa, 0, sizeof sa);
  sa.sa_handler = on_signal;
  sigemptyset(&sa.sa_mask);
  sigaction(SIGCHLD, &sa, NULL);
  sigaction(SIGTERM, &sa, NULL);
  sigaction(SIGINT, &sa, NULL);
  sigaction(SIGHUP, &sa, NULL);
  signal(SIGPIPE, SIG_IGN);
}

/* ---- clients --------------------------------------------------------------- */

static void send_err(client_t *c, uint16_t code, const char *msg) {
  size_t at = frame_begin(&c->out, H_ERR);
  buf_u16(&c->out, code);
  uint32_t n = (uint32_t)strlen(msg);
  buf_u32(&c->out, n);
  buf_put(&c->out, msg, n);
  frame_end(&c->out, at);
}

static void client_release_lease(client_t *c) {
  if (c->writer) {
    c->writer = false;
    if (H.writer == c) H.writer = NULL;
  }
}

static void client_close(client_t *c) {
  client_release_lease(c);
  for (pending_write_t *w = H.wq_head; w; w = w->next)
    if (w->client_id == c->id) w->client_id = 0;
  close(c->fd);
  free(c->in.p);
  free(c->out.p);
  for (int i = 0; i < H.nclients; i++) {
    if (H.clients[i] == c) {
      H.clients[i] = H.clients[--H.nclients];
      break;
    }
  }
  free(c);
}

static int count_clients(bool writers) {
  int n = 0;
  for (int i = 0; i < H.nclients; i++)
    if (H.clients[i]->hello_done && H.clients[i]->writer == writers) n++;
  return n;
}

static bool peer_is_us(int fd) {
  uid_t me = geteuid();
#if defined(__APPLE__)
  struct xucred xu;
  socklen_t len = sizeof xu;
  if (getsockopt(fd, 0, LOCAL_PEERCRED, &xu, &len) != 0) return false;
  return xu.cr_uid == me || xu.cr_uid == 0;
#else
  struct ucred cr;
  socklen_t len = sizeof cr;
  if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &cr, &len) != 0) return false;
  return cr.uid == me || cr.uid == 0;
#endif
}

static void accept_client(void) {
  int fd = accept(H.listen_fd, NULL, NULL);
  if (fd < 0) return;
  if (H.nclients >= MAX_CLIENTS || !peer_is_us(fd)) {
    close(fd);
    return;
  }
  set_nonblock(fd);
  set_cloexec(fd);
  client_t *c = calloc(1, sizeof *c);
  if (!c) die("out of memory");
  c->fd = fd;
  c->id = ++H.next_client_id;
  H.clients[H.nclients++] = c;
}

static void queue_status(client_t *c) {
  size_t at = frame_begin(&c->out, H_STATUS);
  buf_u8(&c->out, H.child_exited ? 0 : 1);
  buf_i32(&c->out, H.child_exited ? H.exit_code : -1);
  buf_u8(&c->out, (uint8_t)H.exit_signal);
  buf_u64(&c->out, seq_low());
  buf_u64(&c->out, H.seq_high);
  buf_u8(&c->out, (uint8_t)count_clients(true));
  buf_u8(&c->out, (uint8_t)count_clients(false));
  frame_end(&c->out, at);
}

static bool read_winsize(struct winsize *ws) {
  if (!H.has_pty || H.io_closed) return false;
  return ioctl(H.io_fd, TIOCGWINSZ, ws) == 0;
}

static void handle_hello(client_t *c, const uint8_t *p, uint32_t n) {
  if (n != 2 + 1 + 8) {
    send_err(c, ERR_BAD_FRAME, "bad HELLO");
    c->closing = true;
    return;
  }
  uint16_t version = rd_u16(p);
  uint8_t mode = p[2];
  uint64_t from = rd_u64(p + 3);
  if (version != PROTO_VERSION || (mode != MODE_WRITER && mode != MODE_READER)) {
    send_err(c, ERR_BAD_FRAME, "unsupported HELLO");
    c->closing = true;
    return;
  }
  c->hello_done = true;
  if (mode == MODE_WRITER && H.writer == NULL) {
    H.writer = c;
    c->writer = true;
  }
  struct winsize ws = H.ws;
  read_winsize(&ws);
  size_t at = frame_begin(&c->out, H_WELCOME);
  buf_u16(&c->out, PROTO_VERSION);
  buf_u32(&c->out, (uint32_t)getpid());
  buf_u32(&c->out, (uint32_t)H.child);
  buf_u8(&c->out, H.has_pty ? 1 : 0);
  buf_u16(&c->out, H.has_pty ? ws.ws_col : 0);
  buf_u16(&c->out, H.has_pty ? ws.ws_row : 0);
  buf_u64(&c->out, seq_low());
  buf_u64(&c->out, H.seq_high);
  buf_u8(&c->out, c->writer ? 1 : 0);
  frame_end(&c->out, at);

  uint64_t low = seq_low();
  if (from == TAIL_ONLY || from > H.seq_high) {
    c->next_seq = H.seq_high;
  } else if (from < low) {
    at = frame_begin(&c->out, H_GAP);
    buf_u64(&c->out, low);
    frame_end(&c->out, at);
    c->next_seq = low;
  } else {
    c->next_seq = from;
  }
  if (H.exit_announced) c->exit_owed = true;
}

static void enqueue_write(client_t *c, uint32_t id, const uint8_t *d, uint32_t n) {
  pending_write_t *w = calloc(1, sizeof *w);
  if (!w) die("out of memory");
  w->client_id = c->id;
  w->write_id = id;
  w->len = n;
  w->data = malloc(n ? n : 1);
  if (!w->data) die("out of memory");
  memcpy(w->data, d, n);
  if (H.wq_tail) H.wq_tail->next = w;
  else H.wq_head = w;
  H.wq_tail = w;
}

static void kill_child(int signo) {
  if (H.child_exited || H.child <= 0) return;
  if (kill(-H.child, signo) != 0) kill(H.child, signo);
}

static void request_kill(void) {
  if (H.kill_requested) return;
  H.kill_requested = true;
  kill_child(SIGTERM);
  H.kill_deadline_ms = now_ms() + KILL_GRACE_MS;
}

static void handle_frame(client_t *c, uint8_t type, const uint8_t *p, uint32_t n) {
  if (!c->hello_done) {
    if (type != C_HELLO) {
      send_err(c, ERR_BAD_FRAME, "HELLO must be first");
      c->closing = true;
      return;
    }
    handle_hello(c, p, n);
    return;
  }
  switch (type) {
    case C_HELLO:
      send_err(c, ERR_BAD_FRAME, "duplicate HELLO");
      c->closing = true;
      return;
    case C_WRITE: {
      if (n < 4) goto bad;
      uint32_t id = rd_u32(p);
      if (!c->writer) {
        send_err(c, ERR_NOT_WRITER, "not the writer");
        return;
      }
      if (H.child_exited || H.in_fd < 0) {
        send_err(c, ERR_EXITED, "child exited");
        return;
      }
      enqueue_write(c, id, p + 4, n - 4);
      return;
    }
    case C_RESIZE: {
      if (n != 4) goto bad;
      if (!c->writer) {
        send_err(c, ERR_NOT_WRITER, "not the writer");
        return;
      }
      if (!H.has_pty) {
        send_err(c, ERR_NO_PTY, "no pty");
        return;
      }
      if (H.child_exited || H.io_closed) {
        send_err(c, ERR_EXITED, "child exited");
        return;
      }
      uint16_t cols = rd_u16(p), rows = rd_u16(p + 2);
      struct winsize cur;
      if (!read_winsize(&cur)) cur = H.ws;
      uint8_t changed = 0;
      if (cur.ws_col != cols || cur.ws_row != rows) {
        /* Only here does the kernel see anything: TIOCSWINSZ on a changed size
         * is what signals the foreground process group. A same-size RESIZE
         * issues no ioctl and therefore no signal. */
        struct winsize want = cur;
        want.ws_col = cols;
        want.ws_row = rows;
        if (ioctl(H.io_fd, TIOCSWINSZ, &want) == 0) changed = 1;
        read_winsize(&cur);
      }
      H.ws = cur;
      size_t at = frame_begin(&c->out, H_RESIZED);
      buf_u16(&c->out, cur.ws_col);
      buf_u16(&c->out, cur.ws_row);
      buf_u8(&c->out, changed);
      frame_end(&c->out, at);
      return;
    }
    case C_SIZE: {
      if (!H.has_pty) {
        send_err(c, ERR_NO_PTY, "no pty");
        return;
      }
      struct winsize cur = H.ws;
      read_winsize(&cur);
      size_t at = frame_begin(&c->out, H_SIZE);
      buf_u16(&c->out, cur.ws_col);
      buf_u16(&c->out, cur.ws_row);
      frame_end(&c->out, at);
      return;
    }
    case C_STATUS:
      queue_status(c);
      return;
    case C_SIGNAL: {
      if (n != 1) goto bad;
      if (!c->writer) {
        send_err(c, ERR_NOT_WRITER, "not the writer");
        return;
      }
      if (H.child_exited) {
        send_err(c, ERR_EXITED, "child exited");
        return;
      }
      kill_child(p[0]);
      return;
    }
    case C_DETACH:
      client_release_lease(c);
      c->closing = true;
      return;
    case C_REPLAY: {
      /* Re-send the last `tail` bytes of the ring ON THIS CONNECTION with their
       * original seqs, bracketed by REPLAYING/REPLAYED. Independent of the
       * client's live cursor; touches the child in no way. */
      if (n != 4) goto bad;
      uint32_t tail = rd_u32(p);
      uint64_t low = seq_low();
      uint64_t from = (H.seq_high - low > tail) ? H.seq_high - tail : low;
      size_t at = frame_begin(&c->out, H_REPLAYING);
      buf_u64(&c->out, from);
      frame_end(&c->out, at);
      for (uint64_t seq = from; seq < H.seq_high;) {
        uint64_t avail = H.seq_high - seq;
        size_t len = avail > DATA_CHUNK ? DATA_CHUNK : (size_t)avail;
        at = frame_begin(&c->out, H_DATA);
        buf_u64(&c->out, seq);
        buf_reserve(&c->out, len);
        ring_copy(seq, c->out.p + c->out.len, len);
        c->out.len += len;
        frame_end(&c->out, at);
        seq += len;
      }
      at = frame_begin(&c->out, H_REPLAYED);
      frame_end(&c->out, at);
      return;
    }
    case C_KILL:
      if (!c->writer) {
        send_err(c, ERR_NOT_WRITER, "not the writer");
        return;
      }
      request_kill();
      return;
    default:
      goto bad;
  }
bad:
  send_err(c, ERR_BAD_FRAME, "bad frame");
  c->closing = true;
}

/* Parse every complete frame in c->in. Returns false when the client must go. */
static bool client_parse(client_t *c) {
  for (;;) {
    if (c->in.len < 5) return true;
    uint32_t len = rd_u32(c->in.p);
    if (len < 1 || len > MAX_FRAME) {
      send_err(c, ERR_BAD_FRAME, "bad length");
      c->closing = true;
      return true;
    }
    if (c->in.len < 4 + (size_t)len) return true;
    uint8_t type = c->in.p[4];
    handle_frame(c, type, c->in.p + 5, len - 1);
    buf_consume(&c->in, 4 + (size_t)len);
    if (c->closing) return true;
  }
}

static void client_read(client_t *c) {
  uint8_t tmp[65536];
  ssize_t r = read(c->fd, tmp, sizeof tmp);
  if (r == 0 || (r < 0 && errno != EAGAIN && errno != EINTR)) {
    client_close(c);
    return;
  }
  if (r < 0) return;
  if (c->closing) return; /* draining; ignore further input */
  buf_put(&c->in, tmp, (size_t)r);
  if (!client_parse(c)) client_close(c);
}

/* Fill c->out from the ring when it is empty and the cursor lags. */
static void client_fill(client_t *c) {
  if (c->out.len > 0 || !c->hello_done) return;
  if (c->next_seq < seq_low()) {
    size_t at = frame_begin(&c->out, H_GAP);
    buf_u64(&c->out, seq_low());
    frame_end(&c->out, at);
    c->next_seq = seq_low();
    return;
  }
  if (c->next_seq < H.seq_high) {
    uint64_t avail = H.seq_high - c->next_seq;
    size_t n = avail > DATA_CHUNK ? DATA_CHUNK : (size_t)avail;
    size_t at = frame_begin(&c->out, H_DATA);
    buf_u64(&c->out, c->next_seq);
    buf_reserve(&c->out, n);
    ring_copy(c->next_seq, c->out.p + c->out.len, n);
    c->out.len += n;
    frame_end(&c->out, at);
    c->next_seq += n;
    return;
  }
  if (c->exit_owed && H.exit_announced) {
    size_t at = frame_begin(&c->out, H_EXITED);
    buf_i32(&c->out, H.exit_code);
    buf_u8(&c->out, (uint8_t)H.exit_signal);
    frame_end(&c->out, at);
    c->exit_owed = false;
  }
}

static bool client_wants_out(client_t *c) {
  if (c->out.len > 0) return true;
  if (!c->hello_done) return false;
  if (c->next_seq < H.seq_high) return true;
  return c->exit_owed && H.exit_announced;
}

static void client_write(client_t *c) {
  client_fill(c);
  while (c->out.len > 0) {
    ssize_t w = write(c->fd, c->out.p, c->out.len);
    if (w < 0) {
      if (errno == EAGAIN || errno == EINTR) return;
      client_close(c);
      return;
    }
    buf_consume(&c->out, (size_t)w);
    if (c->out.len == 0) client_fill(c);
  }
}

/* ---- child I/O -------------------------------------------------------------- */

static void announce_exit_if_ready(void) {
  if (H.exit_announced || !H.child_exited || !H.io_closed) return;
  H.exit_announced = true;
  for (int i = 0; i < H.nclients; i++)
    if (H.clients[i]->hello_done) H.clients[i]->exit_owed = true;
  int64_t linger = H.kill_requested || got_term ? 1000 : (int64_t)H.linger_secs * 1000;
  H.linger_deadline_ms = now_ms() + linger;
}

static void close_io(void) {
  if (H.io_closed) return;
  H.io_closed = true;
  if (H.in_fd >= 0 && H.in_fd != H.io_fd) close(H.in_fd);
  H.in_fd = -1;
  close(H.io_fd);
  H.io_fd = -1;
  while (H.wq_head) {
    pending_write_t *w = H.wq_head;
    H.wq_head = w->next;
    free(w->data);
    free(w);
  }
  H.wq_tail = NULL;
  announce_exit_if_ready();
}

/* Read what the child wrote; on EOF/EIO the output side is finished. */
static void io_read(bool drain_all) {
  uint8_t tmp[65536];
  for (;;) {
    ssize_t r = read(H.io_fd, tmp, sizeof tmp);
    if (r > 0) {
      ring_append(tmp, (size_t)r);
      if (!drain_all) return;
      continue;
    }
    if (r < 0 && (errno == EAGAIN || errno == EINTR)) {
      if (drain_all) close_io();
      return;
    }
    close_io(); /* EOF, or EIO once the slave side is gone */
    return;
  }
}

static void io_write(void) {
  while (H.wq_head && H.in_fd >= 0) {
    pending_write_t *w = H.wq_head;
    if (w->off < w->len) {
      ssize_t n = write(H.in_fd, w->data + w->off, w->len - w->off);
      if (n < 0) {
        if (errno == EAGAIN || errno == EINTR) return;
        /* The child's input side is gone; the ack is that nothing more can be written. */
        for (pending_write_t *x = H.wq_head; x; x = x->next) x->len = x->off;
        n = 0;
      }
      w->off += (uint32_t)n;
      if (w->off < w->len) return;
    }
    H.wq_head = w->next;
    if (!H.wq_head) H.wq_tail = NULL;
    if (w->client_id) {
      for (int i = 0; i < H.nclients; i++) {
        client_t *c = H.clients[i];
        if (c->id != w->client_id) continue;
        size_t at = frame_begin(&c->out, H_WRITTEN);
        buf_u32(&c->out, w->write_id);
        buf_u32(&c->out, w->off);
        frame_end(&c->out, at);
        break;
      }
    }
    free(w->data);
    free(w);
  }
}

static void reap_child(void) {
  int status;
  pid_t r;
  while ((r = waitpid(-1, &status, WNOHANG)) > 0) {
    if (r != H.child) continue;
    H.child_exited = true;
    H.kill_deadline_ms = 0;
    if (WIFEXITED(status)) {
      H.exit_code = WEXITSTATUS(status);
      H.exit_signal = 0;
    } else if (WIFSIGNALED(status)) {
      H.exit_signal = WTERMSIG(status);
      H.exit_code = 128 + H.exit_signal;
    }
    /* Whatever the child wrote before exiting is already in the kernel buffer:
     * take all of it now, then treat the output side as finished even if a
     * grandchild still holds the slave open. */
    if (!H.io_closed) io_read(true);
    announce_exit_if_ready();
  }
}

static void handle_signals(void) {
  uint8_t tmp[64];
  while (read(H.sig_pipe[0], tmp, sizeof tmp) > 0) {
  }
  if (got_term && !H.kill_requested) request_kill();
  reap_child();
}

/* ---- startup ---------------------------------------------------------------- */

static int connect_probe(const char *path) {
  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) die("socket: %s", strerror(errno));
  struct sockaddr_un sa;
  memset(&sa, 0, sizeof sa);
  sa.sun_family = AF_UNIX;
  strncpy(sa.sun_path, path, sizeof sa.sun_path - 1);
  int r = connect(fd, (struct sockaddr *)&sa, sizeof sa);
  int err = errno;
  close(fd);
  if (r == 0) return 0;
  errno = err;
  return -1;
}

static void bind_socket(const char *path) {
  struct sockaddr_un sa;
  if (strlen(path) >= sizeof sa.sun_path)
    die("socket path is too long: %zu bytes, the limit is %zu", strlen(path), sizeof sa.sun_path - 1);
  struct stat st;
  if (lstat(path, &st) == 0) {
    if (!S_ISSOCK(st.st_mode)) die("%s exists and is not a socket", path);
    if (connect_probe(path) == 0) {
      fprintf(stderr, "podium-host: already running at %s\n", path);
      exit(3);
    }
    if (errno != ECONNREFUSED && errno != ENOENT)
      die("%s: cannot probe the existing socket: %s", path, strerror(errno));
    if (unlink(path) != 0 && errno != ENOENT) die("unlink %s: %s", path, strerror(errno));
  } else if (errno != ENOENT) {
    die("%s: %s", path, strerror(errno));
  }
  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) die("socket: %s", strerror(errno));
  memset(&sa, 0, sizeof sa);
  sa.sun_family = AF_UNIX;
  strncpy(sa.sun_path, path, sizeof sa.sun_path - 1);
  mode_t old = umask(0077);
  int r = bind(fd, (struct sockaddr *)&sa, sizeof sa);
  umask(old);
  if (r != 0) die("bind %s: %s", path, strerror(errno));
  chmod(path, 0600);
  if (listen(fd, 16) != 0) die("listen %s: %s", path, strerror(errno));
  set_nonblock(fd);
  set_cloexec(fd);
  H.listen_fd = fd;
}

static void usage(void) {
  fputs(
      "usage: podium-host create --socket <path> [--cols N --rows N | --no-pty]\n"
      "                          [--ring-bytes N] [--linger-secs N] [--cwd <dir>] -- <cmd> [args...]\n"
      "       podium-host version\n",
      stderr);
  exit(2);
}

static long arg_long(const char *name, const char *v, long lo, long hi) {
  char *end = NULL;
  errno = 0;
  long n = strtol(v, &end, 10);
  if (errno != 0 || !end || *end != '\0' || n < lo || n > hi) die("bad value for %s: %s", name, v);
  return n;
}

/* Spawn the child on a pty or on pipes. Reports an exec failure through a
 * CLOEXEC pipe so `create` can fail instead of hosting a dead child. */
static void spawn_child(char **argv, int cwd_fd, bool no_pty, const struct winsize *ws) {
  int exec_err[2];
  if (pipe(exec_err) != 0) die("pipe: %s", strerror(errno));
  set_cloexec(exec_err[0]);
  set_cloexec(exec_err[1]);

  int in_pipe[2] = {-1, -1}, out_pipe[2] = {-1, -1};
  int master = -1;
  pid_t pid;
  if (no_pty) {
    if (pipe(in_pipe) != 0 || pipe(out_pipe) != 0) die("pipe: %s", strerror(errno));
    pid = fork();
    if (pid < 0) die("fork: %s", strerror(errno));
    if (pid == 0) {
      setsid();
      dup2(in_pipe[0], 0);
      dup2(out_pipe[1], 1);
      dup2(out_pipe[1], 2);
      close(in_pipe[0]);
      close(in_pipe[1]);
      close(out_pipe[0]);
      close(out_pipe[1]);
    }
  } else {
    struct winsize w = *ws;
    pid = forkpty(&master, NULL, NULL, &w);
    if (pid < 0) die("forkpty: %s", strerror(errno));
  }
  if (pid == 0) {
    /* child */
    close(exec_err[0]);
    if (fchdir(cwd_fd) != 0) {
      int e = errno;
      ssize_t r = write(exec_err[1], &e, sizeof e);
      (void)r;
      _exit(127);
    }
    close(cwd_fd);
    signal(SIGPIPE, SIG_DFL);
    signal(SIGINT, SIG_DFL);
    signal(SIGTERM, SIG_DFL);
    signal(SIGHUP, SIG_DFL);
    signal(SIGCHLD, SIG_DFL);
    execvp(argv[0], argv);
    int e = errno;
    ssize_t r = write(exec_err[1], &e, sizeof e);
    (void)r;
    _exit(127);
  }
  close(exec_err[1]);
  int e = 0;
  ssize_t r;
  do {
    r = read(exec_err[0], &e, sizeof e);
  } while (r < 0 && errno == EINTR);
  close(exec_err[0]);
  if (r > 0) {
    int status;
    waitpid(pid, &status, 0);
    die("cannot run %s: %s", argv[0], strerror(e));
  }
  H.child = pid;
  if (no_pty) {
    close(in_pipe[0]);
    close(out_pipe[1]);
    H.io_fd = out_pipe[0];
    H.in_fd = in_pipe[1];
    H.has_pty = false;
  } else {
    H.io_fd = master;
    H.in_fd = master;
    H.has_pty = true;
    H.ws = *ws;
    read_winsize(&H.ws);
  }
  set_nonblock(H.io_fd);
  set_cloexec(H.io_fd);
  if (H.in_fd != H.io_fd) {
    set_nonblock(H.in_fd);
    set_cloexec(H.in_fd);
  }
}

static void cleanup_and_exit(int code) {
  if (H.sock_path) unlink(H.sock_path);
  exit(code);
}

static void event_loop(void) {
  struct pollfd pfds[MAX_CLIENTS + 3];
  for (;;) {
    int64_t now = now_ms();
    if (H.kill_deadline_ms && now >= H.kill_deadline_ms) {
      H.kill_deadline_ms = 0;
      kill_child(SIGKILL);
    }
    if (H.linger_deadline_ms) {
      bool all_delivered = true;
      for (int i = 0; i < H.nclients; i++)
        if (H.clients[i]->hello_done && (H.clients[i]->exit_owed || H.clients[i]->out.len))
          all_delivered = false;
      if (now >= H.linger_deadline_ms && all_delivered) cleanup_and_exit(0);
      if (now >= H.linger_deadline_ms + 2000) cleanup_and_exit(0); /* a stuck client does not pin us */
    }

    int n = 0;
    pfds[n].fd = H.listen_fd;
    pfds[n].events = POLLIN;
    n++;
    pfds[n].fd = H.sig_pipe[0];
    pfds[n].events = POLLIN;
    n++;
    int io_idx = -1;
    if (!H.io_closed) {
      io_idx = n;
      pfds[n].fd = H.io_fd;
      pfds[n].events = POLLIN;
      if (H.wq_head && H.in_fd == H.io_fd) pfds[n].events |= POLLOUT;
      n++;
    }
    int in_idx = -1;
    if (!H.io_closed && H.in_fd >= 0 && H.in_fd != H.io_fd && H.wq_head) {
      in_idx = n;
      pfds[n].fd = H.in_fd;
      pfds[n].events = POLLOUT;
      n++;
    }
    int first_client = n;
    for (int i = 0; i < H.nclients; i++) {
      client_t *c = H.clients[i];
      pfds[n].fd = c->fd;
      pfds[n].events = c->closing ? 0 : POLLIN;
      if (client_wants_out(c)) pfds[n].events |= POLLOUT;
      n++;
    }

    int timeout = -1;
    int64_t next = 0;
    if (H.kill_deadline_ms) next = H.kill_deadline_ms;
    if (H.linger_deadline_ms && (!next || H.linger_deadline_ms < next)) next = H.linger_deadline_ms;
    if (next) {
      int64_t d = next - now;
      timeout = d < 0 ? 0 : (d > 60000 ? 60000 : (int)d);
    }

    int r = poll(pfds, (nfds_t)n, timeout);
    if (r < 0) {
      if (errno == EINTR) {
        handle_signals();
        continue;
      }
      die("poll: %s", strerror(errno));
    }
    handle_signals();
    if (pfds[1].revents & POLLIN) handle_signals();
    if (io_idx >= 0 && !H.io_closed && (pfds[io_idx].revents & (POLLIN | POLLHUP | POLLERR)))
      io_read(false);
    if (!H.io_closed && H.wq_head) {
      int idx = in_idx >= 0 ? in_idx : io_idx;
      if (idx >= 0 && (pfds[idx].revents & (POLLOUT | POLLERR | POLLHUP))) io_write();
    }
    if (pfds[0].revents & POLLIN) accept_client();

    /* Clients: iterate over a snapshot, since a close reorders the array. */
    client_t *snap[MAX_CLIENTS];
    int fds[MAX_CLIENTS];
    short revs[MAX_CLIENTS];
    int cnt = 0;
    for (int i = 0; i < n - first_client && i < H.nclients; i++) {
      snap[cnt] = H.clients[i];
      fds[cnt] = pfds[first_client + i].fd;
      revs[cnt] = pfds[first_client + i].revents;
      cnt++;
    }
    for (int i = 0; i < cnt; i++) {
      client_t *c = snap[i];
      bool alive = false;
      for (int j = 0; j < H.nclients; j++)
        if (H.clients[j] == c) alive = true;
      if (!alive || c->fd != fds[i]) continue;
      if (revs[i] & (POLLERR | POLLNVAL)) {
        client_close(c);
        continue;
      }
      if (revs[i] & (POLLIN | POLLHUP)) {
        client_read(c);
        alive = false;
        for (int j = 0; j < H.nclients; j++)
          if (H.clients[j] == c) alive = true;
        if (!alive) continue;
      }
      if (client_wants_out(c)) client_write(c);
      alive = false;
      for (int j = 0; j < H.nclients; j++)
        if (H.clients[j] == c) alive = true;
      if (!alive) continue;
      if (c->closing && c->out.len == 0) {
        client_close(c);
        continue;
      }
      if (c->out.len > H.ring_size + MAX_OUTBUF_SLACK) client_close(c);
    }
  }
}

/* Double-fork into the background; the original process waits for the
 * daemonized host to report "started" (or an error) and exits accordingly. */
static void daemonize_then_run(char **argv, int cwd_fd, bool no_pty, const struct winsize *ws) {
  int report[2];
  if (pipe(report) != 0) die("pipe: %s", strerror(errno));
  /* CLOEXEC on both ends: the child must not inherit the report pipe, or the
   * original process would wait for EOF until the whole session ended. */
  set_cloexec(report[0]);
  set_cloexec(report[1]);
  pid_t p1 = fork();
  if (p1 < 0) die("fork: %s", strerror(errno));
  if (p1 > 0) {
    close(report[1]);
    char msg[4096];
    size_t got = 0;
    for (;;) {
      ssize_t r = read(report[0], msg + got, sizeof msg - 1 - got);
      if (r < 0 && errno == EINTR) continue;
      if (r <= 0) break;
      got += (size_t)r;
      if (got >= sizeof msg - 1) break;
    }
    msg[got] = '\0';
    int status;
    waitpid(p1, &status, 0);
    if (got >= 3 && memcmp(msg, "OK\n", 3) == 0) exit(0);
    if (got > 0) fputs(msg, stderr);
    else fputs("podium-host: the host exited before reporting\n", stderr);
    if (H.sock_path) unlink(H.sock_path);
    exit(1);
  }
  /* first child */
  if (setsid() < 0) _exit(1);
  pid_t p2 = fork();
  if (p2 < 0) _exit(1);
  if (p2 > 0) _exit(0);
  /* the host */
  close(report[0]);
  int devnull = open("/dev/null", O_RDWR | O_CLOEXEC);
  if (devnull >= 0) {
    dup2(devnull, 0);
    dup2(devnull, 1);
    /* stderr keeps going to the report pipe until we are up, then /dev/null */
  }
  int saved_err = dup(2);
  if (saved_err >= 0) set_cloexec(saved_err);
  dup2(report[1], 2);
  set_cloexec(2);
  install_signals();
  spawn_child(argv, cwd_fd, no_pty, ws); /* dies (to the report pipe) on failure */
  close(cwd_fd);
  if (chdir("/") != 0) {
    /* harmless */
  }
  ssize_t w = write(report[1], "OK\n", 3);
  (void)w;
  if (devnull >= 0) dup2(devnull, 2);
  else if (saved_err >= 0) dup2(saved_err, 2);
  if (saved_err >= 0) close(saved_err);
  if (devnull >= 0 && devnull > 2) close(devnull);
  close(report[1]);
  event_loop();
}

int main(int argc, char **argv) {
  if (argc < 2) usage();
  if (strcmp(argv[1], "version") == 0) {
    printf("podium-host %s features=%d\n", VERSION, HOST_FEATURES);
    return 0;
  }
  if (strcmp(argv[1], "create") != 0) usage();

  const char *sock = NULL, *cwd = NULL;
  long cols = 0, rows = 0, ring = 4l << 20, linger = 30;
  bool no_pty = false;
  int i = 2;
  for (; i < argc; i++) {
    const char *a = argv[i];
    if (strcmp(a, "--") == 0) {
      i++;
      break;
    }
    const char *v = (i + 1 < argc) ? argv[i + 1] : NULL;
    if (strcmp(a, "--socket") == 0 && v) sock = argv[++i];
    else if (strcmp(a, "--cwd") == 0 && v) cwd = argv[++i];
    else if (strcmp(a, "--cols") == 0 && v) cols = arg_long(a, argv[++i], 1, 65535);
    else if (strcmp(a, "--rows") == 0 && v) rows = arg_long(a, argv[++i], 1, 65535);
    else if (strcmp(a, "--ring-bytes") == 0 && v) ring = arg_long(a, argv[++i], 4096, 1l << 30);
    else if (strcmp(a, "--linger-secs") == 0 && v) linger = arg_long(a, argv[++i], 0, 86400);
    else if (strcmp(a, "--no-pty") == 0) no_pty = true;
    else usage();
  }
  if (!sock || i >= argc) usage();
  if (no_pty && (cols || rows)) die("--no-pty and --cols/--rows are exclusive");
  char **cmd = argv + i;

  H.sock_path = sock;
  H.exit_code = -1;
  H.in_fd = -1;
  H.linger_secs = (int)linger;
  H.ring_size = (size_t)ring;
  H.ring = malloc(H.ring_size);
  if (!H.ring) die("cannot allocate a %ld byte ring", ring);
  struct winsize ws;
  memset(&ws, 0, sizeof ws);
  ws.ws_col = (unsigned short)(cols ? cols : 80);
  ws.ws_row = (unsigned short)(rows ? rows : 24);

  int cwd_fd = open(cwd ? cwd : ".", O_RDONLY | O_DIRECTORY);
  if (cwd_fd < 0) die("cwd %s: %s", cwd ? cwd : ".", strerror(errno));
  set_cloexec(cwd_fd);

  bind_socket(sock);
  daemonize_then_run(cmd, cwd_fd, no_pty, &ws);
  return 0;
}
