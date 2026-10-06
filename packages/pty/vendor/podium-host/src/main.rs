//! podium-host — a small durable process host, and the only one Podium
//! spawns (POD-4986). Rust port (POD-4791) of the C host, host.c, which lived
//! in this directory until POD-4986 removed it (read it in git history); the
//! comments here that compare with host.c describe that retired C host, whose
//! running sessions are still adopted.
//!
//! One process per session. It owns a child (through a pty, or through pipes
//! with --no-pty), keeps a bounded ring of the child's output addressed by a
//! monotonic byte sequence number, serves a framed protocol on one unix socket,
//! grants one writer lease at a time, applies resizes itself and answers with
//! the size the kernel now reports, reports the child's real exit status,
//! lingers briefly so a late client can read it, then unlinks its socket and
//! exits. The protocol is SPEC-6 (POD-3190 artifact #31). With the `screen`
//! feature (the default) a pty host also keeps the terminal's screen and puts
//! pictures of it into the output stream (POD-4909).

mod args;
#[cfg(feature = "screen")]
mod cut;
mod host;
mod proto;
mod ring;
#[cfg(feature = "screen")]
mod screen;
#[cfg(unix)]
mod sys;
#[cfg(windows)]
#[path = "windows.rs"]
mod sys;
#[cfg(unix)]
mod unix;

use std::fmt;
use std::io::{self, Write};
const VERSION: &str = match option_env!("PODIUM_HOST_VERSION") {
    Some(v) => v,
    None => "1-podium",
};
/// 1 — SPEC-6 protocol version 1. 2 — the screen: WELCOME's features byte
/// and PICTURE (POD-4909). The retired C host (host.c) reports 1.
const HOST_FEATURES: u32 = if cfg!(feature = "screen") { 2 } else { 1 };

pub fn die(msg: fmt::Arguments) -> ! {
    let _ = writeln!(io::stderr(), "podium-host: {msg}");
    std::process::exit(1)
}

/// `die` for a message that carries argv or path bytes: they are written
/// exactly as given, as host.c prints them, even when they are not UTF-8.
pub fn die_raw(parts: &[&[u8]]) -> ! {
    let _ = io::stderr().write_all(&[b"podium-host: ", &parts.concat()[..], b"\n"].concat());
    std::process::exit(1)
}

fn usage() -> ! {
    let _ = io::stderr().write_all(
        b"usage: podium-host create --socket <path> [--cols N --rows N | --no-pty]\n\
          \x20                         [--ring-bytes N] [--linger-secs N] [--cwd <dir>]\n\
          \x20                         [--screen-scrollback N] -- <cmd> [args...]\n\
          \x20      podium-host version\n",
    );
    std::process::exit(2)
}

fn main() {
    #[cfg(unix)]
    unix::run();
    #[cfg(windows)]
    sys::run();
}
