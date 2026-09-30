//! When the host cuts: one clock per host decides when the connections that
//! asked for pictures get a fresh one, so the output after a picture (what a
//! late viewer must replay) stays bounded, at a bounded cost.
//!
//! A cut is due once the output since the last one reaches the larger of
//! [`CUT_BYTES`] and the last picture's size, and [`CUT_GAP`] has passed since
//! it. There is no cut on quiet: a due cut that has to wait for the gap is
//! taken when the gap is up, even if nothing more is written (the host polls
//! for that deadline).

use std::time::{Duration, Instant};

/// The least output between two cuts.
pub const CUT_BYTES: u64 = 64 * 1024;
/// The least time between two cuts.
pub const CUT_GAP: Duration = Duration::from_millis(250);

pub struct CutClock {
    /// When the last cut was taken.
    at: Instant,
    /// The ring's high seq then.
    high: u64,
    /// The size of the last picture serialised.
    last_len: usize,
}

impl CutClock {
    pub fn new(now: Instant) -> CutClock {
        CutClock {
            at: now,
            high: 0,
            last_len: 0,
        }
    }

    /// When the next cut may be taken, once enough output has come for one.
    pub fn due(&self, high: u64) -> Option<Instant> {
        let enough = CUT_BYTES.max(self.last_len as u64);
        (high - self.high >= enough).then_some(self.at + CUT_GAP)
    }

    /// Count from here: a cut was taken, every connection that asked for
    /// pictures just got a reset, or none has asked yet.
    pub fn restart(&mut self, now: Instant, high: u64) {
        self.at = now;
        self.high = high;
    }

    /// The last picture's size raises the output a cut must wait for, so a
    /// large screen is not serialised more often than its size in output.
    pub fn sized(&mut self, len: usize) {
        self.last_len = len;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cut_needs_the_bytes_and_then_the_gap() {
        let t0 = Instant::now();
        let mut c = CutClock::new(t0);
        assert_eq!(c.due(CUT_BYTES - 1), None, "not enough output");
        assert_eq!(
            c.due(CUT_BYTES),
            Some(t0 + CUT_GAP),
            "enough: due at the gap"
        );
        let t1 = t0 + Duration::from_secs(5);
        c.restart(t1, 100_000);
        assert_eq!(
            c.due(100_000 + CUT_BYTES - 1),
            None,
            "counted from the last cut"
        );
        assert_eq!(c.due(100_000 + CUT_BYTES), Some(t1 + CUT_GAP));
    }

    #[test]
    fn a_large_picture_raises_the_bytes_a_cut_waits_for() {
        let t0 = Instant::now();
        let mut c = CutClock::new(t0);
        c.sized(300_000);
        assert_eq!(c.due(299_999), None);
        assert_eq!(c.due(300_000), Some(t0 + CUT_GAP));
        c.sized(10);
        assert_eq!(
            c.due(CUT_BYTES),
            Some(t0 + CUT_GAP),
            "never under CUT_BYTES"
        );
    }
}
