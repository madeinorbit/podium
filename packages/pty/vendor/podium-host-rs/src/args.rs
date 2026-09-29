//! The command line, parsed exactly as host.c's main() does.

use std::ffi::CString;
use std::ffi::OsString;
use std::os::unix::ffi::OsStringExt;

#[derive(Debug)]
pub struct CreateOpts {
    pub socket: OsString,
    pub cwd: Option<Vec<u8>>,
    pub cols: u16,
    pub rows: u16,
    pub ring_bytes: usize,
    pub linger_secs: u64,
    pub no_pty: bool,
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
    /// Print `podium-host: <msg>`, exit 1.
    Die(String),
}

/// strtol(3) base 10 as host.c uses it: leading whitespace and one sign are
/// accepted, the rest must be digits, and the value must be in [lo, hi].
fn arg_long(name: &[u8], v: &[u8], lo: i64, hi: i64) -> Result<i64, ArgError> {
    let bad = || {
        ArgError::Die(format!(
            "bad value for {}: {}",
            String::from_utf8_lossy(name),
            String::from_utf8_lossy(v)
        ))
    };
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
            (b"--cols", Some(v)) => cols = arg_long(a, v, 1, 65535)?,
            (b"--rows", Some(v)) => rows = arg_long(a, v, 1, 65535)?,
            (b"--ring-bytes", Some(v)) => ring = arg_long(a, v, 4096, 1 << 30)?,
            (b"--linger-secs", Some(v)) => linger = arg_long(a, v, 0, 86400)?,
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
            "--no-pty and --cols/--rows are exclusive".into(),
        ));
    }
    let command = argv[i..]
        .iter()
        .map(|a| CString::new(a.clone()).expect("argv holds no NUL"))
        .collect();
    Ok(Command::Create(CreateOpts {
        socket: OsString::from_vec(sock),
        cwd,
        cols: if cols != 0 { cols as u16 } else { 80 },
        rows: if rows != 0 { rows as u16 } else { 24 },
        ring_bytes: ring as usize,
        linger_secs: linger as u64,
        no_pty,
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
            Err(ArgError::Die(m)) => m,
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
    fn a_later_flag_wins_and_the_command_keeps_its_dashes() {
        let o = create("create --socket /a --socket /b -- prog --socket x --");
        assert_eq!(o.socket, "/b");
        assert_eq!(o.command.len(), 4);
    }
}
