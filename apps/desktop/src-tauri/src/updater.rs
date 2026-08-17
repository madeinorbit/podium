use crate::bootstrap::{build_update_channel, write_update_channel, UpdateChannel};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_updater::{Update, UpdaterExt};

pub type UpdateOwnership = Arc<AtomicBool>;

const STABLE_ENDPOINT: &str =
    "https://github.com/madeinorbit/podium/releases/latest/download/latest.json";
const EDGE_ENDPOINT: &str =
    "https://github.com/madeinorbit/podium/releases/download/edge/latest.json";
const UPDATE_PROGRESS_EVENT: &str = "podium://update-progress";
const PROGRESS_INTERVAL_MS: u64 = 2_000;
const PROGRESS_PERCENT_STEP: u8 = 5;

/// Every code this shell can actually produce (§7).
///
/// `RestartFailed` used to be here and is not, because this side cannot observe
/// a failed restart: both install paths end in `app.restart()`, which diverges —
/// the process is replaced and nothing after it runs. So the variant had one
/// construction site in the whole repo and it was inside this file's own test
/// module, which made `every_error_code_has_a_stable_safe_shape` read as
/// coverage of the taxonomy while proving the shape of a value the shipped
/// binary never creates (POD-2188).
///
/// The user-facing sentence is not lost, and never lived here. `install_update`
/// resolving at all IS the failed restart, and the page is the only thing left
/// alive to say so — it synthesises `restart-failed` in `use-update-state.ts`,
/// which is the producer §5 implies and the one the panel's handler reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum UpdateErrorCode {
    DebugBuild,
    NoPendingUpdate,
    InvalidUpdateChannel,
    UpdaterUnavailable,
    NoReleaseOnChannel,
    NetworkUnreachable,
    UpdateCheckFailed,
    DownloadFailed,
    SignatureInvalid,
    InstallFailed,
    NoUpdateAvailable,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct UpdateError {
    pub code: UpdateErrorCode,
    pub message: String,
}

impl UpdateError {
    fn new(code: UpdateErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn debug_build() -> Self {
        Self::new(
            UpdateErrorCode::DebugBuild,
            "Desktop updates are disabled in debug builds.",
        )
    }

    fn no_pending_update() -> Self {
        Self::new(
            UpdateErrorCode::NoPendingUpdate,
            "No checked desktop update is ready to install.",
        )
    }

    fn invalid_update_channel() -> Self {
        Self::new(
            UpdateErrorCode::InvalidUpdateChannel,
            "Podium received an unsupported desktop update channel.",
        )
    }

    fn updater_unavailable() -> Self {
        Self::new(
            UpdateErrorCode::UpdaterUnavailable,
            "Podium could not start the desktop update checker.",
        )
    }

    fn no_release_on_channel(channel: UpdateChannel) -> Self {
        Self::new(
            UpdateErrorCode::NoReleaseOnChannel,
            format!(
                "Nothing has been published on the {} channel yet.",
                channel.as_str()
            ),
        )
    }

    fn network_unreachable(channel: UpdateChannel) -> Self {
        Self::new(
            UpdateErrorCode::NetworkUnreachable,
            format!(
                "Podium could not reach the {} update channel.",
                channel.as_str()
            ),
        )
    }

    fn update_check_failed(channel: UpdateChannel) -> Self {
        Self::new(
            UpdateErrorCode::UpdateCheckFailed,
            format!(
                "Podium could not read release information from the {} channel.",
                channel.as_str()
            ),
        )
    }

    fn download_failed() -> Self {
        Self::new(
            UpdateErrorCode::DownloadFailed,
            "Podium could not download the desktop update.",
        )
    }

    fn signature_invalid() -> Self {
        Self::new(
            UpdateErrorCode::SignatureInvalid,
            "The desktop update could not be verified.",
        )
    }

    fn install_failed() -> Self {
        Self::new(
            UpdateErrorCode::InstallFailed,
            "Podium could not install the desktop update.",
        )
    }

    fn no_update_available() -> Self {
        Self::new(
            UpdateErrorCode::NoUpdateAvailable,
            "No desktop update is available.",
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum UpdatePhase {
    Downloading,
    Installing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct UpdateProgress {
    pub phase: UpdatePhase,
    pub received: u64,
    pub total: Option<u64>,
    pub percent: Option<u8>,
}

#[derive(Debug, Default)]
struct ProgressState {
    received: u64,
    total: Option<u64>,
    last_emitted_at_ms: Option<u64>,
    last_percent: Option<u8>,
}

/// Bound progress traffic while still surfacing meaningful jumps immediately.
/// Unknown totals have no percentage signal and therefore emit on elapsed time only.
pub fn should_emit_progress(
    last_emitted_at_ms: Option<u64>,
    last_percent: Option<u8>,
    now_ms: u64,
    percent: Option<u8>,
) -> bool {
    let Some(last_emitted_at_ms) = last_emitted_at_ms else {
        return true;
    };
    let time_elapsed = now_ms.saturating_sub(last_emitted_at_ms) >= PROGRESS_INTERVAL_MS;
    let percent_advanced = match (last_percent, percent) {
        (Some(previous), Some(current)) => current.saturating_sub(previous) >= PROGRESS_PERCENT_STEP,
        _ => false,
    };
    time_elapsed || percent_advanced
}

pub fn progress_percent(received: u64, total: Option<u64>) -> Option<u8> {
    let total = total.filter(|total| *total > 0)?;
    Some(received.saturating_mul(100).checked_div(total)?.min(100) as u8)
}

/// Resolve one updater authority everywhere. Precedence is the explicit bridge argument, then the
/// persisted user choice, then the channel stamped into the installed build. [spec:SP-7f2c]
pub fn resolve_update_channel(
    argument: Option<UpdateChannel>,
    persisted: Option<UpdateChannel>,
    build: UpdateChannel,
) -> UpdateChannel {
    argument.or(persisted).unwrap_or(build)
}

pub fn should_install_native_update(update_available: bool, confirmed: bool) -> bool {
    update_available && confirmed
}

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
pub fn channel_from_name(channel: &str) -> Result<UpdateChannel, UpdateError> {
    match channel {
        "stable" => Ok(UpdateChannel::Stable),
        "edge" => Ok(UpdateChannel::Edge),
        _ => {
            log::error!("unsupported desktop update channel: {channel}");
            Err(UpdateError::invalid_update_channel())
        }
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
    update: Mutex<Option<CheckedUpdate>>,
}

struct CheckedUpdate {
    channel: UpdateChannel,
    update: Update,
}

fn parse_updater_endpoint(endpoint: &str) -> Result<tauri::Url, UpdateError> {
    tauri::Url::parse(endpoint).map_err(|error| {
        log::error!("invalid updater endpoint: {error}");
        UpdateError::updater_unavailable()
    })
}

fn updater_for_channel(
    app: &AppHandle,
    channel: UpdateChannel,
) -> Result<tauri_plugin_updater::Updater, UpdateError> {
    let endpoint = parse_updater_endpoint(endpoint_for_channel(channel))?;
    app.updater_builder()
        .endpoints(vec![endpoint])
        .and_then(|builder| builder.build())
        .map_err(|error| {
            log::error!("updater unavailable: {error}");
            UpdateError::updater_unavailable()
        })
}

/// Classify failures while asking a channel for its manifest. The updater crate reports a
/// non-successful endpoint (including the production feed's observed 404) as ReleaseNotFound;
/// transport failures remain distinct from a response that cannot be interpreted.
fn check_error(
    error: &tauri_plugin_updater::Error,
    channel: UpdateChannel,
) -> UpdateError {
    let public = match error {
        tauri_plugin_updater::Error::ReleaseNotFound => {
            UpdateError::no_release_on_channel(channel)
        }
        tauri_plugin_updater::Error::Reqwest(error) if !error.is_decode() => {
            UpdateError::network_unreachable(channel)
        }
        tauri_plugin_updater::Error::Network(_) => UpdateError::network_unreachable(channel),
        _ => UpdateError::update_check_failed(channel),
    };
    log::error!(
        "desktop update check failed for {}: {error}",
        channel.as_str()
    );
    public
}

fn update_error(error: &tauri_plugin_updater::Error) -> UpdateError {
    let public = match error {
        tauri_plugin_updater::Error::Minisign(_)
        | tauri_plugin_updater::Error::Base64(_)
        | tauri_plugin_updater::Error::SignatureUtf8(_) => UpdateError::signature_invalid(),
        tauri_plugin_updater::Error::Reqwest(_) | tauri_plugin_updater::Error::Network(_) => {
            UpdateError::download_failed()
        }
        _ => UpdateError::install_failed(),
    };
    log::error!("desktop update failed: {error}");
    public
}

fn progress_after_chunk(
    state: &mut ProgressState,
    chunk: usize,
    total: Option<u64>,
    now_ms: u64,
) -> Option<UpdateProgress> {
    state.received = state.received.saturating_add(chunk as u64);
    state.total = total;
    let percent = progress_percent(state.received, total);
    if !should_emit_progress(
        state.last_emitted_at_ms,
        state.last_percent,
        now_ms,
        percent,
    ) {
        return None;
    }
    state.last_emitted_at_ms = Some(now_ms);
    state.last_percent = percent;
    Some(UpdateProgress {
        phase: UpdatePhase::Downloading,
        received: state.received,
        total,
        percent,
    })
}

async fn download_and_install_with_progress<F>(
    update: &Update,
    report: F,
) -> Result<(), UpdateError>
where
    F: Fn(UpdateProgress) + Clone,
{
    let started = Instant::now();
    let state = Arc::new(Mutex::new(ProgressState::default()));
    let chunk_state = state.clone();
    let chunk_report = report.clone();
    let finish_state = state;
    update
        .download_and_install(
            move |chunk, total| {
                let now_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
                let progress = chunk_state.lock().ok().and_then(|mut state| {
                    progress_after_chunk(&mut state, chunk, total, now_ms)
                });
                if let Some(progress) = progress {
                    chunk_report(progress);
                }
            },
            move || {
                let progress = finish_state.lock().ok().map(|state| UpdateProgress {
                    phase: UpdatePhase::Installing,
                    received: state.received,
                    total: state.total,
                    percent: progress_percent(state.received, state.total),
                });
                if let Some(progress) = progress {
                    report(progress);
                }
            },
        )
        .await
        .map_err(|error| update_error(&error))
}

fn emit_update_progress(app: &AppHandle, progress: UpdateProgress) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if let Err(error) = window.emit(UPDATE_PROGRESS_EVENT, progress) {
        log::warn!("could not emit desktop update progress: {error}");
    }
}

pub fn native_progress_title(progress: UpdateProgress) -> String {
    match (progress.phase, progress.percent) {
        (UpdatePhase::Downloading, Some(percent)) => {
            format!("Podium — Downloading update ({percent}%)")
        }
        (UpdatePhase::Downloading, None) => {
            format!("Podium — Downloading update ({} bytes)", progress.received)
        }
        (UpdatePhase::Installing, _) => "Podium — Installing update".to_string(),
    }
}

fn set_native_progress_title(app: &AppHandle, progress: UpdateProgress) {
    if let Some(window) = app.get_webview_window("main") {
        if let Err(error) = window.set_title(&native_progress_title(progress)) {
            log::warn!("could not update desktop window title: {error}");
        }
    }
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

// `feed_endpoint`, which templated an updater base URL into
// `<base>/update/{{target}}/{{arch}}/{{current_version}}`, was removed in
// POD-2106. It read as production configuration and was not: the shipped
// endpoint is the static GitHub asset in `tauri.conf.json`, and the only thing
// that ever wanted the templated shape — `apps/desktop/scripts/verify-update.sh`
// — writes it into a throwaway config itself, in node, without asking Rust.
// Its two tests therefore asserted a string against itself. If a pluggable base
// is ever needed again, it belongs next to a caller that has one.

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

/// Keep the shell's native fallback on the same production feed the user chose in the app.
#[tauri::command]
pub fn set_update_channel(channel: String) -> Result<(), String> {
    let channel = channel_from_name(&channel)
        .map_err(|_| "unsupported desktop update channel".to_string())?;
    write_update_channel(channel)
}

/// Check a production feed and retain the signed update for a later install command.
#[tauri::command]
pub async fn check_update(
    app: AppHandle,
    channel: String,
    pending: State<'_, PendingUpdate>,
) -> Result<Option<UpdateInfo>, UpdateError> {
    {
        let mut slot = pending
            .update
            .lock()
            .map_err(|_| UpdateError::no_pending_update())?;
        *slot = None;
    }

    if !production_auto_update_enabled(cfg!(debug_assertions)) {
        return Err(UpdateError::debug_build());
    }

    let channel = channel_from_name(&channel)?;
    let updater = updater_for_channel(&app, channel)?;
    let update = updater
        .check()
        .await
        .map_err(|error| check_error(&error, channel))?;

    match update {
        Some(update) => {
            let info = update_info(&update);
            let mut slot = pending
                .update
                .lock()
                .map_err(|_| UpdateError::no_pending_update())?;
            *slot = Some(CheckedUpdate { channel, update });
            Ok(Some(info))
        }
        None => Ok(None),
    }
}

/// Install the last checked update. If the page skipped the check, re-check the
/// page-supplied channel; shell config is never consulted on the bridge path.
#[tauri::command]
pub async fn install_update(
    app: AppHandle,
    channel: Option<String>,
    pending: State<'_, PendingUpdate>,
) -> Result<(), UpdateError> {
    if !production_auto_update_enabled(cfg!(debug_assertions)) {
        return Err(UpdateError::debug_build());
    }

    let argument_channel = channel
        .as_deref()
        .map(channel_from_name)
        .transpose()?;
    let checked_update = {
        let mut slot = pending
            .update
            .lock()
            .map_err(|_| UpdateError::no_pending_update())?;
        slot.take()
    };
    let pending_channel = checked_update.as_ref().map(|checked| checked.channel);
    let channel = match (argument_channel, pending_channel) {
        (Some(argument), _) => argument,
        (None, Some(pending)) => pending,
        (None, None) => return Err(UpdateError::no_pending_update()),
    };
    let update = match checked_update {
        Some(checked) if checked.channel == channel => checked.update,
        Some(_) | None => {
            let updater = updater_for_channel(&app, channel)?;
            updater
                .check()
                .await
                .map_err(|error| check_error(&error, channel))?
                .ok_or_else(UpdateError::no_update_available)?
        }
    };

    let progress_app = app.clone();
    download_and_install_with_progress(&update, move |progress| {
        emit_update_progress(&progress_app, progress);
    })
    .await?;
    // Diverges: the process is replaced, this promise is dropped unresolved
    // along with everything else, and there is no failure for this side to
    // return. A settled `installUpdate` on the page therefore MEANS the restart
    // did not happen, which is where `restart-failed` is produced (POD-2188).
    app.restart();
}

/// When the page does not claim update ownership, check the configured channel and
/// offer a minimal native install path. Network failures remain non-fatal at launch.
pub async fn check_and_prompt_update(
    app: AppHandle,
    persisted_channel: Option<UpdateChannel>,
) {
    if !production_auto_update_enabled(cfg!(debug_assertions)) {
        log::info!("production auto-update disabled in debug builds");
        return;
    }

    let channel = resolve_update_channel(
        None,
        persisted_channel,
        build_update_channel(),
    );
    let updater = match updater_for_channel(&app, channel) {
        Ok(updater) => updater,
        Err(error) => {
            log::warn!("native update check unavailable: {}", error.message);
            return;
        }
    };
    let update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => return,
        Err(error) => {
            log::warn!("native update check failed: {error}");
            return;
        }
    };

    let test_autoconfirm =
        std::env::var("PODIUM_UPDATE_TEST_AUTOCONFIRM").as_deref() == Ok("1");
    let confirmed = test_autoconfirm
        || app
            .dialog()
            .message(format!(
                "Podium {} is available — install and restart?",
                update.version
            ))
            .title("Podium Update")
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Install and restart".to_string(),
                "Not now".to_string(),
            ))
            .blocking_show();
    if !should_install_native_update(true, confirmed) {
        log::info!("native desktop update declined");
        return;
    }

    let title_app = app.clone();
    if let Err(error) = download_and_install_with_progress(&update, move |progress| {
        set_native_progress_title(&title_app, progress);
    })
    .await
    {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.set_title("Podium");
        }
        log::error!("native desktop update failed: {}", error.message);
        return;
    }
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(
            channel_from_name("development"),
            Err(UpdateError::invalid_update_channel())
        );
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

    #[test]
    fn progress_emits_initially_then_at_time_or_percent_thresholds() {
        assert!(should_emit_progress(None, None, 0, Some(1)));
        assert!(!should_emit_progress(Some(100), Some(10), 2_099, Some(14)));
        assert!(should_emit_progress(Some(100), Some(10), 2_100, Some(14)));
        assert!(should_emit_progress(Some(100), Some(10), 101, Some(15)));
    }

    #[test]
    fn unknown_total_reports_bytes_without_a_percent() {
        let mut state = ProgressState::default();
        let first = progress_after_chunk(&mut state, 512, None, 0).expect("initial event");
        assert_eq!(first.received, 512);
        assert_eq!(first.total, None);
        assert_eq!(first.percent, None);
        assert_eq!(progress_after_chunk(&mut state, 256, None, 1_999), None);
        let timed = progress_after_chunk(&mut state, 256, None, 2_000).expect("timed event");
        assert_eq!(timed.received, 1_024);
        assert_eq!(timed.percent, None);
        assert_eq!(progress_percent(512, Some(0)), None);
    }

    #[test]
    fn percentage_is_bounded_when_received_exceeds_total() {
        assert_eq!(progress_percent(125, Some(100)), Some(100));
    }

    #[test]
    fn every_error_code_has_a_stable_safe_shape() {
        let errors = [
            UpdateError::debug_build(),
            UpdateError::no_pending_update(),
            UpdateError::invalid_update_channel(),
            UpdateError::updater_unavailable(),
            UpdateError::no_release_on_channel(UpdateChannel::Stable),
            UpdateError::network_unreachable(UpdateChannel::Stable),
            UpdateError::update_check_failed(UpdateChannel::Stable),
            UpdateError::download_failed(),
            UpdateError::signature_invalid(),
            UpdateError::install_failed(),
            UpdateError::no_update_available(),
        ];
        let codes = [
            "debug-build",
            "no-pending-update",
            "invalid-update-channel",
            "updater-unavailable",
            "no-release-on-channel",
            "network-unreachable",
            "update-check-failed",
            "download-failed",
            "signature-invalid",
            "install-failed",
            "no-update-available",
        ];
        for (error, code) in errors.into_iter().zip(codes) {
            let json = serde_json::to_value(error).expect("error serializes");
            assert_eq!(json["code"], code);
            assert!(json["message"].as_str().is_some_and(|message| {
                !message.contains('/') && !message.to_ascii_lowercase().contains("token")
            }));
        }
    }

    #[test]
    fn check_failures_map_to_distinct_codes_and_messages() {
        assert_eq!(
            check_error(
                &tauri_plugin_updater::Error::ReleaseNotFound,
                UpdateChannel::Stable
            ),
            UpdateError::new(
                UpdateErrorCode::NoReleaseOnChannel,
                "Nothing has been published on the stable channel yet."
            )
        );
        assert_eq!(
            check_error(
                &tauri_plugin_updater::Error::Network("offline".to_string()),
                UpdateChannel::Edge
            ),
            UpdateError::new(
                UpdateErrorCode::NetworkUnreachable,
                "Podium could not reach the edge update channel."
            )
        );
        let malformed = tauri_plugin_updater::Error::Serialization(
            serde_json::from_str::<serde_json::Value>("{").expect_err("malformed JSON"),
        );
        assert_eq!(
            check_error(&malformed, UpdateChannel::Stable),
            UpdateError::new(
                UpdateErrorCode::UpdateCheckFailed,
                "Podium could not read release information from the stable channel."
            )
        );
    }

    #[test]
    fn malformed_endpoint_is_an_updater_setup_failure() {
        assert_eq!(
            parse_updater_endpoint("not a URL"),
            Err(UpdateError::new(
                UpdateErrorCode::UpdaterUnavailable,
                "Podium could not start the desktop update checker."
            ))
        );
    }

    #[test]
    fn transfer_failures_remain_download_failures() {
        let download = tauri_plugin_updater::Error::Network("offline".to_string());
        assert_eq!(update_error(&download), UpdateError::download_failed());
    }

    #[test]
    fn install_failures_map_to_explainable_categories() {
        let signature = tauri_plugin_updater::Error::SignatureUtf8("invalid".to_string());
        assert_eq!(
            update_error(&signature).code,
            UpdateErrorCode::SignatureInvalid
        );
        let install = tauri_plugin_updater::Error::PackageInstallFailed;
        assert_eq!(update_error(&install).code, UpdateErrorCode::InstallFailed);
    }

    #[test]
    fn an_edge_build_without_config_resolves_edge() {
        assert_eq!(
            resolve_update_channel(None, None, UpdateChannel::Edge),
            UpdateChannel::Edge
        );
    }

    #[test]
    fn explicit_bridge_argument_wins_over_persisted_choice_and_build() {
        assert_eq!(
            resolve_update_channel(
                Some(UpdateChannel::Edge),
                Some(UpdateChannel::Stable),
                UpdateChannel::Stable,
            ),
            UpdateChannel::Edge
        );
    }

    #[test]
    fn persisted_choice_wins_over_build_channel() {
        assert_eq!(
            resolve_update_channel(None, Some(UpdateChannel::Stable), UpdateChannel::Edge),
            UpdateChannel::Stable
        );
    }

    #[test]
    fn native_fallback_honors_confirm_and_decline() {
        assert!(should_install_native_update(true, true));
        assert!(!should_install_native_update(true, false));
        assert!(!should_install_native_update(false, true));
    }

    #[test]
    fn native_title_reflects_download_and_install_progress() {
        assert_eq!(
            native_progress_title(UpdateProgress {
                phase: UpdatePhase::Downloading,
                received: 50,
                total: Some(100),
                percent: Some(50),
            }),
            "Podium — Downloading update (50%)"
        );
        assert_eq!(
            native_progress_title(UpdateProgress {
                phase: UpdatePhase::Downloading,
                received: 512,
                total: None,
                percent: None,
            }),
            "Podium — Downloading update (512 bytes)"
        );
        assert_eq!(
            native_progress_title(UpdateProgress {
                phase: UpdatePhase::Installing,
                received: 100,
                total: Some(100),
                percent: Some(100),
            }),
            "Podium — Installing update"
        );
    }
}
