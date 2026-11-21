//! `create --pipe-env` (POD-7378): bytes the launcher writes to the host's
//! stdin reach the child on an inherited pipe, named by a variable, and
//! nowhere else. Linux: the tests read /proc.

#![cfg(target_os = "linux")]

use std::fs;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Output, Stdio};
use std::time::Duration;

mod common;

use common::*;

const SECRET: &str = "sk-ant-api03-PODIUM-PIPE-ENV-FIXTURE";

/// `create` with `stdin` written to the host's stdin, which is then closed.
fn create_with_stdin(sock: &Path, args: &[&str], cmd: &[&str], stdin: &[u8]) -> Output {
    let mut child = Command::new(BIN)
        .arg("create")
        .arg("--socket")
        .arg(sock)
        .args(args)
        .arg("--")
        .args(cmd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(stdin).unwrap();
    child.wait_with_output().unwrap()
}

/// The child's whole output, until it exits.
fn output_of(c: &mut Conn) -> String {
    let mut text = Vec::new();
    while let Some((ty, p)) = c.next(Duration::from_secs(10)) {
        if ty == H_DATA {
            text.extend_from_slice(&p[8..]);
        }
        if ty == H_EXITED {
            break;
        }
    }
    String::from_utf8_lossy(&text).into_owned()
}

/// The pipe inodes `pid` holds open.
fn pipes_of(pid: u32) -> Vec<String> {
    let Ok(entries) = fs::read_dir(format!("/proc/{pid}/fd")) else {
        return Vec::new();
    };
    entries
        .filter_map(|e| fs::read_link(e.ok()?.path()).ok())
        .map(|l| l.to_string_lossy().into_owned())
        .filter(|l| l.starts_with("pipe:"))
        .collect()
}

#[test]
fn the_child_reads_the_bytes_from_the_named_descriptor_and_nowhere_else() {
    let dir = Scratch::new("pipe-env");
    let sock = dir.path("h.sock");
    let mut hosts = Hosts::default();
    // The child names the pipe, reads it to its end twice (the second read is
    // empty: one copy, already drained), and looks for the bytes in its
    // environment and its arguments. The sleep lets the test look at the
    // host's descriptors while the child still runs.
    // The pattern is joined at run time: the script's own text, which is the
    // shell's argv, never holds the whole secret.
    let script = "P=PODIUM-PIPE; \
                  echo \"link=$(readlink /proc/self/fd/$CRED_FD)\"; \
                  echo \"first=$(cat /proc/self/fd/$CRED_FD)\"; \
                  echo \"second=$(cat /proc/self/fd/$CRED_FD)\"; \
                  if env | grep -q \"$P-ENV-FIXTURE\"; then echo env=yes; else echo env=no; fi; \
                  if tr '\\0' ' ' </proc/$$/cmdline | grep -q \"$P-ENV-FIXTURE\"; then echo argv=yes; else echo argv=no; fi; \
                  sleep 1";
    let out = create_with_stdin(
        &sock,
        &["--no-pty", "--linger-secs", "10", "--pipe-env", "CRED_FD"],
        &["sh", "-c", script],
        SECRET.as_bytes(),
    );
    assert!(
        out.status.success(),
        "create failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let (mut c, host_pid) = Conn::open(&sock, READER, 0);
    hosts.track(&c);
    // The host closed its copy once the child had it.
    let host_pipes = pipes_of(host_pid);
    let text = output_of(&mut c);
    assert!(
        text.contains(&format!("first={SECRET}")),
        "child output: {text:?}"
    );
    assert!(
        text.contains("second=\n"),
        "the pipe held a second copy: {text:?}"
    );
    assert!(
        text.contains("env=no"),
        "the bytes reached the environment: {text:?}"
    );
    assert!(
        text.contains("argv=no"),
        "the bytes reached the arguments: {text:?}"
    );
    let link = text
        .lines()
        .find_map(|l| l.strip_prefix("link="))
        .unwrap_or_default()
        .to_owned();
    assert!(link.starts_with("pipe:"), "CRED_FD is not a pipe: {text:?}");
    assert!(
        !host_pipes.contains(&link),
        "the host still holds the child's pipe {link}: {host_pipes:?}"
    );
}

#[test]
fn nothing_on_stdin_refuses_the_start() {
    for stdin in [&b""[..], b" \n\t"] {
        let dir = Scratch::new("pipe-env-empty");
        let sock = dir.path("h.sock");
        let marker = dir.path("started");
        let out = create_with_stdin(
            &sock,
            &["--no-pty", "--pipe-env", "CRED_FD"],
            &["sh", "-c", &format!("touch '{}'", marker.display())],
            stdin,
        );
        assert_eq!(out.status.code(), Some(1), "{stdin:?} was accepted");
        let err = String::from_utf8_lossy(&out.stderr);
        assert!(
            err.contains("--pipe-env CRED_FD: nothing on stdin"),
            "unexpected refusal: {err:?}"
        );
        std::thread::sleep(Duration::from_millis(200));
        assert!(!marker.exists(), "the child ran on an empty pipe");
        assert!(!sock.exists(), "a refused create left its socket");
    }
}

#[test]
fn a_variable_that_is_not_a_name_is_refused() {
    let dir = Scratch::new("pipe-env-name");
    let sock = dir.path("h.sock");
    let out = create_with_stdin(
        &sock,
        &["--no-pty", "--pipe-env", "A=B"],
        &["true"],
        SECRET.as_bytes(),
    );
    assert_eq!(out.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&out.stderr).contains("bad value for --pipe-env"));
}

#[test]
fn a_pty_child_gets_the_pipe_too() {
    let dir = Scratch::new("pipe-env-pty");
    let sock = dir.path("h.sock");
    let mut hosts = Hosts::default();
    let out = create_with_stdin(
        &sock,
        &[
            "--cols",
            "80",
            "--rows",
            "24",
            "--linger-secs",
            "10",
            "--pipe-env",
            "CRED_FD",
        ],
        &[
            "sh",
            "-c",
            "echo \"got=$(cat /proc/self/fd/$CRED_FD)\"; sleep 1",
        ],
        SECRET.as_bytes(),
    );
    assert!(
        out.status.success(),
        "create failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let (mut c, _) = Conn::open(&sock, READER, 0);
    hosts.track(&c);
    let text = output_of(&mut c);
    assert!(
        text.contains(&format!("got={SECRET}")),
        "child output: {text:?}"
    );
}
