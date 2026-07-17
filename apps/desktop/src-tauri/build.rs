fn main() {
    // App-defined commands must be declared so tauri-build generates their
    // allow-* permissions for the capability system. [spec:SP-3701]
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["enable_hosting"])),
    )
    .expect("failed to run tauri-build");
}
