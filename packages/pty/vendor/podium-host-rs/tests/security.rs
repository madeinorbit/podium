//! Regression tests for the security reviews of podium-host (POD-4842 for
//! host.c, POD-4843 for this port). Each test drives the real binary through
//! its socket and fails on the code before the fix. Linux: they read /proc.

#![cfg(target_os = "linux")]

use std::fs;
use std::io::Read;
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::os::unix::net::UnixListener;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

mod common;

use common::*;

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
    for id in 0..160u32 {
        let mut p = id.to_be_bytes().to_vec();
        p.extend_from_slice(&chunk);
        w.send(&frame(C_WRITE, &p)); // 40 MiB in all, past the 16 MiB cap
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
        refused.len() >= 90,
        "only {} of 160 writes were refused",
        refused.len()
    );
    assert!(
        refused.windows(2).all(|p| p[0] < p[1]),
        "each refusal names a different write, in order: {refused:?}"
    );
    assert!(
        refused[0] >= 60,
        "a write the queue had room for was refused: {refused:?}"
    );
    assert!(refused.iter().all(|&id| id < 160));
    let grew = status_kb(pid, "VmHWM").saturating_sub(before);
    assert!(
        grew < 24 * 1024,
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
