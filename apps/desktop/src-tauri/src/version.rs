/// This shell's version, available before Tauri creates an app handle.
/// build.rs stamps the same merged Tauri config used by app.package_info().
/// Cargo.toml describes the Rust crate; runtime environment can describe a
/// predecessor shell, so neither identifies this executable.
pub const APP_VERSION: &str = env!("PODIUM_DESKTOP_APP_VERSION");
