//! podium-host — a small durable process host. EXPERIMENTAL Rust port
//! (POD-4791) of ../podium-host/host.c, which stays the shipped host.
//!
//! One process per session. It owns a child (through a pty, or through pipes
//! with --no-pty), keeps a bounded ring of the child's output addressed by a
//! monotonic byte sequence number, serves a framed protocol on one unix socket,
//! grants one writer lease at a time, applies resizes itself and answers with
//! the size the kernel now reports, reports the child's real exit status,
//! lingers briefly so a late client can read it, then unlinks its socket and
//! exits. The protocol is SPEC-6 (POD-3190 artifact #31).

mod args;
mod host;
mod proto;
mod ring;
mod sys;

use std::ffi::OsStr;
use std::fmt;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::os::fd::{AsFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{FileTypeExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::process;

use args::{Command, CreateOpts};
use host::{Child, ChildIo, Host};
use ring::Ring;

const VERSION: &str = match option_env!("PODIUM_HOST_VERSION") {
    Some(v) => v,
    None => "1-podium",
};
const HOST_FEATURES: u32 = 1;

pub fn die(msg: fmt::Arguments) -> ! {
    let _ = writeln!(io::stderr(), "podium-host: {msg}");
    std::process::exit(1)
}

macro_rules! die {
    ($($t:tt)*) => { crate::die(format_args!($($t)*)) };
}

fn usage() -> ! {
    let _ = io::stderr().write_all(
        b"usage: podium-host create --socket <path> [--cols N --rows N | --no-pty]\n\
          \x20                         [--ring-bytes N] [--linger-secs N] [--cwd <dir>] -- <cmd> [args...]\n\
          \x20      podium-host version\n",
    );
    std::process::exit(2)
}

#[cfg(target_os = "linux")]
const SUN_PATH_LEN: usize = 108;
#[cfg(target_os = "macos")]
const SUN_PATH_LEN: usize = 104;

fn bind_socket(path: &Path) -> UnixListener {
    let shown = path.display();
    let len = path.as_os_str().len();
    if len >= SUN_PATH_LEN {
        die!(
            "socket path is too long: {len} bytes, the limit is {}",
            SUN_PATH_LEN - 1
        );
    }
    match fs::symlink_metadata(path) {
        Ok(st) => {
            if !st.file_type().is_socket() {
                die!("{shown} exists and is not a socket");
            }
            match UnixStream::connect(path) {
                Ok(_) => {
                    let _ = writeln!(io::stderr(), "podium-host: already running at {shown}");
                    std::process::exit(3);
                }
                Err(e)
                    if matches!(
                        e.kind(),
                        io::ErrorKind::ConnectionRefused | io::ErrorKind::NotFound
                    ) => {}
                Err(e) => die!(
                    "{shown}: cannot probe the existing socket: {}",
                    sys::strerror(&e)
                ),
            }
            if let Err(e) = fs::remove_file(path)
                && e.kind() != io::ErrorKind::NotFound
            {
                die!("unlink {shown}: {}", sys::strerror(&e));
            }
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => die!("{shown}: {}", sys::strerror(&e)),
    }
    let old = rustix::process::umask(rustix::fs::Mode::from_raw_mode(0o077));
    let bound = UnixListener::bind(path);
    rustix::process::umask(old);
    let listener = bound.unwrap_or_else(|e| die!("bind {shown}: {}", sys::strerror(&e)));
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    let _ = listener.set_nonblocking(true);
    listener
}

/// Spawn the child on a pty or on pipes. std's Command does the fork and exec
/// and reports an exec (or chdir) failure as an error from `spawn`, so
/// `create` fails instead of hosting a dead child.
fn spawn_child(opts: &CreateOpts, cwd: &OsStr) -> Child {
    let [program, args @ ..] = opts.command.as_slice() else {
        unreachable!("args::parse requires a command")
    };
    let mut cmd = process::Command::new(OsStr::from_bytes(program.as_bytes()));
    cmd.args(args.iter().map(|a| OsStr::from_bytes(a.as_bytes())));
    cmd.current_dir(cwd);
    let ws = sys::Winsize {
        ws_col: opts.cols,
        ws_row: opts.rows,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    let fail = |what: &str, e: io::Error| -> ! { die!("{what}: {}", sys::strerror(&e)) };

    let io = if opts.no_pty {
        // stdin from a pipe; stdout AND stderr into one pipe, merged in the ring.
        let (in_r, in_w) = io::pipe().unwrap_or_else(|e| fail("pipe", e));
        let (out_r, out_w) = io::pipe().unwrap_or_else(|e| fail("pipe", e));
        let out_w2 = out_w.try_clone().unwrap_or_else(|e| fail("dup", e));
        cmd.stdin(in_r).stdout(out_w).stderr(out_w2);
        ChildIo {
            output: File::from(OwnedFd::from(out_r)),
            input: Some(File::from(OwnedFd::from(in_w))),
        }
    } else {
        let (master, slave) = sys::openpty(ws).unwrap_or_else(|e| fail("openpty", e));
        let dup = || slave.try_clone().unwrap_or_else(|e| fail("dup", e));
        cmd.stdin(dup()).stdout(dup()).stderr(slave);
        ChildIo {
            output: File::from(master),
            input: None,
        }
    };
    // A session (and so a process group) of its own, so SIGNAL and KILL
    // reach the whole group.
    sys::new_session_in_child(&mut cmd, !opts.no_pty);
    #[expect(
        clippy::zombie_processes,
        reason = "the host loop reaps it with waitpid(-1), as host.c does"
    )]
    let child = cmd.spawn().unwrap_or_else(|e| {
        die!(
            "cannot run {}: {}",
            program.to_string_lossy(),
            sys::strerror(&e)
        )
    });
    drop(cmd); // closes the parent's copies of the child's ends
    let pid = sys::child_pid(&child);
    for f in [Some(&io.output), io.input.as_ref()].into_iter().flatten() {
        sys::set_nonblock(f);
    }
    Child {
        pid,
        io,
        has_pty: !opts.no_pty,
        ws,
    }
}

/// Double-fork into the background; the original process waits for the
/// daemonized host to report "started" (or an error) and exits accordingly.
fn daemonize_then_run(opts: CreateOpts, listener: UnixListener, cwd: &OsStr) -> ! {
    // Identify the socket we bound, and name it absolutely: the host chdirs to
    // "/" and must not unlink someone else's socket at exit (POD-4842 C-4, C-6).
    let sock_id = sys::socket_id(&listener);
    let sock_path = std::path::absolute(&opts.socket).unwrap_or_else(|_| PathBuf::from(&opts.socket));
    // CLOEXEC on both ends: the child must not inherit the report pipe, or the
    // original process would wait for EOF until the whole session ended.
    let (report_r, report_w) = io::pipe().unwrap_or_else(|e| die!("pipe: {}", sys::strerror(&e)));
    match sys::fork().unwrap_or_else(|e| die!("fork: {}", sys::strerror(&e))) {
        sys::Forked::Parent(p1) => {
            drop(report_w);
            let mut msg = Vec::with_capacity(4096);
            let _ = (&report_r).take(4095).read_to_end(&mut msg);
            sys::wait_for(p1);
            if msg.starts_with(b"OK\n") {
                process::exit(0);
            }
            let mut err = io::stderr();
            let _ = if msg.is_empty() {
                err.write_all(b"podium-host: the host exited before reporting\n")
            } else {
                err.write_all(&msg)
            };
            sys::remove_own_socket(&sock_path, sock_id);
            process::exit(1);
        }
        sys::Forked::Child => {}
    }
    // First child: a new session, then fork again so the host is not its
    // leader and can never acquire a controlling terminal. Nothing is buffered
    // in this process, so exit() here flushes nothing twice.
    if rustix::process::setsid().is_err() {
        process::exit(1);
    }
    match sys::fork() {
        Ok(sys::Forked::Child) => {}
        Ok(sys::Forked::Parent(_)) => process::exit(0),
        Err(_) => process::exit(1),
    }
    // The host. stdin/stdout go to /dev/null now; stderr keeps going to the
    // report pipe until we are up, then to /dev/null too.
    drop(report_r);
    let devnull = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open("/dev/null")
        .ok();
    if let Some(d) = &devnull {
        let _ = rustix::stdio::dup2_stdin(d);
        let _ = rustix::stdio::dup2_stdout(d);
    }
    let saved_err = rustix::io::fcntl_dupfd_cloexec(rustix::stdio::stderr(), 0).ok();
    let _ = rustix::stdio::dup2_stderr(&report_w);
    let sig_fd = sys::install_signals().unwrap_or_else(|e| die!("pipe: {}", sys::strerror(&e)));
    let child = spawn_child(&opts, cwd); // dies (to the report pipe) on failure
    let _ = std::env::set_current_dir("/");
    let _ = (&report_w).write_all(b"OK\n");
    if let Some(back) = devnull
        .as_ref()
        .map(AsFd::as_fd)
        .or(saved_err.as_ref().map(AsFd::as_fd))
    {
        let _ = rustix::stdio::dup2_stderr(back);
    }
    drop((devnull, saved_err, report_w));
    let ring = Ring::new(opts.ring_bytes);
    Host::new(
        sock_path,
        sock_id,
        listener,
        sig_fd,
        child,
        ring,
        opts.linger_secs,
    )
    .run()
}

fn main() {
    let argv: Vec<Vec<u8>> = std::env::args_os().map(|a| a.as_bytes().to_vec()).collect();
    match args::parse(&argv) {
        Ok(Command::Version) => {
            let _ = writeln!(
                io::stdout(),
                "podium-host {VERSION} features={HOST_FEATURES}"
            );
        }
        Ok(Command::Create(opts)) => {
            // Before the host opens anything of its own: nothing this process
            // inherited may reach the child (POD-4842 C-7).
            sys::cloexec_inherited_fds();
            let cwd = OsStr::from_bytes(opts.cwd.as_deref().unwrap_or(b".")).to_owned();
            // Opened only to refuse a bad --cwd up front, as host.c does; the
            // child changes into it by path.
            if let Err(e) = fs::OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_DIRECTORY)
                .open(&cwd)
            {
                die!("cwd {}: {}", cwd.to_string_lossy(), sys::strerror(&e));
            }
            let listener = bind_socket(Path::new(&opts.socket));
            daemonize_then_run(opts, listener, &cwd)
        }
        Err(args::ArgError::Usage) => usage(),
        Err(args::ArgError::Die(msg)) => die!("{msg}"),
    }
}
