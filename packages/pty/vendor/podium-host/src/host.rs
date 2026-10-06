//! Host state and the single-threaded poll loop: the child's output into the
//! ring, clients, the writer lease, the write queue, exit and linger, and (in
//! `screen` builds) the kept screen and the pictures sent from it.

use std::collections::VecDeque;
use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::time::{Duration, Instant};

#[cfg(feature = "screen")]
use crate::cut::CutClock;
use crate::proto::{self, Frame, Next, Request};
use crate::ring::Ring;
use crate::sys::{self, Io, Listener, Pid, PollFlags, SignalSource, Stream, Winsize};
#[cfg(unix)]
use crate::sys::{PollFd, Timespec};

const MAX_CLIENTS: usize = 64;
const KILL_GRACE: Duration = Duration::from_millis(5000);
const SHORT_LINGER: Duration = Duration::from_millis(1000);
/// A stuck client does not pin the host past its linger by more than this.
const STUCK_GRACE: Duration = Duration::from_millis(2000);
/// poll() wakes at least this often while a deadline is pending.
const MAX_WAIT: Duration = Duration::from_secs(60);
const READ_CHUNK: usize = 65536;

/// Bytes queued for one client. Sent from a cursor, so a partial write costs
/// nothing; the buffer is reset once everything in it has gone, and the sent
/// prefix is dropped once it is both large and a quarter of the buffer (also
/// before appending, so new frames reuse the space). A client that never quite
/// drains therefore cannot pin what it was already sent (the queue limits
/// count only unsent bytes): the buffer stays within 4/3 of what is pending,
/// at no more than three moves per byte, amortized.
#[derive(Default)]
struct Outbox {
    buf: Vec<u8>,
    sent: usize,
    /// Bytes ever queued before `buf[0]`: positions in the stream of
    /// everything queued survive the resets and compactions.
    base: u64,
}

impl Outbox {
    fn pending(&self) -> &[u8] {
        &self.buf[self.sent..]
    }
    fn is_empty(&self) -> bool {
        self.sent == self.buf.len()
    }
    fn len(&self) -> usize {
        self.buf.len() - self.sent
    }
    fn advance(&mut self, n: usize) {
        self.sent += n;
        if self.is_empty() {
            self.base += self.buf.len() as u64;
            self.buf.clear();
            self.sent = 0;
            // A replay or a picture made it large once: do not keep that.
            if self.buf.capacity() > 4 * Self::COMPACT_AT {
                self.buf.shrink_to(Self::COMPACT_AT);
            }
        } else {
            self.compact();
        }
    }
    const COMPACT_AT: usize = 64 * 1024;
    fn compact(&mut self) {
        if self.sent >= Self::COMPACT_AT && self.sent * 4 >= self.buf.len() {
            self.buf.drain(..self.sent);
            self.base += self.sent as u64;
            self.sent = 0;
        }
    }
    /// Stream position of the next byte to send.
    #[cfg(feature = "screen")]
    fn sent_pos(&self) -> u64 {
        self.base + self.sent as u64
    }
    /// Stream position after the last byte queued.
    #[cfg(feature = "screen")]
    fn end_pos(&self) -> u64 {
        self.base + self.buf.len() as u64
    }
    /// Where new frames are appended.
    fn tail(&mut self) -> &mut Vec<u8> {
        self.compact();
        &mut self.buf
    }
}

struct Client {
    stream: Stream,
    id: u32,
    hello_done: bool,
    /// Holds the lease.
    writer: bool,
    /// EXITED not yet queued for this client.
    exit_owed: bool,
    /// Flush `out`, then close (DETACH, or a protocol error).
    closing: bool,
    /// Its output queue passed the limit: close at once, without flushing.
    overflowed: bool,
    /// Data cursor into the ring.
    next_seq: u64,
    /// Partial frames.
    input: Vec<u8>,
    /// Control frames + the DATA frame being sent.
    out: Outbox,
    /// Asked for a picture: gets cuts and resize resets from then on.
    #[cfg(feature = "screen")]
    pictures: bool,
    /// A picture taken for this client, waiting for its DATA cursor to
    /// reach the seq it stands for; then it goes into `out`.
    #[cfg(feature = "screen")]
    waiting: Option<Waiting>,
    /// The picture being sent: its (start, end) stream positions in `out`.
    #[cfg(feature = "screen")]
    picture: Option<(u64, u64)>,
    /// A picture due to this client, and why: taken once the one it is being
    /// sent is gone, so it holds at most one more (H4). A reset outranks a cut.
    #[cfg(feature = "screen")]
    owed: Option<u8>,
}

/// A picture of the state at `seq`, serialised once and shared by every
/// client it was taken for.
#[cfg(feature = "screen")]
struct Waiting {
    seq: u64,
    reason: u8,
    cols: u16,
    rows: u16,
    bytes: std::rc::Rc<Vec<u8>>,
}

impl Client {
    /// All queued bytes, including a picture; only bounded pictures get slack.
    fn queued(&self) -> usize {
        self.out.len()
    }

    fn picture_slack(&self) -> usize {
        #[cfg(feature = "screen")]
        if let Some((start, end)) = self.picture {
            return ((end - start) as usize).min(crate::screen::PICTURE_MAX + 18);
        }
        0
    }

    /// Owe this client a picture; a reset is never downgraded to a cut.
    #[cfg(feature = "screen")]
    fn owe(&mut self, reason: u8) {
        if self.owed != Some(proto::PICTURE_RESET) {
            self.owed = Some(reason);
        }
    }
}

struct PendingWrite {
    /// 0 = the client is gone, no ack owed.
    client_id: u32,
    write_id: u32,
    data: Vec<u8>,
    off: usize,
}

/// The child's side: a pty master (input is the same fd), or two pipes.
pub struct ChildIo {
    pub output: Io,
    pub input: Option<Io>,
}

impl ChildIo {
    fn input(&self) -> &Io {
        self.input.as_ref().unwrap_or(&self.output)
    }
}

pub struct Child {
    pub pid: Pid,
    pub io: ChildIo,
    pub has_pty: bool,
    pub ws: Winsize,
    #[cfg(windows)]
    pub control: sys::ChildControl,
}

pub struct Host {
    /// Absolute, so the unlink at exit still names it after chdir("/").
    sock_path: PathBuf,
    /// Device and inode of the socket we bound: the unlink at exit removes
    /// the path only while it is still ours.
    sock_id: Option<(u64, u64)>,
    listener: Listener,
    #[cfg(unix)]
    sig_fd: SignalSource,
    /// None once the output is drained and closed.
    io: Option<ChildIo>,
    has_pty: bool,
    child: Pid,
    /// waitpid collected.
    child_exited: bool,
    exit_announced: bool,
    /// -1 while alive.
    exit_code: i32,
    /// 0 unless killed by a signal.
    exit_signal: i32,
    ws: Winsize,
    #[cfg(windows)]
    control: sys::ChildControl,

    ring: Ring,
    clients: Vec<Client>,
    next_client_id: u32,
    /// Id of the client holding the lease.
    writer: Option<u32>,
    wq: VecDeque<PendingWrite>,
    /// What `wq` holds: bytes not yet written plus WRITE_OVERHEAD per entry.
    wq_cost: usize,

    kill_deadline: Option<Instant>,
    kill_requested: bool,
    linger_deadline: Option<Instant>,
    linger: Duration,
    scratch: Box<[u8]>,
    /// The kept screen (a `screen` build with a pty).
    #[cfg(feature = "screen")]
    screen: Option<Kept>,
}

/// The emulator, the cut clock, and whether some client may now be sent the
/// picture it is owed.
#[cfg(feature = "screen")]
struct Kept {
    screen: crate::screen::Screen,
    clock: CutClock,
    due: bool,
}

impl Host {
    pub fn new(
        sock_path: PathBuf,
        sock_id: Option<(u64, u64)>,
        listener: Listener,
        sig_fd: SignalSource,
        child: Child,
        ring: Ring,
        linger_secs: u64,
    ) -> Host {
        #[cfg(windows)]
        let _ = sig_fd;
        let mut h = Host {
            sock_path,
            sock_id,
            listener,
            #[cfg(unix)]
            sig_fd,
            #[cfg(windows)]
            control: child.control,
            io: Some(child.io),
            has_pty: child.has_pty,
            child: child.pid,
            child_exited: false,
            exit_announced: false,
            exit_code: -1,
            exit_signal: 0,
            ws: child.ws,
            ring,
            clients: Vec::new(),
            next_client_id: 0,
            writer: None,
            wq: VecDeque::new(),
            wq_cost: 0,
            kill_deadline: None,
            kill_requested: false,
            linger_deadline: None,
            linger: Duration::from_secs(linger_secs),
            scratch: vec![0u8; READ_CHUNK].into_boxed_slice(),
            #[cfg(feature = "screen")]
            screen: None,
        };
        if let Some(ws) = h.read_winsize() {
            h.ws = ws;
        }
        h
    }

    /// Keep the screen from here on (the ring is still empty).
    #[cfg(feature = "screen")]
    pub fn keep_screen(&mut self, scrollback: usize) {
        self.screen = Some(Kept {
            screen: crate::screen::Screen::new(self.ws.ws_col, self.ws.ws_row, scrollback),
            clock: CutClock::new(Instant::now()),
            due: false,
        });
    }

    /// The most a client's output queue may hold: a whole ring replay plus slack.
    fn out_limit(&self) -> usize {
        self.ring.size() + proto::MAX_OUTBUF_SLACK
    }

    fn idx(&self, id: u32) -> Option<usize> {
        self.clients.iter().position(|c| c.id == id)
    }

    /// The pty master while it is open (None without a pty, or once closed).
    fn pty(&self) -> Option<&Io> {
        self.io
            .as_ref()
            .filter(|_| self.has_pty)
            .map(|io| &io.output)
    }

    #[cfg(unix)]
    fn read_winsize(&mut self) -> Option<Winsize> {
        let pty = self.pty()?;
        let mut ws = sys::get_winsize(pty)?;
        let (cols, rows) = (
            ws.ws_col.clamp(1, crate::args::MAX_COLS),
            ws.ws_row.clamp(1, crate::args::MAX_ROWS),
        );
        if (cols, rows) != (ws.ws_col, ws.ws_row) {
            let bounded = Winsize {
                ws_col: cols,
                ws_row: rows,
                ..ws
            };
            if sys::set_winsize(pty, bounded) {
                ws = bounded;
            }
        }
        self.ws = ws;
        #[cfg(feature = "screen")]
        if self
            .screen
            .as_ref()
            .is_some_and(|s| s.screen.size() != (ws.ws_col, ws.ws_row))
        {
            self.screen_resized(ws);
        }
        Some(ws)
    }

    #[cfg(windows)]
    fn read_winsize(&mut self) -> Option<Winsize> {
        self.pty().map(|_| self.ws)
    }

    // ---- clients ------------------------------------------------------------

    fn release_lease(&mut self, ci: usize) {
        let c = &mut self.clients[ci];
        if c.writer {
            c.writer = false;
            if self.writer == Some(c.id) {
                self.writer = None;
            }
        }
    }

    fn client_close(&mut self, ci: usize) {
        self.release_lease(ci);
        let id = self.clients[ci].id;
        for w in self.wq.iter_mut().filter(|w| w.client_id == id) {
            w.client_id = 0;
        }
        self.clients.swap_remove(ci); // drops (closes) the socket
    }

    fn count_clients(&self, writers: bool) -> u8 {
        self.clients
            .iter()
            .filter(|c| c.hello_done && c.writer == writers)
            .count() as u8
    }

    fn accept_client(&mut self) {
        let Ok((stream, _)) = self.listener.accept() else {
            return;
        };
        if self.clients.len() >= MAX_CLIENTS || !sys::peer_is_us(&stream) {
            return; // dropping the stream closes it
        }
        let _ = stream.set_nonblocking(true);
        self.next_client_id += 1;
        self.clients.push(Client {
            stream,
            id: self.next_client_id,
            hello_done: false,
            writer: false,
            exit_owed: false,
            closing: false,
            overflowed: false,
            next_seq: 0,
            input: Vec::new(),
            out: Outbox::default(),
            #[cfg(feature = "screen")]
            pictures: false,
            #[cfg(feature = "screen")]
            waiting: None,
            #[cfg(feature = "screen")]
            picture: None,
            #[cfg(feature = "screen")]
            owed: None,
        });
    }

    fn queue_status(&mut self, ci: usize) {
        let (low, high) = (self.ring.low(), self.ring.high());
        let (writers, readers) = (self.count_clients(true), self.count_clients(false));
        let (exited, code, sig) = (self.child_exited, self.exit_code, self.exit_signal);
        Frame::begin(self.clients[ci].out.tail(), proto::H_STATUS)
            .u8(if exited { 0 } else { 1 })
            .i32(if exited { code } else { -1 })
            .u8(sig as u8)
            .u64(low)
            .u64(high)
            .u8(writers)
            .u8(readers);
    }

    /// Send ERR bad-frame and close once it is flushed.
    fn bad(&mut self, ci: usize, msg: &str) {
        let c = &mut self.clients[ci];
        proto::err(c.out.tail(), proto::ERR_BAD_FRAME, msg);
        c.closing = true;
    }

    /// Send an ERR the connection survives.
    fn refuse(&mut self, ci: usize, code: u16, msg: &str) {
        proto::err(self.clients[ci].out.tail(), code, msg);
    }

    /// Refuse a WRITE: the ERR names the write it answers.
    fn refuse_write(&mut self, ci: usize, code: u16, msg: &str, write_id: u32) {
        proto::err_write(self.clients[ci].out.tail(), code, msg, write_id);
    }

    fn handle_hello(&mut self, ci: usize, writer: bool, from: u64) {
        let ws = self.read_winsize().unwrap_or(self.ws);
        let (low, high) = (self.ring.low(), self.ring.high());
        let (has_pty, child, announced) = (self.has_pty, self.child, self.exit_announced);
        let features = self.features();
        if writer && self.writer.is_none() {
            self.writer = Some(self.clients[ci].id);
            self.clients[ci].writer = true;
        }
        let c = &mut self.clients[ci];
        c.hello_done = true;
        Frame::begin(c.out.tail(), proto::H_WELCOME)
            .u16(proto::PROTO_VERSION)
            .u32(std::process::id())
            .u32(child.as_raw_nonzero().get() as u32)
            .u8(has_pty as u8)
            .u16(if has_pty { ws.ws_col } else { 0 })
            .u16(if has_pty { ws.ws_row } else { 0 })
            .u64(low)
            .u64(high)
            .u8(c.writer as u8)
            .u8(features);
        if from == proto::TAIL_ONLY || from > high {
            c.next_seq = high;
        } else if from < low {
            Frame::begin(c.out.tail(), proto::H_GAP).u64(low);
            c.next_seq = low;
        } else {
            c.next_seq = from;
        }
        if announced {
            c.exit_owed = true;
        }
    }

    /// WELCOME's trailing features byte.
    fn features(&self) -> u8 {
        #[cfg(feature = "screen")]
        if self.screen.is_some() {
            return proto::FEATURE_SCREEN;
        }
        0
    }

    #[cfg(unix)]
    fn kill_child(&self, signo: i32) {
        if !self.child_exited {
            sys::kill_child(self.child, signo);
        }
    }

    #[cfg(windows)]
    fn kill_child(&self, signo: i32) {
        if !self.child_exited {
            self.control.signal(signo);
        }
    }

    fn request_kill(&mut self) {
        if self.kill_requested {
            return;
        }
        self.kill_requested = true;
        self.kill_child(sys::SIGTERM);
        let now = Instant::now();
        self.kill_deadline = Some(now + KILL_GRACE);
        // Already lingering: a kill is the owner saying nobody needs the ring
        // any more, so the host goes on the short kill linger instead of holding
        // the socket (and the label) for the rest of a long one.
        if self.exit_announced {
            let soon = now + SHORT_LINGER;
            if self.linger_deadline.is_none_or(|d| soon < d) {
                self.linger_deadline = Some(soon);
            }
        }
    }

    fn handle_frame(&mut self, ci: usize, ty: u8, p: &[u8]) {
        let hello_done = self.clients[ci].hello_done;
        if !hello_done && ty != proto::C_HELLO {
            return self.bad(ci, "HELLO must be first");
        }
        if hello_done && ty == proto::C_HELLO {
            return self.bad(ci, "duplicate HELLO");
        }
        let req = match proto::parse_request(ty, p) {
            Ok(req) => req,
            Err(msg) => return self.bad(ci, msg),
        };
        let is_writer = self.clients[ci].writer;
        let needs_lease = matches!(
            req,
            Request::Write { .. } | Request::Resize { .. } | Request::Signal(_) | Request::Kill
        );
        if needs_lease && !is_writer {
            return match req {
                Request::Write { id, .. } => {
                    self.refuse_write(ci, proto::ERR_NOT_WRITER, "not the writer", id)
                }
                _ => self.refuse(ci, proto::ERR_NOT_WRITER, "not the writer"),
            };
        }
        match req {
            Request::Hello { writer, from } => self.handle_hello(ci, writer, from),
            Request::Write { id, data } => {
                if self.child_exited || self.io.is_none() {
                    return self.refuse_write(ci, proto::ERR_EXITED, "child exited", id);
                }
                let cost = data.len() + proto::WRITE_OVERHEAD;
                if self.wq_cost + cost > proto::MAX_INPUT_QUEUE && !self.wq.is_empty() {
                    // The child is not reading its input. Refuse rather than
                    // queue without limit (host.c does: POD-4842 C-3); an
                    // empty queue always takes one write, however large.
                    return self.refuse_write(ci, proto::ERR_INPUT_FULL, "input queue full", id);
                }
                self.wq_cost += cost;
                self.wq.push_back(PendingWrite {
                    client_id: self.clients[ci].id,
                    write_id: id,
                    data: data.to_vec(),
                    off: 0,
                });
            }
            Request::Resize { cols, rows } => {
                if !(1..=crate::args::MAX_COLS).contains(&cols)
                    || !(1..=crate::args::MAX_ROWS).contains(&rows)
                {
                    return self.refuse(
                        ci,
                        proto::ERR_BAD_SIZE,
                        "size exceeds 1000 columns or 500 rows, or is zero",
                    );
                }
                if !self.has_pty {
                    return self.refuse(ci, proto::ERR_NO_PTY, "no pty");
                }
                let Some(pty) = self.pty().filter(|_| !self.child_exited) else {
                    return self.refuse(ci, proto::ERR_EXITED, "child exited");
                };
                #[cfg(unix)]
                let mut cur = sys::get_winsize(pty).unwrap_or(self.ws);
                #[cfg(windows)]
                let mut cur = self.ws;
                let mut changed = 0u8;
                if cur.ws_col != cols || cur.ws_row != rows {
                    // Only here does the kernel see anything: TIOCSWINSZ on a
                    // changed size is what signals the foreground process group.
                    // A same-size RESIZE issues no ioctl and therefore no signal.
                    let want = Winsize {
                        ws_col: cols,
                        ws_row: rows,
                        ..cur
                    };
                    #[cfg(unix)]
                    {
                        if sys::set_winsize(pty, want) {
                            changed = 1;
                        }
                        cur = sys::get_winsize(pty).unwrap_or(cur);
                    }
                    #[cfg(windows)]
                    {
                        let _ = pty;
                        if self.control.resize(want) {
                            changed = 1;
                            cur = want;
                        }
                    }
                }
                #[cfg(windows)]
                {
                    self.ws = cur;
                    #[cfg(feature = "screen")]
                    if changed != 0 {
                        self.screen_resized(cur);
                    }
                }
                cur = self.read_winsize().unwrap_or(cur);
                Frame::begin(self.clients[ci].out.tail(), proto::H_RESIZED)
                    .u16(cur.ws_col)
                    .u16(cur.ws_row)
                    .u8(changed);
            }
            Request::Size => {
                if !self.has_pty {
                    return self.refuse(ci, proto::ERR_NO_PTY, "no pty");
                }
                let cur = self.read_winsize().unwrap_or(self.ws);
                Frame::begin(self.clients[ci].out.tail(), proto::H_SIZE)
                    .u16(cur.ws_col)
                    .u16(cur.ws_row);
            }
            Request::Status => self.queue_status(ci),
            Request::Signal(signo) => {
                if self.child_exited {
                    return self.refuse(ci, proto::ERR_EXITED, "child exited");
                }
                #[cfg(windows)]
                if signo == 2 && self.has_pty {
                    // Console Ctrl-C is input, not a POSIX process-group signal.
                    if self.wq_cost + 1 + proto::WRITE_OVERHEAD > proto::MAX_INPUT_QUEUE {
                        return self.refuse(ci, proto::ERR_INPUT_FULL, "input queue full");
                    }
                    self.wq_cost += 1 + proto::WRITE_OVERHEAD;
                    self.wq.push_back(PendingWrite {
                        client_id: 0,
                        write_id: 0,
                        data: vec![3],
                        off: 0,
                    });
                } else if matches!(signo, 2 | 9 | 15) {
                    self.kill_child(signo as i32);
                } else {
                    // SIGWINCH/SIGHUP/SIGCONT have no Windows process semantics.
                    // Report the ignored request so the daemon logs it; never kill.
                    self.refuse(ci, proto::ERR_BAD_FRAME, "signal unsupported on Windows; ignored");
                }
                #[cfg(unix)]
                self.kill_child(signo as i32);
            }
            Request::Detach => {
                self.release_lease(ci);
                self.clients[ci].closing = true;
            }
            Request::Replay { tail } => {
                // Re-send the last `tail` bytes of the ring ON THIS CONNECTION
                // with their original seqs, bracketed by REPLAYING/REPLAYED.
                // Independent of the client's live cursor; touches the child in no way.
                let (low, high) = (self.ring.low(), self.ring.high());
                let from = high.saturating_sub(tail as u64).max(low);
                // Refuse a replay that would push the queue past the limit
                // BEFORE copying (host.c copies first: pipelined REPLAYs grow
                // it by a ring each, POD-4842 C-2). A client asking for that
                // is not reading; it is dropped.
                let frames = (high - from).div_ceil(proto::DATA_CHUNK as u64) as usize + 2;
                let queued = self.clients[ci].queued() + (high - from) as usize + frames * 13;
                if queued > self.out_limit() + self.clients[ci].picture_slack() {
                    self.clients[ci].overflowed = true;
                    return;
                }
                let out = self.clients[ci].out.tail();
                Frame::begin(out, proto::H_REPLAYING).u64(from);
                let mut seq = from;
                while seq < high {
                    let len = (high - seq).min(proto::DATA_CHUNK as u64) as usize;
                    let mut f = Frame::begin(out, proto::H_DATA);
                    f.u64(seq);
                    self.ring.copy_to(seq, len, f.buf());
                    drop(f);
                    seq += len as u64;
                }
                Frame::begin(out, proto::H_REPLAYED);
            }
            Request::Kill => self.request_kill(),
            Request::Steal => {
                // A deliberate takeover: the holder keeps its connection (it
                // still reads) but loses the lease, and hears LEASE_LOST so it
                // never mistakes a swallowed write for a delivered one. Stealing
                // from nobody is a no-op success.
                let me = self.clients[ci].id;
                if let Some(holder) = self.writer.filter(|&w| w != me).and_then(|w| self.idx(w)) {
                    Frame::begin(self.clients[holder].out.tail(), proto::H_LEASE_LOST);
                    self.release_lease(holder);
                }
                if self.writer.is_none() {
                    self.writer = Some(me);
                    self.clients[ci].writer = true;
                }
                Frame::begin(self.clients[ci].out.tail(), proto::H_STOLEN);
            }
            #[cfg(feature = "screen")]
            Request::Picture => {
                let Some(kept) = &mut self.screen else {
                    // No pty, no screen: as any host answers an unknown frame.
                    return self.bad(ci, "bad frame");
                };
                let c = &mut self.clients[ci];
                c.pictures = true;
                c.owe(proto::PICTURE_RESET);
                kept.due = true;
            }
        }
    }

    /// Handle every complete frame in the client's input.
    fn client_parse(&mut self, ci: usize) {
        let mut input = std::mem::take(&mut self.clients[ci].input);
        let mut used = 0;
        loop {
            match proto::next_frame(&input[used..]) {
                Next::Incomplete => break,
                Next::BadLength => {
                    self.bad(ci, "bad length");
                    break;
                }
                Next::Frame { ty, total } => {
                    self.handle_frame(ci, ty, &input[used + 5..used + total]);
                    used += total;
                    let c = &mut self.clients[ci];
                    // Checked per frame, not once per read: one read can carry
                    // thousands of pipelined requests.
                    if c.queued() > self.ring.size() + proto::MAX_OUTBUF_SLACK + c.picture_slack() {
                        c.overflowed = true;
                    }
                    if c.closing || c.overflowed {
                        break;
                    }
                }
            }
        }
        input.drain(..used);
        self.clients[ci].input = input;
    }

    /// Returns false when the client was closed.
    fn client_read(&mut self, ci: usize) -> bool {
        let c = &mut self.clients[ci];
        match (&c.stream).read(&mut self.scratch) {
            Ok(0) => {}
            Ok(n) => {
                if !c.closing && !c.overflowed {
                    // draining after DETACH/error: further input is ignored
                    c.input.extend_from_slice(&self.scratch[..n]);
                    self.client_parse(ci);
                }
                return true;
            }
            Err(e) if is_transient(&e) => return true,
            Err(_) => {}
        }
        self.client_close(ci);
        false
    }

    /// Fill `out` from the ring when it is empty and the cursor lags; a
    /// waiting picture goes in once the DATA before it has.
    fn client_fill(&mut self, ci: usize) {
        let (low, high, announced) = (self.ring.low(), self.ring.high(), self.exit_announced);
        let (code, sig) = (self.exit_code, self.exit_signal);
        let c = &mut self.clients[ci];
        if !c.out.is_empty() || !c.hello_done {
            return;
        }
        #[allow(unused_mut)]
        let mut until = high;
        #[cfg(feature = "screen")]
        if let Some(w) = &c.waiting {
            if w.seq < low.max(c.next_seq) {
                // The ring moved past it before this client read up to it:
                // the DATA it stands between is gone. A fresh reset instead.
                c.waiting = None;
                c.owe(proto::PICTURE_RESET);
                if let Some(kept) = &mut self.screen {
                    kept.due = true;
                }
            } else if c.next_seq == w.seq {
                let start = c.out.end_pos();
                Frame::begin(c.out.tail(), proto::H_PICTURE)
                    .u64(w.seq)
                    .u8(w.reason)
                    .u16(w.cols)
                    .u16(w.rows)
                    .bytes(&w.bytes);
                c.picture = Some((start, c.out.end_pos()));
                c.waiting = None;
                return;
            } else {
                until = w.seq;
            }
        }
        if c.next_seq < low {
            Frame::begin(c.out.tail(), proto::H_GAP).u64(low);
            c.next_seq = low;
        } else if c.next_seq < until {
            let n = (until - c.next_seq).min(proto::DATA_CHUNK as u64) as usize;
            let mut f = Frame::begin(c.out.tail(), proto::H_DATA);
            f.u64(c.next_seq);
            self.ring.copy_to(c.next_seq, n, f.buf());
            drop(f);
            c.next_seq += n as u64;
        } else if c.exit_owed && announced {
            Frame::begin(c.out.tail(), proto::H_EXITED)
                .i32(code)
                .u8(sig as u8);
            c.exit_owed = false;
        }
    }

    fn client_wants_out(&self, c: &Client) -> bool {
        if !c.out.is_empty() {
            return true;
        }
        if !c.hello_done {
            return false;
        }
        #[cfg(feature = "screen")]
        if c.waiting.is_some() {
            return true;
        }
        c.next_seq < self.ring.high() || (c.exit_owed && self.exit_announced)
    }

    /// Returns false when the client was closed.
    fn client_write(&mut self, ci: usize) -> bool {
        self.client_fill(ci);
        while !self.clients[ci].out.is_empty() {
            let c = &mut self.clients[ci];
            match (&c.stream).write(c.out.pending()) {
                Ok(0) => {
                    // A socket that takes nothing is gone; never spin on it.
                    self.client_close(ci);
                    return false;
                }
                Ok(n) => {
                    c.out.advance(n);
                    #[cfg(feature = "screen")]
                    if c.picture.is_some_and(|(_, end)| c.out.sent_pos() >= end) {
                        c.picture = None;
                        // The one it is owed can go now (H4), and a cut
                        // skipped meanwhile is re-checked (H2).
                        if let (Some(_), Some(kept)) = (c.owed, &mut self.screen) {
                            kept.due = true;
                        }
                    }
                }
                Err(e) if is_transient(&e) => return true,
                Err(_) => {
                    self.client_close(ci);
                    return false;
                }
            }
            self.client_fill(ci); // a no-op until the outbox has drained
        }
        true
    }

    // ---- pictures ---------------------------------------------------------------

    /// When the loop must wake for a cut that waits only for its gap (H2).
    fn cut_deadline(&self) -> Option<Instant> {
        #[cfg(feature = "screen")]
        if let Some(kept) = &self.screen
            && self.clients.iter().any(|c| c.pictures)
        {
            return kept.clock.due(self.ring.high());
        }
        None
    }

    /// The pty took a new size: the screen follows, and every client that
    /// asked for pictures is owed a reset at that size.
    #[cfg(feature = "screen")]
    fn screen_resized(&mut self, ws: Winsize) {
        let Some(kept) = &mut self.screen else { return };
        kept.screen.resize(ws.ws_col, ws.ws_row);
        for c in self.clients.iter_mut().filter(|c| c.pictures) {
            c.owe(proto::PICTURE_RESET);
            kept.due = true;
        }
        if kept.due {
            // everyone is about to get a picture: count the next cut from here
            kept.clock.restart(Instant::now(), self.ring.high());
        }
    }

    /// Take a cut when one is due, then take the picture each client is
    /// owed, unless it is still being sent one. One picture is serialised
    /// for all of them, of the state at the ring's high seq; each client gets
    /// it once its DATA has reached there (`client_fill`), so it sits exactly
    /// between the bytes it stands for and the bytes after it.
    #[cfg(feature = "screen")]
    fn pictures(&mut self, now: Instant) {
        let high = self.ring.high();
        let Some(kept) = &mut self.screen else { return };
        if !self.clients.iter().any(|c| c.pictures) {
            kept.clock.restart(now, high); // nobody to cut for: nothing owed
        } else if kept.clock.due(high).is_some_and(|at| now >= at) {
            kept.clock.restart(now, high);
            for c in self.clients.iter_mut().filter(|c| c.pictures) {
                c.owe(proto::PICTURE_CUT);
            }
            kept.due = true;
        }
        // A picture now must be exact: wait while a sequence longer than the
        // hold limit is still open (the next read retries).
        if !kept.due || !kept.screen.at_ground() {
            return;
        }
        kept.due = false;
        let ready = |c: &Client| {
            c.owed.is_some()
                && c.waiting.is_none()
                && c.picture.is_none()
                && !c.closing
                && !c.overflowed
        };
        if !self.clients.iter().any(ready) {
            return;
        }
        debug_assert_eq!(kept.screen.fed_seq() + kept.screen.held_len() as u64, high);
        let mut bytes = Vec::new();
        kept.screen.picture(&mut bytes);
        if bytes.is_empty() {
            // Visible state cannot fit the absolute ceiling. Refuse rather than
            // sending a partial redraw or pinning unbounded copies per client.
            for c in self.clients.iter_mut().filter(|c| ready(c)) {
                proto::err(
                    c.out.tail(),
                    proto::ERR_BAD_FRAME,
                    "screen exceeds picture budget",
                );
                c.owed = None;
                c.closing = true;
            }
            return;
        }
        kept.clock.sized(bytes.len());
        let bytes = std::rc::Rc::new(bytes);
        let (cols, rows) = kept.screen.size();
        for c in self.clients.iter_mut().filter(|c| ready(c)) {
            c.waiting = Some(Waiting {
                seq: high,
                reason: c.owed.take().expect("owed"),
                cols,
                rows,
                bytes: bytes.clone(),
            });
        }
    }

    // ---- child I/O ------------------------------------------------------------

    fn announce_exit_if_ready(&mut self) {
        if self.exit_announced || !self.child_exited || self.io.is_some() {
            return;
        }
        self.exit_announced = true;
        for c in self.clients.iter_mut().filter(|c| c.hello_done) {
            c.exit_owed = true;
        }
        let linger = if self.kill_requested || sys::got_term() {
            SHORT_LINGER
        } else {
            self.linger
        };
        self.linger_deadline = Some(Instant::now() + linger);
    }

    fn close_io(&mut self) {
        if self.io.take().is_none() {
            return; // dropping ChildIo closed both fds
        }
        self.wq.clear();
        self.wq_cost = 0;
        self.announce_exit_if_ready();
    }

    /// Read what the child wrote; on EOF/EIO the output side is finished.
    fn io_read(&mut self, drain_all: bool) {
        #[cfg(feature = "screen")]
        self.read_winsize();
        loop {
            let Some(io) = &self.io else { return };
            match (&io.output).read(&mut self.scratch) {
                Ok(n) if n > 0 => {
                    self.ring.append(&self.scratch[..n]);
                    #[cfg(feature = "screen")]
                    if let Some(kept) = &mut self.screen {
                        kept.screen.feed(&self.scratch[..n]);
                    }
                    if !drain_all {
                        return;
                    }
                }
                // Draining after the child exited: a signal must not cut the
                // drain short and drop output (host.c does; a note in POD-4842).
                Err(e) if drain_all && e.kind() == io::ErrorKind::Interrupted => {}
                Err(e) if is_transient(&e) => {
                    if drain_all {
                        self.close_io();
                    }
                    return;
                }
                _ => {
                    self.close_io(); // EOF, or EIO once the slave side is gone
                    return;
                }
            }
        }
    }

    fn io_write(&mut self) {
        while let (Some(w), Some(io)) = (self.wq.front_mut(), &self.io) {
            if w.off < w.data.len() {
                match io.input().write(&w.data[w.off..]) {
                    Ok(n) => {
                        w.off += n;
                        self.wq_cost -= n;
                    }
                    Err(e) if is_transient(&e) => return,
                    Err(_) => {
                        // The child's input side is gone; the ack is that
                        // nothing more can be written.
                        for x in self.wq.iter_mut() {
                            self.wq_cost -= x.data.len() - x.off;
                            x.data.truncate(x.off);
                        }
                    }
                }
                let w = &self.wq[0];
                if w.off < w.data.len() {
                    return;
                }
            }
            let w = self.wq.pop_front().expect("front exists");
            self.wq_cost -= proto::WRITE_OVERHEAD;
            if w.client_id != 0
                && let Some(ci) = self.idx(w.client_id)
            {
                Frame::begin(self.clients[ci].out.tail(), proto::H_WRITTEN)
                    .u32(w.write_id)
                    .u32(w.off as u32);
            }
        }
    }

    #[cfg(unix)]
    fn reap_child(&mut self) {
        while let Some((pid, status)) = sys::reap_any() {
            if pid != self.child {
                continue;
            }
            self.child_exited = true;
            self.kill_deadline = None;
            if let Some(code) = status.exit_status() {
                self.exit_code = code;
                self.exit_signal = 0;
            } else if let Some(sig) = status.terminating_signal() {
                self.exit_signal = sig;
                self.exit_code = 128 + sig;
            }
            // Whatever the child wrote before exiting is already in the kernel
            // buffer: take all of it now, then treat the output side as finished
            // even if a grandchild still holds the slave open.
            if self.io.is_some() {
                self.io_read(true);
            }
            self.announce_exit_if_ready();
        }
    }

    #[cfg(unix)]
    fn handle_signals(&mut self) {
        let mut tmp = [0u8; 64];
        while matches!((&self.sig_fd).read(&mut tmp), Ok(n) if n > 0) {}
        if sys::got_term() && !self.kill_requested {
            self.request_kill();
        }
        self.reap_child();
    }

    #[cfg(windows)]
    fn handle_signals(&mut self) {
        if !self.child_exited
            && let Some(code) = self.control.exit_code()
        {
            self.child_exited = true;
            self.exit_code = code;
            self.kill_deadline = None;
            // Close ConPTY on a helper thread while the main loop keeps draining it.
            self.control.close_console();
        }
        self.announce_exit_if_ready();
    }

    fn cleanup_and_exit(&self) -> ! {
        sys::remove_own_socket(&self.sock_path, self.sock_id);
        std::process::exit(0)
    }

    /// Wait for the next event; which fds are polled follows the state now.
    #[cfg(unix)]
    fn wait(&self, timeout: Option<Duration>, ev: &mut Events) -> io::Result<()> {
        let with_out = |out: bool| {
            if out {
                PollFlags::OUT
            } else {
                PollFlags::empty()
            }
        };
        let mut fds = Vec::with_capacity(self.clients.len() + 4);
        fds.push(PollFd::new(&self.listener, PollFlags::IN));
        fds.push(PollFd::new(&self.sig_fd, PollFlags::IN));
        let (mut output, mut input) = (None, None);
        if let Some(io) = &self.io {
            let separate = io.input.is_some();
            output = Some(fds.len());
            fds.push(PollFd::new(
                &io.output,
                PollFlags::IN | with_out(!self.wq.is_empty() && !separate),
            ));
            if separate && !self.wq.is_empty() {
                input = Some(fds.len());
                fds.push(PollFd::new(io.input(), PollFlags::OUT));
            }
        }
        let first_client = fds.len();
        for c in &self.clients {
            let read = if c.closing || c.overflowed {
                PollFlags::empty()
            } else {
                PollFlags::IN
            };
            fds.push(PollFd::new(
                &c.stream,
                read | with_out(self.client_wants_out(c)),
            ));
        }
        let ts = timeout.map(|d| Timespec {
            tv_sec: d.as_secs() as _,
            tv_nsec: d.subsec_nanos() as _,
        });
        rustix::event::poll(&mut fds, ts.as_ref())?;
        ev.listener = fds[0].revents();
        ev.signals = fds[1].revents();
        ev.output = output.map(|i| fds[i].revents());
        ev.input = input.map(|i| fds[i].revents());
        ev.clients.clear();
        let polled = self.clients.iter().zip(&fds[first_client..]);
        ev.clients.extend(polled.map(|(c, f)| (c.id, f.revents())));
        Ok(())
    }

    #[cfg(windows)]
    fn wait(&self, timeout: Option<Duration>, ev: &mut Events) -> io::Result<()> {
        // Overlapped I/O never blocks this loop. Bound the wait so process exit,
        // disconnects and backpressure are serviced even without new output.
        std::thread::sleep(
            timeout
                .unwrap_or(Duration::from_millis(5))
                .min(Duration::from_millis(5)),
        );
        ev.listener = if self.listener.ready() {
            PollFlags::IN
        } else {
            PollFlags::empty()
        };
        ev.signals = PollFlags::empty();
        ev.output = self.io.as_ref().map(|io| io.output.events());
        ev.input = self.io.as_ref().map(|_| PollFlags::OUT);
        ev.clients.clear();
        ev.clients
            .extend(self.clients.iter().map(|c| (c.id, c.stream.events())));
        Ok(())
    }

    pub fn run(mut self) -> ! {
        let mut ev = Events::new();
        loop {
            let now = Instant::now();
            if self.kill_deadline.is_some_and(|d| now >= d) {
                self.kill_deadline = None;
                self.kill_child(sys::SIGKILL);
            }
            if let Some(linger) = self.linger_deadline {
                let all_delivered = !self
                    .clients
                    .iter()
                    .any(|c| c.hello_done && (c.exit_owed || !c.out.is_empty()));
                if (now >= linger && all_delivered) || now >= linger + STUCK_GRACE {
                    self.cleanup_and_exit();
                }
            }

            #[cfg(feature = "screen")]
            {
                self.read_winsize();
                self.pictures(now);
            }

            let next = [
                self.kill_deadline,
                self.linger_deadline,
                self.cut_deadline(),
            ]
            .into_iter()
            .flatten()
            .min();
            #[allow(unused_mut)]
            let mut timeout = next.map(|d| d.saturating_duration_since(now).min(MAX_WAIT));
            #[cfg(feature = "screen")]
            if self.screen.is_some() {
                // A quiet child can change winsize without producing PTY output.
                let tick = Duration::from_millis(250);
                timeout = Some(timeout.unwrap_or(tick).min(tick));
            }
            match self.wait(timeout, &mut ev) {
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {
                    self.handle_signals();
                    continue;
                }
                Err(e) => crate::die(format_args!("poll: {}", sys::strerror(&e))),
                Ok(()) => {}
            }

            self.handle_signals();
            if ev.signals.contains(PollFlags::IN) {
                self.handle_signals();
            }
            if let Some(r) = ev.output
                && self.io.is_some()
                && r.intersects(PollFlags::IN | PollFlags::HUP | PollFlags::ERR)
            {
                self.io_read(false);
            }
            if self.io.is_some()
                && !self.wq.is_empty()
                && let Some(r) = ev.input.or(ev.output)
                && r.intersects(PollFlags::OUT | PollFlags::ERR | PollFlags::HUP)
            {
                self.io_write();
            }
            if ev.listener.contains(PollFlags::IN) {
                self.accept_client();
            }

            // Clients by id: a close reorders the array.
            for &(id, revs) in &ev.clients {
                let Some(ci) = self.idx(id) else { continue };
                if revs.intersects(PollFlags::ERR | PollFlags::NVAL) {
                    self.client_close(ci);
                    continue;
                }
                if revs.intersects(PollFlags::IN | PollFlags::HUP) && !self.client_read(ci) {
                    continue;
                }
                if self.clients[ci].overflowed {
                    self.client_close(ci); // no flush: its queue is the problem
                    continue;
                }
                if self.client_wants_out(&self.clients[ci]) && !self.client_write(ci) {
                    continue;
                }
                let c = &self.clients[ci];
                if (c.closing && c.out.is_empty())
                    || c.overflowed
                    || c.queued() > self.out_limit() + c.picture_slack()
                {
                    self.client_close(ci);
                }
            }
        }
    }
}

/// What one poll() reported.
struct Events {
    listener: PollFlags,
    signals: PollFlags,
    /// The child's output (or the pty master), while open.
    output: Option<PollFlags>,
    /// The child's stdin pipe, polled only when it is separate and writes are queued.
    input: Option<PollFlags>,
    clients: Vec<(u32, PollFlags)>,
}

impl Events {
    fn new() -> Events {
        Events {
            listener: PollFlags::empty(),
            signals: PollFlags::empty(),
            output: None,
            input: None,
            clients: Vec::with_capacity(MAX_CLIENTS),
        }
    }
}

fn is_transient(e: &io::Error) -> bool {
    matches!(
        e.kind(),
        io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
    )
}

#[cfg(test)]
mod tests {
    use super::Outbox;

    #[test]
    fn a_client_that_never_quite_drains_does_not_pin_what_it_was_sent() {
        // Keep 1 KiB unsent at all times while 64 MiB flows through: without
        // compaction the buffer would hold every byte ever queued.
        let mut out = Outbox::default();
        let chunk = vec![7u8; 32 * 1024];
        out.tail().extend_from_slice(&[0; 1024]);
        for _ in 0..2048 {
            out.tail().extend_from_slice(&chunk);
            let n = out.len() - 1024;
            out.advance(n);
            assert_eq!(out.len(), 1024);
        }
        assert!(
            out.buf.len() <= Outbox::COMPACT_AT + 2 * chunk.len(),
            "{}",
            out.buf.len()
        );
        assert!(
            out.buf.capacity() <= 4 * Outbox::COMPACT_AT + 2 * chunk.len(),
            "{}",
            out.buf.capacity()
        );
    }

    #[test]
    fn compaction_keeps_the_unsent_bytes_in_order() {
        let mut out = Outbox::default();
        let data: Vec<u8> = (0..200_000u32).map(|i| i as u8).collect();
        out.tail().extend_from_slice(&data);
        let mut got = Vec::new();
        while !out.is_empty() {
            let n = out.pending().len().min(70_001);
            got.extend_from_slice(&out.pending()[..n]);
            out.advance(n);
            if got.len() == 70_001 {
                out.tail().extend_from_slice(b"tail"); // appended mid-send
            }
        }
        let mut want = data.clone();
        want.extend_from_slice(b"tail");
        assert_eq!(got, want);
    }
}
