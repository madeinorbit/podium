//! Pictures in the output stream (POD-4909, SPEC v4 step A): the host keeps
//! the screen and sends exact pictures of it on request, after a resize, and
//! to bound the tail. Each test drives the real binary through its socket.
//! Linux: the helpers read /proc.

#![cfg(all(target_os = "linux", feature = "screen"))]

mod common;

// The host's own emulator is the oracle: a picture followed by the DATA after
// it must leave a fresh screen exactly where the whole stream leaves one.
#[allow(dead_code)]
#[path = "../src/screen.rs"]
mod screen;

use std::fs;
use std::process::Command;
use std::time::{Duration, Instant};

use common::*;
use screen::Screen;

const C_RESIZE: u8 = 0x03;
const C_PICTURE: u8 = 0x0B;
const H_RESIZED: u8 = 0x84;
const H_PICTURE: u8 = 0x8D;
const RESET: u8 = 0;
const CUT: u8 = 1;
const BUDGET: usize = 1 << 20;
const END: &[u8] = b"\x1b[0m<END-OF-STREAM>";

#[derive(Debug)]
struct Picture {
    seq: u64,
    reason: u8,
    cols: u16,
    rows: u16,
    bytes: Vec<u8>,
}

impl Picture {
    /// `u64 seq`, `u8 reason`, `u16 cols`, `u16 rows`, the picture bytes.
    fn parse(p: &[u8]) -> Picture {
        Picture {
            seq: u64::from_be_bytes(p[..8].try_into().unwrap()),
            reason: p[8],
            cols: u16::from_be_bytes([p[9], p[10]]),
            rows: u16::from_be_bytes([p[11], p[12]]),
            bytes: p[13..].to_vec(),
        }
    }
}

fn resize(cols: u16, rows: u16) -> Vec<u8> {
    let mut p = cols.to_be_bytes().to_vec();
    p.extend_from_slice(&rows.to_be_bytes());
    frame(C_RESIZE, &p)
}

/// Every frame until `quiet` passes without one; DATA must be contiguous.
struct Read {
    data: Vec<u8>,
    from: u64,
    pictures: Vec<Picture>,
    /// Frame types in arrival order.
    types: Vec<u8>,
}

impl Read {
    fn new(from: u64) -> Read {
        Read {
            data: Vec::new(),
            from,
            pictures: Vec::new(),
            types: Vec::new(),
        }
    }

    fn end(&self) -> u64 {
        self.from + self.data.len() as u64
    }

    /// Take one frame into the record; false on timeout or EOF.
    fn step(&mut self, c: &mut Conn, within: Duration) -> bool {
        let Some((ty, p)) = c.next(within) else {
            return false;
        };
        self.types.push(ty);
        match ty {
            H_DATA => {
                let seq = u64::from_be_bytes(p[..8].try_into().unwrap());
                if self.data.is_empty() && self.from == u64::MAX {
                    self.from = seq;
                }
                assert_eq!(seq, self.end(), "DATA is contiguous");
                self.data.extend_from_slice(&p[8..]);
            }
            H_PICTURE => {
                let pic = Picture::parse(&p);
                assert!(
                    pic.reason == RESET || pic.reason == CUT,
                    "reason {}",
                    pic.reason
                );
                if self.data.is_empty() && self.from == u64::MAX {
                    self.from = pic.seq;
                }
                assert_eq!(
                    pic.seq,
                    self.end(),
                    "a picture follows the DATA it stands for"
                );
                self.pictures.push(pic);
            }
            H_ERR => panic!("ERR {:?}", String::from_utf8_lossy(&p)),
            _ => {}
        }
        true
    }

    fn until_quiet(&mut self, c: &mut Conn, quiet: Duration) -> &mut Self {
        while self.step(c, quiet) {}
        self
    }

    fn pictures_of(&self, reason: u8) -> Vec<&Picture> {
        self.pictures
            .iter()
            .filter(|p| p.reason == reason)
            .collect()
    }
}

/// Deterministic noise: colours (16/256/RGB), attributes, cursor jumps,
/// erases, wide and combining characters, scrolling and regions, titles,
/// DCS strings, synchronized output and the alternate screen.
fn noise(seed: u64, n: usize) -> Vec<u8> {
    let mut x = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
    let mut r = move |m: u64| {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        x % m
    };
    let words = [
        "the ",
        "quick ",
        "日本語 ",
        "é ",
        "e\u{301} ",
        "✓ ",
        "brown fox jumps over ",
    ];
    let mut out = String::new();
    while out.len() < n {
        match r(26) {
            0 => out += &format!("\x1b[38;5;{}m", r(256)),
            1 => out += &format!("\x1b[48;2;{};{};{}m", r(256), r(256), r(256)),
            2 => {
                out += &format!(
                    "\x1b[{}m",
                    [0, 1, 2, 3, 4, 7, 9, 22, 24, 27, 31, 42, 95][r(13) as usize]
                )
            }
            3 => out += &format!("\x1b[{};{}H", r(32), r(102)),
            4 => {
                out += [
                    "\x1b[K", "\x1b[1K", "\x1b[2K", "\x1b[J", "\x1b[3X", "\x1b[2P", "\x1b[2@",
                ][r(7) as usize]
            }
            5 => out += "\r\n",
            6 => out += ["\x1b[2L", "\x1b[1M", "\x1bM", "\x1b[S", "\x1b[T"][r(5) as usize],
            7 => out += &format!("\x1b]2;title {}\x07", r(1000)),
            8 => out += "\x1bP1$q\"m\x1b\\",
            9 => out += ["\x1b[?2026h", "\x1b[?2026l", "\x1b[?25l", "\x1b[?25h"][r(4) as usize],
            10 => out += &format!("\x1b[{};{}r", 1 + r(10), 12 + r(18)),
            11 => out += ["\x1b[?1049h", "\x1b[?1049l", "\x1b[r"][r(3) as usize],
            _ => out += words[r(words.len() as u64) as usize],
        }
    }
    out.into_bytes()
}

/// Dense colour, one RGB background per cell.
fn dense(cols: usize, lines: usize) -> Vec<u8> {
    let mut out = String::new();
    for l in 0..lines {
        for c in 0..cols {
            let v = (l * 7 + c * 13) % 251;
            out += &format!(
                "\x1b[48;2;{v};{};{}m{}",
                (v * 3) % 256,
                (v * 5) % 256,
                (b'a' + (c % 26) as u8) as char
            );
        }
        out += "\x1b[0m\r\n";
    }
    out.into_bytes()
}

fn picture_of(s: &mut Screen) -> Vec<u8> {
    let mut p = Vec::new();
    s.picture(&mut p);
    p
}

fn feed(s: &mut Screen, bytes: &[u8]) {
    for c in bytes.chunks(4096) {
        s.feed(c);
    }
}

/// Wait until the host's ring stops growing and return its high seq.
fn settled(c: &mut Conn) -> u64 {
    let mut last = u64::MAX;
    loop {
        std::thread::sleep(Duration::from_millis(300));
        let now = c.seq_high();
        if now == last {
            return now;
        }
        last = now;
    }
}

/// SPEC v4 step A, done-when 1: heavy output, requests and cuts on one
/// connection; every picture plus the DATA after it equals the direct feed.
#[test]
fn pictures_amid_heavy_output_are_exact() {
    let dir = Scratch::new("pic-exact");
    let sock = dir.path("h.sock");
    for i in 0..60u64 {
        let mut part = noise(i + 1, 50_000);
        if i == 59 {
            part.extend_from_slice(END);
        }
        fs::write(dir.path(&format!("p{i:03}")), part).unwrap();
    }
    let play = format!(
        "for f in {}/p*; do cat \"$f\"; sleep 0.02; done; exec sleep 60",
        dir.0.display()
    );
    create(
        &sock,
        &[
            "--cols",
            "100",
            "--rows",
            "30",
            "--ring-bytes",
            "67108864",
            "--linger-secs",
            "0",
            "--screen-scrollback",
            "200",
        ],
        &["sh", "-c", &play],
    );
    let (mut c, _) = Conn::open(&sock, READER, 0);
    let mut hosts = Hosts::default();
    hosts.track(&c);
    c.send(&frame(C_PICTURE, &[]));

    let mut read = Read::new(0);
    let deadline = Instant::now() + Duration::from_secs(120);
    let mut frames = 0;
    while !read.data.ends_with(END) {
        assert!(Instant::now() < deadline, "the stream did not end");
        if read.step(&mut c, Duration::from_millis(200)) && read.types.last() == Some(&H_DATA) {
            frames += 1;
            if frames % 25 == 0 {
                c.send(&frame(C_PICTURE, &[])); // a request amid the output
            }
        }
    }
    read.until_quiet(&mut c, Duration::from_millis(800));

    let (resets, cuts) = (read.pictures_of(RESET), read.pictures_of(CUT));
    assert!(resets.len() >= 3, "{} reset pictures", resets.len());
    assert!(
        cuts.len() >= 2,
        "{} cuts in {} bytes",
        cuts.len(),
        read.data.len()
    );
    for w in cuts.windows(2) {
        assert!(
            w[1].seq - w[0].seq >= 65536,
            "cuts at {} and {}",
            w[0].seq,
            w[1].seq
        );
    }

    let mut direct = Screen::new(100, 30, 200);
    feed(&mut direct, &read.data);
    let want = picture_of(&mut direct);
    for p in &read.pictures {
        assert_eq!((p.cols, p.rows), (100, 30));
        let mut replay = Screen::new(p.cols, p.rows, 200);
        feed(&mut replay, &p.bytes);
        feed(&mut replay, &read.data[p.seq as usize..]);
        assert!(
            picture_of(&mut replay) == want,
            "the picture @ {} (reason {}) plus the rest differs from the direct feed",
            p.seq,
            p.reason
        );
    }
}

/// A resize sends a reset picture at the new size to every connection that
/// opted in, after its RESIZED; one that never asked gets none, and a
/// same-size RESIZE (no TIOCSWINSZ) sends nothing.
#[test]
fn a_resize_sends_a_reset_picture_to_every_opted_in_connection() {
    let dir = Scratch::new("pic-resize");
    let sock = dir.path("h.sock");
    create(
        &sock,
        &["--cols", "80", "--rows", "24", "--linger-secs", "0"],
        &["sh", "-c", "printf 'hello \\033[31mred'; exec sleep 60"],
    );
    let (mut w, _) = Conn::open(&sock, WRITER, u64::MAX);
    let mut hosts = Hosts::default();
    hosts.track(&w);
    let (mut r1, _) = Conn::open(&sock, READER, u64::MAX);
    let (mut r2, _) = Conn::open(&sock, READER, u64::MAX);

    let mut rw = Read::new(u64::MAX);
    let mut r1r = Read::new(u64::MAX);
    for (c, r) in [(&mut w, &mut rw), (&mut r1, &mut r1r)] {
        c.send(&frame(C_PICTURE, &[]));
        r.until_quiet(c, Duration::from_millis(500));
        assert_eq!(r.pictures.len(), 1, "one answer to the request");
        let p = &r.pictures[0];
        assert_eq!((p.reason, p.cols, p.rows), (RESET, 80, 24));
    }

    w.send(&resize(100, 40));
    rw.until_quiet(&mut w, Duration::from_millis(500));
    r1r.until_quiet(&mut r1, Duration::from_millis(500));
    for r in [&rw, &r1r] {
        assert_eq!(r.pictures.len(), 2, "a reset after the resize");
        let p = &r.pictures[1];
        assert_eq!((p.reason, p.cols, p.rows), (RESET, 100, 40));
    }
    let at = |ty| rw.types.iter().rposition(|&t| t == ty).unwrap();
    assert!(
        at(H_RESIZED) < at(H_PICTURE),
        "RESIZED comes first: {:?}",
        rw.types
    );

    let mut r2r = Read::new(u64::MAX);
    r2r.until_quiet(&mut r2, Duration::from_millis(500));
    assert!(
        r2r.pictures.is_empty(),
        "a connection that never asked gets no picture"
    );

    w.send(&resize(100, 40));
    rw.until_quiet(&mut w, Duration::from_millis(500));
    r1r.until_quiet(&mut r1, Duration::from_millis(500));
    assert_eq!(
        (rw.pictures.len(), r1r.pictures.len()),
        (2, 2),
        "a same-size RESIZE sends none"
    );
}

/// WELCOME ends with a features byte (bit 0 = screen), and `version` says
/// features=2. A host without a pty keeps no screen: it says so, and answers
/// PICTURE as any host answers an unknown frame.
#[test]
fn the_welcome_announces_the_screen() {
    let out = Command::new(BIN).arg("version").output().unwrap();
    let v = String::from_utf8_lossy(&out.stdout);
    assert!(v.trim_end().ends_with(" features=2"), "{v}");

    let dir = Scratch::new("pic-welcome");
    let (pty, nopty) = (dir.path("a.sock"), dir.path("b.sock"));
    create(
        &pty,
        &["--cols", "80", "--rows", "24", "--linger-secs", "0"],
        &["sleep", "60"],
    );
    create(
        &nopty,
        &["--no-pty", "--linger-secs", "0"],
        &["sleep", "60"],
    );
    let mut hosts = Hosts::default();
    let (a, _) = Conn::open(&pty, READER, u64::MAX);
    hosts.track(&a);
    let (mut b, _) = Conn::open(&nopty, READER, u64::MAX);
    hosts.track(&b);
    assert_eq!((a.welcome.len(), a.welcome[32]), (33, 1));
    assert_eq!((b.welcome.len(), b.welcome[32]), (33, 0));

    b.send(&frame(C_PICTURE, &[]));
    let (ty, p) = b.next(Duration::from_secs(5)).expect("an answer");
    assert_eq!(
        (ty, u16::from_be_bytes([p[0], p[1]])),
        (H_ERR, 3),
        "ERR bad frame"
    );
    assert!(
        b.next(Duration::from_secs(2)).is_none(),
        "then the host closes it"
    );
}

/// SPEC v4 step A, done-when 2: a dense truecolour screen yields a picture
/// within the 1 MiB budget (scrollback trimmed) and the connection lives on.
#[test]
fn a_dense_screen_yields_a_picture_within_the_budget() {
    let dir = Scratch::new("pic-budget");
    let sock = dir.path("h.sock");
    let stream = dense(200, 1100);
    fs::write(dir.path("dense"), &stream).unwrap();
    let play = format!("cat {}/dense; exec sleep 60", dir.0.display());
    create(
        &sock,
        &[
            "--cols",
            "200",
            "--rows",
            "30",
            "--ring-bytes",
            "65536",
            "--linger-secs",
            "0",
        ],
        &["sh", "-c", &play],
    );
    let (mut c, _) = Conn::open(&sock, READER, u64::MAX);
    let mut hosts = Hosts::default();
    hosts.track(&c);
    settled(&mut c);
    c.send(&frame(C_PICTURE, &[]));
    let mut read = Read::new(u64::MAX);
    read.until_quiet(&mut c, Duration::from_millis(1000));
    assert_eq!(read.pictures.len(), 1);
    let p = &read.pictures[0];
    assert!(
        p.bytes.len() <= BUDGET,
        "a picture of {} bytes",
        p.bytes.len()
    );
    assert!(
        p.bytes.len() > BUDGET / 2,
        "scrollback was kept up to the budget: {}",
        p.bytes.len()
    );
    c.seq_high(); // still served
}

/// A queued picture does not count against the connection's queue limit
/// (ring + 1 MiB): a visible screen larger than that is sent whole, to a
/// client that reads it late, and the connection lives on.
#[test]
fn a_picture_larger_than_the_queue_limit_is_delivered() {
    let dir = Scratch::new("pic-limit");
    let sock = dir.path("h.sock");
    fs::write(dir.path("dense"), dense(1000, 120)).unwrap();
    let play = format!("cat {}/dense; exec sleep 60", dir.0.display());
    create(
        &sock,
        &[
            "--cols",
            "1000",
            "--rows",
            "100",
            "--ring-bytes",
            "4096",
            "--screen-scrollback",
            "0",
            "--linger-secs",
            "0",
        ],
        &["sh", "-c", &play],
    );
    let (mut c, _) = Conn::open(&sock, READER, u64::MAX);
    let mut hosts = Hosts::default();
    hosts.track(&c);
    settled(&mut c);
    c.send(&frame(C_PICTURE, &[]));
    std::thread::sleep(Duration::from_millis(700)); // not reading
    let mut read = Read::new(u64::MAX);
    read.until_quiet(&mut c, Duration::from_millis(1000));
    assert_eq!(read.pictures.len(), 1, "frames {:x?}", read.types);
    let n = read.pictures[0].bytes.len();
    assert!(
        n > 4096 + BUDGET + 65536,
        "the picture ({n} bytes) must exceed the queue limit"
    );
    c.seq_high(); // still served
}

/// H4: resets that fall due while a picture is still being sent coalesce
/// into one fresh reset, sent once it drains, at the size then current.
#[test]
fn resets_while_a_picture_is_pending_coalesce_into_one() {
    let dir = Scratch::new("pic-h4");
    let sock = dir.path("h.sock");
    fs::write(dir.path("dense"), dense(1000, 120)).unwrap();
    let play = format!("cat {}/dense; exec sleep 60", dir.0.display());
    create(
        &sock,
        &[
            "--cols",
            "1000",
            "--rows",
            "100",
            "--ring-bytes",
            "4096",
            "--screen-scrollback",
            "0",
            "--linger-secs",
            "0",
        ],
        &["sh", "-c", &play],
    );
    let (mut w, _) = Conn::open(&sock, WRITER, u64::MAX);
    let mut hosts = Hosts::default();
    hosts.track(&w);
    settled(&mut w);
    w.send(&frame(C_PICTURE, &[]));
    std::thread::sleep(Duration::from_millis(300)); // the picture is pending
    for cols in [999, 1000, 998, 1000, 997] {
        w.send(&resize(cols, 100));
    }
    std::thread::sleep(Duration::from_millis(300));
    let mut read = Read::new(u64::MAX);
    read.until_quiet(&mut w, Duration::from_millis(1500));
    let sizes: Vec<_> = read.pictures.iter().map(|p| (p.reason, p.cols)).collect();
    assert_eq!(
        sizes,
        [(RESET, 1000), (RESET, 997)],
        "frames {:x?}",
        read.types
    );
    assert_eq!(read.types.iter().filter(|&&t| t == H_RESIZED).count(), 5);
}

/// H2: a cut that falls due within 250 ms of the last one is sent when the
/// 250 ms are up, even if no further output comes: the tail after the last
/// cut is left under the cut size.
#[test]
fn a_due_cut_is_sent_without_further_output() {
    let dir = Scratch::new("pic-h2");
    let sock = dir.path("h.sock");
    let text = |tag: &str| {
        let mut s = String::new();
        let mut i = 0;
        while s.len() < 70_000 {
            s += &format!("{tag} line {i} of plain text for the cut clock\r\n");
            i += 1;
        }
        s
    };
    fs::write(dir.path("a"), text("a")).unwrap();
    fs::write(dir.path("b"), [text("b").as_bytes(), END].concat()).unwrap();
    let d = dir.0.display();
    let play = format!("sleep 0.4; cat {d}/a; sleep 0.05; cat {d}/b; exec sleep 60");
    create(
        &sock,
        &["--cols", "80", "--rows", "24", "--linger-secs", "0"],
        &["sh", "-c", &play],
    );
    let (mut c, _) = Conn::open(&sock, READER, 0);
    let mut hosts = Hosts::default();
    hosts.track(&c);
    c.send(&frame(C_PICTURE, &[]));
    let mut read = Read::new(0);
    let deadline = Instant::now() + Duration::from_secs(30);
    while !read.data.ends_with(END) {
        assert!(Instant::now() < deadline, "the stream did not end");
        read.step(&mut c, Duration::from_millis(200));
    }
    read.until_quiet(&mut c, Duration::from_millis(1000));
    let cuts = read.pictures_of(CUT);
    let last = cuts.last().expect("at least one cut");
    let tail = read.end() - last.seq;
    assert!(
        tail < 65536,
        "{tail} bytes after the last cut: a due cut was stranded"
    );
}
