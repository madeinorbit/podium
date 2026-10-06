//! The command line, parsed exactly as host.c's main() does.

use std::ffi::CString;
use std::ffi::OsString;
#[cfg(unix)]
use std::os::unix::ffi::OsStringExt;

pub const MAX_COLS: u16 = 1000;
pub const MAX_ROWS: u16 = 500;

#[derive(Debug)]
pub struct CreateOpts {
    pub socket: OsString,
    pub cwd: Option<Vec<u8>>,
    #[cfg(windows)]
    pub pidfile: Option<OsString>,
    pub cols: u16,
    pub rows: u16,
    pub ring_bytes: usize,
    pub linger_secs: u64,
    pub no_pty: bool,
    /// Lines of scrollback the kept screen holds (`screen` builds).
    #[cfg(feature = "screen")]
    pub screen_scrollback: usize,
    pub command: Vec<CString>,
}

#[derive(Debug)]
pub enum Command {
    Version,
    Create(CreateOpts),
}

#[derive(Debug, PartialEq, Eq)]
pub enum ArgError {
    /// Print usage, exit 2.
    Usage,
    /// Print `podium-host: <msg>`, exit 1. Bytes, not a String: argv bytes are
    /// echoed exactly, as host.c does, even when they are not UTF-8.
    Die(Vec<u8>),
}

/// strtol(3) base 10 as host.c uses it: leading whitespace and one sign are
/// accepted, the rest must be digits, and the value must be in [lo, hi]. An
/// EMPTY value is 0: strtol leaves its end pointer on the terminating NUL,
/// which host.c's check accepts (whitespace alone is refused).
fn arg_long(name: &[u8], v: &[u8], lo: i64, hi: i64) -> Result<i64, ArgError> {
    let bad = || ArgError::Die([b"bad value for ", name, b": ", v].concat());
    if v.is_empty() {
        return if (lo..=hi).contains(&0) {
            Ok(0)
        } else {
            Err(bad())
        };
    }
    let t = &v[v
        .iter()
        .position(|b| !matches!(b, b' ' | b'\t'..=b'\r'))
        .unwrap_or(v.len())..]; // isspace
    let n: i64 = std::str::from_utf8(t)
        .ok()
        .and_then(|s| s.parse().ok())
        .ok_or_else(bad)?;
    if n < lo || n > hi { Err(bad()) } else { Ok(n) }
}

pub fn parse(argv: &[Vec<u8>]) -> Result<Command, ArgError> {
    use ArgError::Usage;
    match argv.get(1).map(Vec::as_slice) {
        Some(b"version") => return Ok(Command::Version),
        Some(b"create") => {}
        _ => return Err(Usage),
    }
    let (mut sock, mut cwd) = (None, None);
    let (mut cols, mut rows, mut ring, mut linger) = (0, 0, 4i64 << 20, 30);
    let mut no_pty = false;
    #[cfg(windows)]
    let mut pidfile = None;
    #[cfg(feature = "screen")]
    let mut screen_scrollback = crate::screen::DEFAULT_SCROLLBACK as i64;
    let mut i = 2;
    while i < argv.len() {
        let a = argv[i].as_slice();
        if a == b"--" {
            i += 1;
            break;
        }
        let v = argv.get(i + 1).map(Vec::as_slice);
        match (a, v) {
            (b"--socket", Some(v)) => sock = Some(v.to_vec()),
            (b"--cwd", Some(v)) => cwd = Some(v.to_vec()),
            #[cfg(windows)]
            (b"--pidfile", Some(v)) => pidfile = Some(os_string(v.to_vec())),
            (b"--cols", Some(v)) => cols = arg_long(a, v, 1, MAX_COLS as i64)?,
            (b"--rows", Some(v)) => rows = arg_long(a, v, 1, MAX_ROWS as i64)?,
            (b"--ring-bytes", Some(v)) => ring = arg_long(a, v, 4096, 1 << 30)?,
            (b"--linger-secs", Some(v)) => linger = arg_long(a, v, 0, 86400)?,
            #[cfg(feature = "screen")]
            (b"--screen-scrollback", Some(v)) => {
                screen_scrollback = arg_long(a, v, 0, 100_000)?;
            }
            (b"--no-pty", _) => {
                no_pty = true;
                i += 1;
                continue;
            }
            _ => return Err(Usage),
        }
        i += 2;
    }
    let Some(sock) = sock else { return Err(Usage) };
    if i >= argv.len() {
        return Err(Usage);
    }
    if no_pty && (cols != 0 || rows != 0) {
        return Err(ArgError::Die(
            b"--no-pty and --cols/--rows are exclusive".to_vec(),
        ));
    }
    let command = argv[i..]
        .iter()
        .map(|a| CString::new(a.clone()).expect("argv holds no NUL"))
        .collect();
    Ok(Command::Create(CreateOpts {
        socket: os_string(sock),
        #[cfg(windows)]
        pidfile,
        cwd,
        cols: if cols != 0 { cols as u16 } else { 80 },
        rows: if rows != 0 { rows as u16 } else { 24 },
        ring_bytes: ring as usize,
        linger_secs: linger as u64,
        no_pty,
        #[cfg(feature = "screen")]
        screen_scrollback: screen_scrollback as usize,
        command,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(s: &str) -> Vec<Vec<u8>> {
        std::iter::once("podium-host")
            .chain(s.split(' '))
            .map(|a| a.as_bytes().to_vec())
            .collect()
    }

    fn create(s: &str) -> CreateOpts {
        match parse(&argv(s)) {
            Ok(Command::Create(o)) => o,
            other => panic!("{s}: {other:?}"),
        }
    }

    #[test]
    fn version() {
        assert!(matches!(parse(&argv("version")), Ok(Command::Version)));
    }

    #[test]
    fn defaults() {
        let o = create("create --socket /s -- sh -c true");
        assert_eq!(o.socket, "/s");
        assert_eq!(
            (o.cols, o.rows, o.ring_bytes, o.linger_secs, o.no_pty),
            (80, 24, 4 << 20, 30, false)
        );
        assert_eq!(
            o.command,
            [c"sh".to_owned(), c"-c".to_owned(), c"true".to_owned()]
        );
        assert_eq!(o.cwd, None);
    }

    #[test]
    fn every_flag() {
        let o = create(
            "create --socket /s --cols 120 --rows 40 --ring-bytes 4096 --linger-secs 0 --cwd /tmp -- x",
        );
        assert_eq!(
            (o.cols, o.rows, o.ring_bytes, o.linger_secs),
            (120, 40, 4096, 0)
        );
        assert_eq!(o.cwd.as_deref(), Some(&b"/tmp"[..]));
        assert!(create("create --no-pty --socket /s -- x").no_pty);
        #[cfg(feature = "screen")]
        {
            assert_eq!(create("create --socket /s -- x").screen_scrollback, 1000);
            let o = create("create --socket /s --screen-scrollback 0 -- x");
            assert_eq!(o.screen_scrollback, 0);
        }
    }

    #[test]
    fn usage_errors() {
        for s in [
            "",
            "creat",
            "create --socket /s",    // no command
            "create --socket /s --", // empty command
            "create -- x",           // no socket
            "create --socket",       // flag without value
            "create --socket /s --bogus -- x",
            "create --socket /s --cols", // value missing
        ] {
            let a = if s.is_empty() {
                vec![b"podium-host".to_vec()]
            } else {
                argv(s)
            };
            assert_eq!(parse(&a).err(), Some(ArgError::Usage), "{s:?}");
        }
    }

    #[test]
    fn bad_values_die_like_strtol() {
        let die = |s: &str| match parse(&argv(s)) {
            Err(ArgError::Die(m)) => String::from_utf8(m).unwrap(),
            other => panic!("{s}: {other:?}"),
        };
        assert_eq!(
            die("create --socket /s --cols 0 -- x"),
            "bad value for --cols: 0"
        );
        assert_eq!(
            die("create --socket /s --rows 65536 -- x"),
            "bad value for --rows: 65536"
        );
        assert_eq!(
            die("create --socket /s --ring-bytes 4095 -- x"),
            "bad value for --ring-bytes: 4095"
        );
        assert_eq!(
            die("create --socket /s --linger-secs 5x -- x"),
            "bad value for --linger-secs: 5x"
        );
        assert_eq!(
            die("create --no-pty --socket /s --cols 80 -- x"),
            "--no-pty and --cols/--rows are exclusive"
        );
        // strtol accepts a sign and leading blanks, as host.c does
        assert_eq!(create("create --socket /s --cols +90 -- x").cols, 90);
        let mut a = argv("create --socket /s --cols X -- x");
        a[5] = b" \t77".to_vec();
        match parse(&a) {
            Ok(Command::Create(o)) => assert_eq!(o.cols, 77),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn an_empty_value_is_zero_as_strtol_reads_it() {
        let mut a = argv("create --socket /s --linger-secs X -- x");
        a[5] = Vec::new();
        match parse(&a) {
            Ok(Command::Create(o)) => assert_eq!(o.linger_secs, 0),
            other => panic!("{other:?}"),
        }
        // 0 is out of range for --cols; whitespace alone is not a number
        let mut a = argv("create --socket /s --cols X -- x");
        a[5] = Vec::new();
        assert_eq!(
            parse(&a).err(),
            Some(ArgError::Die(b"bad value for --cols: ".to_vec()))
        );
        a[5] = b" ".to_vec();
        assert_eq!(
            parse(&a).err(),
            Some(ArgError::Die(b"bad value for --cols:  ".to_vec()))
        );
    }

    #[test]
    fn a_bad_value_is_echoed_byte_for_byte() {
        let mut a = argv("create --socket /s --cols X -- x");
        a[5] = vec![b'9', 0xFF];
        assert_eq!(
            parse(&a).err(),
            Some(ArgError::Die(b"bad value for --cols: 9\xFF".to_vec()))
        );
    }

    #[test]
    fn a_later_flag_wins_and_the_command_keeps_its_dashes() {
        let o = create("create --socket /a --socket /b -- prog --socket x --");
        assert_eq!(o.socket, "/b");
        assert_eq!(o.command.len(), 4);
    }
}

fn os_string(bytes: Vec<u8>) -> OsString {
    #[cfg(unix)]
    { OsString::from_vec(bytes) }
    #[cfg(windows)]
    { OsString::from(String::from_utf8(bytes).expect("Unicode Windows argv")) }
}
