//! Finding the quick-tunnel URL in what cloudflared prints.
//!
//! cloudflared announces the assigned hostname inside an ASCII box on stderr,
//! whose borders, padding and line position have changed between releases. So
//! the URL is matched by SHAPE anywhere in a line — never by line number or
//! column: `https://<one DNS label>.trycloudflare.com`, with the host ending
//! right there.

/// Labels that are Cloudflare's own endpoints, never a tunnel. Failure lines
/// quote them (`Post "https://api.trycloudflare.com/tunnel": ...`), and
/// adopting one would publish Cloudflare's API as this server's address.
const NOT_A_TUNNEL: &[&str] = &["api", "www"];

const SCHEME: &str = "https://";
const DOMAIN: &str = ".trycloudflare.com";

fn is_label_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'-'
}

/// The first quick-tunnel origin in `line`, lower-cased, or `None`.
pub fn parse_quick_tunnel_url(line: &str) -> Option<String> {
    let lower = line.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let mut from = 0;
    while let Some(found) = lower[from..].find(SCHEME) {
        let start = from + found + SCHEME.len();
        from = start;
        let mut end = start;
        while end < bytes.len() && is_label_byte(bytes[end]) {
            end += 1;
        }
        let label = &lower[start..end];
        if label.is_empty() || label.starts_with('-') || label.ends_with('-') {
            continue;
        }
        if !lower[end..].starts_with(DOMAIN) {
            continue;
        }
        let after = end + DOMAIN.len();
        // The host must END here: `x.trycloudflare.com.attacker.net` and
        // `x.trycloudflare.com-evil.net` are someone else's. A sentence-ending
        // period, a slash, a quote or a box border is fine.
        let next = bytes.get(after).copied();
        let next2 = bytes.get(after + 1).copied();
        let continues = match next {
            Some(b) if is_label_byte(b) => true,
            Some(b'.') => next2.is_some_and(is_label_byte),
            _ => false,
        };
        if continues || NOT_A_TUNNEL.contains(&label) {
            continue;
        }
        return Some(format!("{SCHEME}{label}{DOMAIN}"));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::parse_quick_tunnel_url as parse;

    const A: &str = "https://prairie-otter-lamp-nine.trycloudflare.com";

    #[test]
    fn finds_the_url_inside_the_banner_box() {
        let line = format!("2026-09-28T10:00:01Z INF |  {A}                                     |");
        assert_eq!(parse(&line).as_deref(), Some(A));
        assert_eq!(parse(&format!("|{A}|")).as_deref(), Some(A));
        assert_eq!(parse(&format!("visit {}/ now", A.to_uppercase())).as_deref(), Some(A));
        assert_eq!(parse(&format!("visit {A}.")).as_deref(), Some(A));
        assert_eq!(parse(&format!("\"{A}/\"")).as_deref(), Some(A));
    }

    #[test]
    fn never_takes_cloudflares_own_endpoints() {
        assert_eq!(
            parse("ERR failed to request quick Tunnel: Post \"https://api.trycloudflare.com/tunnel\": timeout"),
            None
        );
        assert_eq!(parse("INF Requesting new quick Tunnel on trycloudflare.com..."), None);
    }

    #[test]
    fn rejects_look_alikes() {
        assert_eq!(parse("https://evil.trycloudflare.com.attacker.net"), None);
        assert_eq!(parse("https://evil.trycloudflare.com-attacker.net"), None);
        assert_eq!(parse("http://a-b.trycloudflare.com"), None);
        assert_eq!(parse("https://a.b.trycloudflare.com"), None);
        assert_eq!(parse("https://-a.trycloudflare.com"), None);
    }

    #[test]
    fn skips_a_bad_match_and_keeps_looking() {
        let line = format!("see https://api.trycloudflare.com/x then {A}");
        assert_eq!(parse(&line).as_deref(), Some(A));
    }
}
