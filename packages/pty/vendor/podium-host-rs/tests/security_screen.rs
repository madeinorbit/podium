//! POD-4990 reproducers. Only private, short sockets; every host is owned and cleaned up.
#![cfg(all(target_os = "linux", feature = "screen"))]
mod common;
use common::*;
use std::fs;
use std::time::Duration;

const C_RESIZE: u8 = 3;
const C_SIZE: u8 = 4;
const C_PICTURE: u8 = 0x0b;
const H_RESIZED: u8 = 0x84;
const H_SIZE: u8 = 0x85;
const H_PICTURE: u8 = 0x8d;

fn next_type(c: &mut Conn, want: u8) -> Vec<u8> {
    loop {
        let (ty, p) = c.next(Duration::from_secs(10)).expect("host response");
        assert_ne!(ty, H_ERR, "unexpected ERR: {p:?}");
        if ty == want { return p; }
    }
}
fn resize(cols: u16, rows: u16) -> Vec<u8> {
    frame(C_RESIZE, &[cols.to_be_bytes(), rows.to_be_bytes()].concat())
}
fn picture(c: &mut Conn) -> Vec<u8> {
    c.send(&frame(C_PICTURE, &[]));
    next_type(c, H_PICTURE)
}
fn host(dir: &Scratch, stream: &[u8]) -> (Conn, Hosts) {
    fs::write(dir.path("stream"), stream).unwrap();
    let play = format!("while ! test -e {0}/go; do sleep .01; done; cat {0}/stream; exec sleep 60", dir.0.display());
    create(&dir.path("s"), &["--cols", "80", "--rows", "24", "--ring-bytes", "65536", "--screen-scrollback", "0", "--linger-secs", "0"], &["sh", "-c", &play]);
    let (c, _) = Conn::open(&dir.path("s"), WRITER, u64::MAX);
    let mut hosts = Hosts::default();
    hosts.track(&c);
    (c, hosts)
}
fn play(dir: &Scratch, c: &mut Conn, n: usize) {
    fs::write(dir.path("go"), b"").unwrap();
    wait_until("all output consumed", Duration::from_secs(60), || c.seq_high() == n as u64);
}
fn memory(label: &str, c: &Conn, idle: u64) -> u64 {
    let rss = status_kb(c.host_pid, "VmRSS");
    let peak = status_kb(c.host_pid, "VmHWM");
    println!("{label}: idle={idle} KiB RSS={rss} KiB HWM={peak} KiB");
    peak.saturating_sub(idle)
}

#[test]
fn review_h1_unterminated_16_mib_osc_has_bounded_rss() {
    let dir = Scratch::new("s1");
    let stream = [b"\x1b]0;".as_slice(), &vec![b'A'; 16 * 1024 * 1024]].concat();
    let (mut c, _hosts) = host(&dir, &stream);
    let idle = status_kb(c.host_pid, "VmRSS");
    play(&dir, &mut c, stream.len());
    assert!(memory("H1", &c, idle) < 4 * 1024, "unterminated OSC grows the parser");
}
#[test]
fn review_h2_four_million_combining_marks_have_bounded_rss() {
    let dir = Scratch::new("s2");
    let stream = [b"A".as_slice(), "\u{301}".repeat(4_000_000).as_bytes()].concat();
    let (mut c, _hosts) = host(&dir, &stream);
    let idle = status_kb(c.host_pid, "VmRSS");
    play(&dir, &mut c, stream.len());
    let grew = memory("H2", &c, idle);
    let p = picture(&mut c);
    assert!(grew < 4 * 1024, "one cell grows without a bound");
    assert!(p.windows(2).filter(|b| *b == [0xcc, 0x81]).count() <= 16);
}
#[test]
fn review_h3_oversized_resize_is_refused_before_allocating() {
    let dir = Scratch::new("s3");
    let (mut c, _hosts) = host(&dir, b"");
    let idle = status_kb(c.host_pid, "VmRSS");
    c.send(&resize(2500, 2500));
    let (ty, _) = c.next(Duration::from_secs(15)).expect("resize response");
    memory("H3 2500x2500", &c, idle);
    assert_eq!(ty, H_ERR, "2500x2500 must be refused before ioctl/allocation");
    for (cols, rows) in [(8000, 4000), (0, 0), (1001, 24), (80, 501)] {
        c.send(&resize(cols, rows));
        assert_eq!(c.next(Duration::from_secs(5)).expect("ERR").0, H_ERR);
    }
    c.send(&resize(100, 40));
    let p = next_type(&mut c, H_RESIZED);
    assert_eq!(&p[..4], &[0, 100, 0, 40]);
    assert!(alive(c.host_pid));
    c.seq_high();
}
#[test]
fn review_h4_two_mib_title_is_bounded_in_the_picture() {
    let dir = Scratch::new("s4t");
    let stream = [b"\x1b]2;".as_slice(), &vec![b'B'; 2_000_000], b"\x07"].concat();
    let (mut c, _hosts) = host(&dir, &stream);
    play(&dir, &mut c, stream.len());
    let p = picture(&mut c);
    assert!(p.iter().filter(|&&b| b == b'B').count() <= 4096, "title: {} bytes", p.len());
    c.seq_high();
}
#[test]
fn review_h4_huge_uri_is_bounded_in_the_picture() {
    let dir = Scratch::new("s4u");
    let stream = [b"\x1b]8;;http://x/".as_slice(), &vec![b'U'; 1_500_000], b"\x1b\\X"].concat();
    let (mut c, _hosts) = host(&dir, &stream);
    play(&dir, &mut c, stream.len());
    let p = picture(&mut c);
    assert!(p.iter().filter(|&&b| b == b'U').count() <= 8192, "URI emitted twice: {} bytes", p.len());
    c.seq_high();
}
#[test]
fn review_m1_picture_after_alt_resize_does_not_change_decrc() {
    let mut results = Vec::new();
    for mid_picture in [false, true] {
        let dir = Scratch::new("s5");
        fs::write(dir.path("initial"), [vec![b'A'; 80], b"\x1b[?1049h".to_vec()].concat()).unwrap();
        let play = format!("cat {0}/initial; while ! test -e {0}/leave; do sleep .01; done; printf '\\033[?1049l\\0338Z'; exec sleep 60", dir.0.display());
        create(&dir.path("s"), &["--cols", "80", "--rows", "24", "--ring-bytes", "65536", "--screen-scrollback", "0", "--linger-secs", "0"], &["sh", "-c", &play]);
        let (mut c, _) = Conn::open(&dir.path("s"), WRITER, u64::MAX);
        let mut hosts = Hosts::default(); hosts.track(&c);
        wait_until("alt entry", Duration::from_secs(5), || c.seq_high() == 88);
        c.send(&resize(120, 24)); next_type(&mut c, H_RESIZED);
        if mid_picture { picture(&mut c); }
        fs::write(dir.path("leave"), b"").unwrap();
        wait_until("DECRC and Z", Duration::from_secs(5), || c.seq_high() == 99);
        results.push(picture(&mut c));
    }
    assert_eq!(results[0], results[1], "a picture changed the primary saved cursor");
    assert!(results[0].windows(6).any(|b| b == b"\x1b[2;2H"));
}
#[test]
fn review_m2_child_winsize_resizes_the_screen_and_sends_reset() {
    let dir = Scratch::new("s6");
    let play = format!("while ! test -e {0}/go; do sleep .01; done; stty cols 120 rows 40; printf ready; exec sleep 60", dir.0.display());
    create(&dir.path("s"), &["--cols", "80", "--rows", "24", "--linger-secs", "0"], &["sh", "-c", &play]);
    let (mut c, _) = Conn::open(&dir.path("s"), READER, u64::MAX);
    let mut hosts = Hosts::default(); hosts.track(&c);
    assert_eq!(&picture(&mut c)[9..13], &[0, 80, 0, 24]);
    fs::write(dir.path("go"), b"").unwrap();
    std::thread::sleep(Duration::from_millis(200));
    c.send(&frame(C_SIZE, &[]));
    let mut reset = None;
    loop {
        let (ty, p) = c.next(Duration::from_secs(5)).expect("SIZE/reset");
        if ty == H_PICTURE { reset = Some(p); }
        else if ty == H_SIZE { assert_eq!(p, [0, 120, 0, 40]); break; }
    }
    let reset = reset.unwrap_or_else(|| next_type(&mut c, H_PICTURE));
    assert_eq!(&reset[8..13], &[0, 0, 120, 0, 40], "reset at kernel size");
    assert_eq!(&picture(&mut c)[9..13], &[0, 120, 0, 40]);
}
