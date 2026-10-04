# Palette and populated group latency

Both matched-corpus medians beat the historical OLD targets: palette
**64.9 ms** versus **111 ms**, populated-group expansion **79.4 ms** versus
**101 ms**, n=16 each. The group fix is already landed on
`integrate/4286-pilot`; palette landing is ready. Final live A1 OFF / ON
measurements remain pending, so this checkpoint claims corpus acceptance only.

## Baseline before changing the code

The first re-measurement of the then-current pilot, `9f9be4d761`, already
included the old-store deletion `e22a8b6bd9`: palette **150.6 ms**, populated
group **208.1 ms**, n=8 each. Deletion alone had not removed either cost.
Later pilot `6009e5acaa` measured palette 68.6 ms / group 186.0 ms, n=8.
These moving-pilot observations are descriptive, not a causal menu comparison.

POD-5501's complete OLD / untouched `96f705cd4e` web 1x pair, reported on
2026-10-04 at 19:38 UTC, is the stronger independent baseline:

| Action | OLD p50 / p95 | Untouched pilot p50 / p95 | OLD → pilot CPU p50 | n per arm |
|---|---:|---:|---:|---:|
| Palette open | 96.7 / 416.9 ms | 135.5 / 451.1 ms | 87.3 → 120.1 ms | 16 |
| Populated group expand | 93.2 / 131.6 ms | 242.8 / 339.7 ms | 88.7 → 219.7 ms | 16 |

Its earlier n=8 palette improvement did not persist in the complete n=16
aggregate. My own 160.3 ms palette capture at `84abd07618` contained a newly
introduced, unscoped projection-owner cleanup; it was **not** untouched pilot.
That cleanup was scoped to opted-in retained projections before landing.
Palette query-to-results search is separate work in POD-5553; POD-5501 was informed.

## Causes and OFF controls

The group matrix uses one pilot base, `96f705cd4e`, the same minified production
build configuration and the same 117-row project group. Each arm changes only
the retention policy relative to the corresponding completed implementation.

| Group policy | Source | n | Input → Paint p50 / p95 | Thread CPU p50 | Input → DOM p50 | Layout CPU p50 |
|---|---|---:|---:|---:|---:|---:|
| Discard DOM | `e47e4067c2` | 8 | 189.6 / 208.3 ms | 183.4 ms | 138.5 ms | 26.5 ms |
| Retain DOM, release projections | `8f279f6649` | 8 | 136.3 / 157.1 ms | 131.6 ms | 90.3 ms | 25.3 ms |
| Retain DOM and lazy projections | `84abd07618` | 16 | **82.0 / 122.1 ms** | **75.3 ms** | **38.1 ms** | 24.1 ms |

Discarding visited rows repeats React mounts. Keeping only DOM still recreates
the rich row/worktree projections and their MobX computed graph. Turning each
retention layer off restores its cost. Layout stays near 24–27 ms; most of the
saving is before the DOM witness. The later final palette-OFF build, which
includes both group fixes, independently measures group **83.7 / 117.8 ms**,
CPU **71.7 ms**, n=16.

Closing the palette also discarded its observing projection. MobX then
suspended the issue-summary graph; reopening rebuilt thousands of summaries.
The final control keeps the same persistent React owner and all group fixes,
and changes only `retainWhileInactive` from true to false:

| Palette policy | Source / bundle | n | Input → Paint p50 / p95 | Thread CPU p50 |
|---|---|---:|---:|---:|
| Release closed graph (OFF) | `341aa58a72` / `hM0viYmy` | 16 | 146.8 / 364.6 ms | 117.6 ms |
| Retain closed lazy graph (ON) | `a99e1a067d` / `HXUnJNkS` | 16 | **64.9 / 372.3 ms** | **58.8 ms** |

Two extra OFF CPU profiles show 51.9 / 57.3 ms inclusively in the palette
projection, including 33.6 / 32.4 ms in issue summaries. Inclusive times overlap
and are not added together. The corresponding ON profiles
spend only 2.36 / 2.34 ms in that projection, with no sampled bulk issue-summary
work. Timing CPU drops 117.6 → 58.8 ms. The one-flag OFF switch restores the
rebuild cost, establishing the cause alongside the deterministic read guard.
The first cold ON open remains 372.3 ms; retention improves repeated opens and
does not claim to remove first construction. Its p95 is slightly above the OFF
364.6 ms, but below both my fresh OLD p95 of 393.9 ms and POD-5501's complete
OLD p95 of 416.9 ms.

## Resulting behavior and guards

Visited project groups keep physical rows after their closing animation.
Closed panels are hidden, inert and aria-hidden. Row clocks and rich reads
pause; reveal catches up once and reuses unchanged paints. Other folds retain
their existing unmount behavior. The palette shell owns its visited graph;
closing the dialog pauses reads without discarding the summaries. It performs
no summary work before the first open and refreshes dirty data on reveal.
Owner and pool teardown dispose retained observers.

The inactive retained reaction pauses **before** MobX's computed-staleness
check. Pausing only inside the invalidation callback would already have
recomputed hidden rows. This uses MobX 7.0.3's `Reaction.runReaction_` seam;
the focused computed-suspension guard must continue to pass on a MobX upgrade.
Retaining visited DOM and observed graphs spends memory until owner/pool
teardown in exchange for avoiding repeated construction; it is not a first-open
or first-mount optimization.

Foreground focused verification ran only on flatblock in `~/podium-test-5514`,
after `bun run setup:worktree`, using its copied `.toolchain` (Bun 1.4.2):

- Sidebar runtime: 15 passing tests; exact node identity through folds, hidden
  issue/session/clock changes causing zero rich reads or leaf commits, fresh
  reveal, and zero rich work on unchanged reveal.
- Palette runtime: 2 passing tests; stable hover/render settling, zero closed
  summary reads, exactly one changed summary on reopen, fresh displayed title,
  and zero summary reads on unchanged reopen.
- Runtime projections: 10 passing tests, including computed suspension.
- Host projections: 9 passing tests, including retained-owner teardown.
- Filtered client-graph typecheck: 9/9 tasks successful, concurrency 1.
- Filtered web typecheck: 15/15 tasks successful, 13 cached, concurrency 1.

These are **36 distinct focused tests**, not a full-suite or my own lean-gate
result. The named files ran through root `bun run test:file -- <paths>`;
typechecks ran through root `bun run typecheck -- --filter <package>
--concurrency=1`. The extra legacy flat-row file fails before assertions because
its pool mock has no `sidebar`; untouched pilot `96f705cd4e` fails identically.
POD-5549 tracks that independent fixture repair. No additional runtime checks
are needed for the final documentation-only revision.

## Live A1 evidence and measurement limits

A1 uses an isolated, minified production preview on ludovico, Chromium
148.0.7778.96 at 1600 × 1000, proxying the existing live backend on 18787.
It waits for hydration and ten seconds of settling. The command-palette feature
is enabled only in this browser's snapshot response, leaving settings untouched.
All `layout.set` / `layout.clear` writes are held indefinitely inside the browser
and never forwarded, so group preparation and folds cannot alter operator state.
Any visible updater panel is hidden through its tab-local React control only.
The isolated browser and recorded preview PID are closed after each capture.

The successful readiness-only check saw 6,272 issues / 5,238 sessions and a
198-item target group. It contains no timed samples. Earlier no-DOM and DOM-only
live group arms measured 288.3 / 365.9 ms wall p50 and 282.6 / 231.6 ms CPU p50.
The changing loaded host prevents those two wall medians from establishing a
live improvement. Final OFF / ON live arms are pending. A fresh OLD live pair
cannot use today's backend because OLD and current wire versions differ.

The matched corpus is seed 4443, 4,867 issues / 4,304 sessions, plus the harness's
control rows. SHA-256:
`2458ea73e0e6182b8f67ae7b0aa618e882fcb60bc9dd9eaf5778e42e1261363e`.
The corpus lane uses Chromium 153.0.8010.12 on flatblock, web 1x, 1800 × 1000,
reduced motion, and the original performance-panel configuration. OLD wire 3
and current wire 4 use the matched corpus normalization. A visited group is
prepared before repeated captures; every unprofiled palette open, including
the first open, is included. Trusted input timestamps, a semantic DOM witness
and actual Chromium Paint bound each interval; CPU uses Chrome thread time.

Two extra CPU profiles per action are excluded from quantiles (100 µs corpus,
1 ms A1); no unprofiled cold sample or outlier is removed. Quantiles are sorted
`min(n-1, floor(q*n))`, so p95 at n=16 is the maximum. These small samples have
no confidence interval, and `bench:flatblock` serializes timing without making
either shared host idle. The lease covers timing captures only and is released
at capture end. Only recorded owned PIDs are stopped; no stash is used.

The corpus final OFF capture has two understood synthetic-target 404s
(`issues.markRead`, `sessions.transcriptRead`), recorded as diagnostics;
there are no unavailable actions. Service-worker blocking and WebGL readback
warnings are also identified rather than silently dropped. The failed initial live
attempts produced zero gesture samples and are excluded. Readiness now waits
for attached groups and explicitly scrolls the target header into view; an
initially folded sidebar is expanded only inside the protected browser. Vite's
`/podium-build.json` intentionally proxies the backend stamp, so frontend
provenance is verified against served HTML and JavaScript bytes instead. The
preview refuses port fallback. This corrected readiness-only check succeeded.

Raw traces, source maps, control builds and collectors stay in this issue's
ignored `.artifacts/pod-5514` and its owned flatblock checkout. Raw live evidence
stays local; the final companion aggregate publishes numeric counts/timings and
build provenance only. Group support landed at `c624fdca39`; the test helper type
fix `a77c665534` is preserved in pilot. Final palette landing is pending,
ff-only on `integrate/4286-pilot` under its canonical merge mutex.
