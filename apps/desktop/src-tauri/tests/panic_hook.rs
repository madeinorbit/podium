//! RUNTIME VERIFICATION OF THE PANIC HOOK (chunk 5 of the logging spec).
//!
//! Not a unit test of the record builders — those live next to them. This one
//! makes a REAL panic happen in a REAL process with the hook installed and then
//! reads what is on disk, because every interesting way this feature fails is a
//! way that the pure functions cannot see: a hook that was never installed, a
//! log directory resolved from the wrong base, a record buffered in a writer
//! that a dying process never flushes.
//!
//! It is its OWN test binary on purpose. The hook is process-global and the log
//! path resolves through `PODIUM_STATE_DIR`, so a test that sets that variable
//! has to own the process; sharing one with the unit tests would make both
//! order-dependent.
//!
//! WHAT THIS CANNOT PROVE. Release builds are `panic = "abort"`, and a test
//! harness needs unwinding, so this runs the hook under unwind. The property at
//! stake — the record reaches the disk BEFORE the process goes away — is the
//! same either way: `std` runs the hook to completion before aborting, and the
//! sink writes unbuffered, one `write` per record.

use std::path::PathBuf;

fn scratch_state_dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("podium-desktop-panic-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("scratch state dir");
    dir
}

#[test]
fn a_real_panic_lands_in_the_ndjson_file_and_on_the_pending_queue() {
    let state_dir = scratch_state_dir();
    std::env::set_var("PODIUM_STATE_DIR", &state_dir);

    podium_desktop_lib::logging::install_panic_hook("0.1.0-test".to_string());

    // The default hook still runs (it is chained), so its stderr line is
    // expected output for this test rather than a failure signal.
    let outcome = std::panic::catch_unwind(|| {
        panic!("forced panic for the logging runtime check");
    });
    assert!(outcome.is_err(), "the panic must actually happen");

    let log_path = state_dir.join("logs").join("desktop-native.ndjson");
    let text = std::fs::read_to_string(&log_path)
        .unwrap_or_else(|e| panic!("no native log at {log_path:?}: {e}"));
    let line = text.lines().last().expect("at least one record");
    let record: serde_json::Value = serde_json::from_str(line).expect("the record is valid NDJSON");

    assert_eq!(record["level"], "error");
    assert_eq!(record["ns"], "desktop:panic");
    assert_eq!(record["role"], "desktop-native");
    assert_eq!(record["v"], "0.1.0-test");
    assert_eq!(record["err"]["name"], "RustPanic");
    let message = record["err"]["message"].as_str().expect("a message");
    assert!(
        message.contains("forced panic for the logging runtime check"),
        "the panic payload must survive: {message}"
    );
    // The location is what turns "something panicked" into a place to look.
    assert!(
        message.contains("tests/panic_hook.rs"),
        "location missing: {message}"
    );
    let stack = record["err"]["stack"].as_str().expect("a stack");
    assert!(
        stack.starts_with("RustPanic: forced panic"),
        "stack shape: {stack}"
    );

    // The same record is queued for the next launch's hand-off to `logs.crash`.
    let pending_path = state_dir
        .join("logs")
        .join("desktop-native-pending-crashes.ndjson");
    let pending = std::fs::read_to_string(&pending_path).expect("a pending-crash queue");
    assert_eq!(
        pending.trim(),
        line,
        "the queued crash is the record verbatim"
    );

    // Reading the queue CLEARS it — a crash is handed over once, not on every
    // launch until the end of time.
    let taken = podium_desktop_lib::logging::take_pending_crashes();
    assert_eq!(taken.len(), 1);
    assert_eq!(taken[0]["err"]["name"], "RustPanic");
    assert!(
        !pending_path.exists(),
        "the queue is cleared by the hand-off"
    );
    assert!(
        podium_desktop_lib::logging::take_pending_crashes().is_empty(),
        "a second read finds nothing"
    );

    let _ = std::fs::remove_dir_all(&state_dir);
}
