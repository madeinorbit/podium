#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bootstrap;

use std::process::Command;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri::path::BaseDirectory;

fn main() {
    tauri::Builder::default()
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

            // Keep the child alive for the lifetime of the app (Task 3 will add graceful shutdown).
            app.manage(std::sync::Mutex::new(Some(child)));

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
        .run(tauri::generate_context!())
        .expect("error while running Podium");
}
