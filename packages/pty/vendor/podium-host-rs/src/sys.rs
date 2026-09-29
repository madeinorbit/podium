//! The POSIX surface std does not cover. Almost all of it goes through
//! rustix's safe wrappers. The `unsafe` left is the part no wrapper can make
//! safe: fork, installing a signal handler (and the handler's own write), the
//! code that runs in a child between fork and exec, and on macOS the one peer
//! credential call rustix does not wrap.

use std::io;
#[cfg(target_os = "macos")]
use std::os::fd::AsRawFd;
use std::os::fd::{AsFd, IntoRawFd, OwnedFd};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};

pub use rustix::event::{PollFd, PollFlags, Timespec};
pub use rustix::process::{Pid, WaitStatus};
pub use rustix::termios::Winsize;

/// strerror(3) text for `e`, without std's " (os error N)" suffix, so
/// messages read exactly as host.c's.
pub fn strerror(e: &io::Error) -> String {
    let s = e.to_string();
    match s.rfind(" (os error ") {
        Some(i) => s[..i].to_string(),
        None => s,
    }
}

pub fn set_nonblock(fd: impl AsFd) {
    let _ = rustix::io::ioctl_fionbio(fd, true);
}

pub fn get_winsize(fd: impl AsFd) -> Option<Winsize> {
    rustix::termios::tcgetwinsize(fd).ok()
}

pub fn set_winsize(fd: impl AsFd, ws: Winsize) -> bool {
    rustix::termios::tcsetwinsize(fd, ws).is_ok()
}

/// Whether the peer of a unix socket runs as our euid or as root.
pub fn peer_is_us(sock: &UnixStream) -> bool {
    let me = rustix::process::geteuid().as_raw();
    peer_uid(sock).is_some_and(|u| u == me || u == 0)
}

#[cfg(target_os = "linux")]
fn peer_uid(sock: &UnixStream) -> Option<u32> {
    rustix::net::sockopt::socket_peercred(sock)
        .ok()
        .map(|c| c.uid.as_raw())
}

#[cfg(target_os = "macos")]
fn peer_uid(sock: &UnixStream) -> Option<u32> {
    // rustix wraps SO_PEERCRED (Linux) but not LOCAL_PEERCRED, and std's
    // UnixStream::peer_cred is still unstable.
    // SAFETY: xucred is plain data, so all-zero is a valid value; the
    // pointer and length describe it exactly. Level 0 is SOL_LOCAL.
    unsafe {
        let mut xu: libc::xucred = std::mem::zeroed();
        let mut len = std::mem::size_of::<libc::xucred>() as libc::socklen_t;
        let r = libc::getsockopt(
            sock.as_raw_fd(),
            0,
            libc::LOCAL_PEERCRED,
            (&raw mut xu).cast(),
            &mut len,
        );
        (r == 0).then_some(xu.cr_uid)
    }
}

/// Signal the child's process group, falling back to the child alone.
/// Numbers with no name (real-time signals) and 0 do nothing: rustix builds a
/// signal from a raw number only in `unsafe`, and no caller sends one.
pub fn kill_child(pid: Pid, signo: i32) {
    let Some(sig) = rustix::process::Signal::from_named_raw(signo) else {
        return;
    };
    if rustix::process::kill_process_group(pid, sig).is_err() {
        let _ = rustix::process::kill_process(pid, sig);
    }
}

/// waitpid(-1, WNOHANG): the next child that changed state, if any. (Not
/// rustix's `waitpid(None, ..)`: that is waitpid(0), which sees only children
/// in our own process group — never the child, which has its own session.)
pub fn reap_any() -> Option<(Pid, WaitStatus)> {
    rustix::process::wait(rustix::process::WaitOptions::NOHANG)
        .ok()
        .flatten()
}

pub fn child_pid(child: &std::process::Child) -> Pid {
    Pid::from_raw(child.id() as i32).expect("a spawned child has a positive pid")
}

pub fn wait_for(pid: Pid) {
    let _ = rustix::process::waitpid(Some(pid), rustix::process::WaitOptions::empty());
}

// ---- signals ------------------------------------------------------------------

static SIG_PIPE_W: AtomicI32 = AtomicI32::new(-1);
static GOT_TERM: AtomicBool = AtomicBool::new(false);

pub fn got_term() -> bool {
    GOT_TERM.load(Ordering::Relaxed)
}

extern "C" fn on_signal(signo: libc::c_int) {
    if signo == libc::SIGTERM || signo == libc::SIGINT || signo == libc::SIGHUP {
        GOT_TERM.store(true, Ordering::Relaxed);
    }
    let b = signo as u8;
    // SAFETY: write(2) is async-signal-safe; the fd is the self-pipe's write
    // end, open (and nonblocking) for the life of the process.
    unsafe { libc::write(SIG_PIPE_W.load(Ordering::Relaxed), (&raw const b).cast(), 1) };
}

/// Route SIGCHLD/SIGTERM/SIGINT/SIGHUP into a self-pipe (returns its read
/// end, nonblocking) and ignore SIGPIPE.
pub fn install_signals() -> io::Result<std::fs::File> {
    let (r, w) = io::pipe()?; // CLOEXEC both ends
    set_nonblock(&r);
    set_nonblock(&w);
    // The handler owns the write end for the life of the process.
    SIG_PIPE_W.store(OwnedFd::from(w).into_raw_fd(), Ordering::Relaxed);
    // SAFETY: the handler touches only atomics and write(2), both
    // async-signal-safe; the struct is zeroed plain data with an empty mask.
    unsafe {
        let mut sa: libc::sigaction = std::mem::zeroed();
        sa.sa_sigaction = on_signal as *const () as libc::sighandler_t;
        libc::sigemptyset(&mut sa.sa_mask);
        for s in [libc::SIGCHLD, libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
            libc::sigaction(s, &sa, std::ptr::null_mut());
        }
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
    }
    Ok(OwnedFd::from(r).into())
}

// ---- process creation ------------------------------------------------------------

pub enum Forked {
    Child,
    Parent(Pid),
}

/// fork(2), for daemonizing. This process has no other threads (it never
/// starts one), which is what makes carrying on in the child sound.
pub fn fork() -> io::Result<Forked> {
    // SAFETY: single-threaded, see above.
    match unsafe { libc::fork() } {
        -1 => Err(io::Error::last_os_error()),
        0 => Ok(Forked::Child),
        pid => Ok(Forked::Parent(
            Pid::from_raw(pid).expect("fork returned a positive pid"),
        )),
    }
}

/// A new pty: (master, slave), both CLOEXEC, the slave at `ws`. This is
/// openpty(3) from safe calls.
pub fn openpty(ws: Winsize) -> io::Result<(OwnedFd, OwnedFd)> {
    use rustix::fs::{Mode, OFlags};
    use rustix::pty::OpenptFlags;
    let master = rustix::pty::openpt(OpenptFlags::RDWR | OpenptFlags::NOCTTY)?;
    rustix::io::fcntl_setfd(&master, rustix::io::FdFlags::CLOEXEC)?;
    rustix::pty::grantpt(&master)?;
    rustix::pty::unlockpt(&master)?;
    let name = rustix::pty::ptsname(&master, Vec::new())?;
    let slave = rustix::fs::open(
        name.as_c_str(),
        OFlags::RDWR | OFlags::NOCTTY | OFlags::CLOEXEC,
        Mode::empty(),
    )?;
    rustix::termios::tcsetwinsize(&slave, ws)?;
    Ok((master, slave))
}

/// Make the spawned child the leader of a new session, as host.c's child is
/// in both modes; with a pty, also make its stdin (the slave) the session's
/// controlling terminal — what login_tty(3) does inside forkpty(3).
pub fn new_session_in_child(cmd: &mut Command, controlling_tty: bool) {
    // SAFETY: the closure runs between fork and exec; setsid and the
    // TIOCSCTTY ioctl are async-signal-safe and allocate nothing.
    unsafe {
        cmd.pre_exec(move || {
            rustix::process::setsid()?;
            if controlling_tty {
                // rustix's stdin() is a plain BorrowedFd of fd 0; std's
                // io::stdin() would allocate its buffer here.
                rustix::process::ioctl_tiocsctty(rustix::stdio::stdin())?;
            }
            Ok(())
        });
    }
}
