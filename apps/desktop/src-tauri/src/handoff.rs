//! The existing deep-link plugin delivers cold and warm URLs to the native FIFO.
//! Keep credentials out of the page's generic native-open event: navigate the
//! webview to its configured API, whose response installs the HttpOnly cookie.
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Url;
use tauri_plugin_opener::OpenerExt;

static ATTEMPT_LOCK: Mutex<()> = Mutex::new(());
#[derive(serde::Serialize, serde::Deserialize)]
struct PendingAttempt {
    challenge: String,
    server: String,
    expires_at: u64,
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn valid_challenge(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn attempt_path() -> std::path::PathBuf {
    crate::bootstrap::state_dir().join("desktop-sign-in.json")
}

#[tauri::command]
pub fn begin_cloud_sign_in(
    app: tauri::AppHandle,
    url: String,
    challenge: String,
) -> Result<(), String> {
    let _guard = ATTEMPT_LOCK
        .lock()
        .map_err(|_| "Sign-in state unavailable")?;
    if !valid_challenge(&challenge) {
        return Err("Invalid sign-in challenge".into());
    }
    let mut destination = crate::bootstrap::validated_webview_http_url(&url)?;
    if !destination.username().is_empty() || destination.password().is_some() {
        return Err("Invalid sign-in destination".into());
    }
    let server = crate::bootstrap::read_config()
        .server_url
        .ok_or("No cloud server configured")?;
    let pending = PendingAttempt {
        challenge: challenge.clone(),
        server,
        expires_at: now() + 600,
    };
    let path = attempt_path();
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let temp = path.with_extension("tmp");
    std::fs::write(
        &temp,
        serde_json::to_vec(&pending).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    std::fs::rename(&temp, &path).map_err(|e| e.to_string())?;
    destination
        .query_pairs_mut()
        .append_pair("challenge", &challenge);
    if let Err(error) = app.opener().open_url(destination.as_str(), None::<&str>) {
        let _ = std::fs::remove_file(path);
        return Err(error.to_string());
    }
    Ok(())
}

fn consume_at(path: &std::path::Path, challenge: &str, server: &str, now: u64) -> Option<()> {
    let pending: PendingAttempt = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    if pending.expires_at <= now {
        let _ = std::fs::remove_file(path);
        return None;
    }
    if pending.challenge != challenge || pending.server != server {
        return None;
    }
    std::fs::remove_file(path).ok()?;
    Some(())
}

pub fn receive(url: &Url, server: &str) -> Option<Url> {
    let _guard = ATTEMPT_LOCK.lock().ok()?;
    let (code, challenge) = parse_signed_in(url)?;
    let target = handoff_url(server, &code).ok()?;
    consume_at(&attempt_path(), &challenge, server, now())?;
    Some(target)
}

pub fn parse_signed_in(url: &Url) -> Option<(String, String)> {
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
    let pairs: Vec<_> = url.query_pairs().collect();
    if pairs.len() != 2 {
        return None;
    }
    let code = pairs.iter().find(|(k, _)| k == "code")?.1.as_ref();
    let challenge = pairs.iter().find(|(k, _)| k == "challenge")?.1.as_ref();
    if !valid_code(code) || !valid_challenge(challenge) {
        return None;
    }
    Some((code.into(), challenge.into()))
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
            parse_signed_in(
                &Url::parse(&format!(
                    "podium://signed-in?code={CODE}&challenge={}",
                    "a".repeat(64)
                ))
                .unwrap()
            ),
            Some((CODE.into(), "a".repeat(64)))
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
                parse_signed_in(&Url::parse(&format!("{raw}&challenge={}", "a".repeat(64))).unwrap()).is_none(),
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

    #[test]
    fn pending_attempt_survives_cold_read_and_is_consumed_once() {
        let path = std::env::temp_dir().join(format!("podium-pending-{}", std::process::id()));
        let challenge = "a".repeat(64);
        let write = || {
            std::fs::write(
                &path,
                serde_json::to_vec(&PendingAttempt {
                    challenge: challenge.clone(),
                    server: "https://api.podium.do".into(),
                    expires_at: 100,
                })
                .unwrap(),
            )
            .unwrap()
        };
        assert!(consume_at(&path, &challenge, "https://api.podium.do", 1).is_none());
        write(); // Persisted by a previous process: cold and warm delivery use the same gate.
        assert!(consume_at(&path, &"b".repeat(64), "https://api.podium.do", 1).is_none());
        assert!(consume_at(&path, &challenge, "https://evil.example", 1).is_none());
        assert!(consume_at(&path, &challenge, "https://api.podium.do", 1).is_some());
        assert!(consume_at(&path, &challenge, "https://api.podium.do", 1).is_none());
        write();
        assert!(consume_at(&path, &challenge, "https://api.podium.do", 100).is_none());
        assert!(!path.exists());
    }
}
