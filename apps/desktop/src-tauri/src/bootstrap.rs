use std::net::TcpListener;
use std::path::{Path, PathBuf};
use tauri::webview::cookie::{Cookie, SameSite};
use tauri::{Url, WebviewUrl};

const SERVER_TRANSFER_JOURNAL: &str = ".server-transfer/journal.json";

/// Default local server port for the `default` instance — must match `@podium/runtime`
/// `defaultInstancePorts('default').server`.
pub const DEFAULT_LOCAL_PORT: u16 = 18787;

/// The compatibility instance id, which keeps every historical port. [spec:SP-15aa]
pub const DEFAULT_INSTANCE_ID: &str = "default";

/// Bind an ephemeral loopback port and return it (best-effort; falls back to [`DEFAULT_LOCAL_PORT`]).
///
/// Prefer [`resolve_local_port`] for the all-in-one / local-server webview origin: SW cache,
/// cookies, and IndexedDB are origin-keyed, so the port must be stable across restarts.
/// Kept for callers that intentionally want an ephemeral listen (tests, one-off probes).
///
/// NOTE: The port is not reserved between this call and when the backend binds it (TOCTOU).
pub fn pick_free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .ok()
        .and_then(|l| l.local_addr().ok())
        .map(|a| a.port())
        .unwrap_or(DEFAULT_LOCAL_PORT)
}

/// Is this a valid Podium instance id? Mirrors `@podium/runtime` `INSTANCE_ID_PATTERN`
/// (`^[a-z][a-z0-9-]{0,31}$`).
fn is_valid_instance_id(id: &str) -> bool {
    let mut chars = id.chars();
    if !matches!(chars.next(), Some(c) if c.is_ascii_lowercase()) {
        return false;
    }
    id.len() <= 32 && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// This shell's instance identity: `PODIUM_INSTANCE`, else `default`. [spec:SP-15aa]
///
/// `@podium/runtime` `validateInstanceId` THROWS on a malformed id; a desktop shell has to
/// open a window anyway, so a malformed value degrades to the default instance here. The
/// sidecar we spawn inherits this same environment variable, so both sides agree on which
/// instance they are — which is what makes [`resolve_local_port`] agree with `resolvePort`.
pub fn resolve_instance_id() -> String {
    let raw = std::env::var("PODIUM_INSTANCE").unwrap_or_default();
    let id = raw.trim();
    if is_valid_instance_id(id) {
        id.to_string()
    } else {
        DEFAULT_INSTANCE_ID.to_string()
    }
}

/// FNV-1a (32-bit) over the id's UTF-8 bytes — byte-for-byte the hash `@podium/runtime`
/// `defaultInstancePorts` uses, so the two runtimes derive the SAME port for an instance.
fn fnv1a(value: &str) -> u32 {
    let mut hash: u32 = 0x811c_9dc5;
    for byte in value.as_bytes() {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

/// Default server port for an instance — mirrors `defaultInstancePorts(id).server`:
/// `default` keeps [`DEFAULT_LOCAL_PORT`]; named instances take one of 8,000 non-overlapping
/// triplets in 20000..43999.
pub fn default_instance_server_port(instance_id: &str) -> u16 {
    if instance_id == DEFAULT_INSTANCE_ID {
        return DEFAULT_LOCAL_PORT;
    }
    // 20000 + 7999*3 = 43997, so the cast cannot truncate.
    (20_000 + (fnv1a(instance_id) % 8_000) * 3) as u16
}

/// Stable local server port for the desktop webview origin.
///
/// Precedence matches `@podium/runtime` `resolvePort`: `PODIUM_PORT` → `config.port` →
/// `defaultInstancePorts(PODIUM_INSTANCE).server`. The last step is why this is
/// instance-aware rather than a bare [`DEFAULT_LOCAL_PORT`]: two desktop shells launched
/// under different `PODIUM_INSTANCE` values must NOT resolve the same loopback origin, or the
/// second one's window would load the first one's server — with the window controls, opener,
/// `sql:allow-execute` and update-bridge grants this shell hands its own origin. Documented
/// in the updater-convergence spec §2.1.
pub fn resolve_local_port(config: &DesktopConfig) -> u16 {
    if let Ok(raw) = std::env::var("PODIUM_PORT") {
        if let Ok(port) = raw.parse::<u16>() {
            if port > 0 {
                return port;
            }
        }
    }
    match config.port {
        Some(port) if port > 0 => port,
        _ => default_instance_server_port(&resolve_instance_id()),
    }
}

/// Loopback http origin the all-in-one / local-server webview loads when the sidecar is up.
pub fn local_served_http_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

/// Desktop release channel persisted in the shared Podium config or stamped into the build.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateChannel {
    Dev,
    Stable,
    Edge,
}

impl UpdateChannel {
    pub fn from_config(value: Option<&str>) -> Option<Self> {
        match value {
            Some("dev") => Some(Self::Dev),
            Some("stable") => Some(Self::Stable),
            Some("edge") => Some(Self::Edge),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Dev => "dev",
            Self::Stable => "stable",
            Self::Edge => "edge",
        }
    }
}

/// The release workflow sets this for every shipped desktop artifact. Local builds are not
/// promoted from a channel, so they retain the historical stable fallback (and cannot update in
/// debug mode anyway).
///
/// A `dev` build stamps itself dev and therefore keeps updating from dev afterwards: this is
/// the fact that makes a test shell a test shell for the rest of its life rather than only on
/// the day it was installed. Without it a build promoted to dev would ask the edge feed for
/// its next version and quietly rejoin the channel real installs follow.
pub fn build_update_channel() -> UpdateChannel {
    match option_env!("PODIUM_DESKTOP_RELEASE_CHANNEL") {
        Some("dev") => UpdateChannel::Dev,
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
    /// WHERE THE UI FOR `server_url` LIVES, when it is not that server (PDM-34).
    ///
    /// Written by the local server at connect/join time from the remote's advertised
    /// `appUrl`; absent for every install whose server serves its own UI, which is the
    /// case this shell has always handled and still handles identically.
    pub ui_url: Option<String>,
    /// Stable local listen port (`resolvePort` / webview origin). See [`resolve_local_port`].
    pub port: Option<u16>,
    /// A valid user choice from config.json. Absence and unknown values deliberately remain
    /// distinguishable so the updater can fall back to the channel stamped into this build.
    pub update_channel: Option<UpdateChannel>,
    /// Manifest endpoint supplied by the attached source server for the dev channel.
    pub update_feed_endpoint: Option<String>,
}

/// What the shell should do at launch, derived purely from the config.
#[derive(Debug, Clone, PartialEq)]
pub enum LaunchAction {
    /// Default: bind the stable local port, spawn the local `podium` (server+daemon), load the
    /// UI from that server (baked dist only if the sidecar is unreachable).
    LocalAllInOne,
    /// `mode=server` (hub-only box): bind the stable local port, spawn `podium server` — the
    /// SERVER role only, no local daemon/agents — and load the UI from that port (#176).
    /// The explicit `server` subcommand (rather than a bare `podium` reading config.mode) also
    /// bypasses the CLI's persistence-managed path, so a systemd/detached-configured hub still
    /// gets a real in-process server child the desktop shell can supervise.
    LocalServerOnly,
    /// Spawn the local `podium` (which reads config → daemon mode → connects to `server_url`);
    /// the window points at the remote (no local server to wait for).
    LocalDaemon {
        server_url: String,
        /// The origin the WINDOW loads, when the server does not serve the UI itself
        /// (PDM-34). `None` — every self-hosted install — keeps today's behaviour of
        /// loading the server's own URL. Only the window target and the IPC capability
        /// origin follow it; the daemon still dials `server_url`.
        ui_url: Option<String>,
    },
    /// Spawn nothing; the window points at the remote server (or, under split hosting,
    /// at `ui_url` — see [`LaunchAction::LocalDaemon`]).
    ClientOnly {
        server_url: String,
        ui_url: Option<String>,
    },
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
/// `serverUrl`, `port`, and `updateChannel`. A missing or corrupt file yields an empty config; the
/// updater resolves the missing channel against the build stamp rather than inventing a persisted
/// choice.
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
        // Empty is not a UI origin, and treating it as one would send the window
        // to an unparseable URL instead of to the server that does work.
        ui_url: json
            .get("uiUrl")
            .and_then(|v| v.as_str())
            .filter(|v| !v.is_empty())
            .map(str::to_string),
        port: json.get("port").and_then(|v| v.as_u64()).and_then(|n| {
            u16::try_from(n).ok().filter(|p| *p > 0)
        }),
        // [spec:SP-7f2c] Missing or unrecognized values are not user choices, so the channel
        // stamped into the installed build remains authoritative.
        update_channel: UpdateChannel::from_config(
            json.get("updateChannel").and_then(|v| v.as_str()),
        ),
        update_feed_endpoint: json
            .get("updateFeedEndpoint")
            .and_then(|v| v.as_str())
            .filter(|v| !v.is_empty())
            .map(str::to_string),
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
        current_config.ui_url.as_deref(),
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

    let LaunchAction::LocalDaemon { server_url, .. } = current_action else {
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
pub fn write_update_channel(
    channel: UpdateChannel,
    feed_endpoint: Option<&str>,
) -> Result<(), String> {
    write_channel(channel, feed_endpoint, EndpointRequirement::Required)
}

/// Whether selecting `dev` must come with a feed endpoint.
///
/// It must when a USER picks the channel — there is a source server in front of them, and a
/// dev selection with nowhere to fetch from is a mistake worth refusing. It must not when the
/// shell is merely recording the channel it was BUILT as: nobody has chosen anything yet, and
/// the endpoint is a fact about a server this shell may not have met.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EndpointRequirement {
    Required,
    SeedWithoutOne,
}

fn write_channel(
    channel: UpdateChannel,
    feed_endpoint: Option<&str>,
    requirement: EndpointRequirement,
) -> Result<(), String> {
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
    if channel == UpdateChannel::Dev {
        let given = feed_endpoint.map(str::trim).filter(|e| !e.is_empty());
        let endpoint = match (given, requirement) {
            (Some(endpoint), _) => Some(endpoint),
            // A dev-built shell records `dev` and no endpoint, and the updater reports itself
            // unavailable until an attached source server supplies one. The alternative is
            // worse in both directions: failing here stops the shell from launching at all,
            // and seeding some other channel would leave a test build quietly updating from
            // the feed real installs follow.
            (None, EndpointRequirement::SeedWithoutOne) => None,
            (None, EndpointRequirement::Required) => {
                return Err("the dev desktop channel needs a feed endpoint".to_string())
            }
        };
        if let Some(endpoint) = endpoint {
            let url =
                Url::parse(endpoint).map_err(|e| format!("invalid dev update endpoint: {e}"))?;
            if url.scheme() != "https" {
                return Err("the dev update endpoint must use https".to_string());
            }
            obj.insert(
                "updateFeedEndpoint".to_string(),
                serde_json::Value::String(endpoint.to_string()),
            );
        } else {
            // A build-channel seed is not entitled to retain an endpoint whose producer is
            // unknown. In particular, older dev shells accepted loopback HTTP here; pairing a
            // fresh `dev` channel with that stale value arms a release build that Tauri refuses.
            obj.remove("updateFeedEndpoint");
        }
    } else {
        obj.remove("updateFeedEndpoint");
    }
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
    // Seeding must never be able to stop the shell launching: `main.rs` propagates this error
    // out of Tauri's setup. A dev-built shell has no feed endpoint on first run — the server
    // it will attach to is what supplies one — so recording `dev` without one is the whole
    // difference between a dev shell that boots and one that cannot start.
    write_channel(build, None, EndpointRequirement::SeedWithoutOne)?;
    Ok(build)
}

/// PURE resolver: map (mode, serverUrl) → the launch action.
///
/// - `client` + serverUrl  → ClientOnly (spawn nothing, window → remote)
/// - `daemon` + serverUrl  → LocalDaemon (spawn local podium daemon, window → remote)
///
/// `ui_url` rides along on the two remote actions rather than deciding any of them: under
/// split hosting it changes only what the WINDOW loads, never what this box runs or what
/// its daemon dials. A `uiUrl` with no `serverUrl` is therefore not a mode — it falls
/// through to LocalAllInOne exactly as it does today.
/// - `server` (with or without serverUrl) → LocalServerOnly (spawn `podium server`, no daemon,
///   window → local port). Previously this fell through to LocalAllInOne, silently running a
///   local daemon + agents on a hub-only box (#176).
/// - everything else (all-in-one / unset / missing serverUrl) → LocalAllInOne
pub fn resolve_launch(
    mode: Option<&str>,
    server_url: Option<&str>,
    ui_url: Option<&str>,
) -> LaunchAction {
    let ui_url = ui_url.filter(|url| !url.is_empty()).map(str::to_string);
    match (mode, server_url) {
        (Some("client"), Some(url)) if !url.is_empty() => LaunchAction::ClientOnly {
            server_url: url.to_string(),
            ui_url,
        },
        (Some("daemon"), Some(url)) if !url.is_empty() => LaunchAction::LocalDaemon {
            server_url: url.to_string(),
            ui_url,
        },
        (Some("server"), _) => LaunchAction::LocalServerOnly,
        _ => LaunchAction::LocalAllInOne,
    }
}

/// The script injected before page load so the **baked** (tauri-scheme) fallback UI talks to
/// the local backend (Phase 2 serverConfig reads window.__PODIUM_SERVER__ first).
///
/// Served-local loads (`http://127.0.0.1:<port>`) are same-origin with the sidecar and use
/// [`local_served_injection_script`] instead — they must not pin `__PODIUM_SERVER__` to a
/// loopback URL that would override same-origin discovery after a transfer navigation.
pub fn injection_script(port: u16) -> String {
    // The script stays installed when the existing WebView moves to the transferred remote
    // origin. Apply the loopback endpoint only on Tauri's bundled origin so it cannot override
    // the remote page's same-origin server discovery after navigation.
    format!(
        "if (window.location.protocol === 'tauri:' || window.location.hostname === 'tauri.localhost') {{ {}\nwindow.__PODIUM_LOCAL_SETUP__ = true; }}",
        server_injection_script(&format!("ws://127.0.0.1:{port}"))
    )
}

/// Injection for a webview that LOADS the local server's http origin (all-in-one / server mode
/// when the sidecar is reachable). Same-origin discovery covers the relay; local-setup still
/// needs the explicit flag so SetupGate treats this shell as the host box.
///
/// Origin-guarded for the same reason [`injection_script`] is: the script stays installed
/// across navigations, including a runtime-transfer retarget to a REMOTE origin, where this
/// shell is no longer the host box and the flag must not survive.
pub fn local_served_injection_script(port: u16) -> String {
    let origin = serde_json::to_string(&local_served_http_url(port))
        .unwrap_or_else(|_| "\"\"".to_string());
    format!("if (window.location.origin === {origin}) {{ window.__PODIUM_LOCAL_SETUP__ = true; }}")
}

/// The JS condition that is true on EITHER document a local window can show — the baked
/// tauri-scheme fallback, or this shell's served-local origin — and false everywhere else,
/// notably after a runtime transfer has retargeted the window to a remote server.
fn local_document_condition(port: u16) -> String {
    let origin = serde_json::to_string(&local_served_http_url(port))
        .unwrap_or_else(|_| "\"\"".to_string());
    format!("(window.location.protocol === 'tauri:' || window.location.hostname === 'tauri.localhost' || window.location.origin === {origin})")
}

/// Tell the page which build last owned this device's local data, so the BAKED fallback can
/// refuse to run when it is too old for it.
///
/// This is the local half of the skew machinery and it exists because the other half cannot
/// work here: the page normally grades itself against a reachable server's `/version`, and the
/// baked fallback is by definition the case where no server answers. The stamp is a local
/// record — the last `/version` this shell actually read from its own server, persisted across
/// restarts — so the page can still ask "is the UI in the .app older than the data on this
/// disk?" with nothing on the network. [spec:§2.1 durability layer 3]
///
/// Origin-guarded like everything else in the local injection: a remote server's page grades
/// itself against that server, not against this box's history.
pub fn local_build_injection_script(port: u16, stamp: Option<&str>) -> String {
    match stamp {
        Some(stamp) => format!(
            "if {} {{ window.__PODIUM_LOCAL_BUILD__ = {stamp}; }}",
            local_document_condition(port)
        ),
        None => String::new(),
    }
}

/// The one injection a LOCAL (all-in-one / server) window carries, correct at EITHER document
/// this shell can show it: the served `http://127.0.0.1:<port>` origin, or the baked
/// tauri-scheme fallback. Every half is origin-guarded, so the same script stays right when
/// the window MOVES between them ([`ServedOriginWatch`]) or is retargeted to a remote server.
pub fn local_injection_script(port: u16, local_build_stamp: Option<&str>) -> String {
    format!(
        "{}\n{}\n{}",
        injection_script(port),
        local_served_injection_script(port),
        local_build_injection_script(port, local_build_stamp)
    )
}

/// Which document a local-mode window is showing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocalDocument {
    /// The connected local server's own http origin — the UI always matches the server.
    Served,
    /// The baked `frontendDist` in the .app — offline / server-down fallback.
    Baked,
}

/// Decide what a local-host window loads after the sidecar readiness probe.
///
/// Reachable → External `http://127.0.0.1:<port>` (UI always matches the server).
/// Unreachable → baked `frontendDist` (offline / boot-race fallback). The injection is the
/// same either way ([`local_injection_script`]), because the window may move between the two
/// while it runs.
pub fn local_window_target(port: u16, server_reachable: bool) -> WebviewUrl {
    if server_reachable {
        match Url::parse(&local_served_http_url(port)) {
            Ok(url) => WebviewUrl::External(url),
            Err(_) => WebviewUrl::default(),
        }
    } else {
        WebviewUrl::default()
    }
}

/// URL of the BAKED document — what `WebviewUrl::default()` resolves to at runtime, and the
/// navigation target when a served-local window has to fall back.
///
/// Tauri serves the embedded assets from `<scheme>://localhost` everywhere except Windows and
/// Android, which use `http://<scheme>.localhost` (`Manager::tauri_protocol_url`). Two config
/// facts this depends on are pinned by `tauri-conf.test.ts`: no `build.devUrl` (which would
/// replace this URL in dev) and no `useHttpsScheme` (which would make the Windows form https).
pub fn baked_document_url() -> &'static str {
    if cfg!(any(target_os = "windows", target_os = "android")) {
        "http://tauri.localhost"
    } else {
        "tauri://localhost"
    }
}

/// Which of this shell's own two documents is `current`, or `None` for anything else — which
/// in practice means the window was retargeted to a remote server and is no longer ours to
/// move.
pub fn document_shown(current: &Url, port: u16) -> Option<LocalDocument> {
    if current.scheme() == "tauri" || current.host_str() == Some("tauri.localhost") {
        return Some(LocalDocument::Baked);
    }
    let served = Url::parse(&local_served_http_url(port)).ok()?;
    if current.origin() == served.origin() {
        return Some(LocalDocument::Served);
    }
    None
}

/// Consecutive failed probes before a served-local window falls back to the baked dist.
/// Deliberately several seconds' worth: the shell RESPAWNS its sidecar (see the supervision
/// monitor), so an ordinary restart — including the one an update performs — must not bounce
/// the window through the fallback and lose the page's state.
pub const SERVED_FALLBACK_STREAK: u32 = 6;
/// Consecutive healthy probes before a fallen-back window returns to the served origin. Lower,
/// because returning is the convergent direction: the served UI is the one that matches the
/// server.
pub const SERVED_RETURN_STREAK: u32 = 2;

/// Tracks the local server's liveness for a window that is already open, and decides when the
/// window should MOVE between the served origin and the baked fallback.
///
/// The boot probe alone is not enough: it answers "was the sidecar up when we opened the
/// window", and killing the server afterwards would otherwise leave the webview parked on a
/// dead origin showing the ENGINE's network error page instead of our reconnect UX.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct ServedOriginWatch {
    fail_streak: u32,
    ok_streak: u32,
}

impl ServedOriginWatch {
    /// Feed one probe result for the document currently shown. Returns the document to
    /// navigate to, or `None` to stay put.
    pub fn observe(&mut self, showing: LocalDocument, healthy: bool) -> Option<LocalDocument> {
        if healthy {
            self.fail_streak = 0;
            self.ok_streak = self.ok_streak.saturating_add(1);
        } else {
            self.ok_streak = 0;
            self.fail_streak = self.fail_streak.saturating_add(1);
        }
        let target = match showing {
            LocalDocument::Served if self.fail_streak >= SERVED_FALLBACK_STREAK => {
                LocalDocument::Baked
            }
            LocalDocument::Baked if self.ok_streak >= SERVED_RETURN_STREAK => LocalDocument::Served,
            _ => return None,
        };
        // The navigation is about to change what "showing" means; start the next streak from
        // scratch so one stale count cannot immediately bounce the window back.
        *self = Self::default();
        Some(target)
    }
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
///
/// SPLIT HOSTING (PDM-34): when the server told us its UI lives elsewhere, `ui_url` wins and
/// the window loads the app host instead. The page is then NOT same-origin with the API — but
/// it is same-SITE, which is what the 1006 failure and the session cookie both actually turn
/// on, and the app host stamps `window.__PODIUM_SERVER__` into its own shell, so no injection
/// is needed here either. A `ui_url` that will not parse is ignored rather than fatal: the
/// server URL still works, and a window on the server URL beats no window at all.
pub fn remote_window_target(server_url: &str, ui_url: Option<&str>) -> (WebviewUrl, String) {
    if let Some(ui_url) = ui_url.filter(|url| !url.is_empty()) {
        if let Ok(url) = Url::parse(ui_url) {
            if matches!(url.scheme(), "http" | "https") {
                return (WebviewUrl::External(url), String::new());
            }
        }
    }
    match Url::parse(&webview_http_url(server_url)) {
        Ok(url) => (WebviewUrl::External(url), String::new()),
        Err(_) => (WebviewUrl::default(), remote_injection_script(server_url)),
    }
}

/// The origin a remote-mode window will actually LOAD — the one the IPC capability grants
/// have to name (`main.rs`), the cookie has to reach, and nothing else keys off.
///
/// It exists as its own function so the grant and the navigation cannot answer the question
/// differently: a capability derived from the server URL while the window sits on the app host
/// is a dead grant, and a dead grant looks like a native bridge that silently does nothing.
pub fn remote_window_origin_url(server_url: &str, ui_url: Option<&str>) -> String {
    match ui_url.filter(|url| !url.is_empty()) {
        Some(ui_url)
            if Url::parse(ui_url)
                .map(|url| matches!(url.scheme(), "http" | "https"))
                .unwrap_or(false) =>
        {
            ui_url.to_string()
        }
        _ => webview_http_url(server_url),
    }
}

/// One HTTP/1.0 GET against the loopback backend. Returns the status line's code and the
/// response body. Deliberately hand-rolled: the shell has no HTTP client dependency, and the
/// two things it ever asks a loopback server for are `/version` and `/health`.
pub fn local_http_get(
    port: u16,
    path: &str,
    timeout: std::time::Duration,
) -> std::io::Result<(u16, String)> {
    use std::io::{Read, Write};
    use std::net::TcpStream;

    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&addr, timeout)?;
    stream.set_read_timeout(Some(timeout))?;
    stream.set_write_timeout(Some(timeout))?;
    stream.write_all(format!("GET {path} HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n").as_bytes())?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw)?;
    let response = String::from_utf8_lossy(&raw).into_owned();
    let status = response
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok())
        .unwrap_or(0);
    let body = response
        .split_once("\r\n\r\n")
        .map(|(_, body)| body.to_string())
        .unwrap_or_default();
    Ok((status, body))
}

/// The JSON object inside a response body, tolerating HTTP chunk framing — a payload this
/// small arrives as a single chunk, so the object itself is intact between the framing lines.
fn json_object_slice(body: &str) -> Option<&str> {
    let start = body.find('{')?;
    let end = body.rfind('}')?;
    (end > start).then(|| &body[start..=end])
}

/// Does this `/version` body come from a Podium server belonging to `expected_instance`?
///
/// Shape first (`wireVersion` + `wireSchemaDigest` are this server's own protocol identity),
/// then instance: a DIFFERENT Podium instance holding the port is just as wrong as a stranger,
/// because its data is not the data this shell's daemon writes. A body with no `instanceId` is
/// accepted on shape alone — that is an older Podium, not an impostor.
pub fn is_podium_version_payload(body: &str, expected_instance: &str) -> bool {
    let Some(slice) = json_object_slice(body) else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(slice) else {
        return false;
    };
    let Some(object) = value.as_object() else {
        return false;
    };
    if !object.contains_key("wireVersion") || !object.contains_key("wireSchemaDigest") {
        return false;
    }
    match object.get("instanceId").and_then(|id| id.as_str()) {
        Some(id) => id == expected_instance,
        None => true,
    }
}

/// Is OUR local server — this instance's — the thing listening on `port` right now?
///
/// A bare TCP connect is NOT enough, and that is a security boundary rather than a nicety:
/// this answer decides whether the shell LOADS a page from `http://127.0.0.1:<port>`, and
/// `main.rs` grants that origin window controls, the opener, `sql:default` +
/// `sql:allow-execute` and the update bridge (claim/check/install). The port is fixed and
/// unprivileged, so any local process can be listening on it first; the origin has to
/// identify itself as ours before the window is pointed at it.
pub fn probe_local_server(port: u16) -> bool {
    probe_local_server_as(port, &resolve_instance_id())
}

/// [`probe_local_server`] with the instance identity passed in (tests, and callers that
/// already resolved it).
pub fn probe_local_server_as(port: u16, expected_instance: &str) -> bool {
    match local_http_get(port, "/version", std::time::Duration::from_millis(1500)) {
        Ok((200, body)) => is_podium_version_payload(&body, expected_instance),
        _ => false,
    }
}

/// Cheap LIVENESS ping: is something still serving on `port` (`/health` → plaintext `ok`)?
///
/// Deliberately NOT an identity check, and deliberately never the answer to "may the window
/// load this origin" — [`probe_local_server`] owns that question, and every navigation goes
/// through it. This one is for the watchdog's once-a-second "is our server still up", where
/// `/version` would mean spawning `git` on a source host every poll (POD-2048).
pub fn local_server_alive(port: u16) -> bool {
    match local_http_get(port, "/health", std::time::Duration::from_millis(1500)) {
        // `contains` rather than an equality: a 200 is already the liveness fact, and the body
        // may arrive inside HTTP chunk framing.
        Ok((200, body)) => body.contains("ok"),
        _ => false,
    }
}

/// Where the last-seen local build stamp is kept, so it survives a restart into the offline
/// case that needs it.
fn local_build_stamp_path() -> PathBuf {
    state_dir().join("desktop-local-build.json")
}

/// The build-identity subset of a `/version` body, as a compact JSON object.
///
/// Deliberately only the fields `classifySkew` reads plus `appVersion` for the message the
/// user sees: the stamp is injected verbatim into a page, so it carries what the decision
/// needs and nothing else.
pub fn local_build_stamp_from_version(body: &str) -> Option<String> {
    let slice = json_object_slice(body)?;
    let value: serde_json::Value = serde_json::from_str(slice).ok()?;
    let object = value.as_object()?;
    let mut stamp = serde_json::Map::new();
    for field in [
        "wireVersion",
        "minSupportedVersion",
        "wireSchemaDigest",
        "appVersion",
    ] {
        if let Some(value) = object.get(field) {
            stamp.insert(field.to_string(), value.clone());
        }
    }
    // Without a wire version there is nothing to compare, and a stamp that cannot decide
    // anything is worse than none: it would look like an answer.
    stamp.get("wireVersion")?;
    serde_json::to_string(&serde_json::Value::Object(stamp)).ok()
}

/// The stamp written by an earlier run, if any. Best-effort in every direction — a missing or
/// unreadable stamp means the guard has nothing to say, which is the safe answer.
pub fn read_local_build_stamp() -> Option<String> {
    let text = std::fs::read_to_string(local_build_stamp_path()).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value.as_object()?.get("wireVersion")?;
    serde_json::to_string(&value).ok()
}

/// Persist the stamp for the next boot. Best-effort: this is a guard's input, never a gate on
/// opening the window.
pub fn write_local_build_stamp(stamp: &str) {
    let path = local_build_stamp_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Err(error) = std::fs::write(&path, stamp) {
        log::warn!("could not record the local build stamp: {error}");
    }
}

/// Read the local server's `/version`, record the build stamp it carries, and return it.
/// Falls back to the persisted stamp when the read fails, so a flaky probe never erases what
/// an earlier run established.
pub fn record_local_build_stamp(port: u16) -> Option<String> {
    let fresh = local_http_get(port, "/version", std::time::Duration::from_millis(1500))
        .ok()
        .filter(|(status, _)| *status == 200)
        .and_then(|(_, body)| local_build_stamp_from_version(&body));
    match fresh {
        Some(stamp) => {
            write_local_build_stamp(&stamp);
            Some(stamp)
        }
        None => read_local_build_stamp(),
    }
}

/// Block until this instance's Podium server answers on `port`, or the budget runs out.
/// Returns true if it did.
pub fn wait_for_local_server(port: u16, attempts: u32, delay_ms: u64) -> bool {
    let instance = resolve_instance_id();
    for _ in 0..attempts {
        if probe_local_server_as(port, &instance) {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(delay_ms));
    }
    false
}

/// The mutable desktop payload install. Tauri's app-data directory is Application
/// Support on macOS and the platform data directory elsewhere; tests and managed
/// installations may pin the same location explicitly.
pub fn payload_home(app_data_dir: &Path) -> PathBuf {
    std::env::var("PODIUM_PAYLOAD_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| app_data_dir.join("payload"))
}

fn copy_payload_tree(src: &Path, dst: &Path) -> std::io::Result<()> {
    use std::fs;
    fs::create_dir(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_payload_tree(&from, &to)?;
        } else {
            fs::copy(from, to)?;
        }
    }
    Ok(())
}

/// Strip the download quarantine from the copied seed. The signed app is assessed
/// by Gatekeeper; the mutable payload is subsequently authenticated by the feed's
/// signature and must not inherit the app download's translocation marker.
fn strip_payload_quarantine(path: &Path) -> std::io::Result<()> {
    #[cfg(target_os = "macos")]
    {
        let status = std::process::Command::new("/usr/bin/xattr")
            .args(["-dr", "com.apple.quarantine"])
            .arg(path)
            .status()?;
        if !status.success() {
            return Err(std::io::Error::other(format!(
                "xattr exited with {status} while clearing the payload quarantine"
            )));
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = path;
    Ok(())
}

/// Seed the external payload exactly once. Presence of the directory is the only
/// decision: no version, health, or content judgment can overwrite an install that
/// the fleet updater owns. Copying into a sibling and renaming keeps a crash from
/// turning a partial seed into a permanently-present payload directory.
pub fn seed_payload_if_absent(seed: &Path, install: &Path) -> std::io::Result<bool> {
    if install.exists() {
        return Ok(false);
    }
    let parent = install
        .parent()
        .ok_or_else(|| std::io::Error::other("payload install has no parent"))?;
    std::fs::create_dir_all(parent)?;
    let staging = parent.join(format!(".payload-seed-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&staging);
    if let Err(error) = copy_payload_tree(seed, &staging)
        .and_then(|_| ensure_executable(&staging.join("podium")))
        .and_then(|_| ensure_executable(&staging.join("podium-cli")))
        .and_then(|_| strip_payload_quarantine(&staging))
        .and_then(|_| std::fs::rename(&staging, install))
    {
        let _ = std::fs::remove_dir_all(&staging);
        if install.exists() {
            return Ok(false);
        }
        return Err(error);
    }
    Ok(true)
}

/// Ensure a payload entrypoint is executable without ever copying or refreshing it.
/// First-run seeding and fleet grants are the only writers of the payload directory.
pub fn ensure_executable(path: &Path) -> std::io::Result<PathBuf> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(path)?.permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(path, perms)?;
    }
    Ok(path.to_path_buf())
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

    /// The ports `@podium/runtime` `defaultInstancePorts(id).server` derives for these ids.
    /// Computed from the TypeScript, pinned here: the two runtimes MUST agree, because the
    /// shell resolves the origin it loads and the sidecar resolves the port it binds.
    const TS_INSTANCE_SERVER_PORTS: &[(&str, u16)] =
        &[("default", 18787), ("work", 37952), ("edge", 25364), ("a", 26660)];

    #[test]
    fn instance_default_ports_match_the_typescript_derivation() {
        for (id, expected) in TS_INSTANCE_SERVER_PORTS {
            assert_eq!(default_instance_server_port(id), *expected, "instance {id}");
        }
    }

    #[test]
    fn resolve_instance_id_falls_back_to_default_for_anything_malformed() {
        let _guard = ENV_LOCK.lock().unwrap();
        let prev = std::env::var_os("PODIUM_INSTANCE");
        for (raw, expected) in [
            ("", "default"),
            ("  ", "default"),
            ("work", "work"),
            ("  work  ", "work"),
            ("Work", "default"),
            ("9work", "default"),
            ("work_two", "default"),
            (
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", // 33 chars — one over the limit
                "default",
            ),
        ] {
            std::env::set_var("PODIUM_INSTANCE", raw);
            assert_eq!(resolve_instance_id(), expected, "PODIUM_INSTANCE={raw:?}");
        }
        match prev {
            Some(value) => std::env::set_var("PODIUM_INSTANCE", value),
            None => std::env::remove_var("PODIUM_INSTANCE"),
        }
    }

    #[test]
    fn resolve_local_port_is_instance_aware_so_two_shells_cannot_share_an_origin() {
        let _guard = ENV_LOCK.lock().unwrap();
        let prev_port = std::env::var_os("PODIUM_PORT");
        let prev_instance = std::env::var_os("PODIUM_INSTANCE");
        std::env::remove_var("PODIUM_PORT");
        std::env::remove_var("PODIUM_INSTANCE");
        assert_eq!(resolve_local_port(&DesktopConfig::default()), DEFAULT_LOCAL_PORT);
        std::env::set_var("PODIUM_INSTANCE", "work");
        assert_eq!(resolve_local_port(&DesktopConfig::default()), 37952);
        // An explicit port still wins over the per-instance default.
        assert_eq!(
            resolve_local_port(&DesktopConfig {
                port: Some(19191),
                ..DesktopConfig::default()
            }),
            19191
        );
        match prev_instance {
            Some(value) => std::env::set_var("PODIUM_INSTANCE", value),
            None => std::env::remove_var("PODIUM_INSTANCE"),
        }
        match prev_port {
            Some(value) => std::env::set_var("PODIUM_PORT", value),
            None => std::env::remove_var("PODIUM_PORT"),
        }
    }

    #[test]
    fn resolve_local_port_matches_runtime_precedence() {
        let _guard = ENV_LOCK.lock().unwrap();
        let prev = std::env::var_os("PODIUM_PORT");
        let prev_instance = std::env::var_os("PODIUM_INSTANCE");
        std::env::remove_var("PODIUM_PORT");
        std::env::remove_var("PODIUM_INSTANCE");
        assert_eq!(resolve_local_port(&DesktopConfig::default()), DEFAULT_LOCAL_PORT);
        assert_eq!(
            resolve_local_port(&DesktopConfig {
                port: Some(19191),
                ..DesktopConfig::default()
            }),
            19191
        );
        std::env::set_var("PODIUM_PORT", "20202");
        assert_eq!(
            resolve_local_port(&DesktopConfig {
                port: Some(19191),
                ..DesktopConfig::default()
            }),
            20202
        );
        std::env::set_var("PODIUM_PORT", "nope");
        assert_eq!(
            resolve_local_port(&DesktopConfig {
                port: Some(19191),
                ..DesktopConfig::default()
            }),
            19191
        );
        match prev {
            Some(value) => std::env::set_var("PODIUM_PORT", value),
            None => std::env::remove_var("PODIUM_PORT"),
        }
        match prev_instance {
            Some(value) => std::env::set_var("PODIUM_INSTANCE", value),
            None => std::env::remove_var("PODIUM_INSTANCE"),
        }
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
    fn injection_script_embeds_the_port() {
        let s = injection_script(18799);
        assert!(s.contains("ws://127.0.0.1:18799"));
        assert!(s.contains("__PODIUM_SERVER__"));
        assert!(s.contains("window.location.protocol === 'tauri:'"));
        assert!(s.contains("__PODIUM_LOCAL_SETUP__ = true"));
    }

    #[test]
    fn local_window_target_loads_loopback_when_reachable() {
        let url = local_window_target(18787, true);
        assert!(matches!(url, WebviewUrl::External(u) if u.as_str() == "http://127.0.0.1:18787/"));
    }

    #[test]
    fn local_window_target_falls_back_to_baked_when_unreachable() {
        assert!(!matches!(
            local_window_target(18787, false),
            WebviewUrl::External(_)
        ));
    }

    #[test]
    fn local_served_injection_guards_the_local_setup_flag_by_origin() {
        // The script survives a retarget to a remote origin, so the flag must not.
        let script = local_served_injection_script(18787);
        assert!(script.contains("window.location.origin === \"http://127.0.0.1:18787\""));
        assert!(script.contains("__PODIUM_LOCAL_SETUP__ = true"));
    }

    #[test]
    fn local_injection_script_is_correct_at_both_documents_a_local_window_can_show() {
        // One script, installed once, guarding each half by the origin it belongs to — the
        // window MOVES between the served origin and the baked dist while it runs.
        let script = local_injection_script(18787, None);
        assert!(script.contains("window.location.protocol === 'tauri:'"));
        assert!(script.contains("ws://127.0.0.1:18787"));
        assert!(script.contains("window.location.origin === \"http://127.0.0.1:18787\""));
        assert_eq!(script.matches("__PODIUM_LOCAL_SETUP__ = true").count(), 2);
        // No stamp recorded yet — the guard gets nothing rather than a value that cannot
        // decide anything.
        assert!(!script.contains("__PODIUM_LOCAL_BUILD__"));
    }

    #[test]
    fn local_build_injection_hands_the_page_the_stamp_on_local_documents_only() {
        let stamp = "{\"wireVersion\":7,\"wireSchemaDigest\":\"abc\"}";
        let script = local_build_injection_script(18787, Some(stamp));
        assert!(script.contains(&format!("window.__PODIUM_LOCAL_BUILD__ = {stamp};")));
        assert!(script.contains("window.location.protocol === 'tauri:'"));
        assert!(script.contains("window.location.origin === \"http://127.0.0.1:18787\""));
        assert_eq!(local_build_injection_script(18787, None), "");
    }

    #[test]
    fn local_build_stamp_keeps_the_fields_the_skew_decision_reads() {
        let body = "{\"wireVersion\":7,\"minSupportedVersion\":5,\"wireSchemaDigest\":\"abc\",\"appVersion\":\"0.1.1\",\"instanceId\":\"default\",\"feedScoping\":\"device-scoped\"}";
        let stamp = local_build_stamp_from_version(body).expect("a /version body yields a stamp");
        let value: serde_json::Value = serde_json::from_str(&stamp).expect("stamp is JSON");
        let object = value.as_object().expect("stamp is an object");
        assert_eq!(object.len(), 4, "only the decision's fields travel: {stamp}");
        assert_eq!(object["wireVersion"], serde_json::json!(7));
        assert_eq!(object["minSupportedVersion"], serde_json::json!(5));
        assert_eq!(object["wireSchemaDigest"], serde_json::json!("abc"));
        assert_eq!(object["appVersion"], serde_json::json!("0.1.1"));
        // A stamp that cannot decide anything would look like an answer, so there is none.
        assert_eq!(
            local_build_stamp_from_version("{\"appVersion\":\"0.1.1\"}"),
            None
        );
        assert_eq!(local_build_stamp_from_version("not json"), None);
    }

    #[test]
    fn local_build_stamp_round_trips_through_the_state_dir() {
        with_state_dir("local-build-stamp", None, || {
            assert_eq!(read_local_build_stamp(), None);
            write_local_build_stamp("{\"wireVersion\":7,\"wireSchemaDigest\":\"abc\"}");
            let stamp = read_local_build_stamp().expect("the stamp survives the write");
            assert!(stamp.contains("\"wireVersion\":7"));
            // Garbage on disk reads as "nothing recorded", never as a decision.
            write_local_build_stamp("{\"appVersion\":\"0.1.1\"}");
            assert_eq!(read_local_build_stamp(), None);
        });
    }

    #[test]
    fn document_shown_names_our_two_documents_and_nothing_else() {
        let baked = Url::parse(baked_document_url()).expect("baked URL parses");
        assert_eq!(document_shown(&baked, 18787), Some(LocalDocument::Baked));
        assert_eq!(
            document_shown(&Url::parse("http://tauri.localhost/workspace").unwrap(), 18787),
            Some(LocalDocument::Baked)
        );
        assert_eq!(
            document_shown(&Url::parse("http://127.0.0.1:18787/workspace").unwrap(), 18787),
            Some(LocalDocument::Served)
        );
        // A different port is a different origin — and a REMOTE origin is not ours to move.
        assert_eq!(
            document_shown(&Url::parse("http://127.0.0.1:19999/").unwrap(), 18787),
            None
        );
        assert_eq!(
            document_shown(&Url::parse("https://podium.example/").unwrap(), 18787),
            None
        );
    }

    #[test]
    fn served_watch_falls_back_only_after_a_sustained_outage() {
        let mut watch = ServedOriginWatch::default();
        for _ in 0..(SERVED_FALLBACK_STREAK - 1) {
            assert_eq!(watch.observe(LocalDocument::Served, false), None);
        }
        assert_eq!(
            watch.observe(LocalDocument::Served, true),
            None,
            "one healthy probe clears the streak"
        );
        for _ in 0..(SERVED_FALLBACK_STREAK - 1) {
            assert_eq!(watch.observe(LocalDocument::Served, false), None);
        }
        assert_eq!(
            watch.observe(LocalDocument::Served, false),
            Some(LocalDocument::Baked)
        );
    }

    #[test]
    fn served_watch_returns_to_the_server_once_it_is_back() {
        let mut watch = ServedOriginWatch::default();
        for _ in 0..(SERVED_RETURN_STREAK - 1) {
            assert_eq!(watch.observe(LocalDocument::Baked, true), None);
        }
        assert_eq!(
            watch.observe(LocalDocument::Baked, true),
            Some(LocalDocument::Served)
        );
        // The streak resets with the navigation, so the very next probe cannot bounce it.
        assert_eq!(watch.observe(LocalDocument::Served, false), None);
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
        let (url, injection) = remote_window_target("https://relay.example:55555", None);
        // Same-origin load: an external relay URL, and NO injected server global.
        assert!(
            matches!(url, WebviewUrl::External(u) if u.as_str() == "https://relay.example:55555/")
        );
        assert_eq!(injection, "");
    }

    #[test]
    fn remote_window_target_falls_back_to_bundled_on_bad_url() {
        let (url, injection) = remote_window_target("not a url", None);
        assert!(!matches!(url, WebviewUrl::External(_)));
        assert!(injection.contains("__PODIUM_SERVER__"));
    }

    #[test]
    fn resolve_launch_client_with_url_is_client_only() {
        assert_eq!(
            resolve_launch(Some("client"), Some("ws://h:1"), None),
            LaunchAction::ClientOnly {
                server_url: "ws://h:1".to_string(),
                ui_url: None,
            }
        );
    }

    #[test]
    fn resolve_launch_daemon_with_url_is_local_daemon() {
        assert_eq!(
            resolve_launch(Some("daemon"), Some("ws://h:1"), None),
            LaunchAction::LocalDaemon {
                server_url: "ws://h:1".to_string(),
                ui_url: None,
            }
        );
    }

    #[test]
    fn resolve_launch_all_in_one_is_local() {
        assert_eq!(
            resolve_launch(Some("all-in-one"), None, None),
            LaunchAction::LocalAllInOne
        );
    }

    #[test]
    fn resolve_launch_server_mode_is_server_only() {
        // #176: a hub-only box must NOT get a local daemon + agents.
        assert_eq!(
            resolve_launch(Some("server"), None, None),
            LaunchAction::LocalServerOnly
        );
        // A stray serverUrl in config doesn't change it — the server runs locally.
        assert_eq!(
            resolve_launch(Some("server"), Some("ws://h:1"), None),
            LaunchAction::LocalServerOnly
        );
    }

    #[test]
    fn resolve_launch_unset_is_local() {
        assert_eq!(resolve_launch(None, None, None), LaunchAction::LocalAllInOne);
    }

    #[test]
    fn resolve_launch_client_without_url_falls_back_to_local() {
        // No serverUrl → can't connect remotely; behave as all-in-one rather than break.
        assert_eq!(
            resolve_launch(Some("client"), None, None),
            LaunchAction::LocalAllInOne
        );
        assert_eq!(
            resolve_launch(Some("daemon"), Some(""), None),
            LaunchAction::LocalAllInOne
        );
    }

    /// PDM-34: under split hosting the UI is a different origin from the API, and the
    /// window has to follow the UI while everything else keeps following the server.
    #[test]
    fn resolve_launch_carries_the_ui_url_on_both_remote_modes() {
        assert_eq!(
            resolve_launch(
                Some("client"),
                Some("wss://api.meetpodium.com"),
                Some("https://app.meetpodium.com")
            ),
            LaunchAction::ClientOnly {
                server_url: "wss://api.meetpodium.com".to_string(),
                ui_url: Some("https://app.meetpodium.com".to_string()),
            }
        );
        assert_eq!(
            resolve_launch(
                Some("daemon"),
                Some("wss://api.meetpodium.com"),
                Some("https://app.meetpodium.com")
            ),
            LaunchAction::LocalDaemon {
                server_url: "wss://api.meetpodium.com".to_string(),
                ui_url: Some("https://app.meetpodium.com".to_string()),
            }
        );
    }

    #[test]
    fn resolve_launch_treats_an_empty_ui_url_as_absent() {
        assert_eq!(
            resolve_launch(Some("client"), Some("wss://api.example"), Some("")),
            LaunchAction::ClientOnly {
                server_url: "wss://api.example".to_string(),
                ui_url: None,
            }
        );
    }

    #[test]
    fn resolve_launch_ui_url_alone_is_not_a_mode() {
        // It changes what a remote window LOADS; it never decides that this box is remote.
        assert_eq!(
            resolve_launch(Some("client"), None, Some("https://app.meetpodium.com")),
            LaunchAction::LocalAllInOne
        );
        assert_eq!(
            resolve_launch(Some("server"), Some("wss://h:1"), Some("https://app.example")),
            LaunchAction::LocalServerOnly
        );
    }

    #[test]
    fn remote_window_target_loads_the_app_host_when_the_server_advertised_one() {
        let (url, injection) = remote_window_target(
            "wss://api.meetpodium.com",
            Some("https://app.meetpodium.com"),
        );
        assert!(
            matches!(url, WebviewUrl::External(u) if u.as_str() == "https://app.meetpodium.com/")
        );
        // Still none: the app host stamps __PODIUM_SERVER__ into its own shell.
        assert_eq!(injection, "");
    }

    #[test]
    fn remote_window_target_ignores_an_unusable_ui_url_and_keeps_the_server() {
        // A window on the server URL beats no window at all.
        for bad in ["not a url", "file:///etc/passwd", ""] {
            let (url, injection) = remote_window_target("https://relay.example:55555", Some(bad));
            let loaded = match url {
                WebviewUrl::External(u) => u.to_string(),
                other => panic!("expected an external URL, got {other:?}"),
            };
            assert_eq!(
                loaded, "https://relay.example:55555/",
                "ui_url {bad:?} should have been ignored"
            );
            assert_eq!(injection, "");
        }
    }

    #[test]
    fn remote_window_origin_url_is_the_origin_the_window_actually_loads() {
        // The IPC capability grants are derived from this; if it disagreed with
        // remote_window_target the native bridge would be granted to nobody.
        assert_eq!(
            remote_window_origin_url(
                "wss://api.meetpodium.com",
                Some("https://app.meetpodium.com")
            ),
            "https://app.meetpodium.com"
        );
        assert_eq!(
            remote_window_origin_url("wss://relay.example:55555", None),
            "https://relay.example:55555"
        );
        assert_eq!(
            remote_window_origin_url("wss://relay.example:55555", Some("not a url")),
            "https://relay.example:55555"
        );
    }

    #[test]
    fn read_config_reads_the_ui_url() {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = std::env::temp_dir().join(format!("podium-cfg-uiurl-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let prev = std::env::var("PODIUM_STATE_DIR").ok();
        std::env::set_var("PODIUM_STATE_DIR", &tmp);

        let split_hosted = concat!(
            r#"{"mode":"daemon","serverUrl":"wss://api.meetpodium.com","#,
            r#""uiUrl":"https://app.meetpodium.com"}"#
        );
        std::fs::write(tmp.join("config.json"), split_hosted).unwrap();
        assert_eq!(
            read_config().ui_url.as_deref(),
            Some("https://app.meetpodium.com")
        );

        // A self-hosted config has no such key, and an empty one is not a value.
        std::fs::write(
            tmp.join("config.json"),
            r#"{"mode":"daemon","serverUrl":"wss://relay","uiUrl":""}"#,
        )
        .unwrap();
        assert_eq!(read_config().ui_url, None);
        std::fs::write(
            tmp.join("config.json"),
            r#"{"mode":"daemon","serverUrl":"wss://relay"}"#,
        )
        .unwrap();
        assert_eq!(read_config().ui_url, None);

        match prev {
            Some(v) => std::env::set_var("PODIUM_STATE_DIR", v),
            None => std::env::remove_var("PODIUM_STATE_DIR"),
        }
        let _ = std::fs::remove_dir_all(&tmp);
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
            ui_url: None,
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
                write_update_channel(UpdateChannel::Stable, None).expect("channel write failed");
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
    fn dev_channel_persists_its_server_manifest_endpoint() {
        with_state_dir("dev-channel", Some(r#"{"extra":42}"#), || {
            write_update_channel(
                UpdateChannel::Dev,
                Some("https://podium.test/updates/feed/dev/latest.json"),
            )
            .expect("dev channel write failed");
            let config = read_config();
            assert_eq!(config.update_channel, Some(UpdateChannel::Dev));
            assert_eq!(
                config.update_feed_endpoint.as_deref(),
                Some("https://podium.test/updates/feed/dev/latest.json")
            );
        });
    }

    /// A DEV BUILD KEEPS UPDATING FROM DEV.
    ///
    /// The channel stamped at build time is what an install falls back to for the rest of
    /// its life, so a shell promoted to dev must seed `dev` into a fresh config and stay
    /// there. If it seeded anything else, a test build would ask a real channel for its
    /// next version — which is the exact thing a dev channel exists to prevent.
    #[test]
    fn dev_build_seeds_and_keeps_the_dev_channel() {
        with_state_dir("channel-seed-dev", Some(r#"{"mode":"all-in-one","updateFeedEndpoint":"http://127.0.0.1:18787/updates/feed/dev/latest.json"}"#), || {
            // First launch of a dev-promoted shell: no channel chosen, and no feed endpoint,
            // because the source server that supplies one has not been attached yet. This
            // must SUCCEED — `main.rs` turns a failure here into a shell that cannot start.
            let channel = initialize_update_channel(None, UpdateChannel::Dev)
                .expect("a dev build must be able to seed its own channel on first launch");
            assert_eq!(channel, UpdateChannel::Dev);
            let raw: serde_json::Value = serde_json::from_str(
                &std::fs::read_to_string(state_dir().join("config.json")).unwrap(),
            )
            .unwrap();
            assert_eq!(raw["updateChannel"], "dev");
            // The seed has no producer for an endpoint yet, so it must not couple the new
            // channel to a stale value that a release updater cannot use.
            assert!(raw.get("updateFeedEndpoint").is_none());
            // And it round-trips: the next launch reads dev back rather than falling
            // through to the build default.
            let persisted = read_config().update_channel;
            assert_eq!(persisted, Some(UpdateChannel::Dev));
            assert_eq!(
                resolve_update_channel(None, persisted, UpdateChannel::Dev),
                UpdateChannel::Dev
            );
        });
    }

    /// Seeding is lenient; CHOOSING is not. A user switching to dev has a source server in
    /// front of them, so a selection with nowhere to fetch from stays a refusal — the
    /// leniency above must not have widened into the path where an endpoint is knowable.
    #[test]
    fn choosing_dev_requires_a_secure_feed_endpoint() {
        with_state_dir("channel-choose-dev", Some(r#"{"mode":"all-in-one"}"#), || {
            assert_eq!(
                write_update_channel(UpdateChannel::Dev, None),
                Err("the dev desktop channel needs a feed endpoint".to_string())
            );
            assert_eq!(
                write_update_channel(UpdateChannel::Dev, Some("ftp://nope.test/feed")),
                Err("the dev update endpoint must use https".to_string())
            );
            assert_eq!(
                write_update_channel(
                    UpdateChannel::Dev,
                    Some("http://127.0.0.1:18787/updates/feed/dev/latest.json"),
                ),
                Err("the dev update endpoint must use https".to_string())
            );
            assert_eq!(
                std::fs::read_to_string(state_dir().join("config.json")).unwrap(),
                r#"{"mode":"all-in-one"}"#,
                "a refused endpoint must not write the channel or endpoint"
            );
        });
    }

    /// `build.rs` refuses an unknown channel at COMPILE time, so a typo in the workflow
    /// fails the build instead of silently producing a stable-updating shell. That guard
    /// has to name every channel the workflow can dispatch, and nothing here can compile
    /// twice to prove it — so the two lists are pinned against each other directly.
    #[test]
    fn the_compile_time_channel_guard_admits_every_dispatchable_channel() {
        let guard = include_str!("../build.rs");
        for channel in ["stable", "edge", "dev"] {
            assert!(
                guard.contains(&format!("channel != \"{channel}\"")),
                "build.rs rejects PODIUM_DESKTOP_RELEASE_CHANNEL={channel}, \
                 so a {channel} promotion could not compile"
            );
        }
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
    fn wait_for_local_server_times_out_on_a_closed_port() {
        // A port nothing is listening on returns false quickly.
        assert!(!wait_for_local_server(1, 2, 10));
    }

    #[test]
    fn a_squatter_on_the_port_is_not_treated_as_our_server() {
        // The whole point of the identity check: something IS listening and answering 200,
        // and the shell must still refuse to load its origin — that origin would receive
        // window controls, the opener, sql:allow-execute and the update bridge.
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind a scratch port");
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            use std::io::{Read, Write};
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            let mut scratch = [0u8; 512];
            let _ = stream.read(&mut scratch);
            let body = "{\"hello\":\"not podium\"}";
            let _ = stream.write_all(
                format!(
                    "HTTP/1.0 200 OK\r\nContent-Length: {}\r\n\r\n{body}",
                    body.len()
                )
                .as_bytes(),
            );
        });
        assert!(!probe_local_server_as(port, "default"));
        server.join().expect("scratch listener thread");
    }

    #[test]
    fn version_payload_identity_accepts_only_this_instances_podium() {
        let podium = |instance: &str| {
            format!(
                "{{\"wireVersion\":7,\"minSupportedVersion\":5,\"wireSchemaDigest\":\"abc\",\"appVersion\":\"0.1.1\",\"instanceId\":\"{instance}\",\"feedScoping\":\"device-scoped\"}}"
            )
        };
        assert!(is_podium_version_payload(&podium("default"), "default"));
        assert!(is_podium_version_payload(&podium("work"), "work"));
        // A DIFFERENT instance's Podium is the wrong server for this shell's data.
        assert!(!is_podium_version_payload(&podium("work"), "default"));
        // Shape alone is the gate for a server too old to report its instance.
        assert!(is_podium_version_payload(
            "{\"wireVersion\":7,\"wireSchemaDigest\":\"abc\"}",
            "default"
        ));
        // Anything that is not a Podium /version answer.
        assert!(!is_podium_version_payload("{\"hello\":\"not podium\"}", "default"));
        assert!(!is_podium_version_payload("ok", "default"));
        assert!(!is_podium_version_payload("", "default"));
        // Chunk framing around a single small chunk still yields the object.
        assert!(is_podium_version_payload(
            "2a\r\n{\"wireVersion\":7,\"wireSchemaDigest\":\"abc\"}\r\n0\r\n\r\n",
            "default"
        ));
    }

    #[test]
    fn payload_home_is_inside_the_platform_application_data_dir() {
        let app_data = Path::new("/Application Support/app.podium.desktop");
        assert_eq!(payload_home(app_data), app_data.join("payload"));
    }

    #[test]
    fn seed_payload_copies_the_complete_bundle_once_and_never_overwrites() {
        use std::fs;
        let tmp = std::env::temp_dir().join(format!("podium-payload-seed-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let seed = tmp.join("resource");
        let install = tmp.join("application-support/payload");
        fs::create_dir_all(seed.join("web")).unwrap();
        fs::write(seed.join("podium"), b"#!/bin/sh\n").unwrap();
        fs::write(seed.join("podium-cli"), b"seed-binary").unwrap();
        fs::write(seed.join("VERSION"), b"0.4.2\n").unwrap();
        fs::write(seed.join("web/index.html"), b"seed-web").unwrap();

        assert!(seed_payload_if_absent(&seed, &install).unwrap());
        assert_eq!(fs::read(install.join("podium-cli")).unwrap(), b"seed-binary");
        assert_eq!(fs::read(install.join("web/index.html")).unwrap(), b"seed-web");

        fs::write(seed.join("podium-cli"), b"new-shell-seed").unwrap();
        assert!(!seed_payload_if_absent(&seed, &install).unwrap());
        assert_eq!(
            fs::read(install.join("podium-cli")).unwrap(),
            b"seed-binary",
            "a later shell must never overwrite the fleet-owned payload"
        );
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn an_existing_broken_payload_is_not_health_judged_or_reseeded() {
        use std::fs;
        let tmp = std::env::temp_dir().join(format!("podium-payload-broken-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let seed = tmp.join("resource");
        let install = tmp.join("application-support/payload");
        fs::create_dir_all(&seed).unwrap();
        fs::write(seed.join("podium"), b"seed").unwrap();
        fs::create_dir_all(&install).unwrap();

        assert!(!seed_payload_if_absent(&seed, &install).unwrap());
        assert!(fs::read_dir(&install).unwrap().next().is_none());
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn ensure_executable_only_touches_the_external_entrypoint() {
        use std::fs;
        let tmp = std::env::temp_dir().join(format!("podium-payload-exec-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let executable = tmp.join("podium");
        fs::write(&executable, b"#!/bin/sh\n").unwrap();
        assert_eq!(ensure_executable(&executable).unwrap(), executable);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_ne!(fs::metadata(&executable).unwrap().permissions().mode() & 0o111, 0);
        }
        let _ = fs::remove_dir_all(&tmp);
    }

}
