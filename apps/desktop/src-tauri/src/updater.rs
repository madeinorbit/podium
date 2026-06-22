use tauri::AppHandle;

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

/// On launch: check the feed; if a newer signed version exists, ask the user, then
/// download+install and restart. Errors are logged, never fatal (no network = no-op).
///
/// TEST-ONLY: when the env var `PODIUM_UPDATE_AUTOCONFIRM=1` is set, the interactive
/// confirmation dialog is SKIPPED and the install proceeds unattended. This exists
/// solely so Task 2's headless e2e (no display server, no human) can exercise the
/// full check → download → install → restart path. Do NOT set it in production.
pub async fn check_and_prompt_update(app: AppHandle) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
    use tauri_plugin_updater::UpdaterExt;

    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            eprintln!("[podium-desktop] updater unavailable: {e}");
            return;
        }
    };
    match updater.check().await {
        Ok(Some(update)) => {
            let msg = format!(
                "Update available ({} → {}). Restart to apply?",
                update.current_version, update.version
            );

            // TEST-ONLY autoconfirm: skip the dialog entirely for headless e2e.
            let confirmed = if std::env::var("PODIUM_UPDATE_AUTOCONFIRM").as_deref() == Ok("1") {
                eprintln!("[podium-desktop] PODIUM_UPDATE_AUTOCONFIRM=1 — skipping dialog (test-only)");
                true
            } else {
                app.dialog()
                    .message(msg)
                    .title("Podium update")
                    .buttons(MessageDialogButtons::OkCancel)
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
}
