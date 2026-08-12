//! Print the crash hand-off script a REAL panic produces, for runtime
//! verification of the last link in the native crash path.
//!
//! The unit tests prove the panic hook writes a record and the script generator
//! emits the right shape. Neither can prove the two fit together, and that seam
//! is where this feature would fail silently: the script embeds whatever
//! `take_pending_crashes` returns, and a mismatch there produces a script that
//! posts nothing while every test stays green.
//!
//! So this runs the actual hook against an actual panic and prints the actual
//! script to stdout, for a JS runtime to execute against a live server:
//!
//! ```sh
//! PODIUM_STATE_DIR=/tmp/probe cargo run --example native_crash_handoff > handoff.js
//! bun handoff.js   # with a window/fetch shim; see docs/verification/POD-1904
//! ```
//!
//! An example rather than a test because its output IS the artifact — a test
//! that printed a script would be a test with no assertion.

use podium_desktop_lib::{bootstrap, logging};

fn main() {
    logging::install_panic_hook("0.1.0-probe".to_string());

    // A real panic on a real thread, caught so this process survives to print.
    // Release builds abort instead of unwinding; the hook runs either way,
    // BEFORE the abort, which is the property the sink's unbuffered writes buy.
    let outcome = std::panic::catch_unwind(|| {
        panic!("POD-1904 native panic probe");
    });
    assert!(outcome.is_err(), "the probe must actually panic");

    let pending = logging::take_pending_crashes();
    eprintln!("queued crash records: {}", pending.len());
    print!(
        "{}",
        bootstrap::native_crash_report_script(&pending, Some("probe-machine"))
    );
}
