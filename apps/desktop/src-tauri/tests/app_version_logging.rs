//! Own process: the logger and panic hook are process-global. No app handle or GUI.

#[test]
fn app_version_labels_the_first_log_and_early_panic() {
    let state = std::env::temp_dir().join(format!("podium-app-version-log-{}", std::process::id()));
    std::env::set_var("PODIUM_STATE_DIR", &state);
    std::env::set_var("PODIUM_DESKTOP_VERSION", "0.1.0-stale");
    let context: tauri::Context<tauri::Wry> = tauri::generate_context!();
    let expected = context.package_info().version.to_string();

    podium_desktop_lib::logging::init();
    log::error!("first log, before any app handle exists");
    let outcome = std::panic::catch_unwind(|| panic!("early startup panic"));
    assert!(outcome.is_err());

    let text = std::fs::read_to_string(state.join("logs/desktop-native.ndjson")).unwrap();
    let records: Vec<serde_json::Value> = text
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(records.len(), 2);
    assert_eq!(records[0]["msg"], "first log, before any app handle exists");
    for record in &records {
        assert_eq!(record["v"], expected);
    }
    let pending = podium_desktop_lib::logging::take_pending_crashes();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0]["v"], expected);
    assert_eq!(podium_desktop_lib::version::APP_VERSION, expected);
    std::fs::remove_dir_all(state).unwrap();
}
