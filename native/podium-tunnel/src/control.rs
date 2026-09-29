//! Telling the Podium server a new URL, over its control socket.
//!
//! The server listens on a user-only unix socket (`<stateDir>/run/control.sock`,
//! 0600 in a 0700 directory). Only this OS user can connect, so there is no
//! token to carry. One plain HTTP/1.1 request per URL, `Connection: close`.

use std::io::{self, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::Duration;

/// What the server said.
#[derive(Debug, PartialEq, Eq)]
pub enum PostOutcome {
    /// 200: recorded (or already recorded).
    Accepted,
    /// 4xx: the server will not take this URL, and asking again will not
    /// change that — PODIUM_PUBLIC_URL owns it, or this box is not a server.
    Refused { status: u16, body: String },
    /// Anything else (5xx, a garbled reply): worth another try later.
    Retry { status: u16 },
}

const IO_TIMEOUT: Duration = Duration::from_secs(10);

/// The request body. The URL comes from `parse_quick_tunnel_url`, which only
/// ever yields `[a-z0-9-.:/]`, but it is escaped anyway so this function is
/// safe on its own.
pub fn request_body(url: &str) -> String {
    let mut escaped = String::with_capacity(url.len());
    for ch in url.chars() {
        match ch {
            '"' => escaped.push_str("\\\""),
            '\\' => escaped.push_str("\\\\"),
            c if (c as u32) < 0x20 => escaped.push_str(&format!("\\u{:04x}", c as u32)),
            c => escaped.push(c),
        }
    }
    // confirmUrlChange: a quick tunnel's URL changes by design, and the old one
    // is already dead when this runs. The server's guard exists to stop a
    // HUMAN from stranding joined machines by accident; here the replacement is
    // the whole point, and Podium Connect is what re-points those machines.
    format!("{{\"url\":\"{escaped}\",\"confirmUrlChange\":true}}")
}

pub fn request_bytes(url: &str) -> Vec<u8> {
    let body = request_body(url);
    format!(
        "POST /v1/public-url HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    )
    .into_bytes()
}

/// `HTTP/1.1 409 Conflict ...` -> (409, body).
pub fn parse_response(raw: &[u8]) -> Option<(u16, String)> {
    let text = String::from_utf8_lossy(raw);
    let status_line = text.lines().next()?;
    let mut parts = status_line.split_whitespace();
    if !parts.next()?.starts_with("HTTP/1.") {
        return None;
    }
    let status = parts.next()?.parse::<u16>().ok()?;
    let body = text.split_once("\r\n\r\n").map(|(_, b)| b.to_string()).unwrap_or_default();
    Some((status, body))
}

pub fn classify(status: u16, body: String) -> PostOutcome {
    match status {
        200..=299 => PostOutcome::Accepted,
        400..=499 => PostOutcome::Refused { status, body },
        _ => PostOutcome::Retry { status },
    }
}

/// POST `url` to the control socket. An `Err` means the server was not
/// reachable (not running, restarting): the caller retries.
pub fn post_public_url(socket: &Path, url: &str) -> io::Result<PostOutcome> {
    let mut stream = UnixStream::connect(socket)?;
    stream.set_read_timeout(Some(IO_TIMEOUT))?;
    stream.set_write_timeout(Some(IO_TIMEOUT))?;
    stream.write_all(&request_bytes(url))?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw)?;
    Ok(match parse_response(&raw) {
        Some((status, body)) => classify(status, body),
        None => PostOutcome::Retry { status: 0 },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn body_confirms_the_change_and_escapes() {
        assert_eq!(
            request_body("https://a-b.trycloudflare.com"),
            r#"{"url":"https://a-b.trycloudflare.com","confirmUrlChange":true}"#
        );
        assert_eq!(request_body("a\"b\\c"), r#"{"url":"a\"b\\c","confirmUrlChange":true}"#);
    }

    #[test]
    fn request_carries_an_exact_content_length() {
        let raw = String::from_utf8(request_bytes("https://x.trycloudflare.com")).unwrap();
        let (head, body) = raw.split_once("\r\n\r\n").unwrap();
        assert!(head.starts_with("POST /v1/public-url HTTP/1.1\r\n"));
        assert!(head.contains(&format!("Content-Length: {}", body.len())));
    }

    #[test]
    fn responses_are_classified() {
        let ok = b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n{\"ok\":true}";
        assert_eq!(parse_response(ok), Some((200, "{\"ok\":true}".to_string())));
        let (s, b) = parse_response(b"HTTP/1.1 409 Conflict\r\n\r\n{\"ok\":false}").unwrap();
        assert!(matches!(classify(s, b), PostOutcome::Refused { status: 409, .. }));
        assert_eq!(classify(503, String::new()), PostOutcome::Retry { status: 503 });
        assert_eq!(parse_response(b"garbage"), None);
    }
}
