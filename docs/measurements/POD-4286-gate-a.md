# Phase C gate — post-Phase-B evidence

**Proposed outcome 4: a bounded reactive proof is justified by remaining shared
derivation cost. The operator has not approved this decision.** Keep C2 and
D1–D6 blocked until confirmation. Budgets are **not met**: the controlled unrelated
session event still derives the worklist; live switching remains expensive.
Passing A3 regression ceilings does not mean the acceptance goals pass.

Outcome 1 (stop) is unsupported. Outcome 3 (key routing) only avoids consumers
whose keys did not change; it cannot avoid whole-worklist derivation for a
material session activity change. Outcome 2 is not established by the measured
host session scans: those are another bounded application-derivation problem,
not evidence that sync transport or transcript processing has displaced the
shared derived-state problem. Rendering and transcript costs remain real,
especially cold, but their inclusive samples overlap application work.

The fresh warm window has **30 worklist derives / 4,041.3 ms** and **8,122.7 ms** sampled inclusive worklist/mission time, compared with **4,163.7 ms** React commit and **2,006.1 ms** transcript/chat stacks. These overlap, but they do not support switching focus away from shared derivation. The largest named warm application self sample is `missionRootFor` (**1,616.3 ms**); session-ID lookup is only **13.4 ms inclusive**. GC is **4,872.7 ms sampled self** and is retained as its own bucket, not assigned to a library.

The proposed D1 proof compares **MobX and TanStack DB**, with Legend State only
as the documented fallback. It must implement the same connected per-issue read
path and beat this post-B baseline, not claim Phase B's savings. The operator may
instead require the measured host-facts follow-up and another gate capture first.

## Comparison lock and provenance

- Post-B runtime: **`c728e9c252c43110944934b8aedb63603695852d`**, branch
  **`integrate/4286-frontend-perf`**; C1 branch
  `issue/4319-c1-phase-b-remeasure-and-gate-decision`. Includes B11 and B12.
- Browser build: checkout `d91adeed1` (documentation-only descendant of that
  runtime), plus the retained seven-line temporary publication/derive timer patch;
  production bundle `index-BMwefuaK.js`, Turbo web build hash `8a1ad469925b97e2`. Instrumentation is removed from the final
  tracked tree. The pinned runtime remains the later pilot's comparison baseline. If another Phase B fix lands, remeasure it and pin a newer post-B baseline before pilot timing; a pilot must not inherit credit for those intervening gains.
- Ludovico, Linux x86-64 KVM, AMD EPYC with IBPB, Bun 1.4.2, production React
  19.2.7, Chromium **148.0.7778.96**, 1600×1000, no CPU throttle; same as A1.
  Shared host, not an isolated timing runner. Builds and browser runs used the
  heavy lease sequentially. Ordinary host load and brief evidence analysis were
  not controlled; timing differences are descriptive, not causal estimates.
- Checkout-local production preview on loopback :55619 proxies the existing
  backend :18787. Fresh authenticated browser contexts, service workers blocked.
  Installed builds and the live server were not replaced.
- C1 cold/idle corpus: **4,884 issues / 4,321 sessions / 501 repos / 6 machines**,
  211 visible issue rows; A1: 4,867 / 4,304 / 500 / 6. The live corpus and event
  feed are not identical. A1's archive was not found in retained worktrees or
  /tmp, and its report explicitly excludes full state snapshots. Historical
  target IDs and a frozen event replay are unavailable. **An identical-data
  before/after live comparison and independent milliseconds saved by each
  commit are unavailable.** A3 supplies controlled event-count evidence instead.

## Method and attribution boundaries

A1 scenario definitions were repeated: hydrate, ten-second settle, approximately
65.8-second connected-idle window, disconnected control, reconnect/settle and
second ordinary-background-activity window; six session-backed issue targets for
30 cold switches; a fresh browser with two of the same targets for 14 switches,
1500 ms dwell. Current `[data-issue-row]` IDs and real pressable buttons are used.
“Activity” is the scenario label, not a claim of a controlled agent workload.

Publication wall timers cover the actual store notification boundary; changed
keys and subscriber callbacks are recorded separately. Callbacks are timed jointly inside fan-out, not as independent per-reader CPU timers; snapshot construction and reactions are outside that timer. Derive timers surround
actual `def.derive` calls and exclude input guards/issue-model construction.
Source-mapped 1 ms CPU sampling attributes enclosing original functions. React
commit includes commit/layout-effect stacks; inclusive React also includes
application work. Sampled stacks, fan-out and derive wall time overlap and
**must not be summed**. No sample in a bucket is reported as “not sampled,” not
proof of zero cost. Native browser layout is separate where measured.

A2 subscriber wakes count generic mounted callbacks, not A1's issue-reader-only
failed equality comparisons. Cold/warm traces use `timedOut` first, then `cold`;
missing first-paint marks are missing evidence. Switch `totalMs` starts inside
the selection handler and is not input-dispatch latency. Post-GC heap includes
probe arrays, panels and transcript caches; no leak conclusion follows.

## Live window census: volume and work

These are observations on different live event streams. **No Phase B recovery
percentage is inferred from these totals.** Multi-key incidences can overlap.

| Window | Seconds | Publishes | Session / machine / host / issue incidences | Subscriber callbacks | Worklist derives | Derive ms | Long tasks / ms |
| --- | ---: | ---: | --- | ---: | ---: | ---: | --- |
| A1 idle | 65.787 | 110 | 13 / 17 / 40 / 7 | not comparable | 38 | 5,536.3 | 57 / 26,643 |
| A1 disconnected | 65.615 | 1 | 0 / 0 / 0 / 0 | not comparable | 1 | 120.6 | 22 / 2,070 |
| A1 activity | 65.517 | 125 | 34 / 13 / 39 / 11 | not comparable | 58 | 8,083 | 70 / 38,367 |
| C1 connected-idle | 66.210 | 33 | 1 / 14 / 0 / 0 | 9,240 | 2 | 334.2 | 12 / 2,489.0 |
| C1 disconnected-idle | 66.080 | 1 | 0 / 0 / 0 / 0 | 280 | 1 | 179.4 | 10 / 1,734.0 |
| C1 activity | 66.165 | 31 | 0 / 14 / 0 / 0 | 8,680 | 1 | 94.4 | 16 / 1,369.0 |
| C1 cold-rotation | 145.123 | 181 | 38 / 27 / 0 / 33 | 73,947 | 66 | 10,118.4 | 262 / 105,953.0 |
| C1 warm-rotation | 52.290 | 66 | 4 / 9 / 0 / 15 | 19,828 | 30 | 4,041.3 | 88 / 32,366.0 |

Per-event comparisons constrain the interpretation:

- A1 idle session-containing events: 13 derives / 13 publications, 2,911.4 ms
  total, **223.95 ms per publication**. A1 activity: 34 / 34, 5,181 ms total,
  **152.38 ms per publication**. C1 idle: **1 / 1, 182.6 ms**. The warm rotation adds 4 session-containing publications, of which one derives
  for 144.9 ms; cold rotation has 38, of which three derive for 692.0 ms. These
  mixed session payloads must not be treated as identical activity events. A single idle
  event is not a distribution or a matched payload; it corroborates a surviving
  expensive rebuild, not a measured percentage improvement.
- C1's second connected window has **zero session publications**. Comparison
  with A1's 34-event activity cost is unavailable. Absence of traffic must not
  be credited to the material guard or a future reactive library.
- A1 machine-only events: idle 17 derives / 17 publications (1,260.7 ms);
  activity 13 / 13 (850 ms). C1: **zero worklist derives on 14 machine-only
  publications in each connected window**. This agrees with B5's controlled
  machine-name evidence, without assuming identical historical payloads.
- A1 host telemetry: 40/39 publications, already zero worklist derives. C1 has
  zero host-metric snapshot publications; A3 deliberately injects a frame and
  proves 0 publishes / 0 wakes / 0 derives. This is B3's bounded gain.

## Residual buckets, including cold and warm

Milliseconds below are wall timers or approximate sampled stack attribution as
labelled. They are overlapping views, not shares of an additive CPU total.

| Bucket | Connected idle | Activity | Cold rotation | Warm rotation |
| --- | ---: | ---: | ---: | ---: |
| Publish fan-out wall time (includes synchronous subscriber work) | 371.8 | 124.5 | 15,753.0 | 5,755.2 |
| Worklist derive wall time (excludes guards/models) | 334.2 | 94.4 | 10,118.4 | 4,041.3 |
| Worklist/mission sampled inclusive | 405.6 | 106.1 | 24,821.3 | 8,122.7 |
| Issue derivation / optimism sampled inclusive | 98.6 | 3.0 | 7,856.4 | 2,699.6 |
| Session-ID lookup sampled inclusive | not sampled | not sampled | 133.9 | 13.4 |
| Machine facts sampled inclusive | 1,284.0 | 1,626.5 | 3,029.3 | 849.6 |
| React commit/layout-effect sampled inclusive | 207.9 | 133.1 | 12,993.6 | 4,163.7 |
| Transcript/chat sampled inclusive | not sampled | 2.2 | 12,098.3 | 2,006.1 |
| GC sampled self | 1,185.8 | 373.3 | 14,492.4 | 4,872.7 |
| Unattributed `(program)` sampled self | 4,627.9 | 3,744.5 | 28,564.8 | 12,398.9 |

Native layout timing was not captured in the first browser run; `(program)` is
not silently assigned to layout. The warm run additionally records CDP native
layout/style metrics. CPU samples and CDP durations have different accounting.
The original repoUsageAt hotspot is not sampled in these C1 windows; that is
consistent with B8, not a claim of an exactly recovered 11.25 seconds.

The host-facts residual is separate from the surviving session-delta worklist
cost: residentSessionsOnMachine self **881.90 ms** and idleSessionSplit self
**233.61 ms** in connected idle; even disconnected they cost **519.92 / 143.26
ms**. Their shared file accounts for **1,626.54 ms inclusive** in the second
connected window, versus 94.4 ms worklist derive. These scans are invoked during
host-indicator rendering; snapshot isolation does not suppress their own store
or timer-driven renders. POD-4357 (Host session aggregate scans) records the measured follow-up as
Proposed, unclaimed; the coordinator has been sent its measurements and ownership request. No implementation is added to this measurement issue.

## Switch classification and memory

| Rotation / class | Samples | totalMs p50 / p95 | chat:first-paint p50 / p95 |
| --- | ---: | --- | --- |
| cold-rotation / cold | 30 | 1,467.7 / 2,810.3 | unavailable / unavailable (n=0) |
| cold-rotation / warm | 0 | unavailable / unavailable | unavailable / unavailable (n=0) |
| cold-rotation / timedOut | 0 | unavailable / unavailable | unavailable / unavailable (n=0) |
| warm-rotation / cold | 2 | 3,027.4 / 3,027.4 | unavailable / unavailable (n=0) |
| warm-rotation / warm | 12 | 1,149.4 / 1,594.5 | 1,149.3 / 1,593.7 (n=12) |
| warm-rotation / timedOut | 0 | unavailable / unavailable | unavailable / unavailable (n=0) |

A1 cold: 30/30 cold, p50 657.2 / p95 1,160.8 ms. A1 warm: 12 completed
warm traces, p50 729.4 / p95 916.8 ms. Those are descriptive historical values:
C1 could not recover A1's target IDs or frozen transcripts, so a paired latency
improvement or regression is **not attributable**. Percentiles here use A1's
sorted element `min(n−1, floor(q*n))`. First-paint and interactable endpoints
are not interchangeable. No input-to-paint pass is inferred from totalMs.

Warm native CDP layout: **862.5 ms**; style recalculation **2,150.1 ms**. These are additional non-additive runtime counters.

Fresh two-target browser retained heap after GC: **113.95 → 217.04 MiB**. A1 was 130.59 → 212.33 MiB, but changed transcripts/feed and retained instrumentation prevent a controlled ≤10% memory acceptance verdict. Cold-run heap endpoints are kept separately in the numeric evidence.

## A3 controlled rerun

`bun run test:perf:frontend`: **5 files / 28 executed tests passed**. No full web
suite or repo-wide typecheck claim. The armed control at all three scales caused
one derive and failed the exact zero-work gate; removing that control restored
zero derives and passed. The existing production material guard stayed enabled.
CI/live/growth retain exactly A3's deterministic data, clock and scenario order.
Timing is shared-host action-entry → settled commit, **not browser paint**.

| Scenario, live profile | Publishes | Wakes | Worklist derives | Row builds | React commits | p50 / p95 ms | Sync p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: |
| unrelated-session | 1 | 5 | 1 | 1 | 1 | 117.32 / 160.59 | 156.52 |
| draft-A | 1 | 5 | 0 | 0 | 1 | 0.10 / 0.31 | 0.16 |
| hostMetrics | 0 | 0 | 0 | 0 | 0 | 0.02 / 0.24 | 0.11 |
| coarseNow | 1 | 5 | 1 | 0 | 1 | 55.96 / 129.51 | 0.11 |
| issue-click | 1 | 5 | 1 | 0 | 1 | 60.47 / 331.02 | 326.55 |
| optimistic-echo | 6 | 30 | 1–2 | 1 | 2 | 127.90 / 192.93 | 100.17 |
| optimistic-rejection | 6 | 30 | 2 | 0 | 2 | 154.28 / 231.43 | 168.09 |
| mixed-feed | 2 | 10 | 1 | 1 | 1 | 121.76 / 174.21 | 172.14 |

Unrelated-session growth p50/p95: **208.92 / 298.78 ms**, synchronous p95
**285.89 ms**, still 1 publish / 1 derive / 1 row build. A3's pre-B11 baseline
was live 103.71 / 138.21 and growth 193.03 / 254.48 ms. These shared-host timing
shifts do not establish a regression; deterministic work remains unchanged.
The live synchronous p95 **156.52 ms** is material relative to the 8 ms goal,
although a controlled-runner CPU acceptance test is still required.

Cold A3 live mount (five fresh runtimes) has p50 **220.12 ms**, p95 **239.99 ms**; 9 publications / 45 wakes / 2 worklist derives / 4,867 row builds / 2 React commits. The pre-B11 cold baseline was 10 / 50 / 2 / 4,867 / 3 with p50 294.61 / p95 344.72 ms. Counts improved; the timing shift is not an isolated causal estimate. Hot fixture events are not browser-resident warm panels.

B11 is independently visible in counts: optimistic echo/rejection **7 → 6
publications, 35 → 30 wakes**. Generic readers still wake on genuine outbox
queue-state changes, as its limitation predicted. Five mounted probe callbacks
are not the 23-reader live cohort in B11's original read-before-echo experiment.

The 14 live warm-rotation gestures produced **14 selectedIssueId publications**. All carried paneA and issueVisitBaseline in the same publication. The full window also contains issue folds, outbox transitions and background publications; its 66 total publications are not 66 navigation events. This is the end-to-end navigation observation, not an addition of B1 and B2 probe savings.

## Acceptance and operator action

| Gate | Verdict |
| --- | --- |
| Zero unrelated-session derives / unrelated commits | **Fail**: controlled delta still 1 derive; shared view updates remain. |
| Zero invisible-idle derives / long tasks | **Not met in observed idle windows**; clock and live traffic labelled above. |
| Navigation publish ceiling | **Pass in A3**: 1 publication / 0 row builds. Live clusters contain labelled optimism/background work; no sum of B1+B2 claims. |
| Host metrics and draft regression ceilings | **Pass in A3**: 0/0/0 and 1/0/0 respectively. |
| Warm p95 ≤100 ms, frozen switch-start → chat:first-paint endpoint | **Fail**: 12 warm samples, p95 **1,593.7 ms**. Actual input-dispatch → paint remains unmeasured. |
| State/derive CPU p95 ≤8 ms | **Not demonstrated; residual plainly material** in both controlled-count fixture and one live session-triggered rebuild. |
| Startup/retained heap ≤10% regression | **Unestablished** without paired data/trace instrumentation. |

**Operator confirmation required:** accept outcome 4 and unblock D1–D6, retaining
A3 guards and the post-B comparison SHA; or keep the gate open for the bounded
host-facts follow-up and another controlled capture. No Phase D–F issue is
archived or unblocked by this report. No pilot library is selected or installed.
The operator, not the coordinator or measurement agent, owns that decision.

## Validation, evidence and disable path

The single focused regression lane passed 28 tests / five files. The production
web build passed through heavy admission and the shared client-build command;
real-browser captures ran sequentially through the same admission wrapper.
Final tracked changes are reports and numeric evidence only, so no lean gate or
additional test lane is required. No ceiling was weakened to obtain green.

[Kernel results](POD-4286-post-b-kernel.json) retain all distinct count/publication
patterns and multiplicities; [live summary](POD-4286-post-b-live.json) retains each
window's event census, bucket times, classified traces and heap endpoints without
entity contents. Raw captures, profiles, source-map analysis, collector and the
temporary patch are retained locally in the issue worktree's `.c1` evidence area.
Raw live evidence is not automatically uploaded. Reviewable aggregate report
and summary are attached to the issue.

Disable/revert: stop the checkout-local preview and isolated browsers, disable
A2 counters by closing those contexts, and remove the temporary seven-line
probe patch. No server restart, installed build, persistent feature flag or
library migration exists to undo. Reverting this issue's documentation commits
removes the deliverable; it does not revert any Phase B implementation.

## Commit attribution ledger

The counterfactuals below are the landed fixes' original focused evidence, not
new C1 ablations. A1 is the only pre-Phase-B live capture. A sequential replay of
all fixes on an identical historical feed is unavailable, so independent live
milliseconds per commit cannot honestly be recovered by subtracting windows.

| Landed commit(s) | Attributable change and evidence | Limit / overlap |
| --- | --- | --- |
| B6 `5c7ab6545` | Superagent input guard depends on its two inputs. Original guarded/unguarded probe: bootstrap plus three unrelated changes gives 1 vs 4 derives (hot work 0 vs 3). | Does not eliminate session-driven worklist derivation; no independent live time saving measured. |
| B3 `1487cf68b` | Host metrics leave the entity snapshot. C1 A3 observes 0 publications / 0 wakes / 0 derives. | A1 host-only fan-out was 71.2 ms idle / 34.1 ms activity, with zero worklist derives already. Host-indicator rendering can still run. |
| A2 `03960c5e4` | Opt-in boundary counters provide the measurement instrument. | No product speedup claimed. |
| B8 `07d2f50fb` | Repository usage prefix index: three controlled frames drop session visits 6,456,000 → 12,912 and index derives 3 → 0. | A1 repoUsageAt sampled self 11,255 ms is an opportunity, not a guaranteed recovered amount on a different feed. See POD-4340 report. |
| B4 `1e922f3da` | Original 32-reader / 256-session probe: three unrelated deltas retain 3 publishes / 96 wakes / 96 selectors, but find comparisons fall 24,576 → 0. Replaced collection: 8,192 → 0 comparisons, one shared index build. | One index construction still scans; does not cover every session aggregate or prove a live millisecond share. |
| A1 `0af1b787b` | Baseline documentation. | No runtime change. |
| B7 `d56e2d3e8` | Narrows 13 mobile whole-store reads and guards two web selector objects. Original NewIssueScreen probe retains 3 publishes while unrelated commits fall 3 → 0; relevant update stays 1 publish / 1 commit. | Desktop run does not measure mobile gains; no independent CPU share asserted. |
| B9 `f4dac49c4` | Mobile placement fixtures. | Test-only, no speedup. |
| B1 `4a1fbef92`, `181dd8626` | Atomic navigation: original warm 3 → 1 and first-open 5 → 1. | After B2 the legacy warm arm is already 1, first-open 4; credit the warm win once. Independent B1 first-open/cross-worktree contribution remains 4 → 1. |
| B5 `82a1d1964` | For three machine-name or session-diagnostic frames: derives 3 → 0; seven-reader commits 21 → 0. | Material lastActiveAt still invalidates. A1's 850 ms machine-only derives are a historical opportunity, not a C1 causal time measurement. |
| B10 `9cfeaa01b` | Mobile terminal remount assertion. | Test-only, no speedup. |
| B2 `0569c7545` | Synchronous event publications: outbox 2 → 1, fallback 3 → 1, worktree follow 2 → 1, issue follow 4 → 1, prune 2 → 1, visit baseline 3 → 1, session/issue read each 4 → 1. | These events overlap a navigation gesture and B1. Do not add counts or savings across rows. |
| A3 `955be5a0f`, `ca0942e90` | Kernel fixture and frozen ceilings. | Measurement/test changes, no product speedup. |
| B11 `6766e4183` | Original controlled read-before-echo: entity publications 5 → 1, total publications 5 → 3, 23-reader wakes 115 → 69. Async unchanged handoff 1 → 0. C1 A3 echo/rejection each drop total publications 7 → 6 and wakes 35 → 30 versus A3's pre-B11 baseline. | Genuine queue-status publications still wake all five mounted A3 subscribers. The 23-reader original probe and five-reader C1 fixture are distinct cohorts. |
| Coordinator `91808701f`, `04fc64d40`, `b86b105de`, `2ef640ed5` | Type correction and plan corrections. | No separately measured runtime gain. |
| `ffe515c22`, B12 `c728e9c25` | Web baseline report and repair of the material-publish render probe. | Included in pinned baseline; no product performance claim. |
