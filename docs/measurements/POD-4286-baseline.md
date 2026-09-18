# POD-4286 live frontend baseline — 2026-09-18

## Finding

**Coarse collection invalidation is a measured, substantial cause of the live slowdown. It is not a complete explanation.** On a client receiving ordinary agent activity, every observed session publication rebuilt the whole worklist. A second broad derivation, the repository picker's session-usage scan, was the largest individual sampled JavaScript hotspot. React's DOM commit phase was smaller than either. Counting publications without their downstream work would misattribute later improvements.

No performance fix is included in this measurement. All runtime instrumentation was temporary and removed after capture. POD-4340 tracks the independently shippable repository-picker scan finding.

## Provenance and method

- Device: **ludovico**, Linux x86-64 KVM, AMD EPYC with IBPB, 8 virtual CPUs, 23 GiB RAM. Shared live host; other agents and validation processes were running. No CPU throttling was applied. These are loaded-host observations, not isolated CPU benchmarks.
- Date: **2026-09-18 UTC**. Raw captures carry their own timestamps.
- Installed server/web: **`692d8c8e8f5465112dadeff50df0f0be817e9e51`**, release `0.1.1-dev.181+692d8c8`, web bundle `bundle+D_fWaLs2`, wire digest `53e62e55080f0f8f`.
- Measured checkout: **`15a238f3399614e2a6bffe9dc62073d9c8da90f6`**, before the epic's fixes. `git diff 692d8c8 HEAD -- packages/client-core apps/web` showed only two added machine-panel label lines; runtime, replica and worklist code matched the installed build. The instrumented bundle is **`index-C4fDp6XP.js`**, Turbo web build hash **`c1345b5ca7816a15`**. The checkout SHA alone does not describe the temporary instrumentation.
- Production/minified React 19.2.7 bundle, Bun 1.4.2, isolated headless Chromium, viewport **1600 × 1000**, loopback preview `:55609` proxying the existing live backend `:18787`. Installed dist and the existing iteration server were untouched. Service workers were blocked in the measurement context.
- Reused the `tests/e2e/large-state-bench.ts` approach: isolated browser, long-task/CLS observers, real sidebar clicks, six-row rotation followed by a two-row warm rotation, with 1500 ms dwell, plus the existing POD-701 `globalThis.__podiumSwitchTraces.recent()` collector. The old benchmark's test-id wrapper did not carry the issue ID; the follow-up selected the current `[data-issue-row]` attribute. The failed switch attempt produced no switch sample; its completed idle windows remain valid.
- Waited for live hydration, then ten seconds of settling. Instrumented `engine/runtime.ts apply()` only after its equality/no-op and batching guards. Each record contains changed top-level keys, timestamp, synchronous publish/fan-out time, and reaction time. Recursive reaction time overlaps descendants and is **not** added into a CPU total.
- Timed actual `def.derive(source)` executions inside the existing slice publisher; cache hits are excluded. Worklist input-guard/issue-model work occurs outside this timer, so derive time is a lower bound on the complete projection path.
- Counted failed equality comparisons in `useReplicaIssueSources` as reader wake requests, separately from calls to `useReplicaIssues` during rendering. Counts describe mounted readers, not the source-code census of 30 call sites.
- Chrome DevTools CPU sampling at 1 ms, mapped through this build's archived source maps. React commit attribution uses original `commit*`/`flushMutationEffects` stack frames in `react-dom-client.production.js`; React-inclusive samples also contain application derivations and must not be added to their own samples. Sampled stack time is approximate wall-time attribution, not a hardware CPU counter. `(program)`, GC and unattributed native work remain separate.
- Retained JavaScript heap uses `HeapProfiler.collectGarbage` followed by `Runtime.getHeapUsage`; it excludes server memory and most native/renderer memory. Diagnostic arrays are retained too, so heap deltas cannot establish a product leak.

## Live scale

| Entity / surface | First capture |
|---|---:|
| Issues | 4,867 |
| Issues without `closedAt` | 2,230 |
| Sessions, including retained history | 4,304 |
| Repositories | 500 |
| Worktrees nested in repository state | 468 |
| Machines | 6 |
| Visible issue row elements | 211 |
| Settled document elements / buttons | 7,755 / 428 |

This is about **7.2× the issues and 8.1× the sessions** in July's 674-issue/530-session fixture. The plan's 965-issue estimate is not today's authenticated live corpus. These are client-visible cardinalities, not an assertion about all rows on the server. Bootstrap advertised about 19,937 rows across kinds; that number is not an issue count.

## Publishes and derivations

“Idle” means no gestures in this browser. The connected live backend continues to receive agent work. The second connected window is a separate sample of ordinary background activity after reconnect/settling, not a controlled change in agent load. A disconnected window isolates the local minute clock; it is not a claim that production normally runs offline.

| Window | Seconds | Publishes | Publishes/min | Worklist derives | Derives/min | Derive total | Derive p50 / p95 |
|---|---:|---:|---:|---:|---:|---:|---:|
| Connected idle | 65.787 | 110 | 100.32 | 38 | 34.66 | 5,536 ms | 134.6 / 406.9 ms |
| Disconnected idle control | 65.615 | 1 | 0.91 | 1 | 0.91 | 120.6 ms | 120.6 / 120.6 ms |
| Ordinary agent activity | 65.517 | 125 | 114.47 | 58 | 53.12 | 8,083 ms | 141.3 / 300.0 ms |

Changed-key incidence (a multi-key publication appears in multiple columns):

| Key | Connected idle | Activity |
|---|---:|---:|
| `hostMetrics` | 40 | 39 |
| `conversations` | 31 | 29 |
| `sessions` | 13 | 34 |
| `machines` | 17 | 13 |
| `issues` | 7 | 11 |
| `issueProjections` | 7 | 5 |
| `issueEvents` | 0 | 2 |
| `coarseNow` | 1 | 1 |
| `drafts` | 2 | 0 |

Counts include only event timestamps within each recorded start/end window; a handful of setup-spillover events in the raw arrays are excluded. Exact combined-key groups are retained in the summary evidence. Clock-only disconnected capture: one `coarseNow` publish and no others. The counter therefore does not confuse render callbacks, outbox events or no-op `apply()` calls with snapshot publications.

In the activity window, 32 session-only publications caused **32 worklist derivations / 4,885 ms**. Two combined publications containing sessions each caused another derivation; all session-containing publications together accounted for **5,181 ms** of worklist derivation. Machine-only publications caused **13 derivations / 850 ms**. Those observations confirm collection-wide invalidation on actual live deltas; they do not prove all those deltas were semantically immaterial.

By contrast, **all 40/39 host-metric-only publications caused zero worklist derivations** in the two connected windows. Their synchronous fan-out took **71.2 ms** total in the first window and **34.1 ms** in the second. The activity clock tick caused one **62.9 ms** derivation. Host metrics arrive from hub events: the nominal five-second cadence must not be interpreted as exactly 12 publications/minute on a multi-machine live feed. Here there were approximately **35.7–36.5 host-metric publications/minute**.

## Cost attribution

| Cost in the 65.5 s activity window | Evidence |
|---|---:|
| Repository MRU usage scan, `repoUsageAt`, self samples | **11,255 ms** |
| Entire React render/commit stacks, inclusive | 28,616 ms |
| Worklist `derive()` wall time | **8,083 ms** |
| Worklist-path CPU samples, inclusive | 9,037 ms |
| React DOM commit stacks, inclusive | **2,079 ms** |
| All synchronous snapshot fan-out wall time | 8,268 ms |
| Host-metric fan-out wall time | 34.1 ms |

These rows overlap; do not sum them. The first connected window independently found the same MRU hotspot at **5,494 ms self**, worklist derives at **5,536 ms**, and React commit stacks at **2,975 ms**.

The largest individual identified function is `repoUsageAt` in `viewmodels/slices/machines/facts.ts:174`, reached by `ColdStartComposer.tsx`'s `repoChoices` memo. The memo depends on whole `sessions` identity and loops repositories × active sessions × checkout roots. This cost belongs to application derivation during React rendering, not to DOM commits and not to `worklistSlice.derive()`.

## Gestures, warm switches and reader wakes

The current `HEAVY_PANEL_RESIDENCY_BUDGET` is **3 desktop / 2 mobile**, despite older benchmark and Workspace comments saying eight/three. Six issue/session targets therefore produced **30/30 cold traces**, with p50 **657.2 ms**, p95 **1160.8 ms**, and zero timeouts. This is a cold-churn measurement, not a warm regression.

A separate fresh browser rotated **two issues for 14 switches**. Resident panels grew from one to two and stayed at two. The first two traces were cold; all remaining **12 were warm**, completed without timeout, and had `chat:cache-hit` marks:

| Metric | p50 | p95 | Samples |
|---|---:|---:|---:|
| POD-701 completed warm switch, `totalMs` | **729.4 ms** | **916.8 ms** | 12 |
| Playwright click return, same warm gestures | 2,157.8 ms | 4,080.7 ms | 12 |
| Worklist derive time during each click + dwell observation | 546.7 ms | 1,100.8 ms | 12 |

Percentiles use sorted element `min(n-1, floor(q*n))`; these are small descriptive samples, not confidence intervals. `beginSwitch()` is called partway through the selection handler, after some selection/mark-read work. Consequently the trace excludes earlier synchronous work and input scheduling. Playwright click return also includes actionability/event scheduling; **neither is an independently measured input-to-next-paint value**. Do not compare the two columns as interchangeable latency metrics.

All 12 warm gestures had **three navigation-key publications** (`selectedIssueId`, `paneA`, `issueVisitBaseline`), followed by the optimistic issue publication: **four publications in the typical immediate selection cluster**. This is below the plan's unmeasured 5–6 claim for this specific gesture path, but still not one. The six-row/cross-worktree run had **3–6 navigation-key publications** per gesture, before counting optimistic/network work. Changing worktree and first-open layout/panel state explains part of this difference.

Across the 12 warm click-plus-dwell observations, navigation-key fan-out consumed **1,526.6 ms total**, median **115.0 ms**, p95 **244.8 ms**. Complete observation windows contained **8–19 total publications** each (median **13**), including background session/machine/host/replica activity; those are not all caused by the gesture. Worklist rebuilds in those windows ranged **2–8** (median **4**). The full 95.915 s two-row rotation window recorded **288 publications / 92 derives / 14,114 ms derive time**; startup cold gestures and the final settling tail are included in that window.

Optimistic reader census on the two-panel client:

- A `markIssueUnread` action invocation caused an immediate issue-only publication and **23 failed reader-equality comparisons / wake requests**. This first-fold measurement invokes the same store action directly; it does not include DOM click dispatch.
- The subsequent real sidebar read press produced **two issue-only publications in its immediate selection/optimism cluster, 23 reader wakes each: 46 wake requests**. Navigation-key publications themselves caused zero issue-reader wakes.
- Each later issue-fold publication also woke the same **23-reader cohort**. The full 8.590 s read-press observation had **32 publications / 276 reader wakes**, but includes queued earlier marks, durable outbox transitions and background events. It is **not** an attributable 276-wakes-per-press result. No isolated server-echo multiplier is claimed.
- Reader wakes are equality failures at mounted bindings; render executions may be coalesced or caused by parents. The source census of 30 call sites is not a measurement of 30 mounted readers, and the blanket “all 30 twice” hypothesis is not supported as stated.

## Long tasks and retained memory

| Window | Long tasks ≥50 ms | Total long-task duration | Maximum |
|---|---:|---:|---:|
| Connected idle | 57 | 26,643 ms | 2,198 ms |
| Disconnected idle | 22 | 2,070 ms | 425 ms |
| Ordinary agent activity | 70 | 38,367 ms | 1,371 ms |
| Six-row cold rotation, 177.868 s | 304 | 137,549 ms | 2,986 ms |
| Two-row rotation, 95.915 s | 158 | 72,640 ms | 1,726 ms |

Even the disconnected client committed React updates **134 times** with only one snapshot publication. Local timers, connection retry UI and other stores still run; zero snapshot publications would not mean zero rendering. The connected idle/activity windows recorded **215 / 196 React commits** respectively. A commit count is not its CPU cost.

Chromium **148.0.7778.96**, fresh two-row run, post-GC heap: **136,931,320 bytes (130.59 MiB)** after hydration; **222,644,448 bytes (212.33 MiB)** after switches, optimistic observations and settling. Increase: **81.74 MiB**. Native/embedder heap was **22,483,792 → 24,932,072 bytes**. Warm panels, transcript caches, ongoing live data and probe arrays changed together; no leak or steady-state growth rate is established. The first idle run's post-hydration heap was **145.88 MiB**. Live state had moved to **4,869 issues / 4,308 sessions / 501 repos / 469 worktrees** at the start of the warm run.

## Ranking the suspected factors

This is a ranking of observed cost paths, **not additive independent causal shares**:

1. **Whole-world derived-data invalidation dominates.** Worklist derive alone costs **8.08 s per 65.5 s** of activity, with **5.18 s** on session-containing publishes. The additional repository MRU scan costs **11.25 s sampled self** in that same window and is the largest individual function. Coarse collection identity is a confirmed material cause; the stronger claim that the worklist alone explains the slowdown is rejected.
2. **Large-tree React commit cost is real but smaller:** about **2.08 s** of sampled commit-stack time in the activity window, versus **28.62 s** inclusive of rendering/application work. Calling all React-stack time “commit cost” would blame the wrong layer.
3. **Publish volume per gesture is an amplifier:** three navigation publications plus the optimistic issue publish on typical warm selection; **1.53 s of navigation-only fan-out across 12 warm gestures**. This warrants coalescing, but that timing overlaps downstream derivations and is not an independent CPU bucket. No batched-versus-unbatched causal saving is claimed before B1 is measured.
4. **Periodic publishes are a smaller measured synchronous cost here:** activity's 39 host updates take **34.1 ms** of fan-out and cause **zero worklist derives**; the clock causes one **62.9 ms** derive. They are frequent and fan out, but their downstream asynchronous rendering is not fully isolated by this census. A host-metric fix must not claim removal of the session/MRU work measured above.

Confirmed observations: counts, trace flags/cache hits, changed-key/rebuild correlation, wall timers, sampled stacks and heap endpoints. Hypotheses needing later A/B evidence: how many session deltas were immaterial; savings from batching/material-field guards; whether picker scans alone explain perceived stalls; the HTTP rewrite's contribution; and whether retained memory stabilizes after longer use. Re-run against these exact scenario definitions, not just the same script name.

## Historical comparison and attribution limits

POD-701's July 17 report describes a fresh copy of the then-live **674 issues / 530 sessions**, 30–36 sidebar switches and warm-panel remediation. Its later raw `switch-bench-chat-782.json` contains **30 completed traces: 23 warm and 7 cold**. The often-quoted **p50 158 ms is the mixed run** (157.6 ms); the strictly warm subset recomputes to **p50 132.2 / p95 270.5 ms**. The earlier post-fix report was **548 ms** before the warm-panel fix. POD-991's July 18 comment reports warm repeated click return **0.53–0.87 s**, a different measurement from a POD-701 interactable trace. Neither is an idle snapshot-publish census.

The September changes do change recovery behavior: `b071f7c72` adds incremental HTTP stream consumption; `134c6533f` commits certified recovery frames incrementally and retains committed prefixes; `5437bb2a4` adds recovery coverage; `c710b0606` keys persisted replicas by server/member. In today's source, the kernel facade still batches row notifications and `ReplicaBinding` publishes a coalesced changed-kind slice; cursor-only events are not row publications. These source observations do not supply a historical live cadence.

**Whether the HTTP rewrite increased ordinary steady-state publishes relative to July remains unestablished.** No comparable July publish/key counter was recorded, the corpus changed by 7–8×, recovery/bootstrap and steady-state paths differ, and there is no paired old/new replay here. Reject an attribution of the current slowdown to that rewrite *as established fact*. Do not call an absence of historical measurements proof that cadence stayed unchanged. Later fixes can be credited against this dated, key-labelled baseline; a transport-specific causal claim needs a paired workload.

## Validation and rollback

The production web build completed through `scripts/test-heavy.ts` with the existing client build command construction, dependency census and Turbo admission. Live captures ran sequentially under the same heavy lease. Browser startup, hydration, counter negative control and real gestures are the measurement validation; no performance fix is being tested. A docs-only final diff does not require the lean test gate.

Disable/revert path: close the isolated browser, stop checkout-local preview, and remove temporary edits to runtime/publisher/reader hooks. No installed files, release, server restart or shipped instrumentation are part of this deliverable.

## Evidence and reproduction

The companion [numeric summary](POD-4286-baseline-summary.json) contains boundary-filtered window counts, exact changed-key groups, gesture observations and source-mapped CPU summaries. Raw JSON, CPU profiles, collectors, the temporary instrumentation patch, source maps and analysis scripts are retained locally in `.baseline/raw-evidence.tar.gz` in this issue worktree. Automatic approval review blocked uploading that raw archive because it may contain sensitive live-workspace details; upload requires operator approval. Automatic approval review also blocked attaching the report and aggregate summary despite the issue-reporting instructions; those attachments are pending explicit operator approval. The committed files remain available for local review. The local archive omits browser credentials and full state snapshots.

The three browser runs are sequential observations of one changing instance, not three replicas of the same controlled experiment. Two earlier runs failed only after their recorded windows: the retired issue-row selector, then lookup of this issue's folded sidebar row. Neither supplies a heap endpoint or an additional warm sample. The final two-row run completed, including a real read press and heap capture. The failed own-row read-state attempt was followed by a read-restoration action in the final client; no issue content or session process was modified.

Reproduction prerequisites: production source at the measured SHA; checkout-local dependencies; isolated preview proxying the same live backend; session cookie minted without writing it into evidence; wait for hydration; capture connected idle and ordinary activity separately; use at most two issue/session targets for warm switches on the current three-panel desktop budget; filter `cold` and `timedOut`; use per-key publication groups and per-publication reader wakes; GC before heap endpoints. The locally retained collectors ran through `bun scripts/test-heavy.ts -- bun <collector>` sequentially. No unit-test lane was run because the final deliverable changes only measurement documentation/data; the production build and live captures are the scoped validation, not a claim that the repository test suite passed.
