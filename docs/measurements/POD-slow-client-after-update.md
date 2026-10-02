# Client slowness after the sidebar pilot landing

POD-5175, for POD-4286. Measured 2026-10-02 on ludovico.

The periodic side-by-side checker is expensive, but it is not the only source of
slowness. The old client and the updated client with the pilot **off** already
spend most of a busy hands-off minute on the main thread. Turning on the pool
removes much of the legacy sidebar work; main-pane, React and shared runtime work
still delay real row clicks. The measured heap behaviour is dominated by allocation
churn and temporary retention, not a demonstrated multi-gigabyte retained leak.
The macOS shell itself and its local switch state were not measurable on this
Linux host; the all-switches-off Chromium comparison is the agreed fallback.

## Build, data and measurement controls

- Before: `a5f55925fa73fa1b4d0de40e2ad37a1046cd849f`.
  Updated: `721dd693787c863eb9c6d8c6fe58ab3d0da8d4b0`.
  Separate `git worktree add --detach` checkouts; pinned Bun 1.4.2,
  checkout-local frozen dependency graphs and production web build helpers.
  Both build tasks reused their cache and were restamped for the exact commit.
  Neither the operator's checkout nor product source was edited.
- The operator's running server stayed on `0.1.1-dev.233+721dd69`, wire version 3,
  schema digest `6ce8d313a50dba81`, at loopback port 18787. Both frontends used
  **this same current backend**. This is not an old/new backend or daemon test.
- Chromium for Testing 151.0.7922.34, Linux headless, 1920 × 1080, one browser at
  a time, fresh isolated profile for each mode, nice level 10. Existing CLI-session
  authentication was read locally as in `export-snapshot.ts`. Nothing was copied
  to flatblock or another machine. No server/daemon restart or reconfiguration.
- Local routing served the exact build's static assets while reads and feed traffic
  reached the real server. The switches were `mobxSidebar=0`, `mobxSidebar=1`, or
  `mobxSidebar=1&mobxSidebarCheck=1`. Both off controls had the perf panel disabled.
- After mount and 30 seconds of settling, collect 12 forced-GC samples at nominal
  minutes 0–11, heap usage every 5 seconds, CPU samples every 4 ms, and a timeline
  trace for the final minute. Schedule 48 wheel inputs in four bursts and 12 clicks
  in three bursts. Every primary mode spans more than ten minutes after GC.
- The operator subsequently authorized real row clicks and mark-read writes.
  Exactly two fixed mission rows were used: API child counts 70 and 40, seven direct
  sessions each at setup. At final verification those child counts were 5 and 40;
  the live contents changed materially during the experiment. All other business
  writes were intercepted. Selection began empty in each isolated profile; the operator's device-local selection was
  not copied or changed. Across the primary and replay matrices there were 96 clicks
  on those two rows and 58 forwarded mark-read requests; both read markers changed
  as authorized. No archive, rename, drag, text input or preference write reached
  the server. The server sidebar preference was unchanged after each run.
- Native terminal `attach` was blocked because its server handler reconciles the
  active renderer and broadcasts state. These measurements cover navigation,
  FlightDeck and permitted transcript reads, **not terminal attachment readiness,
  live PTY replay, macOS WebKit, GPU memory or native-process memory**.

The write guard is another limit: automatic read marks and layout writes were
locally acknowledged without their normal server-feed echo. The primary updated
windows intercepted 224/279/714 `layout.set` calls (off/on/check); the replays
intercepted 4/18/1, all for the static `panelMode` preference. Such activity can
change optimistic-state lifetime and rendering, so it must not be diagnosed as
a product regression from these runs. The checker and legacy derivation costs
are directly observed, but this is not an unguarded replica of the operator's
whole desktop session.

Times below use decimal MB and wall-clock seconds. Startup means the first visible
sidebar shell, not that every lazy surface is ready. Incoming traffic and host load
were uncontrolled: roughly 6–9+ background load on seven logical CPUs. The modes
ran sequentially against changing data. Counts and bytes make that confounding
visible; totals must not be read as a matched-event A/B experiment.

## (a) Off, on, check, and before/after

| Measurement | Before: off | Updated: off | Updated: on | Updated: on + check |
| --- | ---: | ---: | ---: | ---: |
| Sidebar mounted, s | 10.5 | 15.3 | 14.0 | 30.7 |
| GC observation span, s | 660.2 | 657.5 | 661.8 | 661.1 |
| Main-thread task time, s | 447.3 | 614.2 | 423.9 | 524.2 |
| Received delta frames | 798 | 1521 | 1227 | 1384 |
| Received WebSocket data, MB | 30.7 | 21.5 | 22.4 | 21.9 |
| Scroll p50 / p95, ms | 118.4 / 1015.8 | 900.7 / 1509.8 | 133.8 / 1124.4 | 156.7 / 1231.7 |
| Largest 5-second sampled used heap, MB | 745.9 | 1184.6 | 1059.4 | 1109.0 |
| computeMissionIssueIds self CPU, s | 71.8 | 115.9 | 4.6 | 32.3 |

The initial hands-off interval, before any clicks or scrolling, consumed:

| Mode | Interval, s | Main-thread tasks, s | Live delta frames |
| --- | ---: | ---: | ---: |
| Before, off | 57.3 | 55.2 | 136 |
| Updated, off | 59.9 | 59.8 | 186 |
| Updated, on | 61.0 | 22.2 | 134 |
| Updated, on + check | 60.1 | 26.1 | 102 |

This is a user-idle client receiving live updates, not a quiescent feed. The pilot's
own idle counter can be near zero while replica publication and main-pane work
keep the main thread busy. For example, on-only minute 5 reported 0.3 ms of idle
sidebar work while the whole 11-minute window consumed 423.9 seconds of tasks.
Its sampled last incoming-update measurements included 39.0 and 144.4 ms; these
are individual partially pending counter readings, not update latency percentiles.

The source-mapped expensive legacy path is `SocketHub.drainFeedIngress` → feed
application/replica publication → synchronous selectors/legacy worklist derivation.
`computeMissionIssueIds` repeatedly traverses mission membership; `modelsFor`,
`deriveIssueViews`, `indexMissionSessions` and `buildUnifiedRows` also appear.
The mission, issue-view derivation and worklist-row implementation files are
unchanged between the two commits. Shared runtime, normalized issue-user state,
optimism and cache initialization did change; this experiment does not isolate
one of those changes as a new regression.

On-only reduced `computeMissionIssueIds` self CPU from 115.9 to 4.6 seconds in the
updated windows. With the checker enabled it returned to 32.3 seconds. The checker
alone sampled **84.8 seconds across 110 completed checks**, about 771 ms/check.
Its own rolling counter reported **7.20–9.31 seconds per minute** after settling.
All settled check samples matched with zero differences; an initial loading sample
was waiting with two differences and cleared by minute 1.

`attachWorklistPool` returns before importing or subscribing the pool when off;
the checker is attached only inside the pool path with the check URL flag.
Therefore a verified off-mode slowdown cannot be execution of the pool/checker.
The old build already reproduces severe work, while the updated off window was
busier and had a worse scroll p95. Different event traffic, selected content and
host scheduling prevent assigning that difference causally to the landing.
There is **no measured basis to blame the new sidebar for all macOS slowness**, or
to claim this investigation cleared every shared-client regression in 721dd6937.

## (b) Retained heap versus allocation churn

The following is `Runtime.getHeapUsage.usedSize` immediately after
`HeapProfiler.collectGarbage`, in MB. Live delivery can allocate between collection
and the following read; this is not a retained-object graph or a retainer proof.
Clicks follow the minute 2, 6 and 10 samples, warming main-pane state as well as
changing selection.

| Minute | Before: off | Updated: off | Updated: on | Updated: on + check |
| --- | ---: | ---: | ---: | ---: |
| 0 | 162.5 | 190.2 | 183.1 | 191.9 |
| 1 | 150.3 | 246.2 | 181.5 | 198.8 |
| 2 | 148.6 | 305.5 | 189.4 | 204.1 |
| 3 | 164.7 | 370.0 | 204.5 | 248.7 |
| 4 | 178.8 | 421.5 | 203.6 | 240.6 |
| 5 | 171.1 | 385.4 | 200.7 | 225.3 |
| 6 | 172.1 | 183.0 | 207.8 | 216.2 |
| 7 | 171.1 | 213.8 | 232.3 | 224.0 |
| 8 | 172.5 | 268.4 | 232.5 | 217.2 |
| 9 | 173.7 | 192.3 | 241.5 | 217.7 |
| 10 | 173.7 | 176.3 | 230.9 | 230.1 |
| 11 | 226.2 | 176.1 | 225.1 | 227.8 |

The updated off client temporarily retained 421.5 MB, then released it to 183.0 MB
and ended at 176.1 MB. The checker rose to 248.7 MB after the first selection burst,
then ended at 227.8 MB. Neither shows an unbounded climb. On-only ended 41.9 MB
above its initial sample and the old build 63.7 MB above its initial sample;
changing selection/live caches and temporary queues make those endpoints
insufficient to call either a leak. On-only's final three samples decline
241.5 → 230.9 → 225.1 MB. A slower or route-specific leak is not ruled out.

| Final-minute natural GC | Before: off | Updated: off | Updated: on | Updated: on + check |
| --- | ---: | ---: | ---: | ---: |
| Trace duration, s | 62.0 | 58.5 | 60.8 | 58.8 |
| Minor / major collections | 171 / 2 | 157 / 2 | 159 / 2 | 181 / 2 |
| Summed main-thread GC event duration, ms | 2497.8 | 2472.4 | 3585.3 | 2220.0 |
| Reclaimed heap, MB | 4683.4 | 4335.6 | 3929.3 | 5506.2 |

GC totals count top-level MinorGC/MajorGC events on the renderer main thread,
exclude workers and exclude deliberate low-memory/forced collections. Reclaimed
bytes are evidence of churn, not an exact allocation-rate measurement. About
3.9–5.5 GB was reclaimed naturally in one final-minute window, including when the
checker was off. The check adds full reference derivations and allocation work;
it is not the only allocator.

The largest 5-second sampled heap in the expanded matrix was 1,184.6 MB. The
operator's 2.5 GB peak did **not** reproduce. Once-per-minute forced GC changes
natural peak cadence, 5-second sampling can miss brief peaks, and fresh profiles
lack the operator's long-lived state. The observed sawtooth is consistent with
heavy churn, but these runs do not prove every byte of the reported 2.5 GB was
transient or that there are no smaller leaks.

A secondary matrix at 1440 × 1000, with a collapsed rail and no selected mission,
helps separate selection warm-up. Updated off retained 153.1 → 146.8 MB, on-only
195.7 → 193.4 MB, and on+check 196.3 → 200.8 MB over approximately ten minutes.
The pool therefore had an approximately **46.6 MB / 32% larger retained footprint**
in those live windows. That is a footprint problem, not by itself a leak. The old
control retained 138.8 → 144.2 MB. On-only task time was 152.6 seconds, versus 202.0
with checking and 309.5 off. Checker ancestry accounted for 50.6 seconds across
109 checks (~464 ms/check), reproducing the operator's ~5.1 seconds/minute.
The secondary updated-off control had its perf panel enabled, so it is not the
primary all-switches-off comparison.

The collapsed rail was caused by the automatic responsive fold below 1600 pixels,
not a changed operator preference. Initial attempts that waited for an expanded
scroller at that width are excluded. A separate bootstrap decoder read 24,983 rows
in 5.968 seconds; this is transfer/decode evidence, not UI startup time.

## (c) Where selection delay goes

The shipped panel measures click/keydown `event.timeStamp` to two consecutive
`requestAnimationFrame` callbacks. It is a whole-main-thread next-paint proxy,
not sidebar-only CPU or proof that the selected terminal is ready. The local
collector mirrors that boundary and separately records wheel events. The original
219/961 ms percentiles cannot be reconstructed without the operator's trace.

The primary matrix's 12 clicks per mode measured p50/p95 of 990/1796 ms before,
749/1770 ms updated off, 856/2187 ms on, and 796/1937 ms on+check. Their initial
write allowance expired on some delayed commands, leaving 9/4/7/5 actual server
forwarded mark-read requests respectively. Those figures are kept as guarded navigation
observations, not represented as fully acknowledged write-path measurements.

| Separate real-click replay | Before: off | Updated: off | Updated: on | Updated: on + check |
| --- | ---: | ---: | ---: | ---: |
| Click count | 12 | 12 | 12 | 12 |
| Input → double-rAF p50 / p95, ms | 1267.6 / 2256.2 | 1333.4 / 1962.0 | 569.3 / 1551.9 | 491.4 / 856.6 |
| Event dispatch queue delay p50 / p95, ms | 415.4 / 618.8 | 472.0 / 572.7 | 17.7 / 474.2 | 10.5 / 292.5 |
| Forwarded mark-read requests | 5 | 4 | 12 | 12 |
| Confirmed successful receipts | 5 | 4 | 12 | 11 |
| Waits without a confirmed receipt within 20 s | 7 | 8 | 0 | 1 |
| Replay observation span, s | 347.1 | 385.9 | 152.8 | 184.9 |
| Live delta frames in that span | 775 | 902 | 276 | 432 |

This replay removes the primary run's 10-second write-allowance expiry and waits
for a successful response, or a 20-second receipt deadline, after each
click. Already-read selection can legitimately skip a mark-read; the timeout
counts alone do not establish why a receipt was absent. The last checker request
failed in the local forwarding harness with ECONNRESET; its write outcome is
unknown and was not retried. That run saved all 12 input observations and profiles,
closed the browser, then exited 1. Only 11 of its 12 receipts are confirmed.
Restricting that mode to the first 11 confirmed clicks gives p50/p95 606.9/856.6 ms.
Automatic later read marks and every other mutation remain intercepted. These are real clicks with
permitted server writes, not a forced mutation on every navigation. With only
12 observations, nearest-rank p95 is the maximum; these are descriptive samples,
not a stable estimate of the operator's population p95. The lower checker replay
percentiles do not show that enabling checking improves input: it did not overlap
these click windows, and the live content/traffic changed between runs.

| Sampled CPU inside all 12 click waits, s | Before: off | Updated: off | Updated: on | Updated: on + check |
| --- | ---: | ---: | ---: | ---: |
| Main pane + other React | 4.35 | 4.34 | 3.62 | 2.96 |
| Sidebar/pool ancestry | 5.21 | 4.95 | 2.16 | 1.48 |
| Shared replica/runtime | 4.38 | 6.11 | 0.69 | 0.74 |
| Comparison checker | 0.00 | 0.00 | 0.00 | 0.00 |
| GC | 0.68 | 0.68 | 0.37 | 0.09 |
| Other / instrumentation / idle | 1.48 | 1.31 | 2.14 | 1.16 |

For attribution, source maps classify samples inside the union of the
click-timestamp → double-rAF intervals. Categories are exclusive stack ancestry:
idle/GC first, checker, measurement-only instrumentation, main-pane,
sidebar/pool, shared replica/runtime, other React and unclassified work. A wrapper
named measurement is not counted as overhead when it encloses real row rendering. This includes unrelated live work which
happens during the wait, not only work caused by the click. Profiler timestamps
are reconstructed and sorted to handle out-of-order samples;
intervals are clipped to each input window before weighting. Sampling and
scheduling mean bucket sums approximate wall time, not exact React commit durations.

In the primary on-only run, main-pane plus other React ancestry accounted for
8.34 seconds across the 12 click windows, sidebar/pool 1.73 seconds, shared
runtime 0.74 seconds and GC 0.67 seconds. `FlightDeck.readBriefMetrics` alone
sampled 1.13 seconds; it reads geometry/scrollHeight in a layout effect. Shared
hot functions include `selected`, `issueActivityAt`, `lastUsedMachine`,
`buildFlightDeckRows`, session ownership and transcript `reconcileLayout`.
The existing POD-5104 covers the forced-layout work.

The primary check run had no comparison samples inside those particular click
windows, but **3.48 seconds of checker ancestry inside the scroll wait windows**.
Periodic checking can block an unlucky input; its total cost does not mean it
caused every slow click. GC is measurable but did not dominate these click
windows. Pool-only still has large main-pane/shared-state costs.

## (d) Missing Settings switch

The live `features.state` response was `channel=edge`, `devMode=false`,
`podium-development.enabled=true`, and `mobx-sidebar` hidden/unlisted.
`packages/protocol/src/features.ts` declares the pilot hidden. The server's
`getFeatureStates` sets dev mode only for a version exactly equal to `dev`;
`0.1.1-dev.233+721dd69` does not satisfy that sentinel. The Podium development
preference does not change server dev mode. `ExperimentalSection` filters out
unlisted flags before rendering its special pilot setting.

That explains the absent entry on this packaged build. The pilot is a separate,
startup-only device-local preference with a URL override; the catalog's disabled
value cannot establish the macOS app's actual local pilot state.

## (e) Fix ownership and recommendations

No product fix is included in this issue. Evidence was mailed to the relevant
owners. Independently shippable discoveries were filed unclaimed in Proposed
with `discovered-from` links, as required by the tracker workflow; POD-4286's
coordinator recreated the checker proposal as its delivery sub-issue.

| Recommendation | Evidence and owner |
| --- | --- |
| Replace continuous full parity checking with explicitly requested, bounded work; show its cost. An idle callback alone does not split a synchronous 0.5–0.8 s calculation. | POD-5184, child of POD-4286; original proposal POD-5183. 50.6 s/109 checks collapsed, 84.8 s/110 expanded; 7.20–9.31 s/min expanded counter. |
| Remove repeated legacy mission/worklist derivation and reduce broad shared-state publication/selection work. Preserve the off fallback while making the main pane consume narrow data. | Existing POD-5127 and the main-pane migration under POD-4286. `computeMissionIssueIds` 71.8 s before, 115.9 s updated off; expensive main-pane/shared paths remain on. |
| Remove synchronous FlightDeck brief geometry measurement from the selection critical path. | Existing POD-5104; 1.13 s sampled self time across 12 real-data on-mode click windows. |
| Measure and reduce duplicate retained pool/legacy state; distinguish stable graph residency from leaking retainers. | Existing POD-5126; ~46.6 MB / 32% live collapsed-window overhead, no reproduced multi-GB retained growth. |
| Expose the startup-only pilot control to the intended packaged-development audience without changing its default-off semantics. | POD-5180; direct live feature-state and listing-path evidence above. |

## Evidence handling and validation

Raw traces, CPU profiles, browser storage, console/DOM captures, selected-row
identifiers and scratch reductions were analyzed only on ludovico and deleted
after reduction. Both detached build worktrees were removed. No profiling process
remained at cleanup, and the live server version was verified unchanged. Only
aggregate counts, timings, function names, sizes and necessary build/configuration
facts are included here or in issue mail; no live titles, paths, transcripts or
logins.

This deliverable changes documentation only. The runtime test gate is skipped
under AGENTS.md's docs-only exception. The numeric series were checked against
the local reductions, all four long-run spans exceed ten minutes, the write/privacy
audit passed, and `git diff --check` passed. The profiling runs are evidence, not a claim that a product
fix or the full test suite passed.
