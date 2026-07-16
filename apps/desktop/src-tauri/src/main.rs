#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bootstrap;
mod updater;

use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri::path::BaseDirectory;

/// FIX 2 (generalized): supervision monitor thread. Waits on the current child; if it exits
/// while the app is NOT shutting down, respawns it via `spawn_fn` with bounded backoff
/// (500ms → cap 5s). Works for both the all-in-one server and the daemon child.
fn spawn_respawn_monitor<F>(
    child_state: Arc<Mutex<Option<std::process::Child>>>,
    shutting_down: Arc<AtomicBool>,
    spawn_fn: F,
    label: String,
) where
    F: Fn() -> std::io::Result<std::process::Child> + Send + 'static,
{
    std::thread::spawn(move || {
        let mut backoff_ms: u64 = 500;
        const BACKOFF_CAP_MS: u64 = 5_000;

        loop {
            // Wait for the current child to exit.
            let exited = {
                let mut guard = child_state.lock().unwrap();
                if let Some(ref mut child) = *guard {
                    child.wait().ok()
                } else {
                    // Child was already reaped by the exit handler — stop monitoring.
                    break;
                }
            };

            if shutting_down.load(Ordering::Acquire) {
                break;
            }

            eprintln!(
                "[podium-desktop] backend exited ({exited:?}); \
                 respawning in {backoff_ms}ms {label}"
            );
            std::thread::sleep(std::time::Duration::from_millis(backoff_ms));
            backoff_ms = (backoff_ms * 2).min(BACKOFF_CAP_MS);

            if shutting_down.load(Ordering::Acquire) {
                break;
            }

            match spawn_fn() {
                Ok(new_child) => {
                    *child_state.lock().unwrap() = Some(new_child);
                    backoff_ms = 500; // reset on successful spawn
                }
                Err(e) => {
                    eprintln!("[podium-desktop] respawn failed: {e}");
                }
            }
        }
    });
}

/// Best-effort, log-only read of the spawned backend's `/version` (local all-in-one only).
/// Uses a raw `std::net` HTTP/1.0 GET — no HTTP-client dependency — with short timeouts.
/// Any failure is logged as a warning and never fatal: a single bundled artifact keeps the
/// shell and backend versions matched, so this is diagnostics, not a gate.
fn log_backend_version(port: u16) {
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::time::Duration;

    let read_version = || -> std::io::Result<String> {
        let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
        let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(500))?;
        stream.set_read_timeout(Some(Duration::from_millis(500)))?;
        stream.set_write_timeout(Some(Duration::from_millis(500)))?;
        stream.write_all(b"GET /version HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n")?;
        let mut response = String::new();
        stream.read_to_string(&mut response)?;
        Ok(response)
    };

    match read_version() {
        Ok(response) => {
            // Body is whatever follows the header/content blank line; log it verbatim.
            let body = response.split("\r\n\r\n").nth(1).unwrap_or("").trim();
            eprintln!("[podium-desktop] backend /version: {body}");
        }
        Err(e) => eprintln!("[podium-desktop] could not read backend /version: {e}"),
    }
}

fn main() {
    let app = tauri::Builder::default()
        // FIX 1: single-instance guard — if a 2nd instance is launched, focus the existing
        // window and exit the duplicate. Registered FIRST so it fires before any setup work.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        // Auto-updater stack: updater (check/download/install signed artifacts),
        // dialog (the prompt-then-restart confirmation), process (app.restart()).
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        // Opener: hands external URLs (agent login links from the terminal) to the OS
        // browser. The webview itself silently drops window.open/_blank navigations,
        // so the web UI invokes plugin:opener|open_url when it detects Tauri.
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // TEST AID: record the running app version so the e2e can deterministically
            // distinguish 0.1.0 from 0.1.1 across a self-replace+restart. Only writes when
            // PODIUM_STATE_DIR is set (the e2e sets it to a scratch dir); a no-op otherwise.
            if let Ok(state_dir) = std::env::var("PODIUM_STATE_DIR") {
                let version = app.package_info().version.to_string();
                let path = std::path::Path::new(&state_dir).join("running-version");
                let _ = std::fs::create_dir_all(&state_dir);
                if let Err(e) = std::fs::write(&path, &version) {
                    eprintln!("[podium-desktop] could not write running-version: {e}");
                } else {
                    eprintln!("[podium-desktop] running version {version} (wrote {path:?})");
                }
            }

            // Decide what to launch from the persisted deployment mode. A missing/corrupt
            // config (or all-in-one / missing serverUrl) → today's local behavior; mode=server
            // spawns the server role only (#176).
            let cfg = bootstrap::read_config();
            let action = bootstrap::resolve_launch(cfg.mode.as_deref(), cfg.server_url.as_deref());
            eprintln!("[podium-desktop] launch action: {action:?}");

            // FIX 2: shared shutting-down flag — set true in exit handlers so the supervision
            // monitor thread does not attempt to respawn the child during a deliberate quit.
            // (Always managed so the exit handlers have it, even in ClientOnly with no child.)
            let shutting_down = Arc::new(AtomicBool::new(false));
            app.manage(shutting_down.clone());

            // Child slot is always managed so the window-event / exit handlers can reap whatever
            // (if anything) we spawned. ClientOnly leaves it None.
            let child_state: Arc<Mutex<Option<std::process::Child>>> = Arc::new(Mutex::new(None));
            app.manage(child_state.clone());

            // The server URL the window will be pointed at. Local-all-in-one fills this with the
            // local ws URL once a port is picked; remote modes use the configured serverUrl.
            let window_injection: String;
            // Whether to block on a local /health before opening the window (only local server).
            let wait_local_port: Option<u16>;
            // What the window LOADS. All-in-one loads the bundled UI (tauri://localhost) and talks
            // to the local relay. Remote modes load the relay's own URL directly so the page is
            // same-origin with it — WKWebView's WebSocket from a tauri://localhost page to a remote
            // TLS relay fails (1006), but a same-origin load connects, exactly like a browser tab.
            let webview_url: WebviewUrl;

            // mode=server (#176): the sidecar gets the explicit `server` subcommand so it runs
            // the SERVER role only — no local daemon/agents — and bypasses the CLI's
            // persistence-managed dispatch (which would start systemd units and exit, leaving
            // nothing on our picked port to supervise).
            let server_only = action == bootstrap::LaunchAction::LocalServerOnly;

            match action {
                bootstrap::LaunchAction::LocalAllInOne
                | bootstrap::LaunchAction::LocalServerOnly => {
                    // Shared local path: pick a port, spawn the sidecar, point the window local.
                    // `--takeover`: the desktop SUPERVISES its sidecar — an orphan left by a
                    // force-killed desktop must be reclaimed, so it opts into the CLI's
                    // otherwise-refused displacement of a live same-role instance (#18).
                    let sidecar_args: Vec<String> = if server_only {
                        vec!["server".to_string(), "--takeover".to_string()]
                    } else {
                        vec!["--takeover".to_string()]
                    };
                    let port = bootstrap::pick_free_port();

                    // Resolve the bundled podium binary (plain resource, never patchelf'd).
                    let podium_res = app
                        .path()
                        .resolve("resources/podium", BaseDirectory::Resource)?;
                    // Bundled web resource dir for the backend to serve external clients.
                    let web_dir = app
                        .path()
                        .resolve("resources/web", BaseDirectory::Resource)?;

                    // Ensure the binary is on a writable, executable filesystem.
                    // AppImage mounts are read-only; ensure_executable copies it to ~/.podium/bin/.
                    let runnable = bootstrap::ensure_executable(&podium_res).map_err(|e| {
                        eprintln!("[podium-desktop] ensure_executable failed: {e}");
                        e
                    })?;

                    eprintln!(
                        "[podium-desktop] spawning {runnable:?} {sidecar_args:?} on port {port}"
                    );

                    // Spawn the initial sidecar child process.
                    let child = Command::new(&runnable)
                        .args(&sidecar_args)
                        .env("PODIUM_PORT", port.to_string())
                        .env("PODIUM_WEB_DIR", web_dir.to_string_lossy().to_string())
                        .spawn()
                        .map_err(|e| {
                            eprintln!("[podium-desktop] spawn failed: {e}");
                            e
                        })?;
                    *child_state.lock().unwrap() = Some(child);

                    // FIX 2: supervision monitor thread — waits on the child, and if it exits
                    // while the app is NOT shutting down, respawns it on the same port with
                    // bounded backoff (500ms → cap 5s). The web client auto-reconnects over WS.
                    let runnable2 = runnable.clone();
                    let web_dir2 = web_dir.clone();
                    let sidecar_args2 = sidecar_args.clone();
                    spawn_respawn_monitor(
                        child_state.clone(),
                        shutting_down.clone(),
                        move || {
                            Command::new(&runnable2)
                                .args(&sidecar_args2)
                                .env("PODIUM_PORT", port.to_string())
                                .env("PODIUM_WEB_DIR", web_dir2.to_string_lossy().to_string())
                                .spawn()
                        },
                        format!("on port {port}"),
                    );

                    window_injection = bootstrap::injection_script(port);
                    wait_local_port = Some(port);
                    webview_url = WebviewUrl::default();
                }

                bootstrap::LaunchAction::LocalDaemon { server_url } => {
                    // Spawn the local `podium`; it reads config → daemon mode → connects to the
                    // remote server. There is NO local server, so do not force PODIUM_PORT and do
                    // not wait for a local /health — the web client connects to the remote.
                    let podium_res = app
                        .path()
                        .resolve("resources/podium", BaseDirectory::Resource)?;
                    let runnable = bootstrap::ensure_executable(&podium_res).map_err(|e| {
                        eprintln!("[podium-desktop] ensure_executable failed: {e}");
                        e
                    })?;

                    eprintln!("[podium-desktop] spawning daemon {runnable:?} → {server_url}");
                    let child = Command::new(&runnable).spawn().map_err(|e| {
                        eprintln!("[podium-desktop] daemon spawn failed: {e}");
                        e
                    })?;
                    *child_state.lock().unwrap() = Some(child);

                    let runnable2 = runnable.clone();
                    spawn_respawn_monitor(
                        child_state.clone(),
                        shutting_down.clone(),
                        move || Command::new(&runnable2).spawn(),
                        "(daemon)".to_string(),
                    );

                    (webview_url, window_injection) = bootstrap::remote_window_target(&server_url);
                    wait_local_port = None;
                }

                bootstrap::LaunchAction::ClientOnly { server_url } => {
                    // No backend, no monitor — just point the window at the remote server.
                    eprintln!("[podium-desktop] client mode → {server_url} (no local backend)");
                    (webview_url, window_injection) = bootstrap::remote_window_target(&server_url);
                    wait_local_port = None;
                }
            }

            // Build the tray icon with Open / Quit menu items.
            let open = MenuItem::with_id(app, "open", "Open Podium", true, None::<&str>)?;
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

            // Wait for the local backend (if any) to accept connections, then open the window.
            // Remote modes (daemon/client) skip the wait — the web client handles connect/retry.
            let handle = app.handle().clone();
            // The window also gets a restart hook so a setup mode-change can re-run the shell:
            // raw plugin invoke avoids adding a Tauri JS dependency to apps/web.
            let restart_hook = "window.__PODIUM_RESTART__ = () => \
                window.__TAURI_INTERNALS__.invoke('plugin:process|restart');";
            let init = format!("{window_injection}\n{restart_hook}");
            std::thread::spawn(move || {
                if let Some(port) = wait_local_port {
                    let ready = bootstrap::wait_for_port(port, 200, 150);
                    if ready {
                        // Log-only shell↔backend check: read the local backend's /version.
                        log_backend_version(port);
                    } else {
                        eprintln!("[podium-desktop] backend did not become ready within timeout");
                    }
                }
                let handle2 = handle.clone();
                let _ = handle.run_on_main_thread(move || {
                    if let Err(e) = WebviewWindowBuilder::new(
                        &handle2,
                        "main",
                        webview_url,
                    )
                    .title("Podium")
                    .inner_size(1200.0, 800.0)
                    .initialization_script(&init)
                    .build()
                    {
                        eprintln!("[podium-desktop] window build failed: {e}");
                    }
                });
            });

            // Check for updates on launch (non-blocking): if a newer signed version
            // exists, prompt the user and — on confirm — download, install, restart.
            let updater_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                crate::updater::check_and_prompt_update(updater_handle).await;
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                // FIX 3: hide-on-close so the tray "Open Podium" is meaningful. Intercept
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
                                let _ = child.kill();
                                let _ = child.wait();
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
        if let tauri::RunEvent::Exit = event {
            // Set the shutting-down flag first so the monitor thread stops respawning.
            if let Some(sd) = app_handle.try_state::<Arc<AtomicBool>>() {
                sd.store(true, Ordering::Release);
            }
            if let Some(state) = app_handle.try_state::<Arc<Mutex<Option<std::process::Child>>>>() {
                if let Ok(mut guard) = state.lock() {
                    if let Some(mut child) = guard.take() {
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                }
            }
        }
    });
}
