# Large-state frontend benchmark

## Reproduce the CI baseline

```sh
bun run test:perf:frontend
```

CI's unit job invokes this lane explicitly. It runs five files under Bun/Vitest
and happy-dom, one worker, no retries. The new harness uses the shipped
`createKernelReplica` facade, `ClientRuntime`, kernel outbox state machine,
selectors, worklist slice, `UnifiedIssueRow`, and A2 `StoreStatsProfiler`.
The in-memory cache implements the opened IndexedDB read contract, preserving
untouched row identities. Transport and durable I/O are replaced; worklist and
store code are not mocked. These measurements do not cover IndexedDB latency,
Workspace panel residency, terminal rendering, or browser paint.

| Profile | Issues | Sessions | Repositories | Child worktrees |
| --- | ---: | ---: | ---: | ---: |
| CI (historical fast tier) | 674 | 530 | 12 | 96 |
| Live (A1 cardinalities) | 4867 | 4304 | 500 | 468 |
| Growth | 9734 | 8608 | 1000 | 936 |

All profiles run in the CI lane. Only i0/i1 worklist rows and composer s0 are
mounted. The changed session s2 belongs to i2. Those three issues, sessions and
repositories retain the same neighbourhood as the remaining corpus grows;
additional entities are assigned only to repositories 3 and above. Repository
roots are not included in the child-worktree count.

Fixture values, event order and Date are deterministic. Timer progression is
explicit; performance.now remains real. Each profile records five fresh runtime
mounts and twenty samples per hot scenario. A sample ends after the real kernel
outbox drain, microtasks and React act have settled. Rejections are discarded
between samples, outside their measurement windows, so a parked write cannot
block the next sample. Every scenario asserts its visible/state outcome, not
just an upper-bound count. Publication records retain changed keys and nesting,
separately from subscriber wakes, selector runs, row builds and React commits.

## Frozen deterministic ceilings

These are current-build regression ceilings, independent of profile size. The
zero-work idle and unrelated-delta goals below remain explicit acceptance targets;
a baseline ceiling of one derivation does not mean the zero target passes.

| Scenario | Publishes | Worklist derives | Issue row builds |
| --- | ---: | ---: | ---: |
| Cold mount | 10 | 2 | Exactly profile issue count |
| Unrelated session activity (s2) | 1 | 1 | 1 |
| Draft typing A | 1 | 0 | 0 |
| Host metrics frame | 0 | 0 | 0 |
| coarseNow / otherwise idle minute | 1 | 1 | 0 |
| Worklist row press (two mounted rows) | 1 | 1 | 0 |
| Optimistic rename + echo | 7 | 2 | 1 |
| Optimistic rename + rejection | 7 | 2 | 0 |
| Mixed host/session/draft events | 2 | 1 | 1 |

Every hot sample also forbids full durable-cache scans and dropped A2 records.
The separate kernel probe requires exactly one durable lookup and one
notification for a changed issue, retains untouched identities, and verifies
that the retired wire-v1 applySnapshot entry point throws.

The negative control removes `sourceEqual` from the real worklist definition
and subscribes that publisher to the same runtime. Draft A then produces **one
worklist derivation and the exact zero-derivation gate throws**. Unsubscribing the
control restores **zero derivations and the same gate passes**, at all three
scales. Publications stay at one in both cases: fewer publishes are not used as
a substitute for measuring the work. The existing scoped-session render file
also compares coarse subscriptions with addressed readers.

The Tasks board probe now supplies the sessions array required by the shipped
kanban. On the measured tree it mounts 96 cards (97 after keyboard navigation),
1,902 elements and 218 buttons. The ceilings remain 36 cards per stage, 216
aggregate, 4,000 elements and 225 buttons. Property reads are 79,194, frozen at
80,000. The old 55,000/53,212 figures and 200-card progressive-render description
were stale: the former fixture failed before measurement because sessions was
missing. This is an explicit current-tree recalibration, not a claimed speedup.
Sidebar ownership remains bounded to two cwd reads per session.

## Recorded baseline

Measured 2026-09-18 on **ludovico**, AMD EPYC Processor (with IBPB), Bun 1.4.2,
happy-dom / development React, on a shared host. These distributions are
informational, not controlled-runner timing acceptance. Base:
`0569c7545` (`integrate/4286-frontend-perf`) plus this A3 harness.
Included changes: `5c7ab6545` superagent guard, `1487cf68b` host-metrics isolation,
`03960c5e4` A2 counters, `07d2f50fb` repository usage index, `4a1fbef92` navigation
batching, `82a1d1964` material worklist inputs, and `0569c7545` outbox/reaction
batching. Thus these are not the pre-Phase-B baseline.

Timing endpoint: render entry → settled commit for cold mount; action entry →
settled commit for hot events. This includes harness assertions and outbox work.
The printed syncP50/syncP95 measure only the synchronous action call, excluding
awaited effects; they are **not** the entire CPU cost of async echo/rejection or
a timer tick. Never compare them directly with a browser paint budget. Percentiles
use nearest rank; cold n=5, hot n=20. Cold p95 is therefore the largest of five.

| Scenario | CI p50 / p95 ms | Live p50 / p95 ms | Growth p50 / p95 ms |
| --- | ---: | ---: | ---: |
| cold-start | 40.73 / 194.78 | 294.61 / 344.72 | 441.82 / 596.98 |
| unrelated-session | 16.84 / 68.65 | 103.71 / 138.21 | 193.03 / 254.48 |
| draft-A | 0.39 / 2.37 | 0.37 / 3.80 | 0.18 / 0.42 |
| hostMetrics | 0.04 / 0.10 | 0.03 / 0.05 | 0.04 / 0.08 |
| coarseNow | 7.38 / 12.27 | 70.50 / 122.29 | 81.85 / 114.37 |
| issue-click | 7.51 / 12.80 | 70.28 / 142.49 | 85.65 / 107.59 |
| optimistic-echo | 24.10 / 41.99 | 148.11 / 195.52 | 304.09 / 477.64 |
| optimistic-rejection | 24.77 / 45.12 | 165.35 / 214.91 | 334.43 / 397.53 |
| mixed-feed | 9.39 / 16.80 | 103.59 / 138.55 | 213.85 / 328.88 |

A2 observed ranges below are the same across all three profiles (first echo
and already-covered subsequent echoes can differ). Cold row builds equal the
profile issue count. Wakes and selector runs cover the mounted probe, not every
subscriber in the full app.

| Scenario | Publishes | Subscriber wakes | Selector runs | Worklist derives | Row builds | React commits |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| cold-start | 10 | 50 | 50 | 2 | N | 3 |
| unrelated-session | 1 | 5 | 7 | 1 | 1 | 1 |
| draft-A | 1 | 5 | 5 | 0 | 0 | 1 |
| hostMetrics | 0 | 0 | 0 | 0 | 0 | 0 |
| coarseNow | 1 | 5 | 7 | 1 | 0 | 1 |
| issue-click | 1 | 5 | 7 | 1 | 0 | 1 |
| optimistic-echo | 7 | 35 | 40 | 1–2 | 1 | 4 |
| optimistic-rejection | 7 | 35 | 43 | 2 | 0 | 5 |
| mixed-feed | 2 | 10 | 12 | 1 | 1 | 1 |

Navigation publishes `selectedIssueId` and `issueVisitBaseline` together, with
zero nested publications. Optimistic rows and queue bookkeeping remain separately
visible in the raw publication records; seven publications do not imply seven
full worklist derivations. The live→growth timing increase despite constant
row-build counts exposes remaining whole-corpus work.


## Browser measurements and warm classification

A1's measured live idle baseline was **111 snapshot publishes, 39 worklist
rebuilds, and 58 long tasks totalling 27.5 s over 65.8 s**. Host metrics accounted
for 40 publications but zero worklist derives and 34.6 ms fan-out. Those live
figures and this hermetic fixture have different endpoints; no improvement ratio
between them is claimed. The headline target remains no worklist derivations or
long tasks when nothing visible changed.

The removed synthetic 81 ms trace was authored timestamps, not a latency
measurement. The live driver now selects stable `[data-issue-row]` IDs, clicks
their actual pressable button, and rotates two rows. The heavy-panel residency
budget is **3 desktop / 2 mobile**, not eight. The driver classifies each new
trace as **cold**, **warm**, or **timedOut** (timeout takes precedence). Missing
warm samples are null, never an assumed warm result. Total-to-interactable and
start-to-chat:first-paint distributions are separate. A repeated worklist-row
press in happy-dom is not evidence of a warm Workspace panel.

```sh
BENCH_URL=https://podium-host.example.com:55555 \
BENCH_RUNNER=ludovico-production-chromium-1600x1000 \
BENCH_SWITCHES=12 BENCH_ROWS=2 BENCH_DWELL=1500 BENCH_IDLE_MS=65800 \
BENCH_STORAGE_STATE=/path/to/playwright-storage-state.json \
BENCH_OUT=/tmp/ludovico-large-state.json \
bun tests/e2e/large-state-bench.ts
```

The driver captures A2 counts and long tasks during a separate post-startup idle
window, then resets counters for navigation. It records runner and browser
version, row IDs, missing trace count, raw classified traces and the server perf
snapshot. CLS excludes hadRecentInput entries. Use three fresh production-browser
runs with the same viewport, dataset, dwell and row identities. No browser run or
retained-memory measurement was performed for this hermetic baseline.

### Frozen endpoints and acceptance targets

This table supersedes the planning table's idle-publication target. Publication
counts and their work are separate evidence. Current-baseline ceilings in the
harness are regression guards, not a claim that Phase C's targets already pass.

| Acceptance measure | Frozen target | Measurement endpoint |
| --- | --- | --- |
| Invisible idle work | 0 worklist derivations and 0 browser long tasks per 60 s | A2 `slices.worklist`; PerformanceObserver longtask entries in an idle capture, excluding startup |
| Unrelated session delta | 0 worklist derivations, 0 unrelated reader commits | Kernel committed row event → settled React; A2 worklist and addressed subtree Profiler |
| Navigation | 1 snapshot publish, 0 issue row builds per press | DOM `[data-issue-row]` click → settled React; A2 publishes/rowBuilds; optimistic/network work labelled separately |
| Host telemetry | 0 entity snapshot publishes, 0 worklist derivations | hub hostMetrics frame → host telemetry store notification and settled React |
| Draft A | ≤1 publish, 0 worklist derivations, 0 issue row builds | setSessionDraft(s0) → composer commit |
| Warm input → paint | p95 ≤100 ms | Browser switch start → chat:first-paint; only completed traces without panel:mount, with cold and timedOut reported separately |
| State/derivation CPU | p95 ≤8 ms | Event entry → synchronous runtime/derivation completion, separate from paint and async waits; controlled runner distribution |
| Pilot benefit, only Phase D+ | ≥50% p95 CPU reduction | Same event corpus and runner against recorded post-B tree |
| Startup / retained memory | ≤10% increase without approval | Independent cold navigation → interactable; retained heap after identical two-panel rotation and GC on same browser runner |

No browser timing, retained-memory, or long-task pass is inferred from happy-dom.
The nominated browser target remains Ludovico, production build, Chromium,
1600×1000; shared-host CI timing is informational. Timing acceptance needs paired
runs on that controlled target. Warm rotations use two stable issue IDs, within
the actual heavy residency budget (3 desktop / 2 mobile). Every browser trace is
classified cold, warm or timedOut; missing warm samples are missing evidence.

## Revert and failure diagnosis

Revert this issue's commits to disable the new harness and restore the prior
lane. No production store behaviour changes here; the Workspace edit corrects
a comment. Preserve a failing report and compare its changed-key sequences and
named slice counts before changing any ceiling. The negative control is retained
in CI so instrumentation that ceases to observe real work cannot silently pass.

Validation evidence is limited to `bun run test:perf:frontend`: five files,
28 executed tests. It is not a full-suite or real-browser result.
