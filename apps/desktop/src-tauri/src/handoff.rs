//! The existing deep-link plugin delivers cold and warm URLs to the native FIFO.
//! Keep credentials out of the page's generic native-open event: navigate the
//! webview to its configured API, whose response installs the HttpOnly cookie.
use tauri::Url;

pub fn parse_signed_in(url: &Url) -> Option<String> {
    if url.scheme() != "podium"
        || url.host_str() != Some("signed-in")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || !matches!(url.path(), "" | "/")
        || url.fragment().is_some()
    {
        return None;
    }
    let mut pairs = url.query_pairs();
    let (key, code) = pairs.next()?;
    if key != "code" || pairs.next().is_some() || !valid_code(&code) {
        return None;
    }
    Some(code.into_owned())
}

fn valid_code(code: &str) -> bool {
    code.strip_prefix("hoff_")
        .is_some_and(|value| value.len() == 27 && value.bytes().all(|c| c.is_ascii_alphanumeric()))
}

pub fn handoff_url(server_url: &str, code: &str) -> Result<Url, String> {
    if !valid_code(code) {
        return Err("Invalid desktop sign-in code".into());
    }
    let mut url = crate::bootstrap::validated_webview_http_url(server_url)?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err("The desktop server URL must not contain credentials".into());
    }
    url.set_path("/platform/auth/handoff");
    url.set_query(None);
    url.set_fragment(None);
    url.query_pairs_mut().append_pair("code", code);
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;
    const CODE: &str = "hoff_2Y8QmBl3xZc1Kk9nQ0F7hVtAsd1";

    #[test]
    fn parses_signed_in_only() {
        assert_eq!(
            parse_signed_in(&Url::parse(&format!("podium://signed-in?code={CODE}")).unwrap())
                .as_deref(),
            Some(CODE)
        );
        for raw in [
            format!("https://signed-in?code={CODE}"),
            format!("podium://issues?code={CODE}"),
            format!("podium://signed-in/path?code={CODE}"),
            format!("podium://user@signed-in?code={CODE}"),
            format!("podium://signed-in:42?code={CODE}"),
            format!("podium://signed-in?code={CODE}#fragment"),
            format!("podium://signed-in?code={CODE}&code={CODE}"),
            format!("podium://signed-in?code={CODE}&server=https://evil.example"),
            "podium://signed-in".into(),
            "podium://signed-in?code=hoff_short".into(),
            "podium://signed-in?code=hoff_00000000000000000000000000-".into(),
        ] {
            assert!(
                parse_signed_in(&Url::parse(&raw).unwrap()).is_none(),
                "{raw}"
            );
        }
    }

    #[test]
    fn uses_only_the_configured_secure_api() {
        assert_eq!(
            handoff_url("wss://api.podium.do/old?secret=old#old", CODE)
                .unwrap()
                .as_str(),
            format!("https://api.podium.do/platform/auth/handoff?code={CODE}")
        );
        assert!(handoff_url("http://127.0.0.1:8080", CODE).is_ok());
        for server in [
            "http://api.podium.do",
            "file:///tmp/app",
            "https://user:password@api.podium.do",
            "invalid",
        ] {
            assert!(handoff_url(server, CODE).is_err());
        }
        assert!(handoff_url("https://api.podium.do", "bad").is_err());
    }
}
