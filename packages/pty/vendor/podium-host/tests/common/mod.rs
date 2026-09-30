//! What the integration tests share: a private scratch directory, the hosts a
//! test started (ended pass or fail), `create`, and a framed connection.

#![allow(dead_code)] // each test crate uses a different subset

use std::fs;
use std::io::{ErrorKind, Read, Write};
use std::os::fd::OwnedFd;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

pub const BIN: &str = env!("CARGO_BIN_EXE_podium-host");

pub const C_HELLO: u8 = 0x01;
pub const C_WRITE: u8 = 0x02;
pub const C_STATUS: u8 = 0x05;
pub const C_REPLAY: u8 = 0x09;
pub const H_WELCOME: u8 = 0x81;
pub const H_DATA: u8 = 0x82;
pub const H_STATUS: u8 = 0x86;
pub const H_EXITED: u8 = 0x88;
pub const H_ERR: u8 = 0x8F;
pub const WRITER: u8 = 1;
pub const READER: u8 = 2;

/// A private scratch directory, removed on drop.
pub struct Scratch(pub PathBuf);

impl Scratch {
    pub fn new(tag: &str) -> Scratch {
        static N: AtomicU32 = AtomicU32::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("phrs-{tag}-{}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir(&dir).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
        Scratch(dir)
    }
    pub fn path(&self, name: &str) -> PathBuf {
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
pub struct Hosts(pub Vec<(OwnedFd, Option<OwnedFd>)>);

impl Hosts {
    /// Track the host and child named by a connection's WELCOME.
    pub fn track(&mut self, c: &Conn) {
        let open = |pid: u32| {
            rustix::process::Pid::from_raw(pid as i32).and_then(|p| {
                rustix::process::pidfd_open(p, rustix::process::PidfdFlags::empty()).ok()
            })
        };
        // The host just answered WELCOME, so its pidfd must open; the child may
        // already have exited (a `true` child), so its pidfd is optional. A test
        // that fails between `create` and its first HELLO still leaks that host:
        // no pid is known yet.
        let host = open(c.host_pid).expect("pidfd of the host that just answered WELCOME");
        self.0.push((host, open(c.child_pid)));
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

pub fn create(sock: &Path, args: &[&str], cmd: &[&str]) {
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

pub fn frame(ty: u8, payload: &[u8]) -> Vec<u8> {
    let mut f = ((payload.len() + 1) as u32).to_be_bytes().to_vec();
    f.push(ty);
    f.extend_from_slice(payload);
    f
}

pub fn hello(mode: u8, from: u64) -> Vec<u8> {
    let mut p = 1u16.to_be_bytes().to_vec();
    p.push(mode);
    p.extend_from_slice(&from.to_be_bytes());
    frame(C_HELLO, &p)
}

pub struct Conn {
    pub s: UnixStream,
    pub buf: Vec<u8>,
    pub host_pid: u32,
    pub child_pid: u32,
    /// The WELCOME payload.
    pub welcome: Vec<u8>,
}

impl Conn {
    pub fn open(sock: &Path, mode: u8, from: u64) -> (Conn, u32) {
        let s = UnixStream::connect(sock).unwrap();
        s.set_read_timeout(Some(Duration::from_millis(200)))
            .unwrap();
        let mut c = Conn {
            s,
            buf: Vec::new(),
            host_pid: 0,
            child_pid: 0,
            welcome: Vec::new(),
        };
        c.send(&hello(mode, from));
        let (ty, p) = c.next(Duration::from_secs(5)).expect("WELCOME");
        assert_eq!(ty, H_WELCOME);
        c.host_pid = u32::from_be_bytes(p[2..6].try_into().unwrap());
        c.child_pid = u32::from_be_bytes(p[6..10].try_into().unwrap());
        c.welcome = p;
        let host_pid = c.host_pid;
        (c, host_pid)
    }

    pub fn send(&mut self, bytes: &[u8]) {
        self.s.write_all(bytes).unwrap();
    }

    /// The next frame, or None on timeout or EOF.
    pub fn next(&mut self, within: Duration) -> Option<(u8, Vec<u8>)> {
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
    pub fn seq_high(&mut self) -> u64 {
        self.send(&frame(C_STATUS, &[]));
        loop {
            let (ty, p) = self.next(Duration::from_secs(5)).expect("STATUS");
            if ty == H_STATUS {
                return u64::from_be_bytes(p[14..22].try_into().unwrap());
            }
        }
    }
}

pub fn status_kb(pid: u32, key: &str) -> u64 {
    let s = fs::read_to_string(format!("/proc/{pid}/status")).unwrap();
    let line = s.lines().find(|l| l.starts_with(key)).unwrap();
    line.split_whitespace().nth(1).unwrap().parse().unwrap()
}

pub fn alive(pid: u32) -> bool {
    fs::read_to_string(format!("/proc/{pid}/stat"))
        .map(|s| !s.split_whitespace().nth(2).is_some_and(|st| st == "Z"))
        .unwrap_or(false)
}

pub fn wait_until(what: &str, within: Duration, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + within;
    while !done() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(50));
    }
}
