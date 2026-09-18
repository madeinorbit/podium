# Phase C gate — measurement in progress

No operator decision has been made. C2 and D1–D6 remain conditional.

## Comparison lock

Post-Phase-B comparison baseline: `c728e9c252c43110944934b8aedb63603695852d`,
branch `integrate/4286-frontend-perf`, measured from
`issue/4319-c1-phase-b-remeasure-and-gate-decision`. Includes B11 and B12.
Any later pilot must compare with this runtime, not A1; Phase B gains cannot be
credited to a reactive library. A3 uses deterministic CI/live/growth profiles;
A1 used a changing live corpus, with no frozen state snapshot in its archive.

A1 authority: [baseline](POD-4286-baseline.md). A3 authority:
[scenario definitions and frozen ceilings](../../perf/frontend-large-state.md).
Regression ceilings are distinct from acceptance goals: one unrelated-session
derivation meets the current ceiling but fails the zero-derivation target.

## Capture plan

Run the five-file frontend performance lane once with Bun 1.4.2 on Ludovico.
Record publication counts separately from wakes, selectors, derivations, row
builds and React commits. Preserve its armed negative-control result.

Recover A1 collectors before live capture: production Chromium 1600×1000,
hydration plus ten-second settle; connected idle, disconnected control and
ordinary activity windows around 65.8 seconds; six-row cold churn and separate
two-row, fourteen-switch rotation with 1500 ms dwell. Classify cold/warm/timedOut
using current data-issue-row identifiers; never label happy-dom commits paint.
Capture source-mapped worklist, lookup, React commit/layout, transcript and GC
buckets, with overlap explicit. Missing measurements stay missing, never zero.

Per-commit attribution must distinguish original controlled probes from this
rerun. B1 and B2 warm-navigation savings overlap; their reported counts must
not be added. B11 removes unchanged async folds but genuine queue-status
publications still wake generic subscribers.

## Rollback

This issue changes measurement documentation only. Remove the report to revert;
no runtime switch, deployed build or live server change is required.

## Commit attribution ledger

The counterfactuals below are the landed fixes' original focused evidence, not
new C1 ablations. A1 is the only pre-Phase-B live capture. A sequential replay of
all fixes on an identical historical feed is unavailable, so independent live
milliseconds per commit cannot honestly be recovered by subtracting windows.

| Landed commit(s) | Attributable change and evidence | Limit / overlap |
| --- | --- | --- |
| B6 `5c7ab6545` | Superagent input guard depends on its two inputs. Unrelated publications skip derivation. | Does not eliminate session-driven worklist derivation; no independent live time saving measured. |
| B3 `1487cf68b` | Host metrics leave the entity snapshot. C1 A3 observes 0 publications / 0 wakes / 0 derives. | A1 host-only fan-out was 71.2 ms idle / 34.1 ms activity, with zero worklist derives already. Host-indicator rendering can still run. |
| A2 `03960c5e4` | Opt-in boundary counters provide the measurement instrument. | No product speedup claimed. |
| B8 `07d2f50fb` | Repository usage prefix index: three controlled frames drop session visits 6,456,000 → 12,912 and index derives 3 → 0. | A1 repoUsageAt sampled self 11,255 ms is an opportunity, not a guaranteed recovered amount on a different feed. See POD-4340 report. |
| B4 `1e922f3da` | Collection-identity session-by-id map replaces repeated scans at migrated sites. | One index construction still scans; does not cover every session aggregate or prove a live millisecond share. |
| A1 `0af1b787b` | Baseline documentation. | No runtime change. |
| B7 `d56e2d3e8` | Narrows 13 mobile whole-store reads and guards two web selector objects. | Desktop run does not measure mobile gains; no independent CPU share asserted. |
| B9 `f4dac49c4` | Mobile placement fixtures. | Test-only, no speedup. |
| B1 `4a1fbef92`, `181dd8626` | Atomic navigation: original warm 3 → 1 and first-open 5 → 1. | After B2 the legacy warm arm is already 1, first-open 4; credit the warm win once. Independent B1 first-open/cross-worktree contribution remains 4 → 1. |
| B5 `82a1d1964` | For three machine-name or session-diagnostic frames: derives 3 → 0; seven-reader commits 21 → 0. | Material lastActiveAt still invalidates. A1's 850 ms machine-only derives are a historical opportunity, not a C1 causal time measurement. |
| B10 `9cfeaa01b` | Mobile terminal remount assertion. | Test-only, no speedup. |
| B2 `0569c7545` | Synchronous event publications: outbox 2 → 1, fallback 3 → 1, worktree follow 2 → 1, issue follow 4 → 1, prune 2 → 1, visit baseline 3 → 1, session/issue read each 4 → 1. | These events overlap a navigation gesture and B1. Do not add counts or savings across rows. |
| A3 `955be5a0f`, `ca0942e90` | Kernel fixture and frozen ceilings. | Measurement/test changes, no product speedup. |
| B11 `6766e4183` | Original controlled read-before-echo: entity publications 5 → 1, total publications 5 → 3, 23-reader wakes 115 → 69. Async unchanged handoff 1 → 0. C1 A3 echo/rejection each drop total publications 7 → 6 and wakes 35 → 30 versus A3's pre-B11 baseline. | Genuine queue-status publications still wake all five mounted A3 subscribers. The 23-reader original probe and five-reader C1 fixture are distinct cohorts. |
| Coordinator `91808701f`, `04fc64d40`, `b86b105de`, `2ef640ed5` | Type correction and plan corrections. | No separately measured runtime gain. |
| `ffe515c22`, B12 `c728e9c25` | Web baseline report and repair of the material-publish render probe. | Included in pinned baseline; no product performance claim. |
