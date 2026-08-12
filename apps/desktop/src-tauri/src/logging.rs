//! NATIVE-SIDE LOGGING FOR THE DESKTOP SHELL
//! (chunk 5 of [spec:2026-08-11-logging-strategy-design]).
//!
//! Everything the Rust half of the desktop app has to say — backend supervision,
//! the update path, and its own panics — becomes an NDJSON record in EXACTLY the
//! shape `@podium/logger` writes, in the same directory the server family logs
//! to (`<state dir>/logs/`). One shape, one place, one reader: `podium logs
//! desktop-native` and `podium logs server` render through the same code.
//!
//! WHY A HAND-ROLLED SINK RATHER THAN A LOGGING CRATE. The record shape is the
//! contract (`ts`/`level`/`ns`/`msg`/`role`/`v`/`err` + free-form fields), and
//! every off-the-shelf backend wants to own the line format. What is worth
//! reusing is the `log` FACADE — so call sites stay `log::warn!(…)` and nothing
//! in `main.rs` knows this file exists — not somebody else's formatter. The
//! whole sink below is a couple of hundred lines and adds one 0-dependency crate
//! (`log`) rather than a tree.
//!
//! ROLE IS `desktop-native`, NOT `desktop`. The webview ships `apps/web` and
//! forwards its own records under its own role; these are the records from the
//! process that OUTLIVES and SUPERVISES that webview. Interleaving them would
//! merge two investigations into one haystack, which is the exact mistake the
//! server's per-origin client files exist to avoid.
//!
//! SERVER-VISIBILITY, AND THE ONE HOP THAT IS NOT SYNCHRONOUS. Records land in
//! the state dir the local server also uses, so in the ordinary (embedded
//! backend) install `podium logs` already sees them. Crashes need more than
//! visibility on the machine, so a panic ALSO goes on a small pending queue that
//! the next launch hands to the webview, which posts it to `logs.crash` — the
//! standard native-crash pattern, because a process that is aborting cannot make
//! an authenticated HTTP call. See [`take_pending_crashes`].

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::bootstrap::state_dir;

/// What these records call themselves, in the log file and on the wire.
pub const ROLE: &str = "desktop-native";
/// `<state dir>/logs/desktop-native.ndjson` — the live file.
pub const LOG_FILE_STEM: &str = "desktop-native";
/// 10 MiB per file, matching `@podium/logger/node`'s `DEFAULT_MAX_BYTES`.
pub const MAX_BYTES: u64 = 10 * 1024 * 1024;
/// Live file plus `.1` … `.4`, matching `DEFAULT_MAX_FILES`.
pub const MAX_FILES: usize = 5;
/// Panics awaiting a hand-off to the webview, oldest dropped past the bound.
/// Small on purpose: this is a crash-loop backstop, not an archive — the full
/// history is in the NDJSON file next to it.
pub const MAX_PENDING_CRASHES: usize = 10;

fn log_dir() -> PathBuf {
    state_dir().join("logs")
}

fn live_log_path() -> PathBuf {
    log_dir().join(format!("{LOG_FILE_STEM}.ndjson"))
}

fn pending_crash_path() -> PathBuf {
    log_dir().join(format!("{LOG_FILE_STEM}-pending-crashes.ndjson"))
}

// ---------------------------------------------------------------------------
// Pure record assembly
// ---------------------------------------------------------------------------

/// `podium_desktop::updater` → `desktop:updater`; the crate root → `desktop:shell`.
///
/// The namespace is the column every log query groups by, so it is derived from
/// the module path rather than typed at each call site: a namespace somebody has
/// to remember to write is a namespace that drifts.
pub fn namespace_for_target(target: &str) -> String {
    let leaf = target.rsplit("::").next().unwrap_or(target);
    match leaf {
        // The binary crate root is where supervision lives; `main` names the
        // function, `shell` names the thing a reader is looking for.
        "" | "main" | "podium_desktop" | "podium-desktop" => "desktop:shell".to_string(),
        other => format!("desktop:{other}"),
    }
}

/// The five levels of the spec, spelled exactly as the record shape spells them.
///
/// `log` has no `trace`-below level and no level ABOVE error, so this total
/// mapping is a rename rather than a lossy projection.
pub fn level_name(level: log::Level) -> &'static str {
    match level {
        log::Level::Error => "error",
        log::Level::Warn => "warn",
        log::Level::Info => "info",
        log::Level::Debug => "debug",
        log::Level::Trace => "trace",
    }
}

/// `PODIUM_LOG_LEVEL` (the logger core's own global switch) → a filter.
///
/// The per-namespace `PODIUM_LOG` syntax is deliberately NOT implemented here:
/// this process has three namespaces, and a half-implementation of an override
/// grammar is worse than an honest global level.
pub fn level_filter_from_env(raw: Option<&str>) -> log::LevelFilter {
    match raw.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
        Some("error") => log::LevelFilter::Error,
        Some("warn") => log::LevelFilter::Warn,
        Some("info") => log::LevelFilter::Info,
        Some("debug") => log::LevelFilter::Debug,
        Some("trace") => log::LevelFilter::Trace,
        Some("silent") | Some("off") => log::LevelFilter::Off,
        // Unrecognized is treated as unset rather than as "off": a typo in a
        // debug env var must not be the reason a crash went unrecorded.
        _ => log::LevelFilter::Info,
    }
}

/// Days since the Unix epoch → (year, month, day).
///
/// Howard Hinnant's `civil_from_days`, which is exact for every date the epoch
/// can express. Written out rather than pulled in with a date crate: this is the
/// only date arithmetic in the process, and `chrono` is a dependency tree.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Epoch milliseconds → `2026-08-11T14:03:22.847Z`.
///
/// ISO-8601 with MILLISECOND precision and a `Z`, because that is what the
/// record shape says and what `renderLogLine` slices columns out of by index.
pub fn format_timestamp(epoch_millis: i64) -> String {
    let (days, millis_of_day) = (
        epoch_millis.div_euclid(86_400_000),
        epoch_millis.rem_euclid(86_400_000),
    );
    let (y, m, d) = civil_from_days(days);
    let (hh, mm, ss, ms) = (
        millis_of_day / 3_600_000,
        (millis_of_day / 60_000) % 60,
        (millis_of_day / 1000) % 60,
        millis_of_day % 1000,
    );
    format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}.{ms:03}Z")
}

fn now_millis() -> i64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis().min(i64::MAX as u128) as i64,
        // A clock before 1970 is a broken clock, not a reason to lose the record.
        Err(_) => 0,
    }
}

/// One NDJSON line, keys in wire order (`ts`, `level`, `ns`, `msg` first) so a
/// raw `tail` is readable by eye — the same ordering `buildRecord` guarantees.
///
/// ASSEMBLED FIELD BY FIELD rather than through a `serde_json::Map`, and not for
/// speed: without the `preserve_order` feature that map is a `BTreeMap`, so a
/// serialized object comes out ALPHABETICAL — `level, msg, ns, role, ts, v` —
/// and the one property that makes a raw log tail readable would have been lost
/// silently. Every VALUE still goes through `serde_json`, so a stack trace full
/// of quotes and newlines cannot corrupt the file; only the key order is ours.
pub fn render_record(
    ts: &str,
    level: &str,
    ns: &str,
    msg: &str,
    version: &str,
    err: Option<serde_json::Value>,
) -> String {
    let quote = |value: &str| {
        serde_json::to_string(value).unwrap_or_else(|_| "\"<unserializable>\"".to_string())
    };
    let mut line = String::with_capacity(msg.len() + 160);
    line.push('{');
    for (key, value) in [
        ("ts", quote(ts)),
        ("level", quote(level)),
        ("ns", quote(ns)),
        ("msg", quote(msg)),
        ("role", quote(ROLE)),
        ("v", quote(version)),
    ] {
        if line.len() > 1 {
            line.push(',');
        }
        line.push_str(&format!("\"{key}\":{value}"));
    }
    if let Some(err) = err {
        let rendered = serde_json::to_string(&err).unwrap_or_else(|_| "null".to_string());
        line.push_str(&format!(",\"err\":{rendered}"));
    }
    line.push('}');
    line
}

/// A panic payload (`&str` or `String`, the only two `panic!` produces) as text.
/// Anything else is described rather than dropped, so an exotic payload still
/// leaves a record that says a panic happened.
pub fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "panic with a non-string payload".to_string()
    }
}

/// The caps `logs.crash` enforces on `err`: `MAX_TEXT` and `MAX_TEXT * 4` in
/// packages/commands/src/logs/contracts.ts.
///
/// THE SERVER REFUSES AN OVERSIZED RECORD RATHER THAN TRUNCATING IT, which is
/// right for a server (a truncated stack lies about where it ends) and fatal
/// here if the producer ignores it: a symbol-rich backtrace over 32 KiB makes
/// the next launch's replay 400 on every attempt, the hand-off script swallows
/// the failure, and the pending queue was already cleared — so precisely the
/// RICHEST crashes would be the ones that never reach the server. The producer
/// CAN know what it meant, so it clamps here and says so in the text, the same
/// bargain `toForwarded` strikes on the TypeScript side.
pub const MAX_ERR_MESSAGE: usize = 8192;
pub const MAX_ERR_STACK: usize = 8192 * 4;

/// `value` cut to at most `max` BYTES, ending in `marker` when anything was cut.
///
/// The cut lands on a char boundary (a `String` sliced mid-codepoint panics —
/// inside the panic hook, which would be a crash reporter that crashes), and the
/// marker is counted INSIDE the budget rather than appended past it, so the
/// result is always acceptable to the contract.
pub fn clamp_text(value: &str, max: usize, marker: &str) -> String {
    if value.len() <= max {
        return value.to_string();
    }
    let budget = max.saturating_sub(marker.len());
    let mut end = budget.min(value.len());
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{marker}", &value[..end])
}

/// The `err` object for a panic, in the logger's `SerializedError` shape.
///
/// `name: "RustPanic"` rather than `Error`: a reader grouping crash events by
/// error name must be able to see at a glance that this one came from the native
/// shell and not from the webview's JavaScript.
///
/// Both text fields are clamped to what the crash contract accepts — see
/// [`MAX_ERR_MESSAGE`] for why an unclamped one loses the whole report.
pub fn panic_error_value(
    message: &str,
    location: Option<String>,
    backtrace: &str,
) -> serde_json::Value {
    let where_ = location.unwrap_or_else(|| "unknown location".to_string());
    serde_json::json!({
        "name": "RustPanic",
        "message": clamp_text(
            &format!("{message} (at {where_})"),
            MAX_ERR_MESSAGE,
            "… [message truncated]",
        ),
        // The stack is prefixed with the panic line so the first line of a stack
        // reads like every other stack: "Name: message", then frames.
        // Truncation is MARKED rather than silent: a reader who sees the last
        // frame cut off must be able to tell that from a backtrace that ended.
        "stack": clamp_text(
            &format!("RustPanic: {message}\n    at {where_}\n{backtrace}"),
            MAX_ERR_STACK,
            "\n    … [backtrace truncated]",
        ),
    })
}

// ---------------------------------------------------------------------------
// The rotating NDJSON sink
// ---------------------------------------------------------------------------

/// Size-based rotation with the same policy and the same interrupt-safety as
/// `@podium/logger/node`'s file sink: rename from the OLDEST end, unlink each
/// destination first (Windows `rename` refuses an existing destination), drop
/// the oldest archive rather than shifting it.
fn rotate(path: &Path) {
    let archive = |index: usize| -> PathBuf {
        let mut name = path.as_os_str().to_os_string();
        name.push(format!(".{index}"));
        PathBuf::from(name)
    };
    if MAX_FILES > 1 {
        let _ = fs::remove_file(archive(MAX_FILES - 1));
        for index in (1..MAX_FILES - 1).rev() {
            let _ = fs::remove_file(archive(index + 1));
            let _ = fs::rename(archive(index), archive(index + 1));
        }
        let _ = fs::remove_file(archive(1));
        let _ = fs::rename(path, archive(1));
    }
    let _ = fs::remove_file(path);
}

/// Append one already-rendered line, rotating first if it would not fit.
///
/// NOTHING HERE PROPAGATES A FAILURE, and nothing here retries. A full disk must
/// not take the desktop shell down, and a sink that probes the filesystem on
/// every record turns a full disk into a performance incident on top of a
/// logging one. The stderr mirror below is the degrade path — it is unconditional
/// rather than triggered, so the operator watching a terminal sees every record
/// whether or not the file write worked.
fn append_line(path: &Path, line: &str) {
    append_line_bounded(path, line, MAX_BYTES)
}

/// The body of [`append_line`] with the rotation threshold as a parameter, so a
/// test can prove the rotation happens without writing ten megabytes to do it.
fn append_line_bounded(path: &Path, line: &str, max_bytes: u64) {
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let existing = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    if existing > 0 && existing + line.len() as u64 + 1 > max_bytes {
        rotate(path);
    }
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) {
        // One write per record, no buffering: the panic hook's own last record
        // has to be on disk BEFORE the process dies, and a buffered writer loses
        // precisely the records worth having.
        let _ = file.write_all(line.as_bytes());
        let _ = file.write_all(b"\n");
    }
}

/// Cap the pending-crash queue at [`MAX_PENDING_CRASHES`], oldest dropped.
/// PURE so the bound is testable without a filesystem.
pub fn bounded_pending(existing: &str, line: &str) -> String {
    let mut lines: Vec<&str> = existing.lines().filter(|l| !l.trim().is_empty()).collect();
    lines.push(line);
    let start = lines.len().saturating_sub(MAX_PENDING_CRASHES);
    let mut out = lines[start..].join("\n");
    out.push('\n');
    out
}

fn queue_pending_crash(line: &str) {
    let path = pending_crash_path();
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let existing = fs::read_to_string(&path).unwrap_or_default();
    let _ = fs::write(&path, bounded_pending(&existing, line));
}

/// Read and CLEAR the queue of panics recorded since the last successful
/// hand-off. Called once at launch; the records are embedded in the webview's
/// init script, which posts them to `logs.crash`.
///
/// AT-MOST-ONCE ON PURPOSE. Clearing before the post means a failed post loses
/// the server-side crash EVENT — but never the record itself, which is already
/// in `desktop-native.ndjson` on the same disk. The alternative (clear on ack)
/// buys one retry and pays for it with a queue that a server which is down for a
/// week replays in full, out of order, into an incident that has passed.
pub fn take_pending_crashes() -> Vec<serde_json::Value> {
    let path = pending_crash_path();
    let Ok(text) = fs::read_to_string(&path) else {
        return Vec::new();
    };
    let _ = fs::remove_file(&path);
    text.lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .collect()
}

// ---------------------------------------------------------------------------
// The `log` facade backend
// ---------------------------------------------------------------------------

struct NdjsonLogger {
    version: String,
    path: PathBuf,
    /// Serializes the read-size-rotate-append sequence. Rotation is not atomic,
    /// and the supervision threads log concurrently.
    write_lock: Mutex<()>,
}

impl log::Log for NdjsonLogger {
    fn enabled(&self, _metadata: &log::Metadata) -> bool {
        // The global max level filter (set in `init`) already decided; a second
        // check here would only be a place for the two to disagree.
        true
    }

    fn log(&self, record: &log::Record) {
        let ns = namespace_for_target(record.target());
        let msg = record.args().to_string();
        let level = level_name(record.level());
        let line = render_record(
            &format_timestamp(now_millis()),
            level,
            &ns,
            &msg,
            &self.version,
            None,
        );
        {
            let _guard = self.write_lock.lock().unwrap_or_else(|e| e.into_inner());
            append_line(&self.path, &line);
        }
        // The stderr mirror keeps the shape every existing `[podium-desktop] …`
        // line had, so a developer running `tauri dev` and an operator reading
        // `<role>.log` both see what they saw before this chunk.
        eprintln!("[podium-desktop] {} {ns} {msg}", level.to_uppercase());
    }

    fn flush(&self) {}
}

static LOGGER: OnceLock<NdjsonLogger> = OnceLock::new();
static PANIC_HOOK_INSTALLED: AtomicBool = AtomicBool::new(false);

/// Install the NDJSON backend and the panic hook. Idempotent, and never fatal:
/// a shell that cannot install a logger still has to start.
pub fn init(version: &str) {
    let logger = LOGGER.get_or_init(|| NdjsonLogger {
        version: version.to_string(),
        path: live_log_path(),
        write_lock: Mutex::new(()),
    });
    let level = level_filter_from_env(std::env::var("PODIUM_LOG_LEVEL").ok().as_deref());
    // `set_logger` refuses a second call; that is the idempotence, not an error.
    if log::set_logger(logger).is_ok() {
        log::set_max_level(level);
    }
    install_panic_hook(version.to_string());
}

/// Record panics as `error` records with a full `err` payload, then queue them
/// for the next launch's hand-off to the server.
///
/// THE HOOK RUNS EVEN THOUGH RELEASE BUILDS ABORT ON PANIC. `panic = "abort"`
/// aborts AFTER the hook returns, so the record and the queue entry are already
/// on disk — which is the whole reason to write synchronously and unbuffered.
///
/// The previous hook is CHAINED rather than replaced, so the default message on
/// stderr (and anything Tauri installed) still happens.
pub fn install_panic_hook(version: String) {
    if PANIC_HOOK_INSTALLED.swap(true, Ordering::SeqCst) {
        return;
    }
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let message = panic_message(info.payload());
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()));
        let backtrace = std::backtrace::Backtrace::force_capture().to_string();
        let err = panic_error_value(&message, location, &backtrace);
        let line = render_record(
            &format_timestamp(now_millis()),
            "error",
            "desktop:panic",
            "native shell panicked",
            &version,
            Some(err),
        );
        append_line(&live_log_path(), &line);
        queue_pending_crash(&line);
        previous(info);
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamp_is_iso8601_with_milliseconds() {
        assert_eq!(format_timestamp(0), "1970-01-01T00:00:00.000Z");
        // 2026-08-11T14:03:22.847Z — the record shape's own example.
        assert_eq!(
            format_timestamp(1_786_457_002_847),
            "2026-08-11T14:03:22.847Z"
        );
    }

    #[test]
    fn timestamp_survives_a_leap_day() {
        // 2024-02-29T23:59:59.999Z: the date arithmetic is written out by hand,
        // so the case it would get wrong is asserted rather than assumed.
        assert_eq!(
            format_timestamp(1_709_251_199_999),
            "2024-02-29T23:59:59.999Z"
        );
    }

    #[test]
    fn namespace_comes_from_the_module_path() {
        assert_eq!(
            namespace_for_target("podium_desktop::updater"),
            "desktop:updater"
        );
        assert_eq!(
            namespace_for_target("podium_desktop::bootstrap"),
            "desktop:bootstrap"
        );
        assert_eq!(namespace_for_target("podium_desktop"), "desktop:shell");
        assert_eq!(namespace_for_target("main"), "desktop:shell");
    }

    #[test]
    fn unrecognized_level_falls_back_to_info_not_off() {
        assert_eq!(
            level_filter_from_env(Some("debug")),
            log::LevelFilter::Debug
        );
        assert_eq!(level_filter_from_env(Some("WARN")), log::LevelFilter::Warn);
        assert_eq!(
            level_filter_from_env(Some("nonsense")),
            log::LevelFilter::Info
        );
        assert_eq!(level_filter_from_env(None), log::LevelFilter::Info);
        assert_eq!(level_filter_from_env(Some("off")), log::LevelFilter::Off);
    }

    #[test]
    fn record_leads_with_the_wire_order_and_escapes_its_text() {
        let line = render_record(
            "2026-08-11T14:03:22.847Z",
            "warn",
            "desktop:shell",
            "quote \" and newline \n inside",
            "0.1.0",
            None,
        );
        assert!(line.starts_with(
            r#"{"ts":"2026-08-11T14:03:22.847Z","level":"warn","ns":"desktop:shell","msg":"#
        ));
        assert!(!line.contains('\n'), "a record must be ONE ndjson line");
        let parsed: serde_json::Value = serde_json::from_str(&line).expect("valid json");
        assert_eq!(parsed["msg"], "quote \" and newline \n inside");
        assert_eq!(parsed["role"], ROLE);
        assert_eq!(parsed["v"], "0.1.0");
    }

    #[test]
    fn panic_payloads_of_both_shapes_are_readable() {
        let str_payload: Box<dyn std::any::Any + Send> = Box::new("static message");
        let string_payload: Box<dyn std::any::Any + Send> = Box::new(String::from("owned message"));
        let other_payload: Box<dyn std::any::Any + Send> = Box::new(7u8);
        assert_eq!(panic_message(str_payload.as_ref()), "static message");
        assert_eq!(panic_message(string_payload.as_ref()), "owned message");
        assert!(panic_message(other_payload.as_ref()).contains("non-string"));
    }

    #[test]
    fn panic_error_names_itself_rust_and_keeps_the_location() {
        let err = panic_error_value("boom", Some("src/main.rs:12:5".into()), "  frame one");
        assert_eq!(err["name"], "RustPanic");
        assert!(err["message"]
            .as_str()
            .unwrap()
            .contains("src/main.rs:12:5"));
        let stack = err["stack"].as_str().unwrap();
        assert!(stack.starts_with("RustPanic: boom"));
        assert!(stack.contains("frame one"));
    }

    #[test]
    fn an_oversized_panic_stays_inside_what_the_crash_contract_accepts() {
        // The failure this pins: a symbol-rich backtrace over the contract's
        // 32 KiB stack cap makes `logs.crash` refuse the replay forever, and the
        // pending queue is already cleared by then — the record is lost.
        let message = "b".repeat(MAX_ERR_MESSAGE * 2);
        let backtrace = "    at frame\n".repeat(MAX_ERR_STACK / 4);
        let err = panic_error_value(&message, Some("src/main.rs:1:1".into()), &backtrace);
        let (msg, stack) = (
            err["message"].as_str().unwrap(),
            err["stack"].as_str().unwrap(),
        );
        assert!(msg.len() <= MAX_ERR_MESSAGE, "message {} bytes", msg.len());
        assert!(stack.len() <= MAX_ERR_STACK, "stack {} bytes", stack.len());
        // Clamped, not silently cut: the reader can tell a cut stack from an end.
        assert!(msg.ends_with("[message truncated]"));
        assert!(stack.ends_with("[backtrace truncated]"));
        // And the part that identifies the crash survives the clamp.
        assert!(stack.starts_with("RustPanic: bbb"));
    }

    #[test]
    fn clamping_never_splits_a_multibyte_character() {
        // A panic message is arbitrary text, so it can be non-ASCII, and slicing
        // a String mid-codepoint PANICS — inside the panic hook.
        let value = "é".repeat(64); // 128 bytes, no char boundary at an odd index
        let clamped = clamp_text(&value, 41, "…"); // "…" is itself 3 bytes
        assert!(clamped.len() <= 41);
        assert!(clamped.ends_with('…'));
        assert!(clamped.starts_with("éé"));
        // Under the cap it is returned untouched, marker and all.
        assert_eq!(clamp_text("short", 41, "…"), "short");
    }

    /// A scratch directory that does not depend on a random-number crate: the
    /// caller's name plus the process id is unique enough for a test binary.
    fn scratch_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("podium-desktop-log-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    #[test]
    fn rotation_archives_the_live_file_and_keeps_the_newest_record() {
        let dir = scratch_dir("rotation");
        let path = dir.join("desktop-native.ndjson");
        // 24 bytes each; a 40-byte budget fits one and rotates on the second.
        append_line_bounded(&path, "first-record-0123456789", 40);
        append_line_bounded(&path, "second-record-012345678", 40);
        let live = fs::read_to_string(&path).expect("live file");
        let archived = fs::read_to_string(dir.join("desktop-native.ndjson.1")).expect("archive");
        assert_eq!(live.trim(), "second-record-012345678");
        assert_eq!(archived.trim(), "first-record-0123456789");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_record_that_fits_never_rotates() {
        let dir = scratch_dir("no-rotation");
        let path = dir.join("desktop-native.ndjson");
        append_line_bounded(&path, "one", MAX_BYTES);
        append_line_bounded(&path, "two", MAX_BYTES);
        assert_eq!(fs::read_to_string(&path).unwrap(), "one\ntwo\n");
        assert!(!dir.join("desktop-native.ndjson.1").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn pending_queue_drops_the_oldest_past_the_bound() {
        let mut text = String::new();
        for index in 0..(MAX_PENDING_CRASHES + 5) {
            text = bounded_pending(&text, &format!("crash-{index}"));
        }
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), MAX_PENDING_CRASHES);
        assert_eq!(lines[0], format!("crash-{}", 5));
        assert_eq!(
            lines[MAX_PENDING_CRASHES - 1],
            format!("crash-{}", MAX_PENDING_CRASHES + 4)
        );
    }
}
