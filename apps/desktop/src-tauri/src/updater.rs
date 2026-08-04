use crate::bootstrap::UpdateChannel;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};

pub type UpdateOwnership = Arc<AtomicBool>;

const STABLE_ENDPOINT: &str =
    "https://github.com/madeinorbit/podium/releases/latest/download/latest.json";
const EDGE_ENDPOINT: &str =
    "https://github.com/madeinorbit/podium/releases/download/edge/latest.json";

/// Resolve the production static manifest for the persisted release channel.
/// [spec:SP-7f2c]
pub fn endpoint_for_channel(channel: UpdateChannel) -> &'static str {
    match channel {
        UpdateChannel::Stable => STABLE_ENDPOINT,
        UpdateChannel::Edge => EDGE_ENDPOINT,
    }
}

/// Convert the bridge's explicit channel name into the shell's production feed.
/// Unknown values fail closed instead of selecting an arbitrary release channel.
pub fn channel_from_name(channel: &str) -> Result<UpdateChannel, String> {
    match channel {
        "stable" => Ok(UpdateChannel::Stable),
        "edge" => Ok(UpdateChannel::Edge),
        _ => Err(format!("unknown update channel: {channel}")),
    }
}

/// The structured update metadata returned to the webview. Notes are descriptive only;
/// `critical` is the policy bit and is never inferred from them.
#[derive(Debug, Clone, serde::Serialize)]
pub struct UpdateInfo {
    pub current_version: String,
    pub version: String,
    pub critical: bool,
    pub notes: Option<String>,
}

#[derive(Default)]
pub struct PendingUpdate {
    update: Mutex<Option<Update>>,
}

fn updater_for_channel(
    app: &AppHandle,
    channel: UpdateChannel,
) -> Result<tauri_plugin_updater::Updater, String> {
    let endpoint = tauri::Url::parse(endpoint_for_channel(channel))
        .map_err(|error| format!("invalid updater endpoint: {error}"))?;
    app.updater_builder()
        .endpoints(vec![endpoint])
        .and_then(|builder| builder.build())
        .map_err(|error| format!("updater unavailable: {error}"))
}

fn update_info(update: &Update) -> UpdateInfo {
    UpdateInfo {
        current_version: update.current_version.clone(),
        version: update.version.clone(),
        critical: is_critical_update(&update.raw_json, update.body.as_deref()),
        notes: update.body.clone(),
    }
}

/// Production auto-update is deliberately absent from debug/`tauri dev` builds.
/// Development is not a third release channel. [spec:SP-7f2c]
pub const fn production_auto_update_enabled(debug_build: bool) -> bool {
    !debug_build
}

/// How long the shell waits for its page to say "I own updates" before showing
/// the native dialog itself. Generous on purpose: in remote mode the page is
/// fetched from another host, and a short window would race a page that was about
/// to render its own dialog, showing the user two prompts for one fact.
pub const OWNERSHIP_GRACE_MS: u64 = 8_000;

/// The shell steps in only when nobody claimed the job and the grace window has
/// passed. A page that claimed ownership keeps it forever: the shell never
/// second-guesses a live page.
pub fn should_show_native_dialog(claimed: bool, elapsed_ms: u64, grace_ms: u64) -> bool {
    !claimed && elapsed_ms > grace_ms
}

/// Build the templated updater endpoint from a pluggable base URL.
///
/// The `{{target}}`/`{{arch}}`/`{{current_version}}` placeholders are filled in by
/// the Tauri updater at request time; we only assemble the path shape here.
pub fn feed_endpoint(base: &str) -> String {
    format!(
        "{}/update/{{{{target}}}}/{{{{arch}}}}/{{{{current_version}}}}",
        base.trim_end_matches('/')
    )
}

/// Whether this release is FORCED, read from the manifest's structured field.
///
/// Deliberately not parsed out of the release notes. Policy that lives in prose
/// can be changed by anyone reflowing a changelog, in either direction, silently.
/// `raw_json` carries the manifest verbatim, so the flag the release process set
/// is the flag we read.
///
/// Fails toward NOT critical: a malformed or absent field must never produce a
/// non-dismissible dialog the user has no way out of.
pub fn is_critical_update(raw: &serde_json::Value, _body: Option<&str>) -> bool {
    raw.get("critical")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
}

/// The page calls this as soon as it mounts the shared update dialog. The shell's
/// fallback timer reads the same flag and never needs the page to perform an update.
#[tauri::command]
pub fn claim_update_ownership(ownership: State<'_, UpdateOwnership>) -> Result<(), String> {
    ownership.store(true, Ordering::Release);
    Ok(())
}

/// Check a production feed and retain the signed update for a later install command.
/// Debug builds deliberately return no update without touching a production endpoint.
#[tauri::command]
pub async fn check_update(
    app: AppHandle,
    channel: String,
    pending: State<'_, PendingUpdate>,
) -> Result<Option<UpdateInfo>, String> {
    {
        let mut slot = pending
            .update
            .lock()
            .map_err(|_| "desktop update state is unavailable".to_string())?;
        *slot = None;
    }

    if !production_auto_update_enabled(cfg!(debug_assertions)) {
        return Ok(None);
    }

    let channel = channel_from_name(&channel)?;
    let updater = updater_for_channel(&app, channel)?;
    let update = updater
        .check()
        .await
        .map_err(|error| format!("update check failed: {error}"))?;

    match update {
        Some(update) => {
            let info = update_info(&update);
            let mut slot = pending
                .update
                .lock()
                .map_err(|_| "desktop update state is unavailable".to_string())?;
            *slot = Some(update);
            Ok(Some(info))
        }
        None => Ok(None),
    }
}

/// Install the last checked update, or check the persisted channel when the web
/// dialog arrived without calling checkUpdate first. The updater itself verifies
/// the signed package before installing, then the shell restarts atomically.
#[tauri::command]
pub async fn install_update(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
) -> Result<(), String> {
    if !production_auto_update_enabled(cfg!(debug_assertions)) {
        return Err("desktop updates are disabled in debug builds".to_string());
    }

    let checked_update = {
        let mut slot = pending
            .update
            .lock()
            .map_err(|_| "desktop update state is unavailable".to_string())?;
        slot.take()
    };
    let update = match checked_update {
        Some(update) => update,
        None => {
            let channel = crate::bootstrap::read_config().update_channel;
            let updater = updater_for_channel(&app, channel)?;
            updater
                .check()
                .await
                .map_err(|error| format!("update check failed: {error}"))?
                .ok_or_else(|| "no desktop update is available".to_string())?
        }
    };

    update
        .download_and_install(|_chunk, _total| {}, || {})
        .await
        .map_err(|error| format!("update install failed: {error}"))?;
    app.restart();
}

/// On launch: check the feed; if a newer signed version exists, ask the user, then
/// download+install and restart. Errors are logged, never fatal (no network = no-op).
///
/// TEST-ONLY: when the env var `PODIUM_UPDATE_AUTOCONFIRM=1` is set, the interactive
/// confirmation dialog is SKIPPED and the install proceeds unattended. This exists
/// solely so Task 2's headless e2e (no display server, no human) can exercise the
/// full check → download → install → restart path. Do NOT set it in production.
pub async fn check_and_prompt_update(app: AppHandle, channel: UpdateChannel) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

    if !production_auto_update_enabled(cfg!(debug_assertions)) {
        eprintln!("[podium-desktop] production auto-update disabled in debug builds");
        return;
    }

    let updater = match updater_for_channel(&app, channel) {
        Ok(u) => u,
        Err(error) => {
            eprintln!("[podium-desktop] {error}");
            return;
        }
    };
    match updater.check().await {
        Ok(Some(update)) => {
            // A critical release is non-dismissible: the dialog offers Ok only (no Cancel) so
            // the user cannot decline, and it always installs. Policy comes from the structured
            // manifest field, never from release-note prose.
            let critical = is_critical_update(&update.raw_json, update.body.as_deref());
            let msg = if critical {
                format!(
                    "Critical update ({} → {}). This update is required and will be installed now.",
                    update.current_version, update.version
                )
            } else {
                format!(
                    "Update available ({} → {}). Restart to apply?",
                    update.current_version, update.version
                )
            };

            // TEST-ONLY autoconfirm: skip the dialog entirely for headless e2e.
            let confirmed = if std::env::var("PODIUM_UPDATE_AUTOCONFIRM").as_deref() == Ok("1") {
                eprintln!("[podium-desktop] PODIUM_UPDATE_AUTOCONFIRM=1 — skipping dialog (test-only)");
                true
            } else {
                // Critical → Ok-only (cannot decline); normal → OkCancel.
                let buttons = if critical {
                    MessageDialogButtons::Ok
                } else {
                    MessageDialogButtons::OkCancel
                };
                app.dialog()
                    .message(msg)
                    .title("Podium update")
                    .buttons(buttons)
                    .blocking_show()
            };

            if confirmed {
                if let Err(e) = update.download_and_install(|_chunk, _total| {}, || {}).await {
                    eprintln!("[podium-desktop] update install failed: {e}");
                    return;
                }
                app.restart();
            }
        }
        Ok(None) => { /* up to date */ }
        Err(e) => eprintln!("[podium-desktop] update check failed: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn feed_endpoint_templates_the_base() {
        assert_eq!(
            feed_endpoint("http://h:8788/"),
            "http://h:8788/update/{{target}}/{{arch}}/{{current_version}}"
        );
    }

    #[test]
    fn feed_endpoint_handles_base_without_trailing_slash() {
        assert_eq!(
            feed_endpoint("http://127.0.0.1:8788"),
            "http://127.0.0.1:8788/update/{{target}}/{{arch}}/{{current_version}}"
        );
    }

    #[test]
    fn critical_is_read_from_the_structured_field() {
        let json = serde_json::json!({ "version": "0.4.2", "critical": true });
        assert!(is_critical_update(&json, Some("ordinary notes")));
    }

    #[test]
    fn absent_critical_field_means_not_critical() {
        let json = serde_json::json!({ "version": "0.4.2" });
        assert!(!is_critical_update(&json, Some("notes")));
    }

    #[test]
    fn explicit_false_means_not_critical() {
        let json = serde_json::json!({ "version": "0.4.2", "critical": false });
        assert!(!is_critical_update(&json, None));
    }

    #[test]
    fn the_prose_marker_no_longer_forces_anything() {
        // Policy must not be parseable out of a changelog. An editor reflowing prose
        // must not be able to change whether an update is forced.
        let json = serde_json::json!({ "version": "0.4.2" });
        assert!(!is_critical_update(&json, Some("CRITICAL: security fix")));
    }

    #[test]
    fn a_non_boolean_critical_is_not_critical() {
        // Fail toward NOT forcing: a malformed manifest must not produce a
        // non-dismissible dialog the user cannot escape.
        let json = serde_json::json!({ "version": "0.4.2", "critical": "yes" });
        assert!(!is_critical_update(&json, None));
    }

    #[test]
    fn a_claiming_page_owns_the_dialog() {
        assert!(!should_show_native_dialog(true, 100_000, OWNERSHIP_GRACE_MS));
    }

    #[test]
    fn an_unclaimed_shell_falls_back_after_the_grace_window() {
        // The bundle failed to load, or the page is too old to know about the bridge.
        // Without this, a broken webview means no update path at all.
        assert!(should_show_native_dialog(false, OWNERSHIP_GRACE_MS + 1, OWNERSHIP_GRACE_MS));
    }

    #[test]
    fn the_shell_waits_out_the_grace_window_before_stepping_in() {
        // A slow page must not race the native dialog and show two prompts.
        assert!(!should_show_native_dialog(false, 10, OWNERSHIP_GRACE_MS));
    }

    #[test]
    fn a_late_claim_still_wins_at_the_boundary() {
        assert!(!should_show_native_dialog(true, OWNERSHIP_GRACE_MS, OWNERSHIP_GRACE_MS));
    }

    #[test]
    fn the_grace_window_is_generous_enough_for_a_remote_bundle() {
        // Remote mode fetches the page from another host. Too short a window shows a
        // native dialog over a page that was about to render its own.
        assert!(OWNERSHIP_GRACE_MS >= 5_000);
    }

    #[test]
    fn bridge_channel_names_select_only_production_channels() {
        assert_eq!(channel_from_name("stable"), Ok(UpdateChannel::Stable));
        assert_eq!(channel_from_name("edge"), Ok(UpdateChannel::Edge));
    }

    #[test]
    fn unknown_bridge_channel_is_rejected() {
        assert!(channel_from_name("development").is_err());
    }

    #[test]
    fn release_channels_use_distinct_static_manifests() {
        assert_eq!(endpoint_for_channel(UpdateChannel::Stable), STABLE_ENDPOINT);
        assert_eq!(endpoint_for_channel(UpdateChannel::Edge), EDGE_ENDPOINT);
    }

    #[test]
    fn debug_builds_never_enable_production_auto_update() {
        assert!(!production_auto_update_enabled(true));
        assert!(production_auto_update_enabled(false));
        assert!(cfg!(debug_assertions), "cargo test should exercise the debug guard");
        assert!(!production_auto_update_enabled(cfg!(debug_assertions)));
    }
}
