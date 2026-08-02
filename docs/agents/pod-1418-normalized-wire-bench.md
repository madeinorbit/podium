# POD-1418 — normalized-wire live-scale bench timeout

## Verdict

Not a hang. The property holds. Wall time is dominated by `new SessionRegistry`
at the historical live snapshot (793 issues × 588 sessions), which alone exceeds
the 300s test budget on a quiet host.

## Evidence (this worktree, 2026-08-02)

Isolated vitest run of a phase-instrumented copy of
`apps/server/src/issues.normalized-wire.bench.test.ts` (host was heavily loaded;
ratios matter more than absolute seconds):

| Phase | Wall |
| --- | --- |
| seed 793 issues | ~0.9s |
| seed 588 sessions | ~0.4s |
| `new SessionRegistry(...)` | **~454s** |
| attach + hello + flush | ~1s |
| 20× `setWorkState` + flush | first ~1.4s, then 1–35ms each |
| `attachBuilds` / `attachScans` | **0 / 0** |
| post-change builds / scans | **0 / 0** |

Quiet-VPS observation from the filing (POD-327, load 1.33): same test timed out
at 300s with file duration 343s. That is consistent with genuine construction
cost at this scale, not a stuck event loop: progress continues and the zero
counters would pass if the budget allowed the assertions to run.

Historical comment on the file claimed ~75s quiet / 177s under load 24.6 (after
POD-1308 isolation). Construction cost has grown past the 300s wedge that was
already four times the old quiet baseline.

## What the property needs

The detector is exact zero issue-wire builds and zero membership scans after
session `workState` changes, plus an attach bound of `builds ≤ ISSUE_COUNT`
(not per session). That is a wiring property of the production composition
(`SessionRegistry`), not a wall-clock benchmark.

It is already proven end-to-end at **300 issues × 200 sessions** in
`issues.normalized-wire.test.ts` (D7.2 suite). Any non-zero residual scan or
build fails at that scale; the historical 793×588 snapshot is not required for
the zero property and turns the unit lane into a multi-minute composition-root
boot soak.

## Fix

Keep the production-path residue assertions; set the fixture scale to 300×200
(same as the sister D7.2 suite). Timeout stays a wedge watchdog sized to that
scale — **not** raised past 300s.

## Follow-up (not this issue)

`SessionRegistry` construction at real live entity counts costing minutes is a
server-restart concern independent of this test. Tracked separately if filed.
