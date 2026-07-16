use crate::bootstrap::UpdateChannel;
use tauri::AppHandle;

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

/// Production auto-update is deliberately absent from debug/`tauri dev` builds.
/// Development is not a third release channel. [spec:SP-7f2c]
pub const fn production_auto_update_enabled(debug_build: bool) -> bool {
    !debug_build
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

/// A release is CRITICAL (forced) when its notes begin with a `CRITICAL:` marker set by
/// the release process. Leading whitespace is tolerated. Critical updates are non-dismissible.
pub fn is_critical(body: &str) -> bool {
    body.trim_start().starts_with("CRITICAL:")
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
    use tauri_plugin_updater::UpdaterExt;

    if !production_auto_update_enabled(cfg!(debug_assertions)) {
        eprintln!("[podium-desktop] production auto-update disabled in debug builds");
        return;
    }

    let endpoint = match tauri::Url::parse(endpoint_for_channel(channel)) {
        Ok(endpoint) => endpoint,
        Err(e) => {
            eprintln!("[podium-desktop] invalid updater endpoint: {e}");
            return;
        }
    };
    let updater = match app
        .updater_builder()
        .endpoints(vec![endpoint])
        .and_then(|builder| builder.build())
    {
        Ok(u) => u,
        Err(e) => {
            eprintln!("[podium-desktop] updater unavailable: {e}");
            return;
        }
    };
    match updater.check().await {
        Ok(Some(update)) => {
            // A CRITICAL release (notes begin with `CRITICAL:`) is non-dismissible: the dialog
            // offers Ok only (no Cancel) so the user cannot decline, and it always installs.
            let critical = is_critical(update.body.as_deref().unwrap_or(""));
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
    fn is_critical_detects_the_marker() {
        assert!(is_critical("CRITICAL: security fix"));
        // Leading whitespace is tolerated (release notes may be indented).
        assert!(is_critical("  CRITICAL: security fix"));
        assert!(!is_critical("normal notes"));
        assert!(!is_critical(""));
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
