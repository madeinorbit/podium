fn main() {
    println!("cargo:rerun-if-env-changed=PODIUM_DESKTOP_RELEASE_CHANNEL");
    if let Ok(channel) = std::env::var("PODIUM_DESKTOP_RELEASE_CHANNEL") {
        if channel != "stable" && channel != "edge" && channel != "dev" {
            panic!("PODIUM_DESKTOP_RELEASE_CHANNEL must be stable, edge, or dev, got {channel}");
        }
    }

    // App-defined commands must be declared so tauri-build generates their
    // allow-* permissions for the capability system. [spec:SP-3701]
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "enable_hosting",
            "begin_cloud_sign_in",
            "daemon_connectivity",
            "runtime_probe_report",
            "claim_update_ownership",
            "check_update",
            "install_update",
            "set_update_channel",
            "save_server_identity",
            "move_server",
        ]),
    ))
    .expect("failed to run tauri-build");

    // tauri-build sets TAURI_ENV_TARGET_TRIPLE for codegen, even under direct cargo
    // cross-builds. Read afterwards with the same loader as generate_context!:
    // platform config and TAURI_CONFIG overrides preserve prerelease/build metadata.
    // Stamping it makes the real app version available to the FIRST log and panic
    // hook, before an app handle (or even the generated context) exists.
    let (config, _) = tauri_codegen::get_config(std::path::Path::new("tauri.conf.json"))
        .expect("failed to read desktop app config");
    let version = config
        .version
        .expect("desktop app version must be configured in tauri.conf.json");
    println!("cargo:rustc-env=PODIUM_DESKTOP_APP_VERSION={version}");
}
