# Stage 0 control baseline (round-two CONTROL)

Measured tree: `ccf9b8155` on `issue/4425-stage-0-control-baseline`, built off
`dev/mw` (`bccac0120`) with seven verified Stage 0 fix branches merged locally.
Nothing in this tree has landed on `dev/mw` or `main`. This document is the
CONTROL baseline for prototype round two; the round-two candidate is judged
against THESE numbers, not against post-B (`docs/measurements/POD-4358-post-b-baseline.md`).
No credit to any library: all movement below is from the hand-written fixes.

As-of: 2026-09-20T18:52:02Z (frozen pass B warm capture end; UTC).
Bundle `index-6g_p9y19.js`, production React, Chromium 148.0.7778.96
(same major browser as post-B).

## What the tree contains

- `issue/4418-pilot-code-removal-from-dev-mw` — prototype removed (4,655 lines).
- `issue/4419-mission-root-index-per-snapshot` + `issue/4432-mission-index-fast-path-uncovered`
  (S1: mission issue index built once per snapshot; 4432 guards the fast path
  with a comparison counter and supersedes 4419).
- `issue/4420-selection-out-of-worklist-derive` (S2: selection post-pass, one
  derive per click instead of two).
- `issue/4421-memoized-rows-with-narrow-props` (S3: memoized rows, narrow props).
- `issue/4422-issue-chip-signature-memo` (S4: chip signature memo).
- `issue/4423-one-publication-per-click` (S5: one synchronous publication per click).
- `issue/4417-salvage-fixes-off-integration-branch` (evidence docs plus the
  reactions/issue-views fixes).

## Merge conflicts resolved (a finding, not just bookkeeping)

1. **4419 vs 4432** (`packages/client-core/src/viewmodels/mission.ts`,
   `mission.test.ts`): both branched the S1 index off `dev/mw` and diverged.
   Resolved by taking the 4432 tree wholesale — it contains the S1 share plus
   the guard, so nothing was lost. Textual conflict only.
2. **4418 vs 4423** (`packages/client-core/src/engine/runtime.test.ts`): 4418
   deleted the D4 pilot block that 4423's branch still carried, while 4423
   appended the S5 A/B block at the file tail. Resolved by keeping 4418's
   deletion and re-applying only 4423's additive S5 block (195 lines, no
   prototype references — verified by grep). Textual conflict only.
3. **4420 vs 4421 (semantic watch)**: 4420 changed what the worklist slice
   hands the rows; 4421 changed what the rows expect. Merged textually clean,
   and the combined tree proves the pair compatible: typecheck 26/26 with
   cache bypassed, plus `selection.test.ts`, `UnifiedIssueRow.memo.test.tsx`
   and `use-unified-work.navigation.test.tsx` all green on the merged tree.
   No incompatibility found; no fix pair was rejected.

Soundness proof on the combined tree before measuring: `bun run typecheck --
--uncached-because="POD-4425 combined Stage 0 tree must not ride a cache hit"`
(26 successful, 0 cached) and the focused suites each fix shipped with —
`mission.test.ts` + `selection.test.ts` + `actions.test.ts` (318 passed),
`issue-chip-refs.test.ts` (6), `UnifiedIssueRow.memo` + `use-unified-work.navigation`
(4), `issue-views.test.ts` (41), `runtime.test.ts` (135, including the S5
`3 -> 1` and 4417 armed counterfactuals), `WorkScreen.memo.test.tsx` (1).

## Method

Same C1/post-B collector, unchanged scripts (`capture.ts`, `build.ts`,
`analyze.ts`, seven-line probe patch — archived with the evidence): production
build via `bun scripts/test-heavy.ts -- bun .b13/build.ts`; loopback preview
`:55658` proxying the unchanged live backend `:18787`; fresh authenticated
contexts; 10 s settle; 65.8 s connected/disconnected/reconnected windows;
30 cold switches across six session-backed rows then 14 warm switches across
two rows, 1500 ms dwell; service workers blocked; 1600x1000, no throttling.
Temporary probe removed after measuring; the frozen tree above is the
un-probed source.

Two full passes were run (A then B), each cold-plus-warm, for a stability
read. **Pass B is frozen below** (complete profile set on disk); pass A is the
repeat. Differences between passes are reported, not averaged away.

Hygiene: `bench:ludovico` acquired around each timing process and released
between scenarios (four leases total); `uptime` recorded with every
measurement (see load log). Lock discipline did not exclude the other
benchmarking worker's traffic — see confounds.

Corpus at measure time: 4,968 issues, 4,426 sessions, 505 repos, 2,227 open,
211 visible rows, 6 machines (post-B: 4,887 / 4,323 / 501 / 2,229 / 211 / 6).
Live events, targets and shared-host load are not frozen: timings describe
each run. Operation counts from the armed unit tests carry the causal claims.

## Host work comparison

New column is run B; buckets use the same stack unions as post-B. Scans are
`hostSessions.materialScan` selector runs (new sessions array), builds are
`hostSessions.aggregateBuild` material rebuilds. Scan/build volume tracks
background session traffic (see confounds), not gesture count.

| Window | post-B duration s | Stage 0 duration s | post-B machine facts ms | Stage 0 machine facts ms | Stage 0 host total ms | Material scans / builds |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| connected-idle | 66.48 | 66.30 | 2.07 | 164.50 | 273.60 | 31 / 16 |
| disconnected-idle | 66.11 | 66.70 | 1.07 | 0.00 | 0.00 | 0 / 0 |
| activity | 66.10 | 66.20 | 7.52 | 99.90 | 171.40 | 25 / 11 |
| cold-rotation | 136.20 | 131.50 | 313.44 | 358.70 | 652.80 | 54 / 9 |
| warm-rotation | 50.93 | 65.70 | 86.89 | 191.50 | 305.70 | 21 / 4 |

The disconnected control is exact: one `coarseNow` publication, zero scans,
zero builds, zero drops — the clock-only path Phase B fixed is still clean on
the combined tree. All other windows carried heavy background session/machine/
issue/draft traffic (e.g. cold-rotation incidence: sessions 94, drafts 43,
issues 37, machines 32), which drives scans; builds fire only on material
changes (live agents changing phase while other workers benchmark).

## Switch and publication baseline (frozen: pass B)

| Window | Publications | Worklist derives / ms | Switch traces / timeouts | Switch p50 / p95 ms |
| --- | ---: | ---: | ---: | ---: |
| connected-idle | 78 | 47 / 7476.20 | — | — |
| disconnected-idle | 1 | 1 / 138.00 | — | — |
| activity | 57 | 42 / 6204.40 | — | — |
| cold-rotation | 245 | 66 / 10101.40 | 30 / 15 | 697.00 / 1266.50 |
| warm-rotation | 98 | 55 / 8583.30 | 14 / 2 | 407.30 / 597.50 |

Repeat (pass A) and post-B reference:

| Window | Pass A pubs / derives | Pass A switches (traces/timeouts/p50/p95) | post-B pubs / derives | post-B switches |
| --- | --- | --- | --- | --- |
| connected-idle | 77 / 56 | — | 28 / 1 | — |
| disconnected-idle | 2 / 2 | — | 1 / 1 | — |
| activity | 83 / 63 | — | 30 / 1 | — |
| cold-rotation | 218 / 73 | 30 / 15 / 1029.20 / 1996.80 | 195 / 75 | 30 / 0 / 1172.00 / 1959.80 |
| warm-rotation | 54 / 17 | 14 / 2 / 431.60 / 805.40 | 68 / 28 | 14 / 0 / 1046.80 / 4471.20 |

Judgement call, stated plainly: **warm is the comparable switch metric**
(p50 ~407-432 vs 1047, p95 ~598-805 vs 4471, replicated across passes with
only 2/14 timeouts). **Cold quantiles carry selection bias**: at 15/30
timeouts, superseded (slow) switches are excluded by the post-B rule, so the
surviving 15 flatter the p50 (697-1029 vs unbiased 1172). The honest cold
claim is weaker: switches did not get slower under ~2x load, with half the
traces superseded by the next click's 1500 ms dwell.

Gesture pubs are exactly one per click in all three runs (30/30 cold,
14/14 warm carry `selectedIssueId`; all three gesture keys ride one
publication). The S5 `3 -> 1` synchronous-pub win is proven by the armed unit
A/B (`runtime.test.ts`: `S5 click A/B sync 3 -> 1`), not by live totals, which
background traffic dominates. Partitioning cold-rotation derives: non-session-
driven derives 38/30 clicks (~1.3/click) vs post-B 69/30 (~2.3/click),
consistent with S2; warm is too background-noisy to partition (see confounds).

## Hotspots: what moved and what did not

Self-time ms per rotation window, post-B vs frozen run B. "Below top-60"
cutoffs: cold 297 ms, warm 144 ms.

| Function | post-B cold | Stage 0 cold | post-B warm | Stage 0 warm | Verdict |
| --- | ---: | ---: | ---: | ---: | --- |
| `missionRootFor` | 4536.3 | below top-60 | 1535.6 | below top-60 | FIXED (S1) |
| `byId` (mission) | 2005.0 | below top-60 | 856.1 | below top-60 | FIXED (S1) |
| `issueReferenceSignature` | 4195.6 | below top-60 | 566.0 | below top-60 | FIXED (S4) |
| `issueKey` | 1940.1 | below top-60 | 330.6 | below top-60 | FIXED (S4) |
| `UnifiedIssueRow` / `origin` | 912.5 (`origin`) | below top-60 | 584.9 / 357.7 | below top-60 | FIXED (S3) |
| `getBoundingClientRect` | 3098.6 | 2568.4 | 1657.6 | 477.6 | MIXED: cold ~flat (-17%), warm down |
| `computeMissionIssueIds` | 2504.1 | 3441.2 | 863.6 | 2468.9 | UP absolute (traffic-driven, see below) |
| `missionIssueIds` | 1502.4 | 2022.2 | 446.6 | 1533.1 | UP absolute (traffic-driven) |
| `indexMissionSessions` | 819.8 | 2166.8 | 284.9 | 651.7 | UP absolute (traffic-driven) |
| `buildFlightDeckRows` | 849.2 | 1335.7 | 251.8 | 618.2 | UP absolute (traffic-driven) |
| `archivedSessionsForIssue` | 2001.8 | 1759.8 | 441.4 | 339.7 | flat to down |
| `renderWithHooks` | 1020.5 | 538.1 | — | 238.3 | down cold |
| `measureBrief` | — | 342.6 | 219.4 | below top-60 | residual remains |

Two facts that look contradictory are not. S1 removed the per-call index
build (`missionRootFor`/`byId` gone from the profile) but member computation
(`computeMissionIssueIds`/`missionIssueIds`) still runs once per
(issue slice, session slice, root) — and the session slice churned 2-8x more
under concurrent-worker traffic (session pubs: cold 43 -> 94-104, warm 4 ->
8-32). Per session-pub, member cost FELL: cold 58 -> 37 ms,
warm 216 -> 77 ms. The unit A/B (`mission.test.ts`: zero builds on repeat
calls, `WeakMap` fast path with zero comparisons) is the causal proof; live
absolute ms follow traffic.

Layout reads are the known NOT-fixed hotspot: POD-4439 (mission brief
re-measuring) was still running at measure time. Cold layout cost is
essentially unchanged (-17%, within load noise); the warm drop plausibly comes
from S3 (fewer row repaints -> fewer forced layouts), not from the brief fix.
Residual `measureBrief` (343 cold) and `getBoundingClientRect` (2568 cold)
remain for POD-4439.

## Confounds and load log (read before citing a number)

1. **Box load.** Another worker benchmarked throughout. `uptime` at each
   phase: build 11.17; cold A start 12.97 -> end 22.96; warm A 9.57 -> 13.70;
   cold B 11.82 -> 14.69; warm B 12.55 -> 14.62 (1-min averages; the cold-A
   spike to ~23 coincides with its 15 timeouts and slowest idle windows).
2. **Background traffic.** Pass A activity caught a 51-session-pub burst;
   pass B cold caught 43 draft pubs from a concurrent operator. Idle-window
   totals swing run to run (connected-idle derives: 56 vs 47; activity pubs:
   83 vs 57) and are not comparable to post-B's quiet box (28/30 pubs).
3. **Timeout selection bias** (above): cold p50/p95 exclude 15 superseded
   traces per the post-B rule.
4. **Corpus drift**: +81 issues, +103 sessions, +4 repos since post-B; same
   211 visible rows, same 6 machines, same browser build.

## Evidence and reversal

Numeric companion: `POD-4286-stage0-live.json` (same schema as
`POD-4358-post-b-live.json`, frozen on pass B; session identifiers omitted as
before). Raw collectors, probe patch, profiles and captures (both passes):
`/home/mgw/pod4286-evidence/stage0-control/` (run A under `runA/`, frozen run
B under `runB/`). Preview bundles/sourcemaps were checkout-local and are
removed. Revert: the seven merges sit on this branch only — `dev/mw` is
untouched, so dropping this branch restores the pre-round-two tree exactly.
