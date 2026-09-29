//! Regression tests for the security reviews of podium-host (POD-4842 for
//! host.c, POD-4843 for this port). Each test drives the real binary through
//! its socket and fails on the code before the fix. Linux: they read /proc.

#![cfg(target_os = "linux")]

use std::fs;
use std::io::{ErrorKind, Read, Write};
use std::os::fd::OwnedFd;
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_podium-host");

const C_HELLO: u8 = 0x01;
const C_WRITE: u8 = 0x02;
const C_STATUS: u8 = 0x05;
const C_REPLAY: u8 = 0x09;
const H_WELCOME: u8 = 0x81;
const H_DATA: u8 = 0x82;
const H_STATUS: u8 = 0x86;
const H_EXITED: u8 = 0x88;
const H_ERR: u8 = 0x8F;
const WRITER: u8 = 1;
const READER: u8 = 2;

/// A private scratch directory, removed on drop.
struct Scratch(PathBuf);

impl Scratch {
    fn new(tag: &str) -> Scratch {
        static N: AtomicU32 = AtomicU32::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("phrs-{tag}-{}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir(&dir).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
        Scratch(dir)
    }
    fn path(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Ends the hosts a test started, and their children, pass or fail: a
/// daemonized host (and a `sleep 60` child) outlives its test otherwise.
/// Both are held as pidfds, so a recycled pid is never signalled.
#[derive(Default)]
struct Hosts(Vec<(OwnedFd, Option<OwnedFd>)>);

impl Hosts {
    /// Track the host and child named by a connection's WELCOME.
    fn track(&mut self, c: &Conn) {
        let open = |pid: u32| {
            rustix::process::Pid::from_raw(pid as i32).and_then(|p| {
                rustix::process::pidfd_open(p, rustix::process::PidfdFlags::empty()).ok()
            })
        };
        if let Some(host) = open(c.host_pid) {
            self.0.push((host, open(c.child_pid)));
        }
    }
}

impl Drop for Hosts {
    fn drop(&mut self) {
        use rustix::process::{Signal, pidfd_send_signal};
        // Gracefully first: on SIGTERM the host signals its child's group,
        // lingers at most a second, and exits.
        for (host, _) in &self.0 {
            let _ = pidfd_send_signal(host, Signal::TERM);
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        for (host, child) in &self.0 {
            let exited = |fd: &OwnedFd| {
                let mut p = [rustix::event::PollFd::new(fd, rustix::event::PollFlags::IN)];
                let zero = rustix::event::Timespec {
                    tv_sec: 0,
                    tv_nsec: 0,
                };
                rustix::event::poll(&mut p, Some(&zero)).unwrap_or(0) > 0
            };
            while !exited(host) && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(20));
            }
            for fd in [Some(host), child.as_ref()].into_iter().flatten() {
                if !exited(fd) {
                    let _ = pidfd_send_signal(fd, Signal::KILL);
                }
            }
        }
    }
}

fn create(sock: &Path, args: &[&str], cmd: &[&str]) {
    let out = Command::new(BIN)
        .arg("create")
        .arg("--socket")
        .arg(sock)
        .args(args)
        .arg("--")
        .args(cmd)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "create failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

fn frame(ty: u8, payload: &[u8]) -> Vec<u8> {
    let mut f = ((payload.len() + 1) as u32).to_be_bytes().to_vec();
    f.push(ty);
    f.extend_from_slice(payload);
    f
}

fn hello(mode: u8, from: u64) -> Vec<u8> {
    let mut p = 1u16.to_be_bytes().to_vec();
    p.push(mode);
    p.extend_from_slice(&from.to_be_bytes());
    frame(C_HELLO, &p)
}

struct Conn {
    s: UnixStream,
    buf: Vec<u8>,
    host_pid: u32,
    child_pid: u32,
}

impl Conn {
    fn open(sock: &Path, mode: u8, from: u64) -> (Conn, u32) {
        let s = UnixStream::connect(sock).unwrap();
        s.set_read_timeout(Some(Duration::from_millis(200)))
            .unwrap();
        let mut c = Conn {
            s,
            buf: Vec::new(),
            host_pid: 0,
            child_pid: 0,
        };
        c.send(&hello(mode, from));
        let (ty, p) = c.next(Duration::from_secs(5)).expect("WELCOME");
        assert_eq!(ty, H_WELCOME);
        c.host_pid = u32::from_be_bytes(p[2..6].try_into().unwrap());
        c.child_pid = u32::from_be_bytes(p[6..10].try_into().unwrap());
        let host_pid = c.host_pid;
        (c, host_pid)
    }

    fn send(&mut self, bytes: &[u8]) {
        self.s.write_all(bytes).unwrap();
    }

    /// The next frame, or None on timeout or EOF.
    fn next(&mut self, within: Duration) -> Option<(u8, Vec<u8>)> {
        let deadline = Instant::now() + within;
        loop {
            if self.buf.len() >= 5 {
                let n = u32::from_be_bytes(self.buf[..4].try_into().unwrap()) as usize;
                if self.buf.len() >= 4 + n {
                    let ty = self.buf[4];
                    let p = self.buf[5..4 + n].to_vec();
                    self.buf.drain(..4 + n);
                    return Some((ty, p));
                }
            }
            if Instant::now() >= deadline {
                return None;
            }
            let mut tmp = [0u8; 65536];
            match self.s.read(&mut tmp) {
                Ok(0) => return None,
                Ok(n) => self.buf.extend_from_slice(&tmp[..n]),
                Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
                Err(_) => return None,
            }
        }
    }

    /// STATUS → seq_high.
    fn seq_high(&mut self) -> u64 {
        self.send(&frame(C_STATUS, &[]));
        loop {
            let (ty, p) = self.next(Duration::from_secs(5)).expect("STATUS");
            if ty == H_STATUS {
                return u64::from_be_bytes(p[14..22].try_into().unwrap());
            }
        }
    }
}

fn status_kb(pid: u32, key: &str) -> u64 {
    let s = fs::read_to_string(format!("/proc/{pid}/status")).unwrap();
    let line = s.lines().find(|l| l.starts_with(key)).unwrap();
    line.split_whitespace().nth(1).unwrap().parse().unwrap()
}

fn alive(pid: u32) -> bool {
    fs::read_to_string(format!("/proc/{pid}/stat"))
        .map(|s| !s.split_whitespace().nth(2).is_some_and(|st| st == "Z"))
        .unwrap_or(false)
}

fn wait_until(what: &str, within: Duration, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + within;
    while !done() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// POD-4842 C-2 / POD-4843 RS-1: one read of pipelined REPLAY frames used to
/// copy the whole ring once per frame before the size check.
#[test]
fn a_replay_flood_is_bounded_and_drops_only_that_client() {
    let dir = Scratch::new("replay");
    let sock = dir.path("h.sock");
    let mut hosts = Hosts::default();
    create(
        &sock,
        &["--no-pty", "--ring-bytes", "1048576", "--linger-secs", "0"],
        &["sh", "-c", "head -c 1048576 /dev/zero; exec sleep 60"],
    );
    let (mut reader, pid) = Conn::open(&sock, READER, u64::MAX);
    hosts.track(&reader);
    wait_until("the ring to fill", Duration::from_secs(10), || {
        reader.seq_high() >= 1048576
    });
    let before = status_kb(pid, "VmHWM");

    let (mut flood, _) = Conn::open(&sock, READER, u64::MAX);
    let burst: Vec<u8> = (0..200)
        .flat_map(|_| frame(C_REPLAY, &u32::MAX.to_be_bytes()))
        .collect();
    flood.send(&burst); // 1.8 KB asking for 200 MiB of replay; never read
    std::thread::sleep(Duration::from_millis(1000));

    assert!(alive(pid), "the host died");
    let grew = status_kb(pid, "VmHWM").saturating_sub(before);
    assert!(
        grew < 8 * 1024,
        "the host grew by {grew} KiB for one client's replay burst"
    );
    let (mut other, _) = Conn::open(&sock, READER, u64::MAX);
    assert_eq!(other.seq_high(), 1048576, "another client is still served");
}

/// POD-4842 C-3 / POD-4843 RS-2: WRITEs to a child that does not read its
/// input used to queue without limit. Past the limit they are refused with
/// ERR 5, and the connection keeps working.
#[test]
fn writes_to_a_child_that_does_not_read_are_bounded_and_refused() {
    let dir = Scratch::new("wq");
    let sock = dir.path("h.sock");
    let mut hosts = Hosts::default();
    create(&sock, &["--no-pty", "--linger-secs", "0"], &["sleep", "60"]);
    let (mut w, pid) = Conn::open(&sock, WRITER, u64::MAX);
    hosts.track(&w);
    let before = status_kb(pid, "VmHWM");

    let chunk = vec![b'x'; 256 * 1024];
    for id in 0..32u32 {
        let mut p = id.to_be_bytes().to_vec();
        p.extend_from_slice(&chunk);
        w.send(&frame(C_WRITE, &p)); // 8 MiB in all
    }
    // Each refusal names its write: u16 code, u32 len, message, u32 write id.
    let mut refused = Vec::new();
    while let Some((ty, p)) = w.next(Duration::from_millis(1500)) {
        if ty == H_ERR && u16::from_be_bytes([p[0], p[1]]) == 5 {
            let n = u32::from_be_bytes(p[2..6].try_into().unwrap()) as usize;
            assert_eq!(&p[6..6 + n], b"input queue full");
            refused.push(u32::from_be_bytes(p[6 + n..10 + n].try_into().unwrap()));
        }
    }
    assert!(
        refused.len() >= 20,
        "only {} of 32 writes were refused",
        refused.len()
    );
    assert!(
        refused.windows(2).all(|p| p[0] < p[1]),
        "each refusal names a different write, in order: {refused:?}"
    );
    assert!(
        refused[0] >= 3,
        "a write the queue had room for was refused: {refused:?}"
    );
    assert!(refused.iter().all(|&id| id < 32));
    let grew = status_kb(pid, "VmHWM").saturating_sub(before);
    assert!(
        grew < 8 * 1024,
        "the host grew by {grew} KiB queueing input"
    );
    assert!(alive(pid));
    assert_eq!(w.seq_high(), 0, "the writer's connection still answers");
}

/// POD-4842 C-4 / POD-4843 RS-4: on exit the host unlinked its socket PATH,
/// deleting whatever had been bound there since.
#[test]
fn exit_leaves_a_socket_that_replaced_ours_alone() {
    let dir = Scratch::new("unlink");
    let sock = dir.path("h.sock");
    let mut hosts = Hosts::default();
    create(&sock, &["--no-pty", "--linger-secs", "0"], &["sleep", "60"]);
    let (conn, pid) = Conn::open(&sock, READER, u64::MAX);
    hosts.track(&conn);
    drop(conn);

    fs::remove_file(&sock).unwrap();
    let replacement = UnixListener::bind(&sock).unwrap();
    let ino = fs::symlink_metadata(&sock).unwrap().ino();
    rustix::process::kill_process(
        rustix::process::Pid::from_raw(pid as i32).unwrap(),
        rustix::process::Signal::TERM,
    )
    .unwrap();
    wait_until("the host to exit", Duration::from_secs(15), || !alive(pid));

    let meta = fs::symlink_metadata(&sock).expect("the replacement socket was deleted");
    assert!(meta.file_type().is_socket());
    assert_eq!(meta.ino(), ino);
    drop(replacement);
}

/// POD-4842 C-6: a relative --socket was unlinked from "/" after chdir, so the
/// real socket was left behind.
#[test]
fn a_relative_socket_is_removed_at_exit() {
    let dir = Scratch::new("rel");
    let out = Command::new(BIN)
        .current_dir(&dir.0)
        .args([
            "create",
            "--socket",
            "rel.sock",
            "--no-pty",
            "--linger-secs",
            "0",
            "--",
            "true",
        ])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    wait_until("the socket to be removed", Duration::from_secs(15), || {
        !dir.path("rel.sock").exists()
    });
}

/// POD-4842 C-7 / POD-4843 RS-5: a descriptor the launcher left open without
/// close-on-exec reached the child.
#[test]
fn inherited_descriptors_do_not_reach_the_child() {
    let dir = Scratch::new("fd");
    let sock = dir.path("h.sock");
    let secret = dir.path("secret");
    fs::write(&secret, "TOPSECRET").unwrap();
    let mut hosts = Hosts::default();
    // The shell opens fd 7 WITHOUT close-on-exec and execs the host with it.
    let script = format!(
        "exec 7<'{}'; exec '{BIN}' create --socket '{}' --no-pty --linger-secs 10 -- \
         sh -c 'sleep 1; cat <&7 2>/dev/null || echo NOFD'",
        secret.display(),
        sock.display()
    );
    let out = Command::new("sh").arg("-c").arg(&script).output().unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let (mut c, _) = Conn::open(&sock, READER, 0);
    hosts.track(&c);
    let mut text = Vec::new();
    while let Some((ty, p)) = c.next(Duration::from_secs(10)) {
        if ty == H_DATA {
            text.extend_from_slice(&p[8..]);
        }
        if ty == H_EXITED {
            break;
        }
    }
    let text = String::from_utf8_lossy(&text);
    assert!(
        !text.contains("TOPSECRET"),
        "the child read the inherited fd: {text:?}"
    );
    assert!(text.contains("NOFD"), "unexpected child output: {text:?}");
}

/// POD-4843 RS-4: a listener with a full accept queue made the startup probe
/// block, so `create` hung. It now counts as "already running" (exit 3).
#[test]
fn a_full_backlog_at_the_socket_path_counts_as_running() {
    use rustix::net::{AddressFamily, SocketAddrUnix, SocketFlags, SocketType};
    let dir = Scratch::new("backlog");
    let sock = dir.path("h.sock");
    let listener = rustix::net::socket(AddressFamily::UNIX, SocketType::STREAM, None).unwrap();
    rustix::net::bind(&listener, &SocketAddrUnix::new(&sock).unwrap()).unwrap();
    rustix::net::listen(&listener, 0).unwrap();
    let mut held = Vec::new();
    loop {
        let c = rustix::net::socket_with(
            AddressFamily::UNIX,
            SocketType::STREAM,
            SocketFlags::NONBLOCK,
            None,
        )
        .unwrap();
        if rustix::net::connect(&c, &SocketAddrUnix::new(&sock).unwrap()).is_err() {
            break; // the queue is full
        }
        held.push(c);
        assert!(held.len() < 4096, "the backlog never filled");
    }

    let mut create = Command::new(BIN)
        .args(["create", "--socket"])
        .arg(&sock)
        .args(["--no-pty", "--", "true"])
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    let status = loop {
        if let Some(st) = create.try_wait().unwrap() {
            break st;
        }
        if Instant::now() >= deadline {
            let _ = create.kill();
            panic!("create blocked on a listener whose queue is full");
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    assert_eq!(status.code(), Some(3));
    let mut err = String::new();
    create
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut err)
        .unwrap();
    assert!(err.contains("already running"), "{err}");
}

/// POD-4843 RS-3: the child starts in the --cwd directory (it fchdirs to the
/// fd opened at startup; the race itself is proved by the review's PoC).
#[test]
fn the_child_starts_in_the_cwd_directory() {
    let dir = Scratch::new("cwd");
    let sock = dir.path("h.sock");
    let work = dir.path("work");
    fs::create_dir(&work).unwrap();
    let mut hosts = Hosts::default();
    create(
        &sock,
        &[
            "--no-pty",
            "--linger-secs",
            "10",
            "--cwd",
            work.to_str().unwrap(),
        ],
        &["sh", "-c", "sleep 1; pwd"],
    );
    let (mut c, _) = Conn::open(&sock, READER, 0);
    hosts.track(&c);
    let mut text = Vec::new();
    while let Some((ty, p)) = c.next(Duration::from_secs(10)) {
        if ty == H_DATA {
            text.extend_from_slice(&p[8..]);
        }
        if ty == H_EXITED {
            break;
        }
    }
    assert_eq!(
        String::from_utf8_lossy(&text).trim(),
        work.to_str().unwrap()
    );
}

/// The other half of the unlink fix: the host still removes its OWN socket.
/// (An identity taken with fstat on the listener names the socket's inode,
/// not the file's, and matched nothing: no socket was ever removed.)
#[test]
fn exit_removes_its_own_socket() {
    let dir = Scratch::new("own");
    let sock = dir.path("h.sock");
    create(&sock, &["--no-pty", "--linger-secs", "0"], &["true"]);
    wait_until("the socket to be removed", Duration::from_secs(15), || {
        !sock.exists()
    });
}
