use std::net::TcpListener;
use std::path::{Path, PathBuf};
use tauri::{Url, WebviewUrl};

/// Bind an ephemeral loopback port and return it (best-effort; falls back to 18787).
///
/// NOTE: The port is not reserved between this call and when the backend binds it (TOCTOU).
/// This is acceptable for a localhost picker — the window between pick and bind is tiny and
/// the port is only used locally.
pub fn pick_free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .ok()
        .and_then(|l| l.local_addr().ok())
        .map(|a| a.port())
        .unwrap_or(18787)
}

/// Desktop release channel persisted in the shared Podium config.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub enum UpdateChannel {
    #[default]
    Stable,
    Edge,
}

impl UpdateChannel {
    fn from_config(value: Option<&str>) -> Self {
        match value {
            Some("edge") => Self::Edge,
            _ => Self::Stable,
        }
    }
}

/// The desktop-relevant slice of ~/.podium/config.json. Other fields are ignored.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct DesktopConfig {
    pub mode: Option<String>,
    pub server_url: Option<String>,
    pub update_channel: UpdateChannel,
}

/// What the shell should do at launch, derived purely from the config.
#[derive(Debug, Clone, PartialEq)]
pub enum LaunchAction {
    /// Default: pick a free port, spawn the local `podium` (server+daemon), point the window local.
    LocalAllInOne,
    /// `mode=server` (hub-only box): pick a free port, spawn `podium server` — the SERVER role
    /// only, no local daemon/agents — and point the window at the local server port (#176).
    /// The explicit `server` subcommand (rather than a bare `podium` reading config.mode) also
    /// bypasses the CLI's persistence-managed path, so a systemd/detached-configured hub still
    /// gets a real in-process server child the desktop shell can supervise.
    LocalServerOnly,
    /// Spawn the local `podium` (which reads config → daemon mode → connects to `server_url`);
    /// the window points at the remote (no local server to wait for).
    LocalDaemon { server_url: String },
    /// Spawn nothing; the window points at the remote server.
    ClientOnly { server_url: String },
}

/// Read `$PODIUM_STATE_DIR/config.json` else `~/.podium/config.json`, extracting `mode`,
/// `serverUrl`, and `updateChannel`. A missing or corrupt file yields an empty config
/// (→ all-in-one behavior on the stable update channel).
pub fn read_config() -> DesktopConfig {
    let base = std::env::var("PODIUM_STATE_DIR").unwrap_or_else(|_| {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
        format!("{home}/.podium")
    });
    let path = std::path::Path::new(&base).join("config.json");
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return DesktopConfig::default(),
    };
    let json: serde_json::Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => return DesktopConfig::default(),
    };
    DesktopConfig {
        mode: json.get("mode").and_then(|v| v.as_str()).map(str::to_string),
        server_url: json
            .get("serverUrl")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        // [spec:SP-7f2c] Desktop releases have only explicit stable/edge channels.
        // Missing or unrecognized values fail closed to stable rather than inventing a
        // development channel or an arbitrary feed.
        update_channel: UpdateChannel::from_config(
            json.get("updateChannel").and_then(|v| v.as_str()),
        ),
    }
}

/// Config-file base dir: `$PODIUM_STATE_DIR` else `~/.podium` (same resolution as `read_config`).
fn state_dir() -> PathBuf {
    let base = std::env::var("PODIUM_STATE_DIR").unwrap_or_else(|_| {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
        format!("{home}/.podium")
    });
    PathBuf::from(base)
}

/// [spec:SP-3701] Flip a client-mode config to daemon mode with the given pairing code — the
/// whole write surface of the in-app "host sessions on this device" toggle. Deliberately
/// NARROW: the webview content that can invoke this is served by the remote hub, so the only
/// transition allowed is client → daemon against the serverUrl the user already configured
/// (never a parameter), and every other config field is preserved verbatim.
pub fn write_hosting_config(pair_code: &str) -> Result<(), String> {
    if pair_code.is_empty() || pair_code.len() > 32 || !pair_code.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("invalid pairing code".to_string());
    }
    let path = state_dir().join("config.json");
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    let mut json: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("config.json is not valid JSON: {e}"))?;
    let obj = json
        .as_object_mut()
        .ok_or_else(|| "config.json is not a JSON object".to_string())?;
    let mode = obj.get("mode").and_then(|v| v.as_str());
    if mode != Some("client") {
        return Err(format!(
            "hosting can only be enabled from client mode (current mode: {})",
            mode.unwrap_or("unset")
        ));
    }
    let has_server_url = obj
        .get("serverUrl")
        .and_then(|v| v.as_str())
        .is_some_and(|s| !s.is_empty());
    if !has_server_url {
        return Err("config has no serverUrl to pair against".to_string());
    }
    obj.insert("mode".to_string(), serde_json::Value::String("daemon".to_string()));
    obj.insert(
        "pairCode".to_string(),
        serde_json::Value::String(pair_code.to_string()),
    );
    let out = serde_json::to_string_pretty(&json).map_err(|e| e.to_string())?;
    // Write-then-rename so a crash mid-write can't leave a truncated config.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, format!("{out}\n"))
        .map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("cannot replace config.json: {e}"))
}

/// PURE resolver: map (mode, serverUrl) → the launch action.
///
/// - `client` + serverUrl  → ClientOnly (spawn nothing, window → remote)
/// - `daemon` + serverUrl  → LocalDaemon (spawn local podium daemon, window → remote)
/// - `server` (with or without serverUrl) → LocalServerOnly (spawn `podium server`, no daemon,
///   window → local port). Previously this fell through to LocalAllInOne, silently running a
///   local daemon + agents on a hub-only box (#176).
/// - everything else (all-in-one / unset / missing serverUrl) → LocalAllInOne
pub fn resolve_launch(mode: Option<&str>, server_url: Option<&str>) -> LaunchAction {
    match (mode, server_url) {
        (Some("client"), Some(url)) if !url.is_empty() => LaunchAction::ClientOnly {
            server_url: url.to_string(),
        },
        (Some("daemon"), Some(url)) if !url.is_empty() => LaunchAction::LocalDaemon {
            server_url: url.to_string(),
        },
        (Some("server"), _) => LaunchAction::LocalServerOnly,
        _ => LaunchAction::LocalAllInOne,
    }
}

/// The script injected before page load so the bundled web UI talks to the local backend
/// (Phase 2 serverConfig reads window.__PODIUM_SERVER__ first).
pub fn injection_script(port: u16) -> String {
    server_injection_script(&format!("ws://127.0.0.1:{port}"))
}

/// Like `injection_script` but for an arbitrary (remote) server URL — used in client/daemon modes.
pub fn server_injection_script(server_url: &str) -> String {
    // serde_json::to_string yields a correctly-escaped JS string literal.
    let lit = serde_json::to_string(server_url).unwrap_or_else(|_| "\"\"".to_string());
    format!("window.__PODIUM_SERVER__ = {lit};")
}

/// Remote-mode (client/daemon) injection: point the window at `server_url` AND mark setup as
/// already done. Without the flag the web SetupGate would probe the REMOTE `/setup/config` —
/// a cross-origin call an older relay answers without CORS (→ a "can't reach backend" screen),
/// and SetupView there would POST setup config to the remote. This install's mode is already
/// chosen, so the client must not gate on (or mutate) the remote's setup state.
pub fn remote_injection_script(server_url: &str) -> String {
    format!(
        "{}\nwindow.__PODIUM_SKIP_SETUP__ = true;",
        server_injection_script(server_url)
    )
}

/// JS shim injected into EVERY window (local and remote modes): route external http(s)
/// URLs — `window.open('_blank')` calls and clicks on external anchors — to the OS
/// browser via the opener plugin. The webview itself (WKWebView on macOS especially)
/// silently drops those, so without this shim agent login links and other external
/// links never open anything. Central here so no web-app caller needs Tauri awareness;
/// the raw plugin invoke avoids adding a Tauri JS dependency to apps/web (same pattern
/// as the __PODIUM_RESTART__ hook). `window.open` returns a stub WindowProxy-alike so
/// callers that probe the return value (e.g. `opened.opener = null`) keep working.
pub fn opener_shim_script() -> &'static str {
    r#";(() => {
  const t = window.__TAURI_INTERNALS__;
  if (!t || typeof t.invoke !== 'function') return;
  const externalHref = (raw) => {
    try {
      const u = new URL(raw, window.location.href);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      return u.origin === window.location.origin ? null : u.href;
    } catch { return null; }
  };
  const openExternal = (href) => { t.invoke('plugin:opener|open_url', { url: href }).catch(() => {}); };
  const nativeOpen = window.open.bind(window);
  window.open = (url, target, features) => {
    const href = url == null ? null : externalHref(String(url));
    if (href === null) return nativeOpen(url, target, features);
    openExternal(href);
    return { closed: true, opener: null, close() {}, focus() {} };
  };
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented) return;
    const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    const href = externalHref(a.href);
    if (href === null) return;
    e.preventDefault();
    openExternal(href);
  }, true);
})();"#
}

/// Map a ws(s):// relay URL to the http(s):// URL the window should LOAD (ws→http, wss→https);
/// an http/https URL passes through unchanged.
pub fn webview_http_url(server_url: &str) -> String {
    if let Some(rest) = server_url.strip_prefix("wss://") {
        format!("https://{rest}")
    } else if let Some(rest) = server_url.strip_prefix("ws://") {
        format!("http://{rest}")
    } else {
        server_url.to_string()
    }
}

/// Decide what a remote-mode (client/daemon) window loads. Preferred: load the relay's own URL
/// directly so the page is SAME-ORIGIN with the relay — WKWebView's WebSocket from a
/// tauri://localhost page to a remote TLS relay fails (1006), but a same-origin load connects
/// (a browser tab / Safari already work this way). The page then derives the server from its own
/// location, so no injection is needed. Fallback (unparseable URL): load the bundled UI and inject
/// the server global, preserving the old behavior rather than failing to open a window.
pub fn remote_window_target(server_url: &str) -> (WebviewUrl, String) {
    match Url::parse(&webview_http_url(server_url)) {
        Ok(url) => (WebviewUrl::External(url), String::new()),
        Err(_) => (WebviewUrl::default(), remote_injection_script(server_url)),
    }
}

/// Block until http://127.0.0.1:<port>/health accepts a TCP connection or the budget runs
/// out. Returns true if the port became reachable. (A TCP connect is enough — the server
/// only binds once it is serving.)
pub fn wait_for_port(port: u16, attempts: u32, delay_ms: u64) -> bool {
    use std::net::TcpStream;
    for _ in 0..attempts {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(delay_ms));
    }
    false
}

/// Copy `src` to `<cache_dir>/podium-sidecar` (chmod 0o755 on unix), re-copying when
/// missing/size-differs/source-newer; return the runnable path.
fn ensure_executable_into(src: &Path, cache_dir: &Path) -> std::io::Result<PathBuf> {
    use std::fs;

    let dst = cache_dir.join("podium-sidecar");

    // Re-copy if: cache missing, OR sizes differ, OR source is newer than cache.
    let src_meta = fs::metadata(src)?;
    let needs_copy = match fs::metadata(&dst) {
        Err(_) => true,
        Ok(dst_meta) => {
            if dst_meta.len() != src_meta.len() {
                true
            } else {
                // Compare mtimes — re-copy if source is strictly newer.
                match (src_meta.modified(), dst_meta.modified()) {
                    (Ok(src_mtime), Ok(dst_mtime)) => src_mtime > dst_mtime,
                    // If mtime is unavailable (some platforms), be conservative and copy.
                    _ => true,
                }
            }
        }
    };

    if needs_copy {
        fs::create_dir_all(cache_dir)?;
        fs::copy(src, &dst)?;
    }

    // Ensure executable bit.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&dst)?.permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&dst, perms)?;
    }

    Ok(dst)
}

/// Return a path to an executable copy of `path`.
///
/// AppImage mounts are read-only and may not preserve the executable bit, so we
/// copy the binary to a writable cache dir and chmod it there.  We re-copy when
/// the cache is missing, the source size differs, or the source is newer than the cache.
///
/// Cache location: `$PODIUM_STATE_DIR/bin/podium-sidecar` if set,
/// otherwise `~/.podium/bin/podium-sidecar`.
pub fn ensure_executable(path: &Path) -> std::io::Result<PathBuf> {
    let base = std::env::var("PODIUM_STATE_DIR")
        .unwrap_or_else(|_| {
            let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
            format!("{home}/.podium")
        });
    ensure_executable_into(path, &std::path::Path::new(&base).join("bin"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // Serializes tests that mutate the PODIUM_STATE_DIR env var (env is process-global).
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn pick_free_port_is_nonzero() {
        assert!(pick_free_port() > 0);
    }

    #[test]
    fn injection_script_embeds_the_port() {
        let s = injection_script(18799);
        assert!(s.contains("ws://127.0.0.1:18799"));
        assert!(s.contains("__PODIUM_SERVER__"));
    }

    #[test]
    fn server_injection_script_embeds_remote_url() {
        let s = server_injection_script("wss://relay.example:443");
        assert!(s.contains("wss://relay.example:443"));
        assert!(s.contains("__PODIUM_SERVER__"));
    }

    #[test]
    fn remote_injection_script_sets_server_and_skip_setup() {
        let s = remote_injection_script("https://relay.example:55555");
        assert!(s.contains("https://relay.example:55555"));
        assert!(s.contains("__PODIUM_SERVER__"));
        assert!(s.contains("__PODIUM_SKIP_SETUP__ = true"));
    }

    #[test]
    fn opener_shim_routes_external_urls_via_opener_plugin() {
        let s = opener_shim_script();
        assert!(s.contains("plugin:opener|open_url"));
        assert!(s.contains("window.open ="));
        assert!(s.contains("addEventListener('click'"));
        // Must be a no-op wherever the Tauri IPC bridge is absent (plain browsers/PWA).
        assert!(s.contains("__TAURI_INTERNALS__"));
    }

    #[test]
    fn webview_http_url_maps_ws_schemes_to_http() {
        assert_eq!(webview_http_url("wss://h:55555"), "https://h:55555");
        assert_eq!(webview_http_url("ws://h:18787"), "http://h:18787");
        assert_eq!(webview_http_url("https://h:55555"), "https://h:55555");
        assert_eq!(webview_http_url("http://h:1"), "http://h:1");
    }

    #[test]
    fn remote_window_target_loads_the_relay_url_directly() {
        let (url, injection) = remote_window_target("https://relay.example:55555");
        // Same-origin load: an external relay URL, and NO injected server global.
        assert!(matches!(url, WebviewUrl::External(u) if u.as_str() == "https://relay.example:55555/"));
        assert_eq!(injection, "");
    }

    #[test]
    fn remote_window_target_falls_back_to_bundled_on_bad_url() {
        let (url, injection) = remote_window_target("not a url");
        assert!(!matches!(url, WebviewUrl::External(_)));
        assert!(injection.contains("__PODIUM_SERVER__"));
    }

    #[test]
    fn resolve_launch_client_with_url_is_client_only() {
        assert_eq!(
            resolve_launch(Some("client"), Some("ws://h:1")),
            LaunchAction::ClientOnly {
                server_url: "ws://h:1".to_string()
            }
        );
    }

    #[test]
    fn resolve_launch_daemon_with_url_is_local_daemon() {
        assert_eq!(
            resolve_launch(Some("daemon"), Some("ws://h:1")),
            LaunchAction::LocalDaemon {
                server_url: "ws://h:1".to_string()
            }
        );
    }

    #[test]
    fn resolve_launch_all_in_one_is_local() {
        assert_eq!(
            resolve_launch(Some("all-in-one"), None),
            LaunchAction::LocalAllInOne
        );
    }

    #[test]
    fn resolve_launch_server_mode_is_server_only() {
        // #176: a hub-only box must NOT get a local daemon + agents.
        assert_eq!(
            resolve_launch(Some("server"), None),
            LaunchAction::LocalServerOnly
        );
        // A stray serverUrl in config doesn't change it — the server runs locally.
        assert_eq!(
            resolve_launch(Some("server"), Some("ws://h:1")),
            LaunchAction::LocalServerOnly
        );
    }

    #[test]
    fn resolve_launch_unset_is_local() {
        assert_eq!(resolve_launch(None, None), LaunchAction::LocalAllInOne);
    }

    #[test]
    fn resolve_launch_client_without_url_falls_back_to_local() {
        // No serverUrl → can't connect remotely; behave as all-in-one rather than break.
        assert_eq!(resolve_launch(Some("client"), None), LaunchAction::LocalAllInOne);
        assert_eq!(
            resolve_launch(Some("daemon"), Some("")),
            LaunchAction::LocalAllInOne
        );
    }

    #[test]
    fn read_config_missing_file_is_empty() {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = std::env::temp_dir().join(format!("podium-cfg-missing-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        // Point PODIUM_STATE_DIR at an empty dir (no config.json).
        let prev = std::env::var("PODIUM_STATE_DIR").ok();
        std::env::set_var("PODIUM_STATE_DIR", &tmp);
        let cfg = read_config();
        assert_eq!(cfg, DesktopConfig::default());
        match prev {
            Some(v) => std::env::set_var("PODIUM_STATE_DIR", v),
            None => std::env::remove_var("PODIUM_STATE_DIR"),
        }
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn read_config_parses_mode_and_server_url() {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = std::env::temp_dir().join(format!("podium-cfg-parse-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(
            tmp.join("config.json"),
            r#"{"mode":"daemon","serverUrl":"ws://h:9","updateChannel":"edge","pairCode":"X"}"#,
        )
        .unwrap();
        let prev = std::env::var("PODIUM_STATE_DIR").ok();
        std::env::set_var("PODIUM_STATE_DIR", &tmp);
        let cfg = read_config();
        assert_eq!(cfg.mode.as_deref(), Some("daemon"));
        assert_eq!(cfg.server_url.as_deref(), Some("ws://h:9"));
        assert_eq!(cfg.update_channel, UpdateChannel::Edge);
        match prev {
            Some(v) => std::env::set_var("PODIUM_STATE_DIR", v),
            None => std::env::remove_var("PODIUM_STATE_DIR"),
        }
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn read_config_defaults_unknown_update_channel_to_stable() {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = std::env::temp_dir().join(format!("podium-cfg-channel-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("config.json"), r#"{"updateChannel":"nightly"}"#).unwrap();
        let prev = std::env::var("PODIUM_STATE_DIR").ok();
        std::env::set_var("PODIUM_STATE_DIR", &tmp);
        assert_eq!(read_config().update_channel, UpdateChannel::Stable);
        match prev {
            Some(v) => std::env::set_var("PODIUM_STATE_DIR", v),
            None => std::env::remove_var("PODIUM_STATE_DIR"),
        }
        let _ = std::fs::remove_dir_all(&tmp);
    }

    // Run `body` with PODIUM_STATE_DIR pointed at a fresh temp dir holding `config` (if any).
    fn with_state_dir(tag: &str, config: Option<&str>, body: impl FnOnce()) {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = std::env::temp_dir().join(format!("podium-cfg-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        if let Some(c) = config {
            std::fs::write(tmp.join("config.json"), c).unwrap();
        }
        let prev = std::env::var("PODIUM_STATE_DIR").ok();
        std::env::set_var("PODIUM_STATE_DIR", &tmp);
        body();
        match prev {
            Some(v) => std::env::set_var("PODIUM_STATE_DIR", v),
            None => std::env::remove_var("PODIUM_STATE_DIR"),
        }
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn write_hosting_config_flips_client_to_daemon_preserving_fields() {
        with_state_dir(
            "host-ok",
            Some(r#"{"mode":"client","serverUrl":"wss://h:5","updateChannel":"edge","extra":42}"#),
            || {
                write_hosting_config("ABCD-EFGH").expect("write failed");
                let cfg = read_config();
                assert_eq!(cfg.mode.as_deref(), Some("daemon"));
                assert_eq!(cfg.server_url.as_deref(), Some("wss://h:5"));
                // Untouched fields survive verbatim.
                let raw: serde_json::Value = serde_json::from_str(
                    &std::fs::read_to_string(state_dir().join("config.json")).unwrap(),
                )
                .unwrap();
                assert_eq!(raw["pairCode"], "ABCD-EFGH");
                assert_eq!(raw["updateChannel"], "edge");
                assert_eq!(raw["extra"], 42);
            },
        );
    }

    #[test]
    fn write_hosting_config_refuses_non_client_modes() {
        // The remote page must not be able to mutate a daemon/server/all-in-one install.
        for cfg in [
            r#"{"mode":"daemon","serverUrl":"wss://h:5"}"#,
            r#"{"mode":"server"}"#,
            r#"{"serverUrl":"wss://h:5"}"#,
        ] {
            with_state_dir("host-mode", Some(cfg), || {
                assert!(write_hosting_config("ABCD-EFGH").is_err());
                // And the config is untouched.
                let after = std::fs::read_to_string(state_dir().join("config.json")).unwrap();
                assert_eq!(after, cfg);
            });
        }
    }

    #[test]
    fn write_hosting_config_refuses_missing_server_url_and_bad_codes() {
        with_state_dir("host-nourl", Some(r#"{"mode":"client"}"#), || {
            assert!(write_hosting_config("ABCD-EFGH").is_err());
        });
        with_state_dir(
            "host-badcode",
            Some(r#"{"mode":"client","serverUrl":"wss://h:5"}"#),
            || {
                assert!(write_hosting_config("").is_err());
                assert!(write_hosting_config(&"X".repeat(33)).is_err());
                assert!(write_hosting_config("bad code!{}").is_err());
            },
        );
        with_state_dir("host-nofile", None, || {
            assert!(write_hosting_config("ABCD-EFGH").is_err());
        });
    }

    #[test]
    fn wait_for_port_times_out_on_a_closed_port() {
        // A port nothing is listening on returns false quickly.
        assert!(!wait_for_port(1, 2, 10));
    }

    #[test]
    fn ensure_executable_into_returns_path_to_existing_executable() {
        use std::fs;
        use std::io::Write;

        // Separate temp dirs for source and cache (no env mutation).
        let tmp = std::env::temp_dir()
            .join(format!("podium-ensure-exe-test-{}", std::process::id()));
        let src_dir = tmp.join("src");
        let cache_dir = tmp.join("cache");
        fs::create_dir_all(&src_dir).unwrap();

        let src = src_dir.join("fake-podium");
        fs::File::create(&src)
            .unwrap()
            .write_all(b"#!/bin/sh\necho hello\n")
            .unwrap();

        let result = ensure_executable_into(&src, &cache_dir)
            .expect("ensure_executable_into failed");

        assert!(result.exists(), "result path does not exist: {result:?}");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&result).unwrap().permissions().mode();
            assert!(mode & 0o111 != 0, "file is not executable, mode={mode:o}");
        }

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn ensure_executable_into_recopy_when_source_differs() {
        use std::fs;
        use std::io::Write;

        let tmp = std::env::temp_dir()
            .join(format!("podium-freshness-test-{}", std::process::id()));
        let src_dir = tmp.join("src");
        let cache_dir = tmp.join("cache");
        fs::create_dir_all(&src_dir).unwrap();

        let src = src_dir.join("fake-podium");

        // First copy: write initial content.
        fs::File::create(&src)
            .unwrap()
            .write_all(b"version-1")
            .unwrap();
        let result = ensure_executable_into(&src, &cache_dir)
            .expect("first copy failed");
        assert_eq!(fs::read(&result).unwrap(), b"version-1");

        // Second copy: different size → must re-copy regardless of mtime.
        fs::File::create(&src)
            .unwrap()
            .write_all(b"version-2-longer")
            .unwrap();

        let result2 = ensure_executable_into(&src, &cache_dir)
            .expect("second copy failed");
        assert_eq!(
            fs::read(&result2).unwrap(),
            b"version-2-longer",
            "cache was not refreshed when source size changed"
        );

        // Third copy: same content again — should NOT re-copy (idempotent).
        let result3 = ensure_executable_into(&src, &cache_dir)
            .expect("third copy failed");
        assert_eq!(
            fs::read(&result3).unwrap(),
            b"version-2-longer",
            "cache content changed unexpectedly on idempotent call"
        );

        let _ = fs::remove_dir_all(&tmp);
    }
}
