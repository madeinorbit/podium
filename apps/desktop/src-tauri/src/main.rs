#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bootstrap;

use std::process::Command;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri::path::BaseDirectory;

fn main() {
    let app = tauri::Builder::default()
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

            let child = Command::new(&runnable)
                .env("PODIUM_PORT", port.to_string())
                .env("PODIUM_WEB_DIR", web_dir.to_string_lossy().to_string())
                .spawn()
                .map_err(|e| {
                    eprintln!("[podium-desktop] spawn failed: {e}");
                    e
                })?;

            // Keep the child alive; kill it when the app exits.
            app.manage(std::sync::Mutex::new(Some(child)));

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

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let app = window.app_handle();
                if let Some(state) = app.try_state::<std::sync::Mutex<Option<std::process::Child>>>() {
                    if let Some(mut child) = state.lock().unwrap().take() {
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Podium");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            if let Some(state) = app_handle.try_state::<std::sync::Mutex<Option<std::process::Child>>>() {
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
