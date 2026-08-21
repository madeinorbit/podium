#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
// The bin target is named `Podium` so the Dock tile under `tauri dev` reads the
// product name (see Cargo.toml). rustc derives the crate name from the target
// name and warns that it is not snake case — the warning is about a spelling we
// chose deliberately, and the crate name is not something call sites ever write.
#![allow(non_snake_case)]

mod bootstrap;
mod logging;
mod updater;

use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::menu::{Menu, MenuItem};
#[cfg(target_os = "macos")]
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::path::BaseDirectory;
use tauri::tray::TrayIconBuilder;
#[cfg(target_os = "macos")]
use tauri::window::{Effect, EffectState, EffectsBuilder};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};
use updater::{check_update, claim_update_ownership, install_update, set_update_channel};

const DESKTOP_SUPERVISED_ENV: &str = "PODIUM_DESKTOP_SUPERVISED";
const PODIUM_CLI_PATH_ENV: &str = "PODIUM_CLI_PATH";
/// This shell's own PID, handed to every backend we spawn so the backend can tie its
/// lifetime to ours (POD-1228). The reap below only runs on a deliberate quit — a GUI
/// crash, a SIGKILL, or a plain SIGTERM executes none of our exit code at all, and the
/// sidecar is simply reparented and keeps holding the fixed hook-ingest port. Nothing we
/// can put in an exit handler covers "the exit handler never ran", so the backend polls
/// for our death instead (packages/runtime/src/supervisor.ts).
const SUPERVISOR_PID_ENV: &str = "PODIUM_SUPERVISOR_PID";
const NATIVE_WINDOW_PERMISSIONS: &[&str] = &[
    "core:window:allow-start-dragging",
    "core:window:allow-internal-toggle-maximize",
    "core:window:allow-toggle-maximize",
    "core:window:allow-minimize",
    "core:window:allow-close",
    "core:window:allow-set-theme",
    "allow-claim-update-ownership",
    "allow-check-update",
    "allow-install-update",
    "allow-set-update-channel",
    "process:allow-restart",
];

fn local_host_sidecar_command(
    runnable: &Path,
    sidecar_args: &[String],
    port: u16,
    web_dir: &Path,
    mobile_web_dir: &Path,
) -> Command {
    let mut command = Command::new(runnable);
    command
        .args(sidecar_args)
        // The daemon makes this exact signed CLI authoritative for every managed session.
        // It remains inside the app bundle on macOS. [spec:SP-d6e8]
        .env(PODIUM_CLI_PATH_ENV, runnable)
        .env("PODIUM_PORT", port.to_string())
        .env("PODIUM_WEB_DIR", web_dir.to_string_lossy().to_string())
        .env(
            "PODIUM_MOBILE_WEB_DIR",
            mobile_web_dir.to_string_lossy().to_string(),
        )
        .env(DESKTOP_SUPERVISED_ENV, "1")
        .env(SUPERVISOR_PID_ENV, std::process::id().to_string());
    command
}

fn replacement_daemon_command(runnable: &Path, server_url: &str) -> Command {
    let mut command = Command::new(runnable);
    command
        .args(["daemon", "--server", server_url, "--takeover"])
        .env(PODIUM_CLI_PATH_ENV, runnable)
        .env(DESKTOP_SUPERVISED_ENV, "1")
        .env(SUPERVISOR_PID_ENV, std::process::id().to_string());
    command
}

fn native_window_capability(
    identifier: &str,
    remote_pattern: Option<String>,
) -> tauri::ipc::CapabilityBuilder {
    let mut capability = tauri::ipc::CapabilityBuilder::new(identifier).window("main");
    for permission in NATIVE_WINDOW_PERMISSIONS {
        capability = capability.permission(*permission);
    }
    if let Some(pattern) = remote_pattern {
        capability = capability.remote(pattern);
    }
    capability
}

fn retarget_session_cookie(
    app: &AppHandle,
    source_url: &Url,
    server_url: &str,
) -> Result<bool, String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window is unavailable".to_string())?;
    let cookies = window
        .cookies_for_url(source_url.clone())
        .map_err(|error| format!("cannot read local session cookie: {error}"))?;
    let Some(source_cookie) = cookies
        .into_iter()
        .find(|cookie| cookie.name() == "podium_session")
    else {
        return Ok(false);
    };
    let target_cookie = bootstrap::session_cookie_for_target(source_cookie.value(), server_url)?;
    window
        .set_cookie(target_cookie)
        .map_err(|error| format!("cannot set transferred session cookie: {error}"))?;
    Ok(true)
}

fn retarget_existing_window(
    app: &AppHandle,
    source_url: &Url,
    server_url: &str,
) -> Result<(), String> {
    match retarget_session_cookie(app, source_url, server_url)? {
        true => {
            log::info!("copied podium_session in memory for transferred origin")
        }
        false => log::info!("no local podium_session cookie to transfer"),
    }
    grant_transfer_remote_capabilities(app, server_url)?;
    let target = Url::parse(&bootstrap::webview_http_url(server_url))
        .map_err(|error| format!("invalid transfer target: {error}"))?;
    app.get_webview_window("main")
        .ok_or_else(|| "main window is unavailable".to_string())?
        .navigate(target)
        .map_err(|error| format!("cannot navigate transferred window: {error}"))?;
    log::info!("existing window retargeted to transferred origin");
    Ok(())
}

/// How often a LOCAL window re-checks that the server it is loaded from is still there.
const LOCAL_DOCUMENT_POLL: std::time::Duration = std::time::Duration::from_secs(1);

/// Keep a local (all-in-one / server) window on a document that can actually render.
///
/// The boot probe answers one question — "was the sidecar up when we opened the window" — and
/// the acceptance case is the other one: kill the server while the app is RUNNING and the
/// webview is parked on a dead origin, where a reload gets the webview engine's own network
/// error page instead of Podium's reconnect UX. So the shell keeps watching and MOVES the
/// window: to the baked dist after a sustained outage, and back to the served origin once the
/// server returns — the convergent direction, because the served UI is the one that matches
/// the server.
///
/// Two rules keep this from being a footgun:
///
/// - It only ever moves the window between THIS shell's own two documents. The moment the
///   window is on anything else it stops: a runtime transfer retargets it to a REMOTE origin,
///   which is not ours to move.
/// - The liveness poll is cheap (`/health`), but RETURNING to the served origin requires the
///   identity-checked probe, because that is a decision to LOAD a page from that origin.
fn spawn_local_document_watchdog(app: AppHandle, port: u16, shutting_down: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        let (Ok(served), Ok(baked)) = (
            Url::parse(&bootstrap::local_served_http_url(port)),
            Url::parse(bootstrap::baked_document_url()),
        ) else {
            log::warn!("local document watchdog not started: unparseable document URL");
            return;
        };
        let mut watch = bootstrap::ServedOriginWatch::default();
        let mut window_seen = false;
        loop {
            std::thread::sleep(LOCAL_DOCUMENT_POLL);
            if shutting_down.load(Ordering::Acquire) {
                return;
            }
            let Some(window) = app.get_webview_window("main") else {
                // Before the build: keep waiting. After it: the window is gone for good.
                if window_seen {
                    return;
                }
                continue;
            };
            window_seen = true;
            let Ok(current) = window.url() else { continue };
            let Some(showing) = bootstrap::document_shown(&current, port) else {
                log::info!("local document watchdog stopping: window is on {current}");
                return;
            };
            let healthy = match showing {
                bootstrap::LocalDocument::Served => bootstrap::local_server_alive(port),
                bootstrap::LocalDocument::Baked => bootstrap::probe_local_server(port),
            };
            let Some(target) = watch.observe(showing, healthy) else {
                continue;
            };
            let (url, label) = match target {
                bootstrap::LocalDocument::Baked => (baked.clone(), "baked dist fallback"),
                bootstrap::LocalDocument::Served => (served.clone(), "local server"),
            };
            log::info!("local server is {healthy}; moving the window to the {label}");
            if let Err(error) = window.navigate(url) {
                log::warn!("could not move the window to the {label}: {error}");
            }
        }
    });
}

/// How often supervision checks whether the backend child is still alive. Cheap enough to be
/// invisible and far below the 500ms floor of the respawn backoff, so it costs no reaction time.
const SUPERVISION_POLL: std::time::Duration = std::time::Duration::from_millis(200);

/// How long a reaped backend gets to exit on SIGTERM before we SIGKILL it. The backend's own
/// shutdown is a log drain and a pidfile removal — sub-second work — and this budget sits on the
/// quit path a human is watching, so it is deliberately short.
#[cfg(unix)]
const REAP_GRACE: std::time::Duration = std::time::Duration::from_millis(1500);
#[cfg(unix)]
const REAP_POLL: std::time::Duration = std::time::Duration::from_millis(50);

/// Ask the backend to exit, and make sure it does.
///
/// `Child::kill` is SIGKILL, which is the wrong first move for a process that owns a pidfile and a
/// log sink: killed outright it leaves a live-looking run-registry record behind, and the NEXT
/// launch has to decide whether that record's PID is a real holder or a recycled one. SIGTERM
/// first lets the backend remove its own record and drain its logs; SIGKILL stays as the backstop
/// for a backend that will not go, so quitting can never hang on it.
///
/// Unix only for the signal — `std::process` has no portable "terminate politely", and a raw
/// `kill(2)` declaration is cheaper than a `libc` dependency for one call. Elsewhere (and if the
/// grace runs out) this is exactly the old behavior.
fn reap_backend(child: &mut std::process::Child) {
    #[cfg(unix)]
    {
        // SIGTERM. Declared here rather than pulled in via `libc`: this is the crate's only FFI,
        // and the signature (`int kill(pid_t, int)`, `pid_t` = i32) is fixed by POSIX.
        unsafe extern "C" {
            fn kill(pid: i32, sig: i32) -> i32;
        }
        const SIGTERM: i32 = 15;
        let pid = child.id() as i32;
        if pid > 1 {
            unsafe {
                kill(pid, SIGTERM);
            }
            let deadline = std::time::Instant::now() + REAP_GRACE;
            while std::time::Instant::now() < deadline {
                match child.try_wait() {
                    // Exited on its own terms, or is already unwaitable — either way, done.
                    Ok(Some(_)) | Err(_) => return,
                    Ok(None) => std::thread::sleep(REAP_POLL),
                }
            }
            log::warn!("backend did not exit within the SIGTERM grace; killing");
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Wait for the supervised child to exit **without holding the child slot's lock while it runs**.
///
/// The lock is the hand-off between this thread and the quit path: `RunEvent::Exit` and
/// `WindowEvent::Destroyed` both lock the same slot, on the main thread, to take the child and
/// kill it. Blocking in `Child::wait()` under that lock holds it for the child's ENTIRE lifetime,
/// so ⌘Q deadlocked — the main thread waited for a lock released only by the child dying, and the
/// only thing that would have killed the child was the main thread. macOS force quits an app whose
/// main thread never returns from `terminate:`, which is what "the desktop app crashes on ⌘Q" was.
/// Polling `try_wait` costs one syscall every [`SUPERVISION_POLL`] and leaves the slot free
/// between checks.
///
/// Returns `None` when there is nothing left to supervise: the slot was emptied by a shutdown
/// handler, or shutdown began while waiting. `Some(status)` is the exit the caller must decide on
/// — `Some(None)` when the exit happened but its status could not be read.
fn await_child_exit(
    child_state: &Arc<Mutex<Option<std::process::Child>>>,
    shutting_down: &Arc<AtomicBool>,
    poll: std::time::Duration,
) -> Option<Option<std::process::ExitStatus>> {
    loop {
        {
            let mut guard = child_state.lock().unwrap();
            match guard.as_mut() {
                Some(child) => match child.try_wait() {
                    Ok(Some(status)) => return Some(Some(status)),
                    Ok(None) => {}
                    Err(error) => {
                        log::warn!("cannot poll the supervised backend: {error}");
                        return Some(None);
                    }
                },
                None => return None,
            }
        }
        if shutting_down.load(Ordering::Acquire) {
            return None;
        }
        std::thread::sleep(poll);
    }
}

/// Supervise the backend child. Ordinary exits retain the existing bounded-backoff respawn;
/// only a durable, matching server-transfer transition retargets the existing webview and
/// switches supervision to an explicit daemon child.
fn spawn_respawn_monitor<F, S, D>(
    child_state: Arc<Mutex<Option<std::process::Child>>>,
    shutting_down: Arc<AtomicBool>,
    app_handle: AppHandle,
    source_cookie_url: Option<Url>,
    spawn_fn: F,
    spawn_daemon_fn: S,
    exit_decision: D,
    label: String,
) where
    F: Fn() -> std::io::Result<std::process::Child> + Send + 'static,
    S: Fn(&str) -> std::io::Result<std::process::Child> + Send + 'static,
    D: Fn() -> bootstrap::BackendExitDecision + Send + 'static,
{
    std::thread::spawn(move || {
        let mut backoff_ms: u64 = 500;
        let mut transferred_server_url: Option<String> = None;
        const BACKOFF_CAP_MS: u64 = 5_000;

        loop {
            let Some(exited) = await_child_exit(&child_state, &shutting_down, SUPERVISION_POLL)
            else {
                break;
            };

            if shutting_down.load(Ordering::Acquire) {
                break;
            }

            let decision = if transferred_server_url.is_some() {
                bootstrap::BackendExitDecision::Respawn
            } else {
                exit_decision()
            };
            let intentional_transfer = match decision {
                bootstrap::BackendExitDecision::Respawn => false,
                bootstrap::BackendExitDecision::Retarget {
                    transfer_id,
                    server_url,
                } => {
                    log::info!(
                        "transfer {transfer_id} committed; retargeting shell to {server_url}"
                    );
                    let result = source_cookie_url
                        .as_ref()
                        .ok_or_else(|| "source cookie origin is unavailable".to_string())
                        .and_then(|source_url| {
                            retarget_existing_window(&app_handle, source_url, &server_url)
                        });
                    if let Err(error) = result {
                        log::error!("committed transfer retarget failed: {error}");
                        let _ = child_state.lock().map(|mut child| child.take());
                        break;
                    }
                    transferred_server_url = Some(server_url);
                    true
                }
                bootstrap::BackendExitDecision::Hold { reason } => {
                    log::warn!(
                        "backend exited during an unproven role transition; not respawning: {reason}"
                    );
                    let _ = child_state.lock().map(|mut child| child.take());
                    break;
                }
            };

            if !intentional_transfer {
                log::warn!(
                    "backend exited ({exited:?}); \
                     respawning in {backoff_ms}ms {label}"
                );
                std::thread::sleep(std::time::Duration::from_millis(backoff_ms));
                backoff_ms = (backoff_ms * 2).min(BACKOFF_CAP_MS);
            }

            if shutting_down.load(Ordering::Acquire) {
                break;
            }

            let spawned = match transferred_server_url.as_deref() {
                Some(server_url) => spawn_daemon_fn(server_url),
                None => spawn_fn(),
            };
            match spawned {
                Ok(mut new_child) => {
                    // Shutdown can begin between the check above and this store. By then the
                    // exit handlers have already emptied the slot, so a child parked here now
                    // would outlive the app and keep holding its port. Re-check under the lock
                    // the handlers use, and reap rather than store.
                    let mut guard = child_state.lock().unwrap();
                    if shutting_down.load(Ordering::Acquire) {
                        reap_backend(&mut new_child);
                        break;
                    }
                    *guard = Some(new_child);
                    backoff_ms = 500;
                }
                Err(e) => log::error!("respawn failed: {e}"),
            }
        }
    });
}

/// Best-effort, log-only read of the spawned backend's `/version` (local all-in-one only).
/// Uses a raw `std::net` HTTP/1.0 GET — no HTTP-client dependency — with short timeouts.
/// Any failure is logged as a warning and never fatal: a single bundled artifact keeps the
/// shell and backend versions matched, so this is diagnostics, not a gate.
fn log_backend_version(port: u16) {
    match bootstrap::local_http_get(port, "/version", std::time::Duration::from_millis(500)) {
        Ok((status, body)) => log::info!("backend /version [{status}]: {}", body.trim()),
        Err(e) => log::warn!("could not read backend /version: {e}"),
    }
}

#[cfg(target_os = "macos")]
const DESKTOP_PLATFORM: &str = "macos";
#[cfg(target_os = "windows")]
const DESKTOP_PLATFORM: &str = "windows";
#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
const DESKTOP_PLATFORM: &str = "linux";

/// Eval a web-app menu hook if the page has registered it. Missing handlers are
/// a no-op: setup/onboarding has nothing to spawn, and an empty workspace must
/// not close the window.
fn eval_menu_hook(app: &tauri::AppHandle, hook: &str) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.eval(&format!("window.{hook} && window.{hook}();"));
    }
}

/// JS expression for `launchMode` in a LOCAL (all-in-one / server) shell.
///
/// The question this answers is "is the page in front of the user THIS shell's own UI, or a
/// remote server's?" — because a runtime transfer moves the existing window to a remote origin,
/// after which this device is a daemon and the update dialog must say so. Origin alone cannot
/// answer it any more: since POD-2510 the local UI is SERVED, so an all-in-one page is
/// `http://127.0.0.1:<port>` — exactly the http(s) shape that used to mean "remote".
///
/// So the shell emits the served-local origin it actually chose and the page compares against
/// that. `{served_origin_literal}` is that origin as a JS string literal (`null` if this shell
/// has no local server); `{launch_mode_literal}` is the resolved local mode.
///
/// Kept as a template constant rather than an inline `format!` so `tauri-conf.test.ts` can lift
/// it out of this source and EVALUATE it against simulated page locations — the defect it
/// replaces was a JS expression that read correctly and returned the wrong string.
const LOCAL_LAUNCH_MODE_EXPRESSION: &str = "((window.location.protocol === 'tauri:' || window.location.hostname === 'tauri.localhost' || window.location.origin === {served_origin_literal}) ? {launch_mode_literal} : 'daemon')";

fn native_desktop_hook(
    launch_mode: &str,
    machine_id: Option<&str>,
    current_version: &str,
    served_local_origin: Option<&str>,
) -> String {
    // [spec:SP-3701] The hosting toggle is exposed only in client mode — the one state where
    // this device is not already running a daemon. The command itself re-checks the mode.
    let enable_hosting = if launch_mode == "client" {
        ",\n            enableHosting: (pairCode) => window.__TAURI_INTERNALS__.invoke('enable_hosting', { pairCode })"
    } else {
        ""
    };
    // Desktop updates are available in every launch mode. The page may be remote or older
    // than this shell, so these methods are always present and are feature-detected by the page.
    let update_commands = ",\n            claimUpdateOwnership: () => window.__TAURI_INTERNALS__.invoke('claim_update_ownership'),\n            checkUpdate: (channel) => window.__TAURI_INTERNALS__.invoke('check_update', { channel }),\n            installUpdate: (channel, expectedVersion) => window.__TAURI_INTERNALS__.invoke('install_update', { channel, expectedVersion }),\n            setUpdateChannel: (channel) => window.__TAURI_INTERNALS__.invoke('set_update_channel', { channel })";
    // Hand a URL to the OS browser on purpose. The injected opener shim only rescues
    // CROSS-origin links (bootstrap::opener_shim_script); a page that wants the real browser
    // for one of the server's OWN URLs — "Open in browser" on a file — has no other route,
    // because the webview answers a same-origin `_blank` with an in-app window. Runs on the
    // opener:default grant the shim already uses ("external-link-opener" capability).
    let open_external = ",\n            openExternal: (url) => window.__TAURI_INTERNALS__.invoke('plugin:opener|open_url', { url })";
    // Native appearance sync (macOS vibrancy): the NSVisualEffectView behind the
    // transparent command bar renders with the WINDOW's NSAppearance, which follows
    // the OS — not the page's data-theme/.dark state. The page reports its resolved
    // theme here ('light' | 'dark' | null); null returns the window to following the
    // system. Passing null for mode=system is load-bearing: forcing an appearance
    // also flips the webview's prefers-color-scheme, which would lock system mode
    // to whatever was last forced.
    let set_theme = ",\n            setTheme: (theme) => window.__TAURI_INTERNALS__.invoke('plugin:window|set_theme', { label: 'main', value: theme })";
    // This device's paired machine identity (daemon.json), so the web UI can mark the
    // matching row "this machine". serde_json escaping — the value comes from disk.
    let machine_id = machine_id
        .and_then(|id| serde_json::to_string(id).ok())
        .map(|lit| format!(",\n            machineId: {lit}"))
        .unwrap_or_default();
    let launch_mode_literal =
        serde_json::to_string(launch_mode).unwrap_or_else(|_| "\"all-in-one\"".to_string());
    let current_version_literal =
        serde_json::to_string(current_version).unwrap_or_else(|_| "\"unknown\"".to_string());
    let launch_mode_expression = if matches!(launch_mode, "all-in-one" | "server") {
        let served_origin_literal = served_local_origin
            .and_then(|origin| serde_json::to_string(origin).ok())
            .unwrap_or_else(|| "null".to_string());
        LOCAL_LAUNCH_MODE_EXPRESSION
            .replace("{served_origin_literal}", &served_origin_literal)
            .replace("{launch_mode_literal}", &launch_mode_literal)
    } else {
        launch_mode_literal
    };
    format!(
        r#"window.__PODIUM_DESKTOP__ = Object.freeze({{
            platform: "{DESKTOP_PLATFORM}",
            currentVersion: {current_version_literal},
            launchMode: {launch_mode_expression}{machine_id},
            minimize: () => window.__TAURI_INTERNALS__.invoke('plugin:window|minimize', {{ label: 'main' }}),
            toggleMaximize: () => window.__TAURI_INTERNALS__.invoke('plugin:window|toggle_maximize', {{ label: 'main' }}),
            close: () => window.__TAURI_INTERNALS__.invoke('plugin:window|close', {{ label: 'main' }}){update_commands}{open_external}{set_theme}{enable_hosting}
        }});"#
    )
}

/// [spec:SP-3701] In-app "host sessions on this device": rewrite the local config from client
/// to daemon mode with a hub-minted pairing code. The web UI then triggers a shell restart
/// (__PODIUM_RESTART__) so `resolve_launch` picks up daemon mode and spawns the sidecar,
/// which pairs over its WebSocket handshake. All validation lives in
/// `bootstrap::write_hosting_config` — notably serverUrl is never accepted from the caller.
#[tauri::command]
fn enable_hosting(pair_code: String) -> Result<(), String> {
    bootstrap::write_hosting_config(&pair_code)
}

/// URLPattern for the origin the remote-mode window actually LOADS. The window is
/// pointed at the ws(s) relay URL mapped to http(s) (see `remote_window_target`), so
/// the capability pattern must be derived from that mapped URL — a raw `wss://…`
/// origin would never match the page's `https://…` origin and the grant would be dead.
fn remote_capability_pattern(server_url: &str) -> Result<String, String> {
    let url = tauri::Url::parse(&bootstrap::webview_http_url(server_url))
        .map_err(|error| error.to_string())?;
    Ok(format!("{}/*", url.origin().ascii_serialization()))
}

fn grant_transfer_remote_capabilities(app: &AppHandle, server_url: &str) -> Result<(), String> {
    let pattern = remote_capability_pattern(server_url)?;
    let window = native_window_capability("transfer-window-controls", Some(pattern.clone()));
    let opener = tauri::ipc::CapabilityBuilder::new("transfer-external-link-opener")
        .window("main")
        .remote(pattern.clone())
        .permission("opener:default");
    let sqlite = tauri::ipc::CapabilityBuilder::new("transfer-replica-sqlite")
        .window("main")
        .remote(pattern.clone())
        .permission("sql:default")
        .permission("sql:allow-execute");
    let updates = tauri::ipc::CapabilityBuilder::new("transfer-update-bridge")
        .window("main")
        .remote(pattern)
        .permission("allow-claim-update-ownership")
        .permission("allow-check-update")
        .permission("allow-install-update")
        // Same reason as the startup grant below: without listen/unlisten the
        // transferred origin can invoke the install but never hear it report.
        .permission("core:event:allow-listen")
        .permission("core:event:allow-unlisten");
    for capability in [window, opener, sqlite, updates] {
        app.add_capability(capability)
            .map_err(|error| format!("cannot grant transferred origin capability: {error}"))?;
    }
    Ok(())
}

fn main() {
    // FIRST STATEMENT IN THE PROCESS, and that placement is the point: the panic
    // hook installed here is what turns a panic during plugin registration or
    // window setup — the failures that leave a user with a shell that never
    // appeared — into a durable record instead of a line on a stderr nobody is
    // reading. `CARGO_PKG_VERSION` rather than `app.package_info()` because the
    // app does not exist yet; they are the same string.
    logging::init(env!("CARGO_PKG_VERSION"));
    let mut builder = tauri::Builder::default();
    // FIX 1: single-instance guard — if a 2nd instance is launched, focus the existing
    // window and exit the duplicate. Registered FIRST so it fires before any setup work.
    // Escape hatch: PODIUM_ALLOW_MULTI=1 skips the guard so a second app (e.g. a demo
    // instance pointed at a different server via PODIUM_STATE_DIR) can run alongside the
    // primary — the guard keys on the bundle identifier, so without this two copies of the
    // same build can never coexist.
    if std::env::var("PODIUM_ALLOW_MULTI").as_deref() != Ok("1") {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }));
    }
    let app = builder
        // Auto-updater stack: updater (check/download/install signed artifacts),
        // dialog (the prompt-then-restart confirmation), process (app.restart()).
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        // Opener: hands external URLs (agent login links from the terminal) to the OS
        // browser. The webview itself silently drops window.open/_blank navigations, so
        // an injected shim routes them here (see bootstrap::opener_shim_script).
        .plugin(tauri_plugin_opener::init())
        // SQL (sqlite): backs the web client's replica persistence (POD-789) —
        // TanStack DB's Tauri adapter opens sqlite:podium-replica.sqlite in the
        // app config dir. Granted to the main window (incl. remote-loaded
        // client/daemon modes) via the replica-sqlite capability below.
        .plugin(tauri_plugin_sql::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            enable_hosting,
            claim_update_ownership,
            check_update,
            install_update,
            set_update_channel
        ])
        .setup(|app| {
            // TEST AID: record the running app version so the e2e can deterministically
            // distinguish 0.1.0 from 0.1.1 across a self-replace+restart. Only writes when
            // PODIUM_STATE_DIR is set (the e2e sets it to a scratch dir); a no-op otherwise.
            if let Ok(state_dir) = std::env::var("PODIUM_STATE_DIR") {
                let version = app.package_info().version.to_string();
                let path = std::path::Path::new(&state_dir).join("running-version");
                let _ = std::fs::create_dir_all(&state_dir);
                if let Err(e) = std::fs::write(&path, &version) {
                    log::warn!("could not write running-version: {e}");
                } else {
                    log::info!("running version {version} (wrote {path:?})");
                }
            }

            // Decide what to launch from the persisted deployment mode. A missing/corrupt
            // config (or all-in-one / missing serverUrl) → today's local behavior; mode=server
            // spawns the server role only (#176).
            let cfg = bootstrap::read_config();
            bootstrap::initialize_update_channel(
                cfg.update_channel,
                bootstrap::build_update_channel(),
            )
            .map_err(|error| {
                log::error!("could not initialize desktop update channel: {error}");
                error
            })?;
            let action = bootstrap::resolve_launch(cfg.mode.as_deref(), cfg.server_url.as_deref());
            log::info!("launch action: {action:?}");
            // Resolved-mode tag exposed to the web UI (bridge.launchMode) and used to gate the
            // hosting toggle [spec:SP-3701].
            let launch_mode_tag = match &action {
                bootstrap::LaunchAction::LocalAllInOne => "all-in-one",
                bootstrap::LaunchAction::LocalServerOnly => "server",
                bootstrap::LaunchAction::LocalDaemon { .. } => "daemon",
                bootstrap::LaunchAction::ClientOnly { .. } => "client",
            };

            // FIX 2: shared shutting-down flag — set true in exit handlers so the supervision
            // monitor thread does not attempt to respawn the child during a deliberate quit.
            // (Always managed so the exit handlers have it, even in ClientOnly with no child.)
            let shutting_down = Arc::new(AtomicBool::new(false));
            app.manage(shutting_down.clone());

            let update_ownership: updater::UpdateOwnership = Arc::new(AtomicBool::new(false));
            app.manage(update_ownership.clone());
            app.manage(updater::PendingUpdate::default());

            // Child slot is always managed so the window-event / exit handlers can reap whatever
            // (if anything) we spawned. ClientOnly leaves it None.
            let child_state: Arc<Mutex<Option<std::process::Child>>> = Arc::new(Mutex::new(None));
            app.manage(child_state.clone());

            // Injection for remote modes (set below). Local modes decide injection after the
            // sidecar readiness probe — served-local vs baked fallback differ.
            let mut window_injection = String::new();
            // Whether to block on a local /health before opening the window (only local server).
            let wait_local_port: Option<u16>;
            // What the window LOADS. Local modes prefer the sidecar's http origin (UI matches
            // the server); baked `frontendDist` is only the offline / boot-race fallback.
            // Remote modes load the relay's own URL so the page is same-origin with it —
            // WKWebView's WebSocket from a tauri:// page to a remote TLS relay fails (1006).
            // Placeholder until the readiness probe (local) or remote_window_target (remote).
            let mut webview_url = WebviewUrl::default();
            // Origin that needs CapabilityBuilder::remote grants. Local served-local uses the
            // stable loopback URL; remote modes use the configured serverUrl.
            let remote_window_server_url: Option<String>;

            // mode=server (#176): the sidecar gets the explicit `server` subcommand so it runs
            // the SERVER role only — no local daemon/agents — and bypasses the CLI's
            // persistence-managed dispatch (which would start systemd units and exit, leaving
            // nothing on our resolved port to supervise).
            let server_only = action == bootstrap::LaunchAction::LocalServerOnly;
            let initial_action = action.clone();

            match action {
                bootstrap::LaunchAction::LocalAllInOne
                | bootstrap::LaunchAction::LocalServerOnly => {
                    // Shared local path: stable port (SW/cookie/IDB origin), spawn the sidecar,
                    // load the UI from that server when reachable.
                    // `--takeover`: the desktop SUPERVISES its sidecar — an orphan left by a
                    // force-killed desktop must be reclaimed, so it opts into the CLI's
                    // otherwise-refused displacement of a live same-role instance (#18).
                    let sidecar_args: Vec<String> = if server_only {
                        vec!["server".to_string(), "--takeover".to_string()]
                    } else {
                        vec!["--takeover".to_string()]
                    };
                    let port = bootstrap::resolve_local_port(&cfg);

                    // Resolve the bundled podium binary (plain resource, never patchelf'd).
                    let podium_res = app
                        .path()
                        .resolve("resources/podium", BaseDirectory::Resource)?;
                    // Bundled web resource dir the sidecar serves (external clients + this
                    // webview once it loads the server origin). Baked `frontendDist` stays in
                    // the .app as the offline fallback only.
                    let web_dir = app
                        .path()
                        .resolve("resources/web", BaseDirectory::Resource)?;
                    let mobile_web_dir = app
                        .path()
                        .resolve("resources/mobile", BaseDirectory::Resource)?;

                    // Ensure the binary is on a writable, executable filesystem.
                    // AppImage mounts are read-only; ensure_executable copies it to ~/.podium/bin/.
                    let runnable = bootstrap::ensure_executable(&podium_res).map_err(|e| {
                        log::error!("ensure_executable failed: {e}");
                        e
                    })?;

                    log::info!(
                        "spawning {runnable:?} {sidecar_args:?} on port {port}"
                    );

                    // Spawn the initial sidecar child process.
                    let child = local_host_sidecar_command(
                        &runnable,
                        &sidecar_args,
                        port,
                        &web_dir,
                        &mobile_web_dir,
                    )
                        .spawn()
                        .map_err(|e| {
                            log::error!("spawn failed: {e}");
                            e
                        })?;
                    *child_state.lock().unwrap() = Some(child);

                    // FIX 2: supervision monitor thread — waits on the child, and if it exits
                    // while the app is NOT shutting down, respawns it on the same port with
                    // bounded backoff (500ms → cap 5s). The web client auto-reconnects over WS.
                    let runnable2 = runnable.clone();
                    let runnable_daemon = runnable.clone();
                    let web_dir2 = web_dir.clone();
                    let mobile_web_dir2 = mobile_web_dir.clone();
                    let sidecar_args2 = sidecar_args.clone();
                    let transition_action = initial_action.clone();
                    let monitor_app = app.handle().clone();
                    let source_cookie_url = Url::parse(&bootstrap::local_served_http_url(port))
                        .expect("loopback desktop URL is valid");
                    spawn_respawn_monitor(
                        child_state.clone(),
                        shutting_down.clone(),
                        monitor_app,
                        Some(source_cookie_url),
                        move || {
                            local_host_sidecar_command(
                                &runnable2,
                                &sidecar_args2,
                                port,
                                &web_dir2,
                                &mobile_web_dir2,
                            )
                                .spawn()
                        },
                        move |server_url| {
                            replacement_daemon_command(&runnable_daemon, server_url).spawn()
                        },
                        move || bootstrap::backend_exit_decision(&transition_action),
                        format!("on port {port}"),
                    );

                    // Grant IPC to the served-local origin even before the readiness probe:
                    // when the sidecar is up we load it; grants for an unused origin are
                    // harmless if we fall back to baked.
                    wait_local_port = Some(port);
                    remote_window_server_url =
                        Some(bootstrap::local_served_http_url(port));
                }

                bootstrap::LaunchAction::LocalDaemon { server_url } => {
                    // Spawn the local `podium`; it reads config → daemon mode → connects to the
                    // remote server. There is NO local server, so do not force PODIUM_PORT and do
                    // not wait for a local /health — the web client connects to the remote.
                    let podium_res = app
                        .path()
                        .resolve("resources/podium", BaseDirectory::Resource)?;
                    let runnable = bootstrap::ensure_executable(&podium_res).map_err(|e| {
                        log::error!("ensure_executable failed: {e}");
                        e
                    })?;

                    log::info!("spawning daemon {runnable:?} → {server_url}");
                    let child = replacement_daemon_command(&runnable, &server_url)
                        .spawn()
                        .map_err(|e| {
                        log::error!("daemon spawn failed: {e}");
                        e
                    })?;
                    *child_state.lock().unwrap() = Some(child);

                    let runnable2 = runnable.clone();
                    let runnable_daemon = runnable.clone();
                    let respawn_server_url = server_url.clone();
                    spawn_respawn_monitor(
                        child_state.clone(),
                        shutting_down.clone(),
                        app.handle().clone(),
                        None,
                        move || replacement_daemon_command(&runnable2, &respawn_server_url).spawn(),
                        move |server_url| {
                            replacement_daemon_command(&runnable_daemon, server_url).spawn()
                        },
                        || bootstrap::BackendExitDecision::Respawn,
                        "(daemon)".to_string(),
                    );

                    remote_window_server_url = Some(server_url.clone());
                    (webview_url, window_injection) = bootstrap::remote_window_target(&server_url);
                    wait_local_port = None;
                }

                bootstrap::LaunchAction::ClientOnly { server_url } => {
                    // No backend, no monitor — just point the window at the remote server.
                    log::info!("client mode → {server_url} (no local backend)");
                    remote_window_server_url = Some(server_url.clone());
                    (webview_url, window_injection) = bootstrap::remote_window_target(&server_url);
                    wait_local_port = None;
                }
            }

            // One canonical list backs both startup and post-transfer remote grants so the
            // custom titlebar cannot lose drag/maximize permissions during retarget.
            let mut window_capability =
                native_window_capability("native-window-controls", None);
            // External-link opener for the injected shim (see bootstrap::opener_shim_script).
            // Runtime-granted next to the window-controls capability so remote-mode windows
            // (which load the relay origin directly) get it too.
            let mut opener_capability = tauri::ipc::CapabilityBuilder::new("external-link-opener")
                .window("main")
                .permission("opener:default");
            // [spec:SP-3701] The enable_hosting command is granted ONLY to a client-mode window
            // (the sole state where the toggle exists), scoped to the configured hub origin.
            let mut hosting_capability = (launch_mode_tag == "client").then(|| {
                tauri::ipc::CapabilityBuilder::new("enable-hosting")
                    .window("main")
                    .permission("allow-enable-hosting")
            });
            // Replica SQLite persistence (POD-789): the web client's TanStack DB
            // persistence adapter drives the SQL plugin. Client/daemon modes load
            // the app FROM THE HUB, so the grant must extend to that remote origin
            // (same precedent as the window-controls/opener/hosting grants; the hub
            // already serves all app JS and is fully trusted).
            let mut sqlite_capability = tauri::ipc::CapabilityBuilder::new("replica-sqlite")
                .window("main")
                .permission("sql:default")
                .permission("sql:allow-execute");
            // Update bridge (POD-1670): the in-app dialog drives check/install through
            // these commands. REMOTE MODE IS THE CASE THAT MATTERS — the shell loads the
            // remote server's own web bundle, so the page invoking them lives on that
            // origin and the grant must extend there, exactly as the window-controls,
            // opener, hosting and sqlite grants do. Granted only in the static
            // capability, a remote-mode shell could never update itself, which is the
            // scenario this bridge exists for.
            // LISTENING IS PART OF THE BRIDGE, not a separate nicety (POD-2150).
            // `install_update` reports its progress by emitting
            // `podium://update-progress`, and a page that may invoke the install
            // but may not subscribe to the event gets a spinner that never moves
            // — the exact silence the progress events were added to end. The
            // static `default.json` grants `core:default` (which includes
            // listen) but declares no remote block, so it covers the local
            // origin only; remote mode, where the page is served by the remote
            // server, needs it named here alongside the commands it belongs to.
            let mut update_capability = tauri::ipc::CapabilityBuilder::new("update-bridge")
                .window("main")
                .permission("allow-claim-update-ownership")
                .permission("allow-check-update")
                .permission("allow-install-update")
                .permission("core:event:allow-listen")
                .permission("core:event:allow-unlisten");
            if let Some(server_url) = remote_window_server_url {
                match remote_capability_pattern(&server_url) {
                    Ok(pattern) => {
                        window_capability = window_capability.remote(pattern.clone());
                        opener_capability = opener_capability.remote(pattern.clone());
                        sqlite_capability = sqlite_capability.remote(pattern.clone());
                        update_capability = update_capability.remote(pattern.clone());
                        hosting_capability = hosting_capability.map(|c| c.remote(pattern));
                    }
                    Err(error) => log::warn!(
                        "no remote window capability for invalid URL {server_url:?}: {error}"
                    ),
                }
            }
            app.add_capability(window_capability)?;
            app.add_capability(opener_capability)?;
            app.add_capability(sqlite_capability)?;
            app.add_capability(update_capability)?;
            if let Some(capability) = hosting_capability {
                app.add_capability(capability)?;
            }

            // macOS app menu: replaces Tauri's implicit default, whose File > Close
            // Window owns Cmd+W — the accelerator never reaches the webview, so a JS
            // keydown handler alone cannot repurpose it. Here Cmd+W is a custom
            // "Close Tab" item routed to the web app (see on_menu_event below). The
            // main window is not closable from this menu: Cmd+Q (Quit) is the only
            // keyboard exit. The Edit submenu must be rebuilt too: WKWebView
            // clipboard chords (Cmd+C/V/X/A) only work as menu accelerators.
            #[cfg(target_os = "macos")]
            {
                let about =
                    MenuItemBuilder::with_id("about-podium", "About Podium ADE").build(app)?;
                let check_updates =
                    MenuItemBuilder::with_id("check-updates", "Check for Updates…").build(app)?;
                // Cmd+, is where macOS keeps app preferences, and like Cmd+N/W below
                // the chord only exists if a menu item claims it — the webview never
                // sees it otherwise. It opens the web app's Settings sheet (an
                // overlay over the held shell, not a second window), so the ellipsis
                // is honest and matches the rest of this menu's grammar.
                let settings = MenuItemBuilder::with_id("open-settings", "Settings…")
                    .accelerator("CmdOrCtrl+,")
                    .build(app)?;
                // Hide/Quit carry the app name explicitly. Left to their defaults, the
                // predefined items title themselves from NSRunningApplication's
                // localizedName, which reads CFBundleDisplayName/CFBundleName — and
                // `tauri dev` runs the bare cargo binary with no .app bundle, so the
                // menu would say "Quit Podium" (the bin target name) even after the
                // bundle was renamed. The packaged bundle gets the product name from
                // tauri.conf.json's `bundle.macOS.bundleName` + the merged Info.plist;
                // explicit text is what makes dev show the same menu the bundle ships.
                // (This menu is hardcoded English throughout, so no localization is
                // lost.)
                let podium_menu = SubmenuBuilder::new(app, "Podium ADE")
                    .item(&about)
                    .item(&check_updates)
                    .separator()
                    .item(&settings)
                    .separator()
                    .services()
                    .separator()
                    .hide_with_text("Hide Podium ADE")
                    .hide_others()
                    .show_all()
                    .separator()
                    .quit_with_text("Quit Podium ADE")
                    .build()?;
                // Cmd+N, same reasoning as Cmd+W below: an unclaimed accelerator
                // never reaches the webview, so the only way the web app can own
                // the chord is to be handed it from here. It starts the sidebar's
                // default agent (see on_menu_event), and being a real menu item
                // is also how the shortcut becomes discoverable at all.
                let new_agent = MenuItemBuilder::with_id("new-agent", "New Agent")
                    .accelerator("CmdOrCtrl+N")
                    .build(app)?;
                let add_project = MenuItemBuilder::with_id("add-project", "Add Project…").build(app)?;
                let close_tab = MenuItemBuilder::with_id("close-tab", "Close Tab")
                    .accelerator("CmdOrCtrl+W")
                    .build(app)?;
                let file_menu = SubmenuBuilder::new(app, "File")
                    .item(&new_agent)
                    .item(&add_project)
                    .separator()
                    .item(&close_tab)
                    .build()?;
                let edit_menu = SubmenuBuilder::new(app, "Edit")
                    .undo()
                    .redo()
                    .separator()
                    .cut()
                    .copy()
                    .paste()
                    .select_all()
                    .build()?;
                let toggle_left = MenuItemBuilder::with_id("toggle-left-sidebar", "Toggle Left Sidebar")
                    .accelerator("Shift+CmdOrCtrl+B")
                    .build(app)?;
                let toggle_flight =
                    MenuItemBuilder::with_id("toggle-flight-deck", "Toggle Flight Deck")
                        .accelerator("Alt+CmdOrCtrl+F")
                        .build(app)?;
                let toggle_right =
                    MenuItemBuilder::with_id("toggle-right-sidebar", "Toggle Right Sidebar")
                        .accelerator("CmdOrCtrl+B")
                        .build(app)?;
                // Session-input commands use one mnemonic pair. Like Cmd+W/N above,
                // these must be real menu accelerators: WKWebView never receives a
                // chord claimed by the macOS application menu.
                let focus_session_prompt =
                    MenuItemBuilder::with_id("focus-session-prompt", "Focus Session Prompt")
                        .accelerator("CmdOrCtrl+L")
                        .build(app)?;
                let toggle_session_view =
                    MenuItemBuilder::with_id("toggle-session-view", "Toggle Chat / Native View")
                        .accelerator("Shift+CmdOrCtrl+L")
                        .build(app)?;
                let view_menu = SubmenuBuilder::new(app, "View")
                    .item(&focus_session_prompt)
                    .item(&toggle_session_view)
                    .separator()
                    .item(&toggle_left)
                    .item(&toggle_flight)
                    .item(&toggle_right)
                    .build()?;
                let window_menu = SubmenuBuilder::new(app, "Window")
                    .minimize()
                    .maximize()
                    .separator()
                    .fullscreen()
                    .build()?;
                let menu = MenuBuilder::new(app)
                    .items(&[&podium_menu, &file_menu, &edit_menu, &view_menu, &window_menu])
                    .build()?;
                app.set_menu(menu)?;
            }

            // Build the tray icon with Open / Quit menu items.
            // The debug-only runtime proof uses a minimal scratch X server with no icon theme.
            if !(cfg!(debug_assertions)
                && std::env::var("PODIUM_DESKTOP_RUNTIME_PROBE").as_deref() == Ok("1"))
            {
                let open = MenuItem::with_id(app, "open", "Open Podium ADE", true, None::<&str>)?;
                let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&open, &quit])?;
                let _tray = TrayIconBuilder::new()
                    .menu(&menu)
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "open" => {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                        "quit" => app.exit(0),
                        _ => {}
                    })
                    .build(app)?;
            }

            // Wait for the local backend (if any) to accept connections, then open the window.
            // Remote modes (daemon/client) skip the wait — the web client handles connect/retry.
            let handle = app.handle().clone();
            let update_ownership_for_window = update_ownership.clone();
            let updater_handle = app.handle().clone();
            let update_channel = cfg.update_channel;
            // The window also gets a restart hook so a setup mode-change can re-run the shell:
            // raw plugin invoke avoids adding a Tauri JS dependency to apps/web.
            let restart_hook = "window.__PODIUM_RESTART__ = () => \
                window.__TAURI_INTERNALS__.invoke('plugin:process|restart');";
            let machine_id = bootstrap::read_daemon_machine_id();
            // `package_info` reads the version stamped into tauri.conf.json by
            // stage-sidecar. Cargo.toml intentionally keeps the Rust crate at
            // 0.1.0, so CARGO_PKG_VERSION would erase edge/stable prerelease
            // detail and make a successful update look unchanged in Settings.
            let desktop_version = app.package_info().version.to_string();
            // The origin this shell serves its OWN UI from, when it has a local server. The
            // page compares `window.location.origin` against it to tell "my server" from a
            // server this window was transferred to — see LOCAL_LAUNCH_MODE_EXPRESSION.
            let served_local_origin = wait_local_port.map(bootstrap::local_served_http_url);
            let native_desktop_hook = native_desktop_hook(
                launch_mode_tag,
                machine_id.as_deref(),
                &desktop_version,
                served_local_origin.as_deref(),
            );
            // Panics from PREVIOUS runs, handed to the webview to post as crash
            // events (bootstrap::native_crash_report_script). Read here — once,
            // at window construction — because reading CLEARS the queue, and a
            // second reader would silently take records off the first one.
            let native_crash_report = bootstrap::native_crash_report_script(
                &logging::take_pending_crashes(),
                machine_id.as_deref(),
            );
            let opener_shim = bootstrap::opener_shim_script();
            // Remote modes already resolved webview_url + window_injection. Local modes
            // fill them after the readiness probe inside the spawn below.
            let remote_init_injection = window_injection;
            let watchdog_shutting_down = shutting_down.clone();
            std::thread::spawn(move || {
                let (resolved_url, resolved_injection) = if let Some(port) = wait_local_port {
                    // Native runtime proof seam: debug builds may force the scratch host
                    // origin so a tiny test server can set an HttpOnly cookie before the
                    // committed transition. It is not a Podium server, so it must skip the
                    // identity-checked readiness wait rather than time out against it.
                    // Production cannot enter this path.
                    if cfg!(debug_assertions)
                        && std::env::var("PODIUM_DESKTOP_RUNTIME_PROBE").as_deref() == Ok("1")
                    {
                        log::info!("runtime probe loading scratch host origin on port {port}");
                        (
                            WebviewUrl::External(
                                Url::parse(&bootstrap::local_served_http_url(port))
                                    .expect("runtime probe loopback URL is valid"),
                            ),
                            bootstrap::local_injection_script(port),
                        )
                    } else {
                        let ready = bootstrap::wait_for_local_server(port, 200, 150);
                        if ready {
                            // Log-only shell↔backend check: read the local backend's /version.
                            log_backend_version(port);
                            log::info!(
                                "loading UI from local server {}",
                                bootstrap::local_served_http_url(port)
                            );
                        } else {
                            log::warn!(
                                "no Podium server for this instance answered on port {port} within the timeout; loading baked dist fallback"
                            );
                        }
                        (
                            bootstrap::local_window_target(port, ready),
                            bootstrap::local_injection_script(port),
                        )
                    }
                } else {
                    (webview_url, remote_init_injection)
                };
                // External-link shim (ALL modes): route window.open/_blank to the OS browser.
                let init = format!(
                    "{resolved_injection}\n{restart_hook}\n{native_desktop_hook}\n{opener_shim}\n{native_crash_report}"
                );
                let handle2 = handle.clone();
                let _ = handle.run_on_main_thread(move || {
                    let window_builder = WebviewWindowBuilder::new(&handle2, "main", resolved_url)
                        .title("Podium ADE")
                        .inner_size(1200.0, 800.0)
                        .initialization_script(&init);

                    // [spec:SP-3834] Native desktop chrome replaces the separate OS title bar.
                    #[cfg(target_os = "macos")]
                    let window_builder = window_builder
                        // Sidebar is the visibly translucent chrome material (Finder,
                        // Notes). HeaderView — the semantic pick for a command bar —
                        // composites in dark mode to within ~3% luminance of the opaque
                        // bar it replaces (measured #232628 vs --bar #1b1d21), i.e. it
                        // reads as opaque. The web document makes only the 48px band
                        // transparent; the content row remains an opaque app surface.
                        .transparent(true)
                        .effects(
                            EffectsBuilder::new()
                                .effect(Effect::Sidebar)
                                .state(EffectState::FollowsWindowActiveState)
                                .build(),
                        )
                        .title_bar_style(tauri::TitleBarStyle::Overlay)
                        .hidden_title(true)
                        .traffic_light_position(tauri::LogicalPosition::new(14.0, 22.0));
                    #[cfg(not(target_os = "macos"))]
                    let window_builder = window_builder.decorations(false);

                    // Schedule the fallback independently of window construction: a page that
                    // never loads cannot claim ownership, and even a failed webview build must
                    // leave the shell with a native update path.
                    let update_started_at = std::time::Instant::now();
                    tauri::async_runtime::spawn(async move {
                        let _ = tauri::async_runtime::spawn_blocking(move || {
                            std::thread::sleep(std::time::Duration::from_millis(
                                crate::updater::OWNERSHIP_GRACE_MS + 1,
                            ));
                        })
                        .await;
                        let elapsed_ms = update_started_at
                            .elapsed()
                            .as_millis()
                            .min(u64::MAX as u128) as u64;
                        let native = crate::updater::should_show_native_dialog(
                            update_ownership_for_window.load(Ordering::Acquire),
                            elapsed_ms,
                            crate::updater::OWNERSHIP_GRACE_MS,
                        );
                        // TEST AID, same discipline as `running-version` above: record
                        // WHICH update path this boot took, in the state dir rather than
                        // the log, because under --appimage-extract-and-run AppRun
                        // redirects stdout and the log is routinely empty on a healthy
                        // boot. verify-update.sh's two arms both drive the NATIVE path,
                        // and the page claiming ownership within the grace window is a
                        // legitimate outcome that silently turns both of them into
                        // assertions about nothing. An arm that cannot see which branch
                        // ran cannot say NO, so it writes the branch down.
                        if let Ok(state_dir) = std::env::var("PODIUM_STATE_DIR") {
                            let path =
                                std::path::Path::new(&state_dir).join("update-ownership");
                            let _ = std::fs::create_dir_all(&state_dir);
                            let _ = std::fs::write(path, if native { "native" } else { "page" });
                        }
                        if native {
                            crate::updater::check_and_prompt_update(
                                updater_handle,
                                update_channel,
                            )
                            .await;
                        }
                    });

                    if let Err(error) = window_builder.build() {
                        log::error!("window build failed: {error}");
                    }
                });
                // Local modes only: keep the window on a document that renders when the local
                // server comes and goes (see spawn_local_document_watchdog). Remote modes have
                // no local server to watch, and the web client owns their reconnect.
                if let Some(port) = wait_local_port {
                    spawn_local_document_watchdog(handle, port, watchdog_shutting_down);
                }
            });
            Ok(())
        })
        .on_menu_event(|app, event| match event.id.as_ref() {
            // Cmd+N (macOS app menu). The web app registers __PODIUM_NEW_AGENT__
            // from the work sidebar's spawn row; it starts the same default agent
            // in the same default repo as the "New <Agent> in <Repo>" button and
            // navigates to the fresh session. Nothing to do if the sidebar is not
            // up (setup/onboarding) — there is no default to spawn yet.
            "new-agent" => eval_menu_hook(app, "__PODIUM_NEW_AGENT__"),
            "add-project" => eval_menu_hook(app, "__PODIUM_ADD_PROJECT__"),
            "about-podium" => eval_menu_hook(app, "__PODIUM_ABOUT__"),
            "check-updates" => eval_menu_hook(app, "__PODIUM_CHECK_UPDATES__"),
            "open-settings" => eval_menu_hook(app, "__PODIUM_SETTINGS__"),
            "focus-session-prompt" => eval_menu_hook(app, "__PODIUM_FOCUS_SESSION_PROMPT__"),
            "toggle-session-view" => eval_menu_hook(app, "__PODIUM_TOGGLE_SESSION_VIEW__"),
            "toggle-left-sidebar" => eval_menu_hook(app, "__PODIUM_TOGGLE_LEFT_SIDEBAR__"),
            "toggle-flight-deck" => eval_menu_hook(app, "__PODIUM_TOGGLE_FLIGHT_DECK__"),
            "toggle-right-sidebar" => eval_menu_hook(app, "__PODIUM_TOGGLE_RIGHT_SIDEBAR__"),
            // Cmd+W (macOS app menu). The web app registers __PODIUM_CLOSE_TAB__
            // and closes a tab on the selected issue while any remain. An empty
            // workspace is a no-op — the main window is not closable from here.
            "close-tab" => eval_menu_hook(app, "__PODIUM_CLOSE_TAB__"),
            _ => {}
        })
        .on_window_event(|window, event| {
            match event {
                // FIX 3: hide-on-close so the tray "Open Podium ADE" is meaningful. Intercept
                // the close button → hide the window instead of destroying it. The tray
                // "Quit" item calls app.exit(0) which is the real exit path.
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = window.hide();
                }
                tauri::WindowEvent::Destroyed => {
                    // Reap the child when the window is actually destroyed (e.g. app.exit).
                    let app = window.app_handle();
                    if let Some(sd) = app.try_state::<Arc<AtomicBool>>() {
                        sd.store(true, Ordering::Release);
                    }
                    if let Some(state) = app.try_state::<Arc<Mutex<Option<std::process::Child>>>>() {
                        if let Ok(mut guard) = state.lock() {
                            if let Some(mut child) = guard.take() {
                                reap_backend(&mut child);
                            }
                        }
                    }
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Podium");

    app.run(|app_handle, event| {
        // Dock-icon click with the window hidden (hide-on-close): reshow it, matching
        // normal macOS app behavior — previously only the tray "Open Podium ADE" could.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = event {
            if let Some(w) = app_handle.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }
        if let tauri::RunEvent::Exit = event {
            // Set the shutting-down flag first so the monitor thread stops respawning.
            if let Some(sd) = app_handle.try_state::<Arc<AtomicBool>>() {
                sd.store(true, Ordering::Release);
            }
            if let Some(state) = app_handle.try_state::<Arc<Mutex<Option<std::process::Child>>>>() {
                if let Ok(mut guard) = state.lock() {
                    if let Some(mut child) = guard.take() {
                        reap_backend(&mut child);
                    }
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::ipc::RuntimeCapability;

    fn command_env(command: &Command, key: &str) -> Option<String> {
        command
            .get_envs()
            .find(|(name, _)| *name == key)
            .and_then(|(_, value)| value)
            .map(|value| value.to_string_lossy().into_owned())
    }

    /// ⌘Q. Supervision must leave the child slot lockable while the backend is alive, because
    /// the quit path reaps the child from the MAIN thread — and a main thread that never gets
    /// the lock never returns from `terminate:`, which macOS force quits as a crash.
    ///
    /// The assertion is `try_lock` against a deadline rather than a plain `lock()`: a regression
    /// must fail this test, not hang it.
    #[test]
    fn the_quit_path_can_reap_the_backend_while_supervision_waits() {
        use std::time::{Duration, Instant};

        // Outlives the test by far, so the child is unambiguously still running when the quit
        // path goes for the lock. The test kills it; only a failure leaks it, and only briefly.
        let child = Command::new("sleep")
            .arg("30")
            .spawn()
            .expect("spawn a long-lived stand-in for the backend");
        let child_state = Arc::new(Mutex::new(Some(child)));
        let shutting_down = Arc::new(AtomicBool::new(false));

        let supervised = child_state.clone();
        let flag = shutting_down.clone();
        let supervision = std::thread::spawn(move || {
            await_child_exit(&supervised, &flag, Duration::from_millis(5))
        });

        // Give supervision time to settle into its wait before contending for the lock.
        std::thread::sleep(Duration::from_millis(50));

        // What RunEvent::Exit does, in its order.
        shutting_down.store(true, Ordering::Release);
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut guard = loop {
            match child_state.try_lock() {
                Ok(guard) => break guard,
                Err(_) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(5)),
                Err(_) => panic!(
                    "the child slot stayed locked while the backend ran: ⌘Q would deadlock the \
                     main thread"
                ),
            }
        };
        let mut child = guard.take().expect("the quit path finds the child to reap");
        reap_backend(&mut child);
        drop(guard);

        assert!(
            supervision.join().expect("supervision thread").is_none(),
            "an emptied slot means shutdown reaped the child; supervision must stop, not respawn"
        );
    }

    /// The other half: an exit supervision itself observes still comes back as an exit, so the
    /// respawn path is intact and the ⌘Q fix did not turn a crashed backend into a silent one.
    #[test]
    fn a_backend_that_exits_on_its_own_is_reported_to_supervision() {
        use std::time::Duration;

        let child = Command::new("true")
            .spawn()
            .expect("spawn an immediate exit");
        let child_state = Arc::new(Mutex::new(Some(child)));
        let shutting_down = Arc::new(AtomicBool::new(false));

        let exited = await_child_exit(&child_state, &shutting_down, Duration::from_millis(5))
            .expect("a live slot reports the exit rather than ending supervision");
        assert!(
            exited.expect("exit status is readable").success(),
            "`true` exits 0"
        );
    }

    #[test]
    fn every_daemon_the_desktop_starts_is_marked_supervised() {
        let host = local_host_sidecar_command(
            Path::new("podium"),
            &["--takeover".to_string()],
            18787,
            Path::new("web"),
            Path::new("mobile"),
        );
        let daemon = replacement_daemon_command(Path::new("podium"), "wss://new.example");

        for (label, command) in [
            ("local host sidecar", &host),
            ("replacement daemon", &daemon),
        ] {
            assert_eq!(
                command_env(command, DESKTOP_SUPERVISED_ENV).as_deref(),
                Some("1"),
                "{label} must announce that the desktop app supervises it"
            );
            assert_eq!(
                command_env(command, PODIUM_CLI_PATH_ENV).as_deref(),
                Some("podium"),
                "{label} must expose the exact bundled CLI to managed sessions"
            );
        }

        assert_eq!(
            command_env(&host, "PODIUM_MOBILE_WEB_DIR").as_deref(),
            Some("mobile"),
            "a native-hosted server must serve the bundled Expo web app"
        );
        assert_eq!(
            daemon
                .get_args()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect::<Vec<_>>(),
            ["daemon", "--server", "wss://new.example", "--takeover"]
        );
    }

    /// POD-1228. The reap below only runs when the shell exits through Tauri; a crash or a
    /// SIGKILL runs none of it and the backend is left holding its ports. Every backend we
    /// start therefore has to know which PID's death is its own cue to leave, so a missing
    /// variable on either spawn path is a silent return of the orphan.
    #[test]
    fn every_backend_the_desktop_starts_knows_whose_death_to_exit_on() {
        let host = local_host_sidecar_command(
            Path::new("podium"),
            &["--takeover".to_string()],
            18787,
            Path::new("web"),
            Path::new("mobile"),
        );
        let daemon = replacement_daemon_command(Path::new("podium"), "wss://new.example");
        let expected = std::process::id().to_string();

        for (label, command) in [
            ("local host sidecar", &host),
            ("replacement daemon", &daemon),
        ] {
            assert_eq!(
                command_env(command, SUPERVISOR_PID_ENV),
                Some(expected.clone()),
                "{label} must carry this shell's pid as the one to die with"
            );
        }
    }

    #[test]
    fn transferred_window_uses_the_full_canonical_permission_set() {
        assert_eq!(
            NATIVE_WINDOW_PERMISSIONS,
            [
                "core:window:allow-start-dragging",
                "core:window:allow-internal-toggle-maximize",
                "core:window:allow-toggle-maximize",
                "core:window:allow-minimize",
                "core:window:allow-close",
                "core:window:allow-set-theme",
                "allow-claim-update-ownership",
                "allow-check-update",
                "allow-install-update",
                "allow-set-update-channel",
                "process:allow-restart",
            ]
        );

        let built = native_window_capability(
            "transfer-window-controls-test",
            Some("https://new.example:55555/*".to_string()),
        )
        .build();
        // `CapabilityFile` itself is NOT `Serialize` (only the `Capability` it
        // wraps is), so the inner value is unwrapped before serializing. This
        // used to call `to_value` on the file and had not compiled since the
        // tauri bump that changed it — invisible because nothing ran this module
        // until POD-1906 gave it a lane.
        let tauri::utils::acl::capability::CapabilityFile::Capability(capability) = built else {
            panic!("a CapabilityBuilder must build to exactly one capability")
        };
        let capability = serde_json::to_value(capability).expect("capability should serialize");
        assert_eq!(capability["windows"], serde_json::json!(["main"]));
        assert_eq!(
            capability["remote"]["urls"],
            serde_json::json!(["https://new.example:55555/*"])
        );
        assert!(capability["permissions"]
            .as_array()
            .expect("permissions should be an array")
            .iter()
            .any(|permission| permission == "core:window:allow-internal-toggle-maximize"));
    }

    const TEST_DESKTOP_VERSION: &str = "0.1.0-edge.9";

    /// The loopback origin a local test shell serves its UI from.
    const TEST_SERVED_ORIGIN: &str = "http://127.0.0.1:18787";

    fn test_native_desktop_hook(launch_mode: &str, machine_id: Option<&str>) -> String {
        native_desktop_hook(
            launch_mode,
            machine_id,
            TEST_DESKTOP_VERSION,
            matches!(launch_mode, "all-in-one" | "server").then_some(TEST_SERVED_ORIGIN),
        )
    }

    #[test]
    fn native_hook_exposes_only_window_actions() {
        let hook = test_native_desktop_hook("all-in-one", None);
        assert!(hook.contains(&format!("platform: \"{DESKTOP_PLATFORM}\"")));
        assert!(hook.contains(&format!("currentVersion: \"{TEST_DESKTOP_VERSION}\"")));
        assert!(hook.contains("? \"all-in-one\" : 'daemon'"));
        assert!(hook.contains("plugin:window|minimize"));
        assert!(hook.contains("plugin:window|toggle_maximize"));
        assert!(hook.contains("plugin:window|close"));
        assert!(!hook.contains("plugin:process|restart"));
        // Hosting is inherent outside client mode — no toggle exposed.
        assert!(!hook.contains("enableHosting"));
        assert!(!hook.contains("machineId"));
    }

    #[test]
    fn native_hook_exposes_update_commands_in_every_launch_mode() {
        for mode in ["all-in-one", "server", "daemon", "client"] {
            let hook = test_native_desktop_hook(mode, None);
            assert!(hook.contains("claimUpdateOwnership"));
            assert!(hook.contains("checkUpdate: (channel)"));
            assert!(hook.contains("installUpdate: (channel, expectedVersion)"));
            assert!(hook.contains("invoke('install_update', { channel, expectedVersion })"));
            assert!(hook.contains("setUpdateChannel: (channel)"));
            assert!(hook.contains("invoke('set_update_channel', { channel })"));
        }
    }

    #[test]
    fn native_hook_opens_a_url_in_the_os_browser_in_every_launch_mode() {
        // The link shim skips same-origin URLs, so "Open in browser" on one of the server's
        // own files reaches the OS only through this method. Present in every mode — the page
        // decides when it needs it (it is same-origin with the server in the remote modes),
        // and it feature-detects, so a mode-dependent bridge would only create dead ends.
        for mode in ["all-in-one", "server", "daemon", "client"] {
            let hook = test_native_desktop_hook(mode, None);
            assert!(hook.contains("openExternal: (url) =>"));
            assert!(hook.contains("invoke('plugin:opener|open_url', { url })"));
        }
    }

    #[test]
    fn native_hook_syncs_native_appearance_in_every_launch_mode() {
        // The macOS vibrancy layer renders with the window's NSAppearance, not the
        // page's data-theme state; the page reports its resolved theme through this
        // method (null = follow the system). Present in every mode — feature-detected.
        for mode in ["all-in-one", "server", "daemon", "client"] {
            let hook = test_native_desktop_hook(mode, None);
            assert!(hook.contains("setTheme: (theme) =>"));
            assert!(
                hook.contains("invoke('plugin:window|set_theme', { label: 'main', value: theme })")
            );
        }
    }

    #[test]
    fn native_hook_exposes_hosting_toggle_only_in_client_mode() {
        // [spec:SP-3701]
        let client = test_native_desktop_hook("client", None);
        assert!(client.contains("launchMode: \"client\""));
        assert!(client.contains("enableHosting: (pairCode) =>"));
        assert!(client.contains("invoke('enable_hosting', { pairCode })"));
        for mode in ["daemon", "server", "all-in-one"] {
            assert!(!test_native_desktop_hook(mode, None).contains("enableHosting"));
        }
    }

    #[test]
    fn local_native_hook_keeps_served_local_local_and_reports_daemon_after_remote_retarget() {
        // The served-local origin is THIS shell's own UI: the update dialog must render the
        // single all-in-one row, not the two-row desktop-remote shape. A page transferred to a
        // remote server is the case 'daemon' exists for.
        for mode in ["all-in-one", "server"] {
            let hook = test_native_desktop_hook(mode, None);
            assert!(hook.contains("window.location.protocol === 'tauri:'"));
            assert!(
                hook.contains(&format!(
                    "window.location.origin === \"{TEST_SERVED_ORIGIN}\""
                )),
                "the served-local origin must be part of the classification: {hook}"
            );
            assert!(hook.contains(&format!("? \"{mode}\" : 'daemon'")));
        }
        assert!(test_native_desktop_hook("daemon", None).contains("launchMode: \"daemon\""));
    }

    #[test]
    fn local_native_hook_without_a_served_origin_still_classifies_the_baked_page() {
        // Belt and braces: a local shell that somehow has no served origin must emit a
        // comparison no page can match, never a bare `undefined` that throws on load.
        let hook = native_desktop_hook("all-in-one", None, TEST_DESKTOP_VERSION, None);
        assert!(hook.contains("window.location.origin === null"));
        assert!(hook.contains("window.location.protocol === 'tauri:'"));
    }

    #[test]
    fn native_hook_embeds_the_paired_machine_id_when_known() {
        // [spec:SP-3701] machineId lets the web UI mark "this machine" in the machines list.
        let hook = test_native_desktop_hook("client", Some("m-abc"));
        assert!(hook.contains("machineId: \"m-abc\""));
    }

    #[test]
    fn remote_capability_is_limited_to_the_configured_origin() {
        assert_eq!(
            remote_capability_pattern("https://podium.example:55555/workspace?view=active"),
            Ok("https://podium.example:55555/*".to_string())
        );
        assert!(remote_capability_pattern("not a URL").is_err());
    }

    #[test]
    fn remote_capability_pattern_uses_the_loaded_http_origin_for_ws_urls() {
        // config.serverUrl is commonly ws(s)://; the window loads the http(s) mapping
        // of it, so the capability must be granted to THAT origin.
        assert_eq!(
            remote_capability_pattern("wss://relay.example:55555"),
            Ok("https://relay.example:55555/*".to_string())
        );
        assert_eq!(
            remote_capability_pattern("ws://relay.example:18787"),
            Ok("http://relay.example:18787/*".to_string())
        );
    }
}
