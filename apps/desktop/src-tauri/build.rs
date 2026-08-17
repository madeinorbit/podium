fn main() {
    println!("cargo:rerun-if-env-changed=PODIUM_DESKTOP_RELEASE_CHANNEL");
    if let Ok(channel) = std::env::var("PODIUM_DESKTOP_RELEASE_CHANNEL") {
        if channel != "stable" && channel != "edge" {
            panic!("PODIUM_DESKTOP_RELEASE_CHANNEL must be stable or edge, got {channel}");
        }
    }

    // App-defined commands must be declared so tauri-build generates their
    // allow-* permissions for the capability system. [spec:SP-3701]
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(
                tauri_build::AppManifest::new().commands(&[
                    "enable_hosting",
                    "claim_update_ownership",
                    "check_update",
                    "install_update",
                    "set_update_channel",
                ]),
            ),
    )
    .expect("failed to run tauri-build");
}
