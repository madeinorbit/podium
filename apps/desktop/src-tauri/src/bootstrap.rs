use std::net::TcpListener;
use std::path::{Path, PathBuf};
use tauri::webview::cookie::{Cookie, SameSite};
use tauri::{Url, WebviewUrl};

const SERVER_TRANSFER_JOURNAL: &str = ".server-transfer/journal.json";

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

/// Desktop release channel persisted in the shared Podium config or stamped into the build.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateChannel {
    Stable,
    Edge,
}

impl UpdateChannel {
    pub fn from_config(value: Option<&str>) -> Option<Self> {
        match value {
            Some("stable") => Some(Self::Stable),
            Some("edge") => Some(Self::Edge),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stable => "stable",
            Self::Edge => "edge",
        }
    }
}

/// The release workflow sets this for every shipped desktop artifact. Local builds are not
/// promoted from a channel, so they retain the historical stable fallback (and cannot update in
/// debug mode anyway).
pub fn build_update_channel() -> UpdateChannel {
    match option_env!("PODIUM_DESKTOP_RELEASE_CHANNEL") {
        Some("edge") => UpdateChannel::Edge,
        Some("stable") | None => UpdateChannel::Stable,
        Some(value) => panic!("invalid PODIUM_DESKTOP_RELEASE_CHANNEL: {value}"),
    }
}

/// The desktop-relevant slice of ~/.podium/config.json. Other fields are ignored.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct DesktopConfig {
    pub mode: Option<String>,
    pub server_url: Option<String>,
    /// A valid user choice from config.json. Absence and unknown values deliberately remain
    /// distinguishable so the updater can fall back to the channel stamped into this build.
    pub update_channel: Option<UpdateChannel>,
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

/// What a desktop supervisor should do when its locally-hosted backend exits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BackendExitDecision {
    Respawn,
    Retarget {
        transfer_id: String,
        server_url: String,
    },
    Hold {
        reason: String,
    },
}

struct TransferMarker {
    version: u64,
    transfer_id: String,
    public_url: String,
    state: String,
}

fn parse_transfer_marker(raw: &str) -> Result<TransferMarker, String> {
    let value: serde_json::Value = serde_json::from_str(raw).map_err(|error| error.to_string())?;
    let version = value
        .get("formatVersion")
        .or_else(|| value.get("version"))
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| "server-transfer marker has no format version".to_string())?;
    let state = value
        .get("state")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "server-transfer marker has no state".to_string())?;
    // POD-1749's stable journal nests transfer identity under `record`. Accept the earlier
    // flat prototype during integration so desktop continuity does not depend on landing order.
    let record = value.get("record").unwrap_or(&value);
    let transfer_id = record
        .get("transferId")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "server-transfer marker has no transfer id".to_string())?;
    let public_url = record
        .get("publicUrl")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "server-transfer marker has no public URL".to_string())?;
    Ok(TransferMarker {
        version,
        transfer_id: transfer_id.to_string(),
        public_url: public_url.to_string(),
        state: state.to_string(),
    })
}

fn is_local_host(action: &LaunchAction) -> bool {
    matches!(
        action,
        LaunchAction::LocalAllInOne | LaunchAction::LocalServerOnly
    )
}

/// Read `$PODIUM_STATE_DIR/config.json` else `~/.podium/config.json`, extracting `mode`,
/// `serverUrl`, and `updateChannel`. A missing or corrupt file yields an empty config; the updater
/// resolves the missing channel against the build stamp rather than inventing a persisted choice.
pub fn read_config() -> DesktopConfig {
    let path = state_dir().join("config.json");
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return DesktopConfig::default(),
    };
    let json: serde_json::Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => return DesktopConfig::default(),
    };
    DesktopConfig {
        mode: json
            .get("mode")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        server_url: json
            .get("serverUrl")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        // [spec:SP-7f2c] Missing or unrecognized values are not user choices, so the channel
        // stamped into the installed build remains authoritative.
        update_channel: UpdateChannel::from_config(
            json.get("updateChannel").and_then(|v| v.as_str()),
        ),
    }
}

/// Config-file base dir: `$PODIUM_STATE_DIR` else `~/.podium` (same resolution as `read_config`).
/// `pub` because the native log sink writes under the SAME state dir the server
/// family logs to — one resolution rule, not two that can drift apart.
pub fn state_dir() -> PathBuf {
    state_dir_from_parts(
        std::env::var_os("PODIUM_STATE_DIR").map(PathBuf::from),
        std::env::var_os("HOME").map(PathBuf::from),
        std::env::var_os("USERPROFILE").map(PathBuf::from),
        std::env::var_os("HOMEDRIVE"),
        std::env::var_os("HOMEPATH"),
        std::env::temp_dir(),
        cfg!(target_os = "windows"),
    )
}

fn state_dir_from_parts(
    configured: Option<PathBuf>,
    home: Option<PathBuf>,
    user_profile: Option<PathBuf>,
    home_drive: Option<std::ffi::OsString>,
    home_path: Option<std::ffi::OsString>,
    temp_dir: PathBuf,
    windows: bool,
) -> PathBuf {
    let nonempty = |path: PathBuf| (!path.as_os_str().is_empty()).then_some(path);
    if let Some(configured) = configured.and_then(nonempty) {
        return configured;
    }

    let windows_home = || {
        user_profile.and_then(nonempty).or_else(|| {
            let mut combined = home_drive?;
            if combined.is_empty() {
                return None;
            }
            let suffix = home_path?;
            if suffix.is_empty() {
                return None;
            }
            combined.push(suffix);
            nonempty(PathBuf::from(combined))
        })
    };
    let base = if windows {
        windows_home().or_else(|| home.and_then(nonempty))
    } else {
        home.and_then(nonempty)
    }
    .unwrap_or(temp_dir);
    base.join(".podium")
}

fn remote_http_url(server_url: &str) -> Result<Url, String> {
    let url = Url::parse(&webview_http_url(server_url)).map_err(|error| error.to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(format!("unsupported remote URL scheme: {}", url.scheme()));
    }
    Ok(url)
}

/// Build the one session cookie copied across a committed desktop origin transition. The value
/// stays in memory; omitting expiry/max-age keeps it a session cookie, while the validated target
/// host, root path, and transport flags prevent it from escaping to an unrelated origin.
pub fn session_cookie_for_target(value: &str, server_url: &str) -> Result<Cookie<'static>, String> {
    let target = remote_http_url(server_url)?;
    let host = target
        .host_str()
        .filter(|host| !host.is_empty())
        .ok_or_else(|| "remote server URL has no host".to_string())?;
    Ok(
        Cookie::build(("podium_session".to_string(), value.to_string()))
            .domain(host.to_string())
            .path("/")
            .secure(target.scheme() == "https")
            .http_only(true)
            .same_site(SameSite::Lax)
            .build(),
    )
}

/// Pure classifier for a supervised local-backend exit. A role-preserving crash respawns with
/// the existing backoff. A host-to-daemon change retargets the shell only when the source's
/// durable committed journal names the same endpoint; every incomplete or mismatched transition
/// holds instead of looping or guessing.
pub fn classify_backend_exit(
    initial_action: &LaunchAction,
    current_config: &DesktopConfig,
    journal_json: Option<&str>,
) -> BackendExitDecision {
    if !is_local_host(initial_action) {
        return BackendExitDecision::Respawn;
    }

    let current_action = resolve_launch(
        current_config.mode.as_deref(),
        current_config.server_url.as_deref(),
    );
    let same_host_role = matches!(
        (initial_action, &current_action),
        (LaunchAction::LocalAllInOne, LaunchAction::LocalAllInOne)
            | (LaunchAction::LocalServerOnly, LaunchAction::LocalServerOnly)
    );
    if same_host_role {
        let Some(journal_json) = journal_json else {
            return BackendExitDecision::Respawn;
        };
        let marker = match parse_transfer_marker(journal_json) {
            Ok(marker) => marker,
            Err(error) => {
                return BackendExitDecision::Hold {
                    reason: format!("server-transfer marker is unreadable: {error}"),
                }
            }
        };
        return match marker.state.as_str() {
            "preparing" | "staged" | "validated" | "aborted" => BackendExitDecision::Respawn,
            "source-fenced" | "committing" | "commit-uncertain" | "committed" => {
                BackendExitDecision::Hold {
                    reason: format!(
                        "server-transfer marker blocks writable local restart ({})",
                        marker.state
                    ),
                }
            }
            _ => BackendExitDecision::Hold {
                reason: format!(
                    "server-transfer marker has an unknown state ({})",
                    marker.state
                ),
            },
        };
    }

    let LaunchAction::LocalDaemon { server_url } = current_action else {
        return BackendExitDecision::Hold {
            reason: format!(
                "desktop backend role changed without a daemon target: {current_action:?}"
            ),
        };
    };
    let Some(journal_json) = journal_json else {
        return BackendExitDecision::Hold {
            reason: "daemon config has no durable server-transfer marker".to_string(),
        };
    };
    let marker = match parse_transfer_marker(journal_json) {
        Ok(marker) => marker,
        Err(error) => {
            return BackendExitDecision::Hold {
                reason: format!("server-transfer marker is unreadable: {error}"),
            }
        }
    };
    if marker.version != 1 || marker.state != "committed" || marker.transfer_id.is_empty() {
        return BackendExitDecision::Hold {
            reason: format!(
                "server-transfer marker is not a committed v1 transfer ({})",
                marker.state
            ),
        };
    }
    let config_url = match remote_http_url(&server_url) {
        Ok(url) => url,
        Err(reason) => return BackendExitDecision::Hold { reason },
    };
    let journal_url = match remote_http_url(&marker.public_url) {
        Ok(url) => url,
        Err(reason) => return BackendExitDecision::Hold { reason },
    };
    if config_url != journal_url {
        return BackendExitDecision::Hold {
            reason: format!(
                "server-transfer marker endpoint mismatch (config {config_url}, marker {journal_url})"
            ),
        };
    }
    BackendExitDecision::Retarget {
        transfer_id: marker.transfer_id,
        server_url,
    }
}

pub fn backend_exit_decision(initial_action: &LaunchAction) -> BackendExitDecision {
    let config = read_config();
    let journal_path = state_dir().join(SERVER_TRANSFER_JOURNAL);
    let journal = std::fs::read_to_string(&journal_path).ok();
    classify_backend_exit(initial_action, &config, journal.as_deref())
}

/// [spec:SP-3701] This device's machine identity from a previous pairing
/// (`~/.podium/daemon.json`), if any — lets the web UI mark "this machine" in the
/// machines list and skip the standalone hosting card for already-paired devices.
pub fn read_daemon_machine_id() -> Option<String> {
    let text = std::fs::read_to_string(state_dir().join("daemon.json")).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    json.get("machineId")?.as_str().map(str::to_string)
}

/// [spec:SP-3701] Flip a client-mode config to daemon mode with the given pairing code — the
/// whole write surface of the in-app "host sessions on this device" toggle. Deliberately
/// NARROW: the webview content that can invoke this is served by the remote hub, so the only
/// transition allowed is client → daemon against the serverUrl the user already configured
/// (never a parameter), and every other config field is preserved verbatim.
pub fn write_hosting_config(pair_code: &str) -> Result<(), String> {
    if pair_code.is_empty()
        || pair_code.len() > 32
        || !pair_code
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
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
    obj.insert(
        "mode".to_string(),
        serde_json::Value::String("daemon".to_string()),
    );
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

/// Persist the desktop updater's production channel without disturbing config fields owned by
/// the server. Unlike the hosting transition this is valid before config.json exists: choosing a
/// channel in the app is enough to create the user's override.
pub fn write_update_channel(channel: UpdateChannel) -> Result<(), String> {
    let path = state_dir().join("config.json");
    let mut json = match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str::<serde_json::Value>(&text)
            .map_err(|e| format!("config.json is not valid JSON: {e}"))?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            serde_json::Value::Object(serde_json::Map::new())
        }
        Err(error) => return Err(format!("cannot read {}: {error}", path.display())),
    };
    let obj = json
        .as_object_mut()
        .ok_or_else(|| "config.json is not a JSON object".to_string())?;
    obj.insert(
        "updateChannel".to_string(),
        serde_json::Value::String(channel.as_str().to_string()),
    );
    let out = serde_json::to_string_pretty(&json).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(state_dir())
        .map_err(|e| format!("cannot create {}: {e}", state_dir().display()))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, format!("{out}\n"))
        .map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("cannot replace config.json: {e}"))
}

/// Give the bundled server the same initial channel as the native updater.
///
/// A release channel is compiled into the desktop shell, but the bundled server resolves its
/// fleet channel from the shared config. Persist the build default before that server starts so
/// first-run onboarding and machine join commands cannot silently fall back to stable. Once a
/// user has chosen a channel, their persisted choice remains authoritative.
pub fn initialize_update_channel(
    configured: Option<UpdateChannel>,
    build: UpdateChannel,
) -> Result<UpdateChannel, String> {
    if let Some(channel) = configured {
        return Ok(channel);
    }
    write_update_channel(build)?;
    Ok(build)
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
    // The script stays installed when the existing WebView moves to the transferred remote
    // origin. Apply the loopback endpoint only on Tauri's bundled origin so it cannot override
    // the remote page's same-origin server discovery after navigation.
    format!(
        "if (window.location.protocol === 'tauri:' || window.location.hostname === 'tauri.localhost') {{ {}\nwindow.__PODIUM_LOCAL_SETUP__ = true; }}",
        server_injection_script(&format!("ws://127.0.0.1:{port}"))
    )
}

/// Like `injection_script` but for an arbitrary (remote) server URL — used in client/daemon modes.
pub fn server_injection_script(server_url: &str) -> String {
    // serde_json::to_string yields a correctly-escaped JS string literal.
    let lit = serde_json::to_string(server_url).unwrap_or_else(|_| "\"\"".to_string());
    format!("window.__PODIUM_SERVER__ = {lit};")
}

/// Remote-mode (client/daemon) injection: point the window at `server_url` AND tell SetupGate not
/// to expose the remote's setup mutations. The gate may still read the public readiness fact so
/// an unconfigured server directs this client back to its host; older relays without that
/// CORS-enabled endpoint keep their historical pass-through behavior.
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
///
/// EXTERNAL IS NOT "CROSS-ORIGIN" (POD-1606). This used to compare against
/// `window.location.origin` alone, which in all-in-one mode is `tauri://localhost`
/// while the server the app talks to is `http://127.0.0.1:<port>` — so a link to the
/// reader's OWN Podium was cross-origin and left the app for Safari. In client mode the
/// window already sits on the server origin, so the identical URL stayed in-app: same
/// link, opposite behaviour, decided by how the app happened to launch. The shim now
/// also counts the injected `__PODIUM_SERVER__` endpoint as ours, read lazily so a
/// window that navigates to a transferred remote origin keeps agreeing with the page.
///
/// A link this shim declines is one the WEB APP must answer — the markdown pipeline and
/// the offer renderer navigate known-Podium links in-page (apps/web/src/lib/markdown.ts,
/// features/chat/OfferText.tsx) — and a caller that wants the OS browser for one of OUR
/// urls asks for it explicitly through `openInSystemBrowser`, which is the mirror of
/// this test (apps/web/src/lib/nativeDesktop.ts).
pub fn opener_shim_script() -> &'static str {
    r#";(() => {
  const t = window.__TAURI_INTERNALS__;
  if (!t || typeof t.invoke !== 'function') return;
  const httpOrigin = (raw) => {
    try {
      const u = new URL(raw);
      const p = u.protocol === 'ws:' ? 'http:' : u.protocol === 'wss:' ? 'https:' : u.protocol;
      if ((p !== 'http:' && p !== 'https:') || !u.hostname) return null;
      return p + '//' + u.hostname + (u.port ? ':' + u.port : '');
    } catch { return null; }
  };
  const activeOrigin = () => {
    const server = window.__PODIUM_SERVER__;
    if (typeof server === 'string') return httpOrigin(server);
    return httpOrigin(window.location.href);
  };
  const isOurs = (origin) => {
    if (origin === null) return false;
    return activeOrigin() === origin;
  };
  const cleanedHref = (raw) => String(raw).replace(/[\t\n\r]/g, '').trim();
  const handoffHref = (href, parsed) => {
    if (/^[\\/][\\/]/.test(href)) {
      const query = href.indexOf('?');
      const fragment = href.indexOf('#');
      const detailAt = query === -1 ? fragment : fragment === -1 ? query : Math.min(query, fragment);
      const address = detailAt === -1 ? href : href.slice(0, detailAt);
      const detail = detailAt === -1 ? '' : href.slice(detailAt);
      return parsed.protocol + address.replace(/\\/g, '/') + detail;
    }
    return parsed.href;
  };
  const externalHref = (raw) => {
    const href = cleanedHref(raw);
    try {
      const base = activeOrigin() || window.location.href;
      const u = new URL(href, base);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      const outgoing = handoffHref(href, u);
      // An authority-relative address is external by definition in the shared
      // resolver, even when it happens to repeat the active server's host.
      // Treating that spelling as ours leaves its target=_blank to WKWebView,
      // which drops both clicks and window.open.
      if (/^[\\/][\\/]/.test(href)) return outgoing;
      // Userinfo is how a link disguises its real host. The protocol resolver
      // refuses it outright, and the two halves have to answer alike: if this
      // one called it ours it would decline, the page would have stamped
      // target=_blank, and WKWebView would drop the click on the floor.
      if (u.username || u.password) return outgoing;
      // `server` is BOOT configuration, never detail for the active replica.
      // The web resolver declines it so the destination can reboot against the
      // selected server; this capture-phase half must therefore hand it out
      // rather than swallowing the blank-target fallback as one of "ours".
      if (u.searchParams.has('server')) return outgoing;
      return isOurs(httpOrigin(u.href)) ? null : outgoing;
    } catch {
      return /^https?:\/\//i.test(href) ? href : null;
    }
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
    const href = externalHref(a.getAttribute('href') || a.href);
    if (href === null) return;
    e.preventDefault();
    openExternal(href);
  }, true);
})();"#
}

/// THE NATIVE CRASH HAND-OFF: panics recorded by the Rust shell on a PREVIOUS
/// run, posted to `logs.crash` by the webview on this one.
///
/// WHY THE NEXT LAUNCH AND NOT THE PANIC ITSELF. A panicking process cannot make
/// an authenticated HTTP call — release builds abort immediately after the hook,
/// and the session cookie lives in the webview's cookie store, not in Rust. So
/// the hook writes the record to disk (`logging`'s pending queue) and the next
/// launch carries it across. This is what every native crash reporter does, and
/// it is why a crash event's `ts` can be older than the launch that filed it.
///
/// The records are EMBEDDED in the script rather than fetched over an IPC
/// command: embedding needs no new capability grant, and the payload is bounded
/// at ten records by the queue that produced it.
///
/// A FAILED POST IS DROPPED, NOT RETRIED. The record is already durable in
/// `desktop-native.ndjson` on the same disk; what is lost is the server-side
/// crash EVENT, and a retry loop against a server that is down would replay a
/// week of panics into an incident that has passed.
pub fn native_crash_report_script(
    pending: &[serde_json::Value],
    machine_id: Option<&str>,
) -> String {
    if pending.is_empty() {
        return String::new();
    }
    // `serde_json` makes the payload safe as a JS literal — quotes, backslashes
    // and control characters are escaped. It does NOT make it safe as HTML, and
    // a panic message is attacker-influenced text in the sense that matters here
    // (any library can panic with any string). `</` → `<\/` closes that gap for
    // good: `\/` is a legal JSON escape that parses back to the same character,
    // so a payload containing a closing script tag cannot terminate a script
    // element if this text is ever placed in one.
    let escape = |json: String| json.replace("</", "<\\/");
    let records = escape(serde_json::to_string(pending).unwrap_or_else(|_| "[]".to_string()));
    let machine = machine_id
        .and_then(|id| serde_json::to_string(id).ok())
        .map(escape)
        .unwrap_or_else(|| "null".to_string());
    format!(
        r#";(() => {{
  const pending = {records};
  const machineId = {machine};
  const httpOrigin = () => {{
    const raw = window.__PODIUM_SERVER__;
    if (raw) {{
      try {{
        const u = new URL(raw);
        if (u.protocol === 'ws:') u.protocol = 'http:';
        else if (u.protocol === 'wss:') u.protocol = 'https:';
        return u.origin;
      }} catch {{}}
    }}
    return window.location.protocol.startsWith('http') ? window.location.origin : null;
  }};
  const post = (origin, record, credentials) => fetch(origin + '/trpc/logs.crash', {{
    method: 'POST',
    credentials,
    headers: {{ 'content-type': 'application/json' }},
    body: JSON.stringify({{
      origin: {{ role: record.role, v: record.v, machineId: machineId ?? undefined }},
      err: record.err,
      // The record IS the snapshot: the native side keeps no ring buffer, and a
      // crash event with an empty snapshot reads as "we lost the context" rather
      // than "there was one line of context and here it is".
      snapshot: [record],
      context: {{ source: 'native-panic', occurredAt: record.ts }},
    }}),
  }});
  const send = () => {{
    const origin = httpOrigin();
    if (!origin) return;
    for (const record of pending) {{
      if (!record || !record.err) continue;
      // Credentialed first — that is the case where a password is configured and
      // the page shares the server's origin. The retry without credentials covers
      // the all-in-one shape, where the page is tauri:// and the server answers
      // cross-origin with a wildcard CORS header that a credentialed fetch
      // refuses; there, no password is configured and the guard lets it through.
      post(origin, record, 'include').catch(() => post(origin, record, 'omit')).catch(() => {{}});
    }}
  }};
  // After load: the cookie and __PODIUM_SERVER__ both have to exist, and a crash
  // report has no reason to compete with first paint.
  if (document.readyState === 'complete') setTimeout(send, 0);
  else window.addEventListener('load', () => setTimeout(send, 0), {{ once: true }});
}})();"#
    )
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

/// Copy `src` to a runnable path under `cache_dir` and return it. Windows gives each
/// staged source revision its own `.exe` name so an update never overwrites an image
/// that the previous desktop process still has open.
fn ensure_executable_into(src: &Path, cache_dir: &Path) -> std::io::Result<PathBuf> {
    ensure_executable_into_for_platform(src, cache_dir, cfg!(target_os = "windows"))
}

fn ensure_executable_into_for_platform(
    src: &Path,
    cache_dir: &Path,
    windows: bool,
) -> std::io::Result<PathBuf> {
    use std::fs;

    let src_meta = fs::metadata(src)?;
    let modified_stamp = src_meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::SystemTime::UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        // Filesystems without modification times still get a per-process Windows name,
        // which preserves the no-overwrite guarantee for a running previous sidecar.
        .unwrap_or_else(|| std::process::id() as u128);
    let dst = cache_dir.join(cached_sidecar_name(windows, src_meta.len(), modified_stamp));

    // Re-copy if: cache missing, OR sizes differ, OR source is newer than cache.
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
/// copy the binary to a writable cache dir and chmod it there. Windows also needs
/// a writable copy, but uses a source-revision name because a running `.exe` cannot
/// be overwritten during an update.
///
/// Cache location: `$PODIUM_STATE_DIR/bin/podium-sidecar` on Linux and a stamped
/// `$PODIUM_STATE_DIR/bin/podium-sidecar-<size>-<mtime>.exe` on Windows. Without
/// an override, the same names live under `~/.podium/bin`.
///
/// macOS is exempt: the sidecar runs from inside the .app, never a copy. Copying it out is what
/// produced `"podium-sidecar" is damaged and can't be opened` on the first notarized build, for
/// two independent reasons, either fatal on its own:
///
///   1. The notarization ticket is stapled to `Podium.app`, not to each nested binary. A lone copy
///      in ~/.podium/bin has no ticket, so Gatekeeper cannot validate it offline.
///   2. `fs::copy` on macOS copies extended attributes, carrying `com.apple.quarantine` from the
///      downloaded bundle onto the copy — which is what makes Gatekeeper assess it at all.
///
/// Neither problem the copy solves exists here: a .app is not a read-only AppImage mount, and the
/// bundled binary is already executable, signed, and covered by the app's stapled ticket.
pub fn ensure_executable(path: &Path) -> std::io::Result<PathBuf> {
    if cfg!(target_os = "macos") {
        return Ok(path.to_path_buf());
    }
    ensure_executable_into(path, &state_dir().join("bin"))
}

fn cached_sidecar_name(windows: bool, source_len: u64, modified_stamp: u128) -> String {
    if windows {
        format!("podium-sidecar-{source_len}-{modified_stamp}.exe")
    } else {
        "podium-sidecar".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::updater::resolve_update_channel;
    use std::sync::Mutex;

    // Serializes tests that mutate the PODIUM_STATE_DIR env var (env is process-global).
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn pick_free_port_is_nonzero() {
        assert!(pick_free_port() > 0);
    }

    #[test]
    fn windows_state_dir_uses_the_native_profile_without_home() {
        let resolved = state_dir_from_parts(
            None,
            None,
            Some(PathBuf::from(r"C:\Users\Ada")),
            None,
            None,
            PathBuf::from(r"C:\Temp"),
            true,
        );
        assert_eq!(resolved, PathBuf::from(r"C:\Users\Ada").join(".podium"));
    }

    #[test]
    fn windows_state_dir_prefers_userprofile_to_a_posix_shell_home() {
        let resolved = state_dir_from_parts(
            None,
            Some(PathBuf::from("/c/Users/wrong")),
            Some(PathBuf::from(r"C:\Users\Ada")),
            None,
            None,
            PathBuf::from(r"C:\Temp"),
            true,
        );
        assert_eq!(resolved, PathBuf::from(r"C:\Users\Ada").join(".podium"));
    }

    #[test]
    fn windows_cached_sidecar_keeps_its_executable_suffix() {
        assert_eq!(
            cached_sidecar_name(true, 123, 456),
            "podium-sidecar-123-456.exe"
        );
        assert_eq!(cached_sidecar_name(false, 123, 456), "podium-sidecar");
    }

    #[test]
    fn injection_script_embeds_the_port() {
        let s = injection_script(18799);
        assert!(s.contains("ws://127.0.0.1:18799"));
        assert!(s.contains("__PODIUM_SERVER__"));
        assert!(s.contains("window.location.protocol === 'tauri:'"));
        assert!(s.contains("__PODIUM_LOCAL_SETUP__ = true"));
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
    fn no_pending_crashes_injects_no_script_at_all() {
        // Not "an empty IIFE": the common case is zero panics, and every launch
        // paying for a script that does nothing is a cost with no reader.
        assert_eq!(native_crash_report_script(&[], Some("machine-1")), "");
    }

    #[test]
    fn the_crash_script_posts_each_record_to_logs_crash() {
        let record = serde_json::json!({
            "ts": "2026-08-11T14:03:22.847Z",
            "level": "error",
            "ns": "desktop:panic",
            "msg": "native shell panicked",
            "role": "desktop-native",
            "v": "0.1.0",
            "err": { "name": "RustPanic", "message": "boom", "stack": "RustPanic: boom" },
        });
        let script = native_crash_report_script(&[record], Some("machine-1"));
        assert!(script.contains("/trpc/logs.crash"));
        assert!(script.contains("\"machine-1\""));
        assert!(script.contains("RustPanic"));
        // ws→http: in the all-in-one shape the page is tauri:// and the server
        // is only reachable through the injected __PODIUM_SERVER__ relay URL.
        assert!(script.contains("u.protocol = 'http:'"));
        assert!(script.contains("__PODIUM_SERVER__"));
        // Credentialed first, then the uncredentialed retry for the wildcard-CORS
        // all-in-one case; without the fallback a local install files nothing.
        assert!(script.contains("'include'"));
        assert!(script.contains("'omit'"));
    }

    #[test]
    fn a_crash_message_with_a_quote_cannot_break_out_of_the_script() {
        let record = serde_json::json!({
            "err": { "name": "RustPanic", "message": "</script><script>alert('x')//\" \n" },
            "role": "desktop-native",
        });
        let script = native_crash_report_script(&[record], None);
        // serde_json escapes the payload, so the injected text carries no raw
        // closing tag and no unescaped newline inside the string literal.
        assert!(!script.contains("</script>"));
        assert!(script.contains("machineId = null"));
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
        assert!(
            matches!(url, WebviewUrl::External(u) if u.as_str() == "https://relay.example:55555/")
        );
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
        assert_eq!(
            resolve_launch(Some("client"), None),
            LaunchAction::LocalAllInOne
        );
        assert_eq!(
            resolve_launch(Some("daemon"), Some("")),
            LaunchAction::LocalAllInOne
        );
    }

    #[test]
    fn transferred_session_cookie_is_scoped_and_keeps_security_flags() {
        let cookie = session_cookie_for_target("secret-test-value", "wss://new.example:55555")
            .expect("cookie target should be valid");
        assert_eq!(cookie.name(), "podium_session");
        assert_eq!(cookie.value(), "secret-test-value");
        assert_eq!(cookie.domain(), Some("new.example"));
        assert_eq!(cookie.path(), Some("/"));
        assert_eq!(cookie.secure(), Some(true));
        assert_eq!(cookie.http_only(), Some(true));
        assert_eq!(cookie.same_site(), Some(SameSite::Lax));
        assert!(cookie.expires().is_none());
        assert!(cookie.max_age().is_none());

        let local = session_cookie_for_target("secret-test-value", "ws://127.0.0.1:9123")
            .expect("http target should be valid");
        assert_eq!(local.domain(), Some("127.0.0.1"));
        assert_eq!(local.secure(), Some(false));
    }

    #[test]
    fn transferred_session_cookie_rejects_non_http_targets() {
        assert!(session_cookie_for_target("secret-test-value", "file:///tmp/server").is_err());
        assert!(session_cookie_for_target("secret-test-value", "not a URL").is_err());
    }

    fn transfer_marker(state: &str, public_url: &str) -> String {
        serde_json::json!({
            "formatVersion": 1,
            "state": state,
            "record": {
                "transferId": "transfer-1",
                "targetMachineId": "machine-2",
                "publicUrl": public_url
            }
        })
        .to_string()
    }

    #[test]
    fn transfer_marker_parser_accepts_the_coordinator_journal_shape() {
        let marker = parse_transfer_marker(&transfer_marker("committed", "https://new.example"))
            .expect("stable coordinator journal should parse");
        assert_eq!(marker.version, 1);
        assert_eq!(marker.state, "committed");
        assert_eq!(marker.transfer_id, "transfer-1");
        assert_eq!(marker.public_url, "https://new.example");
    }

    #[test]
    fn backend_exit_reader_observes_a_durable_scratch_transition() {
        with_state_dir(
            "server-transfer",
            Some(r#"{"mode":"daemon","serverUrl":"wss://new.example:55555"}"#),
            || {
                let state_dir = PathBuf::from(std::env::var("PODIUM_STATE_DIR").unwrap());
                let journal_dir = state_dir.join(".server-transfer");
                std::fs::create_dir_all(&journal_dir).unwrap();
                std::fs::write(
                    journal_dir.join("journal.json"),
                    transfer_marker("committed", "https://new.example:55555"),
                )
                .unwrap();
                assert_eq!(
                    backend_exit_decision(&LaunchAction::LocalAllInOne),
                    BackendExitDecision::Retarget {
                        transfer_id: "transfer-1".to_string(),
                        server_url: "wss://new.example:55555".to_string(),
                    }
                );
            },
        );
    }

    #[test]
    fn unchanged_local_role_respawns_after_an_ordinary_crash() {
        for (initial, config) in [
            (LaunchAction::LocalAllInOne, DesktopConfig::default()),
            (
                LaunchAction::LocalServerOnly,
                DesktopConfig {
                    mode: Some("server".to_string()),
                    ..DesktopConfig::default()
                },
            ),
        ] {
            assert_eq!(
                classify_backend_exit(&initial, &config, None),
                BackendExitDecision::Respawn
            );
        }
    }

    #[test]
    fn unchanged_local_role_holds_when_a_durable_transfer_fence_blocks_server_boot() {
        let config = DesktopConfig::default();
        for state in [
            "source-fenced",
            "committing",
            "commit-uncertain",
            "committed",
        ] {
            assert!(matches!(
                classify_backend_exit(
                    &LaunchAction::LocalAllInOne,
                    &config,
                    Some(&transfer_marker(state, "https://new.example")),
                ),
                BackendExitDecision::Hold { .. }
            ));
        }
    }

    #[test]
    fn unchanged_local_role_respawns_for_safe_transfer_markers() {
        let config = DesktopConfig::default();
        for state in ["preparing", "staged", "validated", "aborted"] {
            assert_eq!(
                classify_backend_exit(
                    &LaunchAction::LocalAllInOne,
                    &config,
                    Some(&transfer_marker(state, "https://new.example")),
                ),
                BackendExitDecision::Respawn
            );
        }
    }

    #[test]
    fn committed_host_to_daemon_transition_retargets_the_app() {
        let config = DesktopConfig {
            mode: Some("daemon".to_string()),
            server_url: Some("wss://new.example:55555".to_string()),
            ..DesktopConfig::default()
        };
        assert_eq!(
            classify_backend_exit(
                &LaunchAction::LocalAllInOne,
                &config,
                Some(&transfer_marker("committed", "https://new.example:55555")),
            ),
            BackendExitDecision::Retarget {
                transfer_id: "transfer-1".to_string(),
                server_url: "wss://new.example:55555".to_string(),
            }
        );
    }

    #[test]
    fn incomplete_or_mismatched_transition_holds_without_a_restart_loop() {
        let config = DesktopConfig {
            mode: Some("daemon".to_string()),
            server_url: Some("wss://new.example".to_string()),
            ..DesktopConfig::default()
        };
        for marker in [
            None,
            Some(transfer_marker("committing", "https://new.example")),
            Some(transfer_marker("committed", "https://other.example")),
            Some(transfer_marker("committed", "file:///not-http")),
        ] {
            assert!(matches!(
                classify_backend_exit(&LaunchAction::LocalAllInOne, &config, marker.as_deref(),),
                BackendExitDecision::Hold { .. }
            ));
        }
    }

    #[test]
    fn restarted_daemon_crash_only_respawns_and_cannot_restart_again() {
        let initial = LaunchAction::LocalDaemon {
            server_url: "wss://new.example".to_string(),
        };
        let config = DesktopConfig {
            mode: Some("daemon".to_string()),
            server_url: Some("wss://new.example".to_string()),
            ..DesktopConfig::default()
        };
        assert_eq!(
            classify_backend_exit(
                &initial,
                &config,
                Some(&transfer_marker("committed", "https://new.example")),
            ),
            BackendExitDecision::Respawn
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
        assert_eq!(cfg.update_channel, Some(UpdateChannel::Edge));
        match prev {
            Some(v) => std::env::set_var("PODIUM_STATE_DIR", v),
            None => std::env::remove_var("PODIUM_STATE_DIR"),
        }
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn unknown_config_value_falls_back_to_build_channel() {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = std::env::temp_dir().join(format!("podium-cfg-channel-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("config.json"), r#"{"updateChannel":"nightly"}"#).unwrap();
        let prev = std::env::var("PODIUM_STATE_DIR").ok();
        std::env::set_var("PODIUM_STATE_DIR", &tmp);
        let persisted = read_config().update_channel;
        assert_eq!(persisted, None);
        assert_eq!(
            resolve_update_channel(None, persisted, UpdateChannel::Edge),
            UpdateChannel::Edge
        );
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
    fn stable_user_choice_persists_and_wins_over_edge_build() {
        with_state_dir(
            "channel-persist",
            Some(r#"{"mode":"client","extra":42}"#),
            || {
                write_update_channel(UpdateChannel::Stable).expect("channel write failed");
                let persisted = read_config().update_channel;
                assert_eq!(persisted, Some(UpdateChannel::Stable));
                assert_eq!(
                    resolve_update_channel(None, persisted, UpdateChannel::Edge),
                    UpdateChannel::Stable
                );
                let raw: serde_json::Value = serde_json::from_str(
                    &std::fs::read_to_string(state_dir().join("config.json")).unwrap(),
                )
                .unwrap();
                assert_eq!(raw["extra"], 42);
            },
        );
    }

    #[test]
    fn edge_build_seeds_missing_server_channel() {
        with_state_dir("channel-seed", Some(r#"{"mode":"all-in-one","extra":42}"#), || {
            let channel = initialize_update_channel(None, UpdateChannel::Edge)
                .expect("channel initialization failed");
            assert_eq!(channel, UpdateChannel::Edge);
            let raw: serde_json::Value = serde_json::from_str(
                &std::fs::read_to_string(state_dir().join("config.json")).unwrap(),
            )
            .unwrap();
            assert_eq!(raw["updateChannel"], "edge");
            assert_eq!(raw["extra"], 42);
        });
    }

    #[test]
    fn explicit_channel_is_not_rewritten_by_build_default() {
        with_state_dir(
            "channel-explicit",
            Some(r#"{"mode":"client","updateChannel":"stable","extra":42}"#),
            || {
                let before = std::fs::read_to_string(state_dir().join("config.json")).unwrap();
                let channel = initialize_update_channel(
                    Some(UpdateChannel::Stable),
                    UpdateChannel::Edge,
                )
                .expect("channel initialization failed");
                let after = std::fs::read_to_string(state_dir().join("config.json")).unwrap();
                assert_eq!(channel, UpdateChannel::Stable);
                assert_eq!(after, before);
            },
        );
    }

    #[test]
    fn read_daemon_machine_id_reads_and_tolerates_absence() {
        with_state_dir("daemon-id", None, || {
            assert_eq!(read_daemon_machine_id(), None);
            std::fs::write(
                state_dir().join("daemon.json"),
                r#"{"machineId":"m-123","token":"t"}"#,
            )
            .unwrap();
            assert_eq!(read_daemon_machine_id().as_deref(), Some("m-123"));
        });
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
    fn ensure_executable_runs_in_place_on_macos_and_copies_elsewhere() {
        use std::fs;
        // Both halves assert here rather than under #[cfg(target_os = "macos")], because the only
        // lane that runs these tests is ubuntu — a macOS-gated test compiles to nothing there and
        // would never run, which is the exact hole scripts/test-rust.ts exists to close.
        //
        // macOS must run the sidecar where it was notarized: a copy in ~/.podium/bin sits outside
        // the app's stapled ticket and inherits com.apple.quarantine, which Gatekeeper reports as
        // `"podium-sidecar" is damaged and can't be opened`. Linux still needs the copy, because
        // an AppImage mount is read-only and may drop the executable bit.
        let src_dir =
            std::env::temp_dir().join(format!("podium-ensure-exec-{}", std::process::id()));
        let _ = fs::remove_dir_all(&src_dir);
        fs::create_dir_all(&src_dir).expect("temp dir");
        let src = src_dir.join("podium");
        fs::write(&src, b"#!/bin/sh\nexit 0\n").expect("write src");

        // with_state_dir keeps the copying branch out of the developer's real ~/.podium.
        with_state_dir("ensure-exec", None, || {
            let resolved = ensure_executable(&src).expect("ensure_executable failed");
            if cfg!(target_os = "macos") {
                assert_eq!(resolved, src, "macOS must run the sidecar in place");
            } else {
                assert_ne!(resolved, src, "non-macOS must run a writable copy");
                assert!(
                    resolved.ends_with("bin/podium-sidecar"),
                    "unexpected copy location: {resolved:?}"
                );
            }
        });

        let _ = fs::remove_dir_all(&src_dir);
    }

    #[test]
    fn ensure_executable_into_returns_path_to_existing_executable() {
        use std::fs;
        use std::io::Write;

        // Separate temp dirs for source and cache (no env mutation).
        let tmp =
            std::env::temp_dir().join(format!("podium-ensure-exe-test-{}", std::process::id()));
        let src_dir = tmp.join("src");
        let cache_dir = tmp.join("cache");
        fs::create_dir_all(&src_dir).unwrap();

        let src = src_dir.join("fake-podium");
        fs::File::create(&src)
            .unwrap()
            .write_all(b"#!/bin/sh\necho hello\n")
            .unwrap();

        let result =
            ensure_executable_into(&src, &cache_dir).expect("ensure_executable_into failed");

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

        let tmp =
            std::env::temp_dir().join(format!("podium-freshness-test-{}", std::process::id()));
        let src_dir = tmp.join("src");
        let cache_dir = tmp.join("cache");
        fs::create_dir_all(&src_dir).unwrap();

        let src = src_dir.join("fake-podium");

        // First copy: write initial content.
        fs::File::create(&src)
            .unwrap()
            .write_all(b"version-1")
            .unwrap();
        let result = ensure_executable_into(&src, &cache_dir).expect("first copy failed");
        assert_eq!(fs::read(&result).unwrap(), b"version-1");

        // Second copy: different size → must re-copy regardless of mtime.
        fs::File::create(&src)
            .unwrap()
            .write_all(b"version-2-longer")
            .unwrap();

        let result2 = ensure_executable_into(&src, &cache_dir).expect("second copy failed");
        assert_eq!(
            fs::read(&result2).unwrap(),
            b"version-2-longer",
            "cache was not refreshed when source size changed"
        );

        // Third copy: same content again — should NOT re-copy (idempotent).
        let result3 = ensure_executable_into(&src, &cache_dir).expect("third copy failed");
        assert_eq!(
            fs::read(&result3).unwrap(),
            b"version-2-longer",
            "cache content changed unexpectedly on idempotent call"
        );

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn windows_source_revisions_do_not_overwrite_the_previous_executable() {
        use std::fs;

        let tmp = std::env::temp_dir().join(format!(
            "podium-windows-exe-revision-test-{}",
            std::process::id()
        ));
        let src_dir = tmp.join("src");
        let cache_dir = tmp.join("cache");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&src_dir).unwrap();
        let src = src_dir.join("podium.exe");

        fs::write(&src, b"version-1").unwrap();
        let first = ensure_executable_into_for_platform(&src, &cache_dir, true)
            .expect("first Windows copy failed");

        fs::write(&src, b"version-2-longer").unwrap();
        let second = ensure_executable_into_for_platform(&src, &cache_dir, true)
            .expect("second Windows copy failed");

        assert_ne!(first, second, "a new source revision must get a new path");
        assert_eq!(fs::read(&first).unwrap(), b"version-1");
        assert_eq!(fs::read(&second).unwrap(), b"version-2-longer");
        assert_eq!(second.extension().and_then(|value| value.to_str()), Some("exe"));

        let _ = fs::remove_dir_all(&tmp);
    }
}
