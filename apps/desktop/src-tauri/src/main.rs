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
        .setup(|app| {
            let port = bootstrap::pick_free_port();

            // Resolve the bundled podium binary (plain resource, never patchelf'd).
            let podium_res = app
                .path()
                .resolve("resources/podium", BaseDirectory::Resource)?;

            // Resolve the bundled web resource dir for the backend to serve external clients.
            let web_dir = app
                .path()
                .resolve("resources/web", BaseDirectory::Resource)?;

            // Ensure the binary is on a writable, executable filesystem.
            // AppImage mounts are read-only; ensure_executable copies it to ~/.podium/bin/.
            let runnable = bootstrap::ensure_executable(&podium_res).map_err(|e| {
                eprintln!("[podium-desktop] ensure_executable failed: {e}");
                e
            })?;

            eprintln!("[podium-desktop] spawning {runnable:?} on port {port}");

            // FIX 2: shared shutting-down flag — set true in exit handlers so the supervision
            // monitor thread does not attempt to respawn the child during a deliberate quit.
            let shutting_down = Arc::new(AtomicBool::new(false));
            app.manage(shutting_down.clone());

            // Spawn the initial sidecar child process.
            let child = Command::new(&runnable)
                .env("PODIUM_PORT", port.to_string())
                .env("PODIUM_WEB_DIR", web_dir.to_string_lossy().to_string())
                .spawn()
                .map_err(|e| {
                    eprintln!("[podium-desktop] spawn failed: {e}");
                    e
                })?;

            // Keep the child alive; kill it when the app exits.
            let child_state: Arc<Mutex<Option<std::process::Child>>> =
                Arc::new(Mutex::new(Some(child)));
            app.manage(child_state.clone());

            // FIX 2: supervision monitor thread — waits on the child, and if it exits while
            // the app is NOT shutting down, respawns it on the same port with bounded backoff
            // (500ms → cap 5s). The web client auto-reconnects over WS on the same port.
            let runnable2 = runnable.clone();
            let web_dir2 = web_dir.clone();
            let child_state2 = child_state.clone();
            let shutting_down2 = shutting_down.clone();
            std::thread::spawn(move || {
                let mut backoff_ms: u64 = 500;
                const BACKOFF_CAP_MS: u64 = 5_000;

                loop {
                    // Wait for the current child to exit.
                    let exited = {
                        let mut guard = child_state2.lock().unwrap();
                        if let Some(ref mut child) = *guard {
                            child.wait().ok()
                        } else {
                            // Child was already reaped by the exit handler — stop monitoring.
                            break;
                        }
                    };

                    // If we're shutting down, do not respawn.
                    if shutting_down2.load(Ordering::Acquire) {
                        break;
                    }

                    eprintln!(
                        "[podium-desktop] backend exited ({exited:?}); \
                         respawning in {backoff_ms}ms on port {port}"
                    );
                    std::thread::sleep(std::time::Duration::from_millis(backoff_ms));
                    backoff_ms = (backoff_ms * 2).min(BACKOFF_CAP_MS);

                    // Check the flag again after sleeping — user may have quit during backoff.
                    if shutting_down2.load(Ordering::Acquire) {
                        break;
                    }

                    match Command::new(&runnable2)
                        .env("PODIUM_PORT", port.to_string())
                        .env("PODIUM_WEB_DIR", web_dir2.to_string_lossy().to_string())
                        .spawn()
                    {
                        Ok(new_child) => {
                            *child_state2.lock().unwrap() = Some(new_child);
                            backoff_ms = 500; // reset on successful spawn
                        }
                        Err(e) => {
                            eprintln!("[podium-desktop] respawn failed: {e}");
                            // Keep backing off; next loop iteration will try again.
                        }
                    }
                }
            });

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

            // Wait for the backend to accept connections, then open the window.
            let handle = app.handle().clone();
            let init = bootstrap::injection_script(port);
            std::thread::spawn(move || {
                let ready = bootstrap::wait_for_port(port, 200, 150);
                if !ready {
                    eprintln!("[podium-desktop] backend did not become ready within timeout");
                }
                let handle2 = handle.clone();
                let _ = handle.run_on_main_thread(move || {
                    if let Err(e) = WebviewWindowBuilder::new(
                        &handle2,
                        "main",
                        WebviewUrl::default(),
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
