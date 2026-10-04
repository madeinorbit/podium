# Palette and populated group latency

Both matched-corpus medians beat the historical OLD targets: palette
**64.9 ms** versus **111 ms**, populated-group expansion **79.4 ms** versus
**101 ms**, n=16 each. The group fix is already landed on
`integrate/4286-pilot` at `8b62001171`. Live A1 captures and profiles also
completed. They confirm the bulk rebuild can disappear, but their connected
wall-time medians do **not** establish a live gain; that limit is recorded below.

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

The final OFF / ON pair saw **6,282 issues / 5,239–5,240 sessions**, six machines
and ten repository rows. Both arms target the same **198-item group**, with
197 physical issue rows, and have zero page errors. Each browser held one
layout request; neither needed to expand an initially folded sidebar. Served
HTML and primary JavaScript hashes matched the intended archive before any
gesture. Browser credentials remained in memory only.

| A1 arm | Action | n | Paint p50 / p95 | Thread CPU p50 |
|---|---|---:|---:|---:|
| Palette retention OFF | Palette | 16 | 142.2 / 539.5 ms | 110.5 ms |
| Palette retention ON | Palette | 16 | 175.3 / 637.5 ms | 130.3 ms |
| Palette retention OFF, full group retention | Group expand | 16 | 119.0 / 197.0 ms | 114.4 ms |
| Palette retention ON, full group retention | Group expand | 16 | 130.2 / 188.9 ms | 113.3 ms |

**This connected live pair does not establish a wall-time gain.** OFF runs from
21:23 to 21:24 UTC, with one-minute host load 9.78 → 14.8; ON follows at 21:24
with load 14.25 → 14.75. Live publications and the operator's workspace can
change between browsers. The CPU median also increases for palette ON, so
host contention alone is not asserted as its cause. Every primary sample,
including the first cold open, remains in the table.

Live profiles nevertheless verify the intended mechanism: OFF spends
15.65 / 165.06 ms in the palette projection; the second repeats bulk summary
construction and about 188 ms of sampled garbage collection. ON spends
1.12 / 15.09 ms with no sampled bulk issue-summary work. Native `focus` occupies
28–78 ms across the four profiles, and command construction remains substantial.
Inclusive sampled time is approximate, overlaps descendants and is not summed
with thread CPU. POD-5563 records that adjacent focus/command work in Proposed;
it is unclaimed, and no further optimization is claimed here.

Earlier no-DOM and DOM-only A1 group arms measured 288.3 / 365.9 ms wall p50
and 282.6 / 231.6 ms CPU p50. Final full-retention CPU is about 113–114 ms, but
those changing loaded-host observations are not a matched live causal wall-time
comparison. My earlier live pilot palette/group medians were 377.9 / 511.4 ms;
they likewise cannot assign the whole-pilot improvement to this fix alone.
A fresh OLD live pair cannot use today's backend because OLD and current wire
versions differ. Corpus controls and deterministic guards establish the
specific original regression and its removal.

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

The [numeric companion](POD-5514-palette-group-summary.json) publishes counts,
quantiles, source/build provenance and the profile summaries; it omits live
IDs, titles, paths and credentials. Raw traces, source maps, control builds,
collectors and the private readiness diagnostics stay in this issue's ignored
`.artifacts/pod-5514` and its owned flatblock checkout. Raw live evidence stays
local. Public corpus-only review evidence is attached to the issue. Automatic
approval review rejected uploading the combined report because it contains
nonpublic operator-environment measurements beyond the authorized POD-4286
report destination; the combined report and aggregate remain local.

Group support landed at `c624fdca39`, its test helper type correction
`a77c665534` remains in history, and palette code `9ad8abbc77` landed with corpus
report tip `8b62001171`. Both code landings were ff-only on
`integrate/4286-pilot` under its granted canonical merge mutex, with issue-tip
ancestry checked and the lock released. The final documentation-only update
uses the same landing procedure and skips another test run because product
bytes and the validated guards are unchanged. POD-4286 receives the final
landing and measurement report through issue mail.
