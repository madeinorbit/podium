//! Own process: the receipt lookup resolves state through the process environment.

#[test]
fn app_version_accepts_only_this_shells_installed_receipt() {
    let state = std::env::temp_dir().join(format!("podium-app-version-receipt-{}", std::process::id()));
    std::env::set_var("PODIUM_STATE_DIR", &state);
    std::env::remove_var("PODIUM_DESKTOP_VERSION");
    std::fs::create_dir_all(state.join("runtime")).unwrap();
    let receipt = state.join("runtime/native-installed.json");
    let context: tauri::Context<tauri::Wry> = tauri::generate_context!();
    let expected = context.package_info().version.to_string();

    let write_receipt = |version: &str| {
        std::fs::write(
            &receipt,
            serde_json::json!({"version": version, "digest": "sha256-installed"}).to_string(),
        )
        .unwrap();
    };
    write_receipt(&expected);
    assert_eq!(
        podium_desktop_lib::updater::native_installed_digest().as_deref(),
        Some("sha256-installed"),
    );
    // A stale launcher environment cannot hide this shell's receipt.
    std::env::set_var("PODIUM_DESKTOP_VERSION", "0.1.0");
    assert_eq!(
        podium_desktop_lib::updater::native_installed_digest().as_deref(),
        Some("sha256-installed"),
    );
    for other in ["0.1.0", "0.2.0-edge.7", "0.2.0", "0.2.0+different-build"] {
        if other != expected {
            write_receipt(other);
            assert_eq!(podium_desktop_lib::updater::native_installed_digest(), None);
        }
    }
    std::fs::write(&receipt, "invalid json").unwrap();
    assert_eq!(podium_desktop_lib::updater::native_installed_digest(), None);
    std::fs::remove_file(receipt).unwrap();
    assert_eq!(podium_desktop_lib::updater::native_installed_digest(), None);
    std::fs::remove_dir_all(state).unwrap();
}
