# Full-screen click CPU profiles

React render accounts for 61.5–92.9% of the sampled input-to-Paint windows. The largest leaf cost is the session read view’s Proxy `get`; its callers repeatedly scan all sessions while FlightDeck collects archived sessions and IssuePanelView builds child controls. Both pilot arms retain these paths at this SHA.

Capture SHA: **`6cbbbc28a905545ff10f2bb2ed9fde27a259f9f8`**. Product base: `a6736a90deff8bdb686075ae75a8c9dd8379e33b` on `integrate/4286-pilot`; the capture commits change only new measurement harness files. Source coordinates below refer to this captured tree, not subsequent integration landings. Date: 2026-10-03T00:34:05.094Z. Issue: POD-5305.

## Measurement contract

The sibling `apps/web/harness/full-screen-click-profile.ts --profile=all` imports the canonical acceptance fixture and the speed gate’s production Vite configuration and Paint-boundary helper. It builds ordinary minified React 19.2.7 (`bundleType=0`), with hidden source maps and the same removal of acceptance state-boundary wrappers. No profiling renderer, product patch, baseline promotion, or speed-gate report write is involved. The original speed gate and fixture are unchanged.

Host: flatblock, Linux x64, 8 logical CPUs, AMD EPYC Processor (with IBPB); Chromium 153.0.8010.12, headless, 1800×1000, reduced motion. An isolated checkout with checkout-local Bun 1.4.2 dependencies was used. Capture ran under `bench:flatblock`; a shell EXIT trap released the lease at completion. OFF then ON use fresh browser contexts in one browser, two unretained warmups followed by three retained samples per action: 24 CPU profiles and 24 traces.

**Pilot definition:** `mobxPane=0` (OFF) versus `mobxPane=1` (ON); `mobxSidebar=1` stays fixed in both arms, as in the repaired gate. These are explicit startup URL overrides, not an all-screens device-setting toggle. The fixture verifies sidebar mode/pool presence and the pane’s legacy/pool startup latch. At this product base the pane switch moves navigation/provider work; FlightDeck and IssuePanelView still run the legacy derivations profiled here.

Fixture: `surface=full`, `scale=4`, seed 4443, `panelMode=chat`, fixed gate targets. Runtime has 19,468 issues and 17,208 sessions (17,216 sessions in the generated input), 1,889 repositories and 1,872 worktrees. Mission targets `i13916` and `i19016` have 325 and 285 deck rows. Session targets are `s8608` and `s11337`. Rename commits `i13916` by a trusted outside click/production blur; background delivery changes the visible title of unrelated `i19016`. After the odd session sample block, session `s11337` is restored to match the ordinary six-sample gate’s rename/background dock context.

Browser `Date.now()` starts at the gate’s fixed 2026-09-20T12:00:00Z anchor and advances with elapsed time. This holds time-dependent card content steady; it does not alter `performance.now()` input/Paint clocks. The clean collector ran approximately 00:28:45–00:34:05 UTC on 2026-10-03 (319.335 seconds including build, warmups and metadata). Process audits during capture saw only this issue’s collector/browser jobs; one-minute load averages recorded after samples ranged 3.52–5.25. The lease was released immediately after capture. Earlier diagnostic and overlapped recordings are excluded.

CPU/trace windows use Chromium’s shared timestamp domain. The captured `clockSync.monotonicUs` is Bun’s process-relative hrtime and cannot be aligned directly with Chromium uptime timestamps; it is unused by all reported timing calculations. The landed collector records browser `performance.timeOrigin` for future UTC alignment. This metadata correction and the offline observer-attribution correction below leave the 24 raw recordings unchanged.

The three mission/session samples alternate target 0, 1, 0. Setup, hover, scrolling, opening/filling the rename editor, warmups, and post-Paint work are excluded. The window starts at the trusted `pointerdown` event timestamp; background update starts at actual fixture feed delivery in rAF. It ends at the **end of the first main-renderer Chromium `Paint` after the expected DOM change**, using the gate’s `paintOf`. This is display-list Paint, not completion of GPU raster/compositing or presentation on a physical monitor.

CDP `Profiler` is armed before input at a requested 1,000 µs sampling interval; the trace uses `toplevel,devtools.timeline,blink.user_timing`. Raw files include setup/tails. The analyzer clips both to the same marked window and emits `.window.cpuprofile` plus a `.mapped.window.cpuprofile` with original function names and declaration coordinates for easier viewing. The raw file is preserved. Source maps and source ASTs recover declaration locations, including property arrows such as Proxy `get`. V8 may inline callbacks into their caller; the tables describe sampled frames, not invocation counts. A tiny generated interop asset has no original source map and retains an explicitly generated location in `analysis.json`; no application source location is invented for it.

## What the numbers count

- **Wall ms:** elapsed trusted input/feed-delivery → qualifying Paint end. Every sample appears below; latency and category tables use medians of three, independently by column.
- **Self ms / inclusive ms:** arithmetic means of three recordings, excluding the measurement observer. V8 sample intervals are reconstructed from `startTime + timeDeltas`, sorted, and clipped. Self counts only the leaf; inclusive counts a function and its sampled descendants once per stack, including inlined code attributed by V8. Inclusive rows overlap and must not be added. These are sampled elapsed-time estimates, not hardware CPU-cycle or call-count measurements. `rawSelf` / `rawInclusive` retain V8’s original attribution per recording in `analysis.json`.
- **React render:** exclusive sampled intervals with React render-root/hooks on the stack, including app functions and their synchronous derivations. A component function’s inclusive cost covers its body and calls; it does not include child components that React renders later. Commit/layout and passive-effect stacks are separate.
- **MobX:** exclusive reaction intervals outside React render/commit; other tracking/computed/scheduling is separate. An additional inclusive reaction figure and the MobX derivation overlap inside React render are shown, so React-triggered work is not charged twice.
- **Layout/paint:** union of clipped main-thread complete trace events per category. The combined union merges `UpdateLayoutTree`, `Layout`, `PrePaint`, `Paint`. These durations overlap CPU samples/native calls and must not be added to the sampled columns.
- **Commits / rendered instances:** DevTools-hook root commits whose marks precede Paint; function, class, ForwardRef and SimpleMemo fibers with `PerformedWork`, excluding host nodes/providers and exact fibers reused from the previous commit. Memo wrapper fibers are excluded because their child invokes the actual component. Counts include distinct instances and repeat renders across commits; they exclude abandoned/restarted render attempts. A measurement-only walk tracks the prior committed fibers even outside capture to avoid counting stale flags in bailed-out subtrees.
- **Tasks:** main-thread `ThreadControllerImpl::RunTask` complete events intersecting the window. A long task has a window intersection >50 ms. The longest-task duration is clipped to the window, while raw analysis also retains each full task duration. Commits within one task do not imply yielding to the browser.
- **Commit observer:** the recorded walk wall duration is `end − at` in browser `performance.now()`. CPU classification excludes the union of these intervals (anchored to the trusted input trace mark) and sampled `onCommitFiberRoot` stacks. V8 often charges hook work to React’s `flushSpawnedWork`; recognizing only the hook’s function name would undercount it. The sampled category can slightly exceed the recorded walk duration because it includes callback work outside the measured walk and sampling-boundary estimates. It also takes priority over GC inside those intervals.

## Latency and task structure

| Action / pilot | Samples 0 / 1 / 2 (wall ms) | Median ms | Commits 0 / 1 / 2 | Tasks 0 / 1 / 2 | Long tasks 0 / 1 / 2 | Longest task 0 / 1 / 2 (ms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| mission-switch OFF | 4,281.0 / 3,431.1 / 3,813.3 | 3,813.3 | 7 / 7 / 7 | 7 / 6 / 5 | 1 / 1 / 2 | 4,239.0 / 3,403.4 / 3,757.7 |
| mission-switch ON | 4,444.1 / 3,334.9 / 4,038.9 | 4,038.9 | 7 / 7 / 7 | 8 / 6 / 5 | 1 / 1 / 1 | 4,403.1 / 3,300.3 / 4,005.8 |
| session-switch OFF | 4,083.6 / 3,166.4 / 2,985.5 | 3,166.4 | 30 / 2 / 10 | 408 / 55 / 119 | 2 / 1 / 1 | 3,129.8 / 2,860.8 / 2,572.0 |
| session-switch ON | 3,668.3 / 3,007.7 / 3,025.0 | 3,025.0 | 48 / 4 / 2 | 602 / 70 / 58 | 1 / 1 / 1 | 2,537.9 / 2,653.6 / 2,719.7 |
| issue-rename OFF | 2,828.4 / 2,980.0 / 2,618.2 | 2,828.4 | 2 / 2 / 2 | 6 / 9 / 10 | 1 / 1 / 1 | 2,818.6 / 2,963.3 / 2,601.5 |
| issue-rename ON | 2,464.8 / 2,532.4 / 2,425.2 | 2,464.8 | 2 / 2 / 2 | 6 / 5 / 9 | 1 / 1 / 1 | 2,456.7 / 2,531.2 / 2,409.6 |
| background-update OFF | 2,638.9 / 2,619.6 / 2,772.5 | 2,638.9 | 2 / 2 / 2 | 1 / 1 / 1 | 1 / 1 / 1 | 2,638.9 / 2,619.6 / 2,772.5 |
| background-update ON | 2,686.5 / 2,627.0 / 3,032.1 | 2,686.5 | 2 / 2 / 2 | 1 / 1 / 1 | 1 / 1 / 1 | 2,686.5 / 2,627.0 / 3,032.1 |

Mission switch and rename spend **at least 98.5%** of their windows in one long task; background delivery’s entire measured window is one task. Session switch has **one 2.54–3.13 s dominant task** accounting for 69.2–90.3% of wall time, within 55–602 total tasks. Its dominant task begins 289–1,115 ms after input. The first session sample has 30 OFF / 48 ON commits; 522.8 / 695.2 ms of its 937.3 / 1,115.0 ms prefix is the measurement observer. Thus the session recording includes considerable instrumentation work before the main render task. The multi-second archive/render pass itself remains one browser-blocking task.

These instrumented latencies must not be substituted for the old gate’s unprofiled 3–4 s figures. `click-speed-baseline.json` is at `0f77a997ed217117cf284f9fa142080c453efae6`, with medians 4,020.7 / 3,405.9 / 2,972.9 / 3,257.5 ms respectively and sidebar 159.5 ms. Product code changed between that baseline and the captured base; Profiler, tracing, and the commit observer also add overhead. No same-SHA unprofiled overhead control was run, so the difference cannot be assigned wholly to instrumentation. The sidebar metric comes from the gate’s separate `surface=sidebar` fixture; these recordings all mount `surface=full`. OFF always precedes ON and n=3 is small, so differences between arm medians are descriptive, not a causal pilot speedup estimate or a new gate verdict.

## Sampled work versus browser work

All entries below are independently computed median ms. “Other” combines other JS/native/program and idle. The measurement observer is kept out of React columns. A zero denotes no observed sampled interval at this resolution, not proof that a function never ran.

| Action / pilot | React render | React commit/layout effects | React passive | MobX reactions outside React | Other MobX | GC | Commit observer | Other |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| mission-switch OFF | 3,124.8 | 223.1 | 42.9 | 0.4 | 0.0 | 70.6 | 136.0 | 199.9 |
| mission-switch ON | 3,407.4 | 219.1 | 43.9 | 5.4 | 7.1 | 66.7 | 126.9 | 181.4 |
| session-switch OFF | 2,453.5 | 53.9 | 9.9 | 1.1 | 0.8 | 44.1 | 188.7 | 427.4 |
| session-switch ON | 2,329.6 | 46.1 | 8.4 | 7.1 | 7.1 | 32.0 | 68.6 | 510.4 |
| issue-rename OFF | 2,610.5 | 31.9 | 0.4 | 1.1 | 0.0 | 55.3 | 35.1 | 98.7 |
| issue-rename ON | 2,288.6 | 33.8 | 0.1 | 3.8 | 0.0 | 40.9 | 39.5 | 75.7 |
| background-update OFF | 2,322.3 | 32.3 | 0.4 | 2.1 | 0.0 | 40.9 | 35.7 | 207.1 |
| background-update ON | 2,348.0 | 42.3 | 0.8 | 1.1 | 1.1 | 43.0 | 34.9 | 206.6 |

| Action / pilot | Style (`UpdateLayoutTree`) | Layout | PrePaint | Paint | Combined union | Inclusive MobX reactions | MobX derivations within React render |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| mission-switch OFF | 25.1 | 129.1 | 29.2 | 17.1 | 210.6 | 0.4 | 0.0 |
| mission-switch ON | 24.6 | 135.0 | 27.6 | 19.7 | 204.7 | 6.0 | 0.0 |
| session-switch OFF | 4.7 | 27.3 | 13.6 | 41.7 | 87.2 | 1.1 | 0.0 |
| session-switch ON | 4.8 | 15.6 | 8.7 | 18.6 | 53.8 | 7.1 | 0.0 |
| issue-rename OFF | 0.2 | 4.0 | 4.5 | 12.4 | 21.1 | 1.1 | 0.0 |
| issue-rename ON | 0.2 | 3.5 | 4.1 | 7.8 | 15.8 | 3.8 | 0.0 |
| background-update OFF | 0.0 | 2.9 | 2.4 | 7.0 | 12.4 | 2.1 | 0.0 |
| background-update ON | 0.0 | 2.9 | 1.6 | 4.5 | 9.5 | 1.1 | 0.0 |

## Ranked costs to target

1. **FlightDeck’s repeated archive scan.** `FlightDeck` (`apps/web/src/app/FlightDeck.tsx:2923`) costs 1,838.9–2,256.5 inclusive ms across the eight action/arm groups. `archivedSessionsForIssue` (`packages/client-core/src/viewmodels/session-ownership.ts:333`) accounts for 1,483.5–1,714.8 inclusive ms. The memo at `FlightDeck.tsx:3328` loops over every mission row and filters all sessions, even while the archive reveal is closed. One recomputation has 285 × 17,208 = 4,904,280 or 325 × 17,208 = 5,592,600 candidate visits; this is a source-derived count, not a sampled invocation count. This path remains present for session selection, title rename and an unrelated visible feed update.
2. **Session read-view property access.** Proxy `get` at `packages/client-core/src/session-values.ts:128` is the top self-time function for every arm: **1,015.7–1,409.7 ms**. It invokes the `read` closure (`:122`) and `Object.hasOwn` / `Reflect.get` for each property. This is accessor execution, distinct from the read-view factory/WeakMap join at `:94`. These getter costs occur inside the scans above and below; they overlap the inclusive figures and are not another additive budget.
3. **Issue membership scans in child controls.** `issueSessions` (`apps/web/src/features/issues/IssueCompactControls.tsx:88`, filter callback `:94`) costs 732.7 OFF / 724.5 ON inclusive ms on mission switch. `IssuePanelView` (`apps/web/src/features/issues/IssuePanelView.tsx:825`) is 696.8 / 691.8 inclusive ms; its `openChildren.map` at `:1132` repeatedly calls that helper, with further calls from compact controls. Other actions have 22.8–144.3 inclusive ms in the helper. Narrow per-issue session inputs address this repeated global filtering.
4. **Broad legacy issue selections and component work.** `useIssueModelsSelection` (`packages/client-core/src/replica/use-issue-views.ts:65`) costs up to 249.9 inclusive ms; its `modelsFor` child (`packages/client-core/src/replica/issue-view-cache.ts:203`) reaches 247.3 ms on background update. Rename’s chat `select` (`apps/web/src/features/chat/issue-chip-refs.ts:75`) is 105.2–121.2 inclusive ms. Each action commits **8,659–15,409 composite instance renders**, including repeated instances over commits. The complete matrix below identifies the sources. These are smaller than the archive pass but still substantial broad-update work.
5. **DOM, layout and paint.** The combined trace union is 204.7–210.6 median ms for mission switch, 53.8–87.2 ms for session switch, 15.8–21.1 ms for rename and 9.5–12.4 ms for background delivery. Mission’s layout alone is 129.1–135.0 ms. `readBriefMetrics` (`FlightDeck.tsx:2384`) has only 0.1–0.2 mean inclusive ms in the mission window at this source tree. MobX reactions outside React are 0.4–7.1 median ms, with other tracking/scheduling at most 7.1 ms. The current main-pane cost is concentrated in React’s synchronous derivations and render work.

## Functions by action

Each arm shows its top five self-time entries, its top five inclusive entries across all functions, and its top five **application** inclusive functions (apps/packages). Measurement observer intervals are excluded from both rankings. The inclusive framework roots overlap almost completely; the application table identifies the work beneath them. Full rankings, original V8 rankings, all samples, generated names and mapping coordinates are in attached `analysis.json`. All ms here are means of three, not medians. Runtime pseudo-frames have no source location. V8 sometimes attributes an inlined filter callback to its caller; compare the archive function’s inclusive time across actions.

### mission-switch OFF

Top self time.

| Function — original declaration file:line | Self ms | Inclusive ms |
| --- | ---: | ---: |
| `get — packages/client-core/src/session-values.ts:128` | 1,318.9 | 1,318.9 |
| `archivedSessionsForIssue / sessions.filter callback@341 — packages/client-core/src/viewmodels/session-ownership.ts:341` | 409.8 | 967.7 |
| `archivedSessionsForIssue — packages/client-core/src/viewmodels/session-ownership.ts:333` | 275.0 | 1,507.4 |
| `issueSessions — apps/web/src/features/issues/IssueCompactControls.tsx:88` | 268.3 | 732.7 |
| `(garbage collector)` | 141.4 | 141.4 |

Top inclusive time.

| Function — original declaration file:line | Self ms | Inclusive ms |
| --- | ---: | ---: |
| `processRootScheduleInMicrotask — node_modules/react-dom/cjs/react-dom-client.production.js:11966` | 0.0 | 3,375.6 |
| `scheduleImmediateRootScheduleTask / scheduleMicrotask callback@12089 — node_modules/react-dom/cjs/react-dom-client.production.js:12089` | 0.0 | 3,375.6 |
| `performWorkOnRoot — node_modules/react-dom/cjs/react-dom-client.production.js:10681` | 0.0 | 3,375.6 |
| `performSyncWorkOnRoot — node_modules/react-dom/cjs/react-dom-client.production.js:12084` | 0.0 | 3,375.6 |
| `flushSyncWorkAcrossRoots_impl — node_modules/react-dom/cjs/react-dom-client.production.js:11918` | 0.0 | 3,375.6 |

Top application inclusive time.

| Function — original declaration file:line | Self ms | Inclusive ms |
| --- | ---: | ---: |
| `FlightDeck — apps/web/src/app/FlightDeck.tsx:2923` | 73.7 | 2,000.0 |
| `archivedSessionsForIssue — packages/client-core/src/viewmodels/session-ownership.ts:333` | 275.0 | 1,507.4 |
| `get — packages/client-core/src/session-values.ts:128` | 1,318.9 | 1,318.9 |
| `archivedSessionsForIssue / sessions.filter callback@341 — packages/client-core/src/viewmodels/session-ownership.ts:341` | 409.8 | 967.7 |
| `issueSessions — apps/web/src/features/issues/IssueCompactControls.tsx:88` | 268.3 | 732.7 |


### mission-switch ON

Top self time.

| Function — original declaration file:line | Self ms | Inclusive ms |
| --- | ---: | ---: |
| `get — packages/client-core/src/session-values.ts:128` | 1,409.7 | 1,409.7 |
| `archivedSessionsForIssue / sessions.filter callback@341 — packages/client-core/src/viewmodels/session-ownership.ts:341` | 436.0 | 1,021.9 |
| `archivedSessionsForIssue — packages/client-core/src/viewmodels/session-ownership.ts:333` | 309.4 | 1,686.3 |
| `issueSessions / sessions.filter callback@94 — apps/web/src/features/issues/IssueCompactControls.tsx:94` | 239.8 | 478.2 |
| `issueSessions — apps/web/src/features/issues/IssueCompactControls.tsx:88` | 153.6 | 724.5 |

Top inclusive time.

| Function — original declaration file:line | Self ms | Inclusive ms |
| --- | ---: | ---: |
| `processRootScheduleInMicrotask — node_modules/react-dom/cjs/react-dom-client.production.js:11966` | 0.0 | 3,545.0 |
| `scheduleImmediateRootScheduleTask / scheduleMicrotask callback@12089 — node_modules/react-dom/cjs/react-dom-client.production.js:12089` | 0.0 | 3,545.0 |
| `performWorkOnRoot — node_modules/react-dom/cjs/react-dom-client.production.js:10681` | 0.0 | 3,545.0 |
| `performSyncWorkOnRoot — node_modules/react-dom/cjs/react-dom-client.production.js:12084` | 0.0 | 3,545.0 |
| `flushSyncWorkAcrossRoots_impl — node_modules/react-dom/cjs/react-dom-client.production.js:11918` | 0.0 | 3,545.0 |

Top application inclusive time.

| Function — original declaration file:line | Self ms | Inclusive ms |
| --- | ---: | ---: |
| `FlightDeck — apps/web/src/app/FlightDeck.tsx:2923` | 65.2 | 2,159.4 |
| `archivedSessionsForIssue — packages/client-core/src/viewmodels/session-ownership.ts:333` | 309.4 | 1,686.3 |
| `get — packages/client-core/src/session-values.ts:128` | 1,409.7 | 1,409.7 |
| `archivedSessionsForIssue / sessions.filter callback@341 — packages/client-core/src/viewmodels/session-ownership.ts:341` | 436.0 | 1,021.9 |
| `issueSessions — apps/web/src/features/issues/IssueCompactControls.tsx:88` | 153.6 | 724.5 |


### session-switch OFF

Top self time.

| Function — original declaration file:line | Self ms | Inclusive ms |
| --- | ---: | ---: |
| `get — packages/client-core/src/session-values.ts:128` | 1,225.1 | 1,225.1 |
| `archivedSessionsForIssue — packages/client-core/src/viewmodels/session-ownership.ts:333` | 721.2 | 1,657.8 |
| `(program)` | 201.1 | 201.1 |
| `FlightDeck — apps/web/src/app/FlightDeck.tsx:2923` | 110.7 | 2,256.5 |
| `IssuePanelView — apps/web/src/features/issues/IssuePanelView.tsx:825` | 110.1 | 225.3 |

Top inclusive time.

| Function — original declaration file:line | Self ms | Inclusive ms |
| --- | ---: | ---: |
| `performWorkOnRoot — node_modules/react-dom/cjs/react-dom-client.production.js:10681` | 0.0 | 2,571.5 |
| `processRootScheduleInMicrotask — node_modules/react-dom/cjs/react-dom-client.production.js:11966` | 0.0 | 2,564.2 |
| `scheduleImmediateRootScheduleTask / scheduleMicrotask callback@12089 — node_modules/react-dom/cjs/react-dom-client.production.js:12089` | 0.0 | 2,564.2 |
| `performSyncWorkOnRoot — node_modules/react-dom/cjs/react-dom-client.production.js:12084` | 0.0 | 2,564.1 |
| `flushSyncWorkAcrossRoots_impl — node_modules/react-dom/cjs/react-dom-client.production.js:11918` | 0.0 | 2,564.1 |

Top application inclusive time.

| Function — original declaration file:line | Self ms | Inclusive ms |
| --- | ---: | ---: |
| `FlightDeck — apps/web/src/app/FlightDeck.tsx:2923` | 110.7 | 2,256.5 |
| `archivedSessionsForIssue — packages/client-core/src/viewmodels/session-ownership.ts:333` | 721.2 | 1,657.8 |
| `get — packages/client-core/src/session-values.ts:128` | 1,225.1 | 1,225.1 |
| `IssuePanelView — apps/web/src/features/issues/IssuePanelView.tsx:825` | 110.1 | 225.3 |
| `selectSession — apps/web/src/app/FlightDeck.tsx:3628` | 0.0 | 183.3 |


### session-switch ON

Top self time.

| Function — original declaration file:line | Self ms | Inclusive ms |
| --- | ---: | ---: |
| `get — packages/client-core/src/session-values.ts:128` | 1,074.6 | 1,074.6 |
| `archivedSessionsForIssue — packages/client-core/src/viewmodels/session-ownership.ts:333` | 728.0 | 1,543.7 |
| `(program)` | 181.2 | 181.2 |
| `(idle)` | 146.5 | 146.5 |
| `FlightDeck — apps/web/src/app/FlightDeck.tsx:2923` | 116.8 | 2,121.1 |

Top inclusive time.

| Function — original declaration file:line | Self ms | Inclusive ms |
| --- | ---: | ---: |
| `performWorkOnRoot — node_modules/react-dom/cjs/react-dom-client.production.js:10681` | 0.0 | 2,386.0 |
| `scheduleImmediateRootScheduleTask / scheduleMicrotask callback@12089 — node_modules/react-dom/cjs/react-dom-client.production.js:12089` | 0.0 | 2,377.4 |
| `processRootScheduleInMicrotask — node_modules/react-dom/cjs/react-dom-client.production.js:11966` | 0.0 | 2,377.4 |
| `flushSyncWorkAcrossRoots_impl — node_modules/react-dom/cjs/react-dom-client.production.js:11918` | 0.0 | 2,377.4 |
| `performSyncWorkOnRoot — node_modules/react-dom/cjs/react-dom-client.production.js:12084` | 0.0 | 2,377.4 |

Top application inclusive time.

| Function — original declaration file:line | Self ms | Inclusive ms |
| --- | ---: | ---: |
| `FlightDeck — apps/web/src/app/FlightDeck.tsx:2923` | 116.8 | 2,121.1 |
| `archivedSessionsForIssue — packages/client-core/src/viewmodels/session-ownership.ts:333` | 728.0 | 1,543.7 |
| `get — packages/client-core/src/session-values.ts:128` | 1,074.6 | 1,074.6 |
| `IssuePanelView — apps/web/src/features/issues/IssuePanelView.tsx:825` | 67.6 | 193.8 |
| `selectSession — apps/web/src/app/FlightDeck.tsx:3628` | 0.0 | 170.1 |


### issue-rename OFF

Top self time.

| Function — original declaration file:line | Self ms | Inclusive ms |
| --- | ---: | ---: |
| `get — packages/client-core/src/session-values.ts:128` | 1,138.9 | 1,138.9 |
| `archivedSessionsForIssue — packages/client-core/src/viewmodels/session-ownership.ts:333` | 784.2 | 1,714.8 |
| `FlightDeck — apps/web/src/app/FlightDeck.tsx:2923` | 106.8 | 2,095.3 |
| `(garbage collector)` | 68.2 | 68.2 |
| `IssuePanelView — apps/web/src/features/issues/IssuePanelView.tsx:825` | 63.5 | 191.3 |

Top inclusive time.

| Function — original declaration file:line | Self ms | Inclusive ms |
| --- | ---: | ---: |
| `performWorkOnRoot — node_modules/react-dom/cjs/react-dom-client.production.js:10681` | 0.0 | 2,603.6 |
| `performSyncWorkOnRoot — node_modules/react-dom/cjs/react-dom-client.production.js:12084` | 0.0 | 2,603.6 |
| `flushSyncWorkAcrossRoots_impl — node_modules/react-dom/cjs/react-dom-client.production.js:11918` | 0.0 | 2,603.6 |
| `processRootScheduleInMicrotask — node_modules/react-dom/cjs/react-dom-client.production.js:11966` | 0.0 | 2,603.6 |
| `scheduleImmediateRootScheduleTask / scheduleMicrotask callback@12089 — node_modules/react-dom/cjs/react-dom-client.production.js:12089` | 0.0 | 2,603.6 |

Top application inclusive time.

| Function — original declaration file:line | Self ms | Inclusive ms |
| --- | ---: | ---: |
| `FlightDeck — apps/web/src/app/FlightDeck.tsx:2923` | 106.8 | 2,095.3 |
| `archivedSessionsForIssue — packages/client-core/src/viewmodels/session-ownership.ts:333` | 784.2 | 1,714.8 |
| `get — packages/client-core/src/session-values.ts:128` | 1,138.9 | 1,138.9 |
| `IssuePanelView — apps/web/src/features/issues/IssuePanelView.tsx:825` | 63.5 | 191.3 |
| `LegacyIssueChipLiveness — apps/web/src/features/chat/IssueChipLiveness.tsx:51` | 7.8 | 129.0 |


### issue-rename ON

Top self time.

| Function — original declaration file:line | Self ms | Inclusive ms |
| --- | ---: | ---: |
| `get — packages/client-core/src/session-values.ts:128` | 1,036.1 | 1,036.1 |
| `archivedSessionsForIssue — packages/client-core/src/viewmodels/session-ownership.ts:333` | 660.1 | 1,495.0 |
| `FlightDeck — apps/web/src/app/FlightDeck.tsx:2923` | 105.5 | 1,838.9 |
| `issueSessions / sessions.filter callback@94 — apps/web/src/features/issues/IssueCompactControls.tsx:94` | 55.7 | 121.9 |
| `(program)` | 51.7 | 51.7 |

Top inclusive time.

| Function — original declaration file:line | Self ms | Inclusive ms |
| --- | ---: | ---: |
| `performWorkOnRoot — node_modules/react-dom/cjs/react-dom-client.production.js:10681` | 0.0 | 2,317.3 |
| `performSyncWorkOnRoot — node_modules/react-dom/cjs/react-dom-client.production.js:12084` | 0.0 | 2,317.3 |
| `flushSyncWorkAcrossRoots_impl — node_modules/react-dom/cjs/react-dom-client.production.js:11918` | 0.0 | 2,317.3 |
| `processRootScheduleInMicrotask — node_modules/react-dom/cjs/react-dom-client.production.js:11966` | 0.0 | 2,317.3 |
| `scheduleImmediateRootScheduleTask / scheduleMicrotask callback@12089 — node_modules/react-dom/cjs/react-dom-client.production.js:12089` | 0.0 | 2,317.3 |

Top application inclusive time.

| Function — original declaration file:line | Self ms | Inclusive ms |
| --- | ---: | ---: |
| `FlightDeck — apps/web/src/app/FlightDeck.tsx:2923` | 105.5 | 1,838.9 |
| `archivedSessionsForIssue — packages/client-core/src/viewmodels/session-ownership.ts:333` | 660.1 | 1,495.0 |
| `get — packages/client-core/src/session-values.ts:128` | 1,036.1 | 1,036.1 |
| `IssuePanelView — apps/web/src/features/issues/IssuePanelView.tsx:825` | 39.7 | 192.2 |
| `issueSessions / sessions.filter callback@94 — apps/web/src/features/issues/IssueCompactControls.tsx:94` | 55.7 | 121.9 |


### background-update OFF

Top self time.

| Function — original declaration file:line | Self ms | Inclusive ms |
| --- | ---: | ---: |
| `get — packages/client-core/src/session-values.ts:128` | 1,015.7 | 1,015.7 |
| `archivedSessionsForIssue / sessions.filter callback@341 — packages/client-core/src/viewmodels/session-ownership.ts:341` | 582.5 | 1,427.1 |
| `FlightDeck — apps/web/src/app/FlightDeck.tsx:2923` | 102.2 | 1,849.5 |
| `issueSessions / sessions.filter callback@94 — apps/web/src/features/issues/IssueCompactControls.tsx:94` | 78.3 | 155.3 |
| `deriveIssueViews — packages/client-core/src/replica/issue-views.ts:303` | 75.3 | 98.3 |

Top inclusive time.

| Function — original declaration file:line | Self ms | Inclusive ms |
| --- | ---: | ---: |
| `performWorkOnRoot — node_modules/react-dom/cjs/react-dom-client.production.js:10681` | 0.0 | 2,382.2 |
| `performSyncWorkOnRoot — node_modules/react-dom/cjs/react-dom-client.production.js:12084` | 0.0 | 2,382.2 |
| `flushSyncWorkAcrossRoots_impl — node_modules/react-dom/cjs/react-dom-client.production.js:11918` | 0.0 | 2,382.2 |
| `processRootScheduleInMicrotask — node_modules/react-dom/cjs/react-dom-client.production.js:11966` | 0.0 | 2,382.2 |
| `scheduleImmediateRootScheduleTask / scheduleMicrotask callback@12089 — node_modules/react-dom/cjs/react-dom-client.production.js:12089` | 0.0 | 2,382.2 |

Top application inclusive time.

| Function — original declaration file:line | Self ms | Inclusive ms |
| --- | ---: | ---: |
| `FlightDeck — apps/web/src/app/FlightDeck.tsx:2923` | 102.2 | 1,849.5 |
| `archivedSessionsForIssue — packages/client-core/src/viewmodels/session-ownership.ts:333` | 56.4 | 1,483.5 |
| `archivedSessionsForIssue / sessions.filter callback@341 — packages/client-core/src/viewmodels/session-ownership.ts:341` | 582.5 | 1,427.1 |
| `get — packages/client-core/src/session-values.ts:128` | 1,015.7 | 1,015.7 |
| `useIssueModelsSelection — packages/client-core/src/replica/use-issue-views.ts:65` | 2.6 | 249.9 |


### background-update ON

Top self time.

| Function — original declaration file:line | Self ms | Inclusive ms |
| --- | ---: | ---: |
| `get — packages/client-core/src/session-values.ts:128` | 1,074.7 | 1,074.7 |
| `archivedSessionsForIssue — packages/client-core/src/viewmodels/session-ownership.ts:333` | 750.8 | 1,634.7 |
| `FlightDeck — apps/web/src/app/FlightDeck.tsx:2923` | 101.1 | 1,966.4 |
| `deriveIssueViews — packages/client-core/src/replica/issue-views.ts:303` | 63.7 | 90.5 |
| `(garbage collector)` | 56.9 | 56.9 |

Top inclusive time.

| Function — original declaration file:line | Self ms | Inclusive ms |
| --- | ---: | ---: |
| `performWorkOnRoot — node_modules/react-dom/cjs/react-dom-client.production.js:10681` | 0.0 | 2,487.9 |
| `performSyncWorkOnRoot — node_modules/react-dom/cjs/react-dom-client.production.js:12084` | 0.0 | 2,487.9 |
| `flushSyncWorkAcrossRoots_impl — node_modules/react-dom/cjs/react-dom-client.production.js:11918` | 0.0 | 2,487.9 |
| `processRootScheduleInMicrotask — node_modules/react-dom/cjs/react-dom-client.production.js:11966` | 0.0 | 2,487.9 |
| `scheduleImmediateRootScheduleTask / scheduleMicrotask callback@12089 — node_modules/react-dom/cjs/react-dom-client.production.js:12089` | 0.0 | 2,487.9 |

Top application inclusive time.

| Function — original declaration file:line | Self ms | Inclusive ms |
| --- | ---: | ---: |
| `FlightDeck — apps/web/src/app/FlightDeck.tsx:2923` | 101.1 | 1,966.4 |
| `archivedSessionsForIssue — packages/client-core/src/viewmodels/session-ownership.ts:333` | 750.8 | 1,634.7 |
| `get — packages/client-core/src/session-values.ts:128` | 1,074.7 | 1,074.7 |
| `useIssueModelsSelection — packages/client-core/src/replica/use-issue-views.ts:65` | 2.0 | 242.8 |
| `modelsFor — packages/client-core/src/replica/issue-view-cache.ts:203` | 43.9 | 240.8 |

## Committed components

The following complete matrix lists **every observed committed composite source function**. Each cell is the summed instance-render counts for samples **0 / 1 / 2**; `0` means absent in all three. Memo/observer wrappers are resolved to the original function through CDP `FunctionLocation` and sampled generated-name mappings. Library factories can produce several components with one source function: those rows are explicitly source-function groups, not a claim that their instances are the same component. Lucide factory functions retain their runtime icon name. Hosts, React context-provider fiber tags, bailouts, and abandoned renders are excluded; function providers that render are included.

| Action / pilot | Rendered instances 0 / 1 / 2 | Observer walk wall ms 0 / 1 / 2 |
| --- | ---: | ---: |
| mission-switch OFF | 15409 / 13612 / 15053 | 132.5 / 133.3 / 115.0 |
| mission-switch ON | 15409 / 13612 / 15053 | 122.6 / 134.7 / 111.8 |
| session-switch OFF | 9136 / 8879 / 8928 | 563.4 / 43.4 / 184.3 |
| session-switch ON | 9287 / 8888 / 8865 | 727.3 / 66.7 / 34.3 |
| issue-rename OFF | 8659 / 8674 / 8664 | 31.5 / 32.9 / 39.5 |
| issue-rename ON | 8659 / 8659 / 8665 | 30.8 / 42.6 / 38.8 |
| background-update OFF | 8662 / 8659 / 8665 | 33.0 / 35.0 / 43.7 |
| background-update ON | 8659 / 8659 / 8662 | 33.5 / 30.2 / 36.2 |

<details>
<summary>Complete component counts and mapped source functions</summary>

| Component source function | mission-switch OFF | mission-switch ON | session-switch OFF | session-switch ON | issue-rename OFF | issue-rename ON | background-update OFF | background-update ON |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ` — node_modules/lucide-react/dist/esm/Icon.mjs:16` | 880 / 764 / 870 | 880 / 764 / 870 | 807 / 809 / 807 | 807 / 809 / 807 | 772 / 772 / 772 | 772 / 772 / 772 | 772 / 772 / 772 | 772 / 772 / 772 |
| `AgentPanel — apps/web/src/features/terminal/AgentPanel.tsx:207` | 4 / 4 / 4 | 4 / 4 / 4 | 6 / 6 / 6 | 6 / 6 / 6 | 3 / 3 / 3 | 3 / 3 / 3 | 3 / 3 / 3 | 3 / 3 / 3 |
| `AgentPanelBoundary — apps/web/src/features/terminal/AgentPanelBoundary.tsx:33` | 4 / 4 / 4 | 4 / 4 / 4 | 6 / 6 / 6 | 6 / 6 / 6 | 3 / 3 / 3 | 3 / 3 / 3 | 3 / 3 / 3 | 3 / 3 / 3 |
| `AgentStatusGlyph — apps/web/src/lib/motion/AgentStatusGlyph.tsx:22` | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 4 / 2 | 2 / 4 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 |
| `AlertDialog — apps/web/src/components/ui/alert-dialog.tsx:7` | 6 / 5 / 5 | 6 / 5 / 5 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 |
| `AlertDialogContent — apps/web/src/components/ui/alert-dialog.tsx:39` | 6 / 5 / 5 | 6 / 5 / 5 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 |
| `AlertDialogPortal — apps/web/src/components/ui/alert-dialog.tsx:17` | 6 / 5 / 5 | 6 / 5 / 5 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 |
| `AlertDialogRoot — node_modules/@base-ui/react/esm/alert-dialog/root/AlertDialogRoot.js:10` | 6 / 5 / 5 | 6 / 5 / 5 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 |
| `Archive — node_modules/lucide-react/dist/esm/createLucideIcon.mjs:14` | 2 / 2 / 2 | 2 / 2 / 2 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `ArrowSwipeKey — packages/terminal-client-react/src/ArrowSwipeKey.tsx:866` | 4 / 4 / 4 | 4 / 4 / 4 | 4 / 4 / 4 | 4 / 4 / 4 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 |
| `ArrowUp — node_modules/lucide-react/dist/esm/createLucideIcon.mjs:14` | 4 / 4 / 4 | 4 / 4 / 4 | 6 / 6 / 6 | 6 / 6 / 6 | 3 / 3 / 3 | 3 / 3 / 3 | 3 / 3 / 3 | 3 / 3 / 3 |
| `ArrowUpRight — node_modules/lucide-react/dist/esm/createLucideIcon.mjs:14` | 46 / 55 / 45 | 46 / 55 / 45 | 22 / 22 / 22 | 22 / 22 / 22 | 22 / 22 / 22 | 22 / 22 / 22 | 22 / 22 / 22 | 22 / 22 / 22 |
| `AtMentionMenu — apps/web/src/lib/at-mention/AtMentionMenu.tsx:34` | 4 / 4 / 4 | 4 / 4 / 4 | 6 / 6 / 6 | 6 / 6 / 6 | 3 / 3 / 3 | 3 / 3 / 3 | 3 / 3 / 3 | 3 / 3 / 3 |
| `AttachmentStrip — apps/web/src/features/chat/AttachmentStrip.tsx:27` | 4 / 4 / 4 | 4 / 4 / 4 | 6 / 6 / 6 | 6 / 6 / 6 | 3 / 3 / 3 | 3 / 3 / 3 | 3 / 3 / 3 | 3 / 3 / 3 |
| `BranchGuides — apps/web/src/app/FlightDeck.tsx:763` | 239 / 226 / 239 | 239 / 226 / 239 | 239 / 239 / 239 | 239 / 239 / 239 | 239 / 239 / 239 | 239 / 239 / 239 | 239 / 239 / 239 | 239 / 239 / 239 |
| `Button — apps/web/src/components/ui/button.tsx:50` | 455 / 392 / 453 | 455 / 392 / 453 | 448 / 448 / 448 | 448 / 448 / 448 | 433 / 433 / 433 | 433 / 433 / 433 | 433 / 433 / 433 | 433 / 433 / 433 |
| `Button — node_modules/@base-ui/react/esm/button/Button.js:12` | 455 / 392 / 453 | 455 / 392 / 453 | 448 / 448 / 448 | 448 / 448 / 448 | 433 / 433 / 433 | 433 / 433 / 433 | 433 / 433 / 433 | 433 / 433 / 433 |
| `ChatComposer — apps/web/src/features/chat/ChatComposer.tsx:110` | 4 / 4 / 4 | 4 / 4 / 4 | 6 / 6 / 6 | 6 / 6 / 6 | 3 / 3 / 3 | 3 / 3 / 3 | 3 / 3 / 3 | 3 / 3 / 3 |
| `ChatRail — apps/web/src/features/chat/ChatRail.tsx:35` | 4 / 4 / 4 | 4 / 4 / 4 | 6 / 6 / 6 | 6 / 6 / 6 | 3 / 3 / 3 | 3 / 3 / 3 | 3 / 3 / 3 | 3 / 3 / 3 |
| `ChatView — apps/web/src/features/chat/ChatView.tsx:158` | 4 / 4 / 4 | 4 / 4 / 4 | 6 / 6 / 6 | 6 / 6 / 6 | 3 / 3 / 3 | 3 / 3 / 3 | 3 / 3 / 3 | 3 / 3 / 3 |
| `Check — node_modules/lucide-react/dist/esm/createLucideIcon.mjs:14` | 19 / 15 / 19 | 19 / 15 / 19 | 19 / 19 / 19 | 19 / 19 / 19 | 19 / 19 / 19 | 19 / 19 / 19 | 19 / 19 / 19 | 19 / 19 / 19 |
| `CheckoutPart — apps/web/src/features/issues/IssuePanelView.tsx:326` | 4 / 3 / 3 | 4 / 3 / 3 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `ChevronDown — node_modules/lucide-react/dist/esm/createLucideIcon.mjs:14` | 122 / 95 / 121 | 122 / 95 / 121 | 118 / 118 / 118 | 118 / 118 / 118 | 118 / 118 / 118 | 118 / 118 / 118 | 118 / 118 / 118 | 118 / 118 / 118 |
| `ChevronLeft — node_modules/lucide-react/dist/esm/createLucideIcon.mjs:14` | 2 / 2 / 2 | 2 / 2 / 2 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `ChevronRight — node_modules/lucide-react/dist/esm/createLucideIcon.mjs:14` | 73 / 70 / 73 | 73 / 70 / 73 | 50 / 50 / 50 | 50 / 50 / 50 | 50 / 50 / 50 | 50 / 50 / 50 | 50 / 50 / 50 | 50 / 50 / 50 |
| `ChevronsDownUp — node_modules/lucide-react/dist/esm/createLucideIcon.mjs:14` | 2 / 2 / 2 | 2 / 2 / 2 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `ClaudeCodeIcon — apps/web/src/lib/icons/AgentIcons.tsx:15` | 126 / 89 / 123 | 126 / 89 / 123 | 112 / 112 / 112 | 112 / 112 / 112 | 113 / 113 / 113 | 113 / 113 / 113 | 113 / 113 / 113 | 113 / 113 / 113 |
| `ClosedIssueFold — apps/web/src/features/worklist/work-folds.tsx:492` | 6 / 6 / 6 | 6 / 6 / 6 | 0 | 0 | 0 | 0 | 0 | 0 |
| `ColdTurn — apps/web/src/features/chat/TranscriptCold.tsx:42` | 16 / 16 / 16 | 16 / 16 / 16 | 16 / 16 / 16 | 16 / 16 / 16 | 8 / 8 / 8 | 8 / 8 / 8 | 8 / 8 / 8 | 8 / 8 / 8 |
| `CollapsedPayload — apps/web/src/app/FlightDeck.tsx:810` | 49 / 46 / 49 | 49 / 46 / 49 | 49 / 49 / 49 | 49 / 49 / 49 | 49 / 49 / 49 | 49 / 49 / 49 | 49 / 49 / 49 | 49 / 49 / 49 |
| `Columns2 — node_modules/lucide-react/dist/esm/createLucideIcon.mjs:14` | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `CommandPaletteBoundary — apps/web/src/app/CommandPaletteBoundary.tsx:17` | 1 / 1 / 1 | 1 / 1 / 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| `CrewCensus — apps/web/src/app/FlightDeck.tsx:688` | 49 / 46 / 49 | 49 / 46 / 49 | 49 / 49 / 49 | 49 / 49 / 49 | 49 / 49 / 49 | 49 / 49 / 49 | 49 / 49 / 49 | 49 / 49 / 49 |
| `DeckSection — apps/web/src/app/FlightDeck.tsx:1973` | 6 / 6 / 6 | 6 / 6 / 6 | 3 / 3 / 3 | 3 / 3 / 3 | 3 / 3 / 3 | 3 / 3 / 3 | 3 / 3 / 3 | 3 / 3 / 3 |
| `DepartedState — apps/web/src/app/FlightDeck.tsx:2024` | 42 / 52 / 42 | 42 / 52 / 42 | 21 / 21 / 21 | 21 / 21 / 21 | 21 / 21 / 21 | 21 / 21 / 21 | 21 / 21 / 21 | 21 / 21 / 21 |
| `DialogPortal — node_modules/@base-ui/react/esm/dialog/portal/DialogPortal.js:18` | 6 / 5 / 5 | 6 / 5 / 5 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 |
| `DockCommentComposer — apps/web/src/features/issues/IssuePanelView.tsx:558` | 4 / 3 / 3 | 4 / 3 / 3 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `DockPart — apps/web/src/features/issues/IssuePanelView.tsx:122` | 29 / 22 / 22 | 29 / 22 / 22 | 7 / 7 / 7 | 7 / 7 / 7 | 7 / 7 / 7 | 7 / 7 / 7 | 7 / 7 / 7 | 7 / 7 / 7 |
| `DpadGlyphs — packages/terminal-client-react/src/ArrowSwipeKey.tsx:568` | 8 / 8 / 8 | 8 / 8 / 8 | 8 / 8 / 8 | 8 / 8 / 8 | 4 / 4 / 4 | 4 / 4 / 4 | 4 / 4 / 4 | 4 / 4 / 4 |
| `DropdownMenu — apps/web/src/components/ui/dropdown-menu.tsx:50` | 538 / 440 / 510 | 538 / 440 / 510 | 362 / 362 / 362 | 362 / 362 / 362 | 358 / 358 / 358 | 358 / 358 / 358 | 358 / 358 / 358 | 358 / 358 / 358 |
| `DropdownMenuContent — apps/web/src/components/ui/dropdown-menu.tsx:62` | 538 / 440 / 510 | 538 / 440 / 510 | 362 / 362 / 362 | 362 / 362 / 362 | 358 / 358 / 358 | 358 / 358 / 358 | 358 / 358 / 358 | 358 / 358 / 358 |
| `DropdownMenuTrigger — apps/web/src/components/ui/dropdown-menu.tsx:58` | 538 / 440 / 510 | 538 / 440 / 510 | 362 / 362 / 362 | 362 / 362 / 362 | 358 / 358 / 358 | 358 / 358 / 358 | 358 / 358 / 358 | 358 / 358 / 358 |
| `Ellipsis — node_modules/lucide-react/dist/esm/createLucideIcon.mjs:14` | 447 / 380 / 440 | 447 / 380 / 440 | 424 / 424 / 424 | 424 / 424 / 424 | 421 / 421 / 421 | 421 / 421 / 421 | 421 / 421 / 421 | 421 / 421 / 421 |
| `Fixture — apps/web/test/sidebar-acceptance.browser.tsx:216` | 1 / 1 / 1 | 1 / 1 / 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| `FlightDeck — apps/web/src/app/FlightDeck.tsx:2923` | 2 / 2 / 2 | 2 / 2 / 2 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `FloatingTree — node_modules/@base-ui/react/esm/floating-ui-react/components/FloatingTree.js:81` | 538 / 440 / 510 | 538 / 440 / 510 | 362 / 362 / 362 | 362 / 362 / 362 | 358 / 358 / 358 | 358 / 358 / 358 | 358 / 358 / 358 | 358 / 358 / 358 |
| `FoldPanel — apps/web/src/features/worklist/work-folds.tsx:269` | 22 / 22 / 22 | 22 / 22 / 22 | 0 | 0 | 0 | 0 | 0 | 0 |
| `FoldRow — apps/web/src/features/issues/IssuePanelView.tsx:167` | 6 / 4 / 5 | 6 / 4 / 5 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `Folder — node_modules/lucide-react/dist/esm/createLucideIcon.mjs:14` | 8 / 7 / 7 | 8 / 7 / 7 | 7 / 7 / 7 | 7 / 7 / 7 | 4 / 4 / 4 | 4 / 4 / 4 | 4 / 4 / 4 | 4 / 4 / 4 |
| `GitStamp — apps/web/src/components/GitStamp.tsx:13` | 4 / 4 / 4 | 4 / 4 / 4 | 6 / 6 / 6 | 6 / 6 / 6 | 3 / 3 / 3 | 3 / 3 / 3 | 3 / 3 / 3 | 3 / 3 / 3 |
| `GrokIcon — apps/web/src/lib/icons/AgentIcons.tsx:59` | 8 / 10 / 8 | 8 / 10 / 8 | 8 / 8 / 8 | 8 / 8 / 8 | 8 / 8 / 8 | 8 / 8 / 8 | 8 / 8 / 8 | 8 / 8 / 8 |
| `HibernatedBanner — apps/web/src/features/terminal/SessionLifecyclePanes.tsx:226` | 0 | 0 | 2 / 2 / 2 | 2 / 2 / 2 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `Hint — apps/web/src/features/issues/IssuePanelView.tsx:75` | 9 / 7 / 7 | 9 / 7 / 7 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 |
| `Hourglass — node_modules/lucide-react/dist/esm/createLucideIcon.mjs:14` | 103 / 80 / 103 | 103 / 80 / 103 | 99 / 99 / 99 | 99 / 99 / 99 | 99 / 99 / 99 | 99 / 99 / 99 | 99 / 99 / 99 | 99 / 99 / 99 |
| `Hung — apps/web/src/app/FlightDeck.tsx:724` | 178 / 130 / 178 | 178 / 130 / 178 | 172 / 172 / 172 | 172 / 172 / 172 | 172 / 172 / 172 | 172 / 172 / 172 | 172 / 172 / 172 | 172 / 172 / 172 |
| `HungRows — apps/web/src/app/FlightDeck.tsx:1426` | 241 / 228 / 241 | 241 / 228 / 241 | 240 / 240 / 240 | 240 / 240 / 240 | 240 / 240 / 240 | 240 / 240 / 240 | 240 / 240 / 240 | 240 / 240 / 240 |
| `IdGutter — apps/web/src/features/worklist/WorkRowShell.tsx:405` | 2 / 2 / 2 | 2 / 2 / 2 | 0 | 0 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `ImageLightbox — apps/web/src/features/chat/ImageLightbox.tsx:7` | 4 / 4 / 4 | 4 / 4 / 4 | 6 / 6 / 6 | 6 / 6 / 6 | 3 / 3 / 3 | 3 / 3 / 3 | 3 / 3 / 3 | 3 / 3 / 3 |
| `InspectHead — apps/web/src/features/issues/IssuePanelView.tsx:451` | 4 / 3 / 3 | 4 / 3 / 3 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `IssueChipLiveness — apps/web/src/features/chat/IssueChipLiveness.tsx:18` | 4 / 4 / 4 | 4 / 4 / 4 | 6 / 6 / 6 | 6 / 6 / 6 | 3 / 3 / 3 | 3 / 3 / 3 | 3 / 3 / 3 | 3 / 3 / 3 |
| `IssueCloseDialog — apps/web/src/features/issues/issue-lifecycle.tsx:139` | 6 / 5 / 5 | 6 / 5 / 5 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 |
| `IssueCompactControls — apps/web/src/features/issues/IssueCompactControls.tsx:490` | 4 / 3 / 3 | 4 / 3 / 3 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `IssueDecisionBand — apps/web/src/features/issues/IssueCompactControls.tsx:341` | 4 / 3 / 3 | 4 / 3 / 3 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `IssueExplorer — apps/web/src/features/issues/explorer/IssueExplorer.tsx:43` | 3 / 3 / 3 | 3 / 3 / 3 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `IssueExplorerCrumbs — apps/web/src/features/issues/explorer/IssueExplorer.tsx:113` | 2 / 2 / 2 | 2 / 2 / 2 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `IssueExplorerProvider — apps/web/src/features/issues/explorer/explorer-context.tsx:89` | 1 / 1 / 1 | 1 / 1 / 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| `IssueFleetSummary — apps/web/src/components/IssueFleetSummary.tsx:39` | 2 / 2 / 2 | 2 / 2 / 2 | 0 | 0 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `IssueGitScope — apps/web/src/features/issues/IssueCompactControls.tsx:174` | 4 / 3 / 3 | 4 / 3 / 3 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `IssueNoteChip — apps/web/src/app/FlightDeck.tsx:575` | 72 / 73 / 72 | 72 / 73 / 72 | 72 / 72 / 72 | 72 / 72 / 72 | 72 / 72 / 72 | 72 / 72 / 72 | 72 / 72 / 72 | 72 / 72 / 72 |
| `IssuePanelView — apps/web/src/features/issues/IssuePanelView.tsx:825` | 4 / 3 / 3 | 4 / 3 / 3 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `IssueSessionRow — apps/web/src/features/issues/IssueCompactControls.tsx:238` | 22 / 17 / 16 | 22 / 17 / 16 | 6 / 6 / 6 | 6 / 6 / 6 | 6 / 6 / 6 | 6 / 6 / 6 | 6 / 6 / 6 | 6 / 6 / 6 |
| `IssueStatusPicker — apps/web/src/features/issues/IssueStatusPicker.tsx:55` | 525 / 428 / 498 | 525 / 428 / 498 | 352 / 352 / 352 | 352 / 352 / 352 | 352 / 352 / 352 | 352 / 352 / 352 | 352 / 352 / 352 | 352 / 352 / 352 |
| `KindIcon — apps/web/src/lib/WorkerLabel.tsx:87` | 255 / 199 / 249 | 255 / 199 / 249 | 235 / 237 / 235 | 235 / 237 / 235 | 232 / 232 / 232 | 232 / 232 / 232 | 232 / 232 / 232 | 232 / 232 / 232 |
| `LayoutGroup — node_modules/framer-motion/dist/es/components/LayoutGroup/index.mjs:11` | 1 / 1 / 1 | 1 / 1 / 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| `LazyMotion — node_modules/framer-motion/dist/es/components/LazyMotion/index.mjs:42` | 1 / 1 / 1 | 1 / 1 / 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| `LegacyIssueChipLiveness — apps/web/src/features/chat/IssueChipLiveness.tsx:51` | 4 / 4 / 4 | 4 / 4 / 4 | 6 / 6 / 6 | 6 / 6 / 6 | 3 / 3 / 3 | 3 / 3 / 3 | 3 / 3 / 3 | 3 / 3 / 3 |
| `LifecycleButton — apps/web/src/features/terminal/SessionLifecyclePanes.tsx:57` | 0 | 0 | 2 / 2 / 2 | 2 / 2 / 2 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `ListTree — node_modules/lucide-react/dist/esm/createLucideIcon.mjs:14` | 2 / 2 / 2 | 2 / 2 / 2 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `MenuPortal — node_modules/@base-ui/react/esm/menu/portal/MenuPortal.js:16` | 538 / 440 / 510 | 538 / 440 / 510 | 362 / 362 / 362 | 362 / 362 / 362 | 358 / 358 / 358 | 358 / 358 / 358 | 358 / 358 / 358 | 358 / 358 / 358 |
| `MessageSquareText — node_modules/lucide-react/dist/esm/createLucideIcon.mjs:14` | 4 / 4 / 4 | 4 / 4 / 4 | 4 / 4 / 4 | 4 / 4 / 4 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 |
| `Mic — node_modules/lucide-react/dist/esm/createLucideIcon.mjs:14` | 8 / 8 / 8 | 8 / 8 / 8 | 10 / 10 / 10 | 10 / 10 / 10 | 5 / 5 / 5 | 5 / 5 / 5 | 5 / 5 / 5 | 5 / 5 / 5 |
| `Minimap — apps/web/src/features/chat/Minimap.tsx:88` | 4 / 4 / 4 | 4 / 4 / 4 | 6 / 6 / 6 | 6 / 6 / 6 | 3 / 3 / 3 | 3 / 3 / 3 | 3 / 3 / 3 | 3 / 3 / 3 |
| `MissionAgentMenu — apps/web/src/app/FlightDeck.tsx:177` | 2 / 2 / 2 | 2 / 2 / 2 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `MissionBrief — apps/web/src/app/FlightDeck.tsx:2455` | 2 / 2 / 2 | 2 / 2 / 2 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `MissionCostChip — apps/web/src/app/MissionCostChip.tsx:94` | 3 / 3 / 3 | 3 / 3 / 3 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `MissionGauge — apps/web/src/app/MissionGauge.tsx:148` | 2 / 2 / 2 | 2 / 2 / 2 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `MobilePromoCard — apps/web/src/features/mobile-handoff/MobilePromoCard.tsx:28` | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 0 | 0 | 0 | 0 |
| `Moon — node_modules/lucide-react/dist/esm/createLucideIcon.mjs:14` | 0 | 0 | 2 / 2 / 2 | 2 / 2 / 2 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `MotionConfig — node_modules/framer-motion/dist/es/components/MotionConfig/index.mjs:26` | 1 / 1 / 1 | 1 / 1 / 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| `MotionDOMComponent — node_modules/framer-motion/dist/es/motion/index.mjs:38` | 1644 / 1644 / 1644 | 1644 / 1644 / 1644 | 0 | 0 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 |
| `NativeRows — apps/web/src/app/FlightDeck.tsx:880` | 178 / 130 / 178 | 178 / 130 / 178 | 172 / 172 / 172 | 172 / 172 / 172 | 172 / 172 / 172 | 172 / 172 / 172 | 172 / 172 / 172 | 172 / 172 / 172 |
| `NewPanelMenu — apps/web/src/app/NewPanelMenu.tsx:122` | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `NewPanelMenuBody — apps/web/src/app/NewPanelMenu.tsx:128` | 3 / 3 / 3 | 3 / 3 / 3 | 2 / 2 / 2 | 2 / 2 / 2 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `ObservedPoolWorkSections — apps/web/src/features/worklist/pool-sidebar.tsx:217` | 1 / 1 / 1 | 1 / 1 / 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| `OpenAIcon — apps/web/src/lib/icons/AgentIcons.tsx:41` | 116 / 92 / 114 | 116 / 92 / 114 | 108 / 110 / 108 | 108 / 110 / 108 | 106 / 106 / 106 | 106 / 106 / 106 | 106 / 106 / 106 | 106 / 106 / 106 |
| `OpenCodeIcon — apps/web/src/lib/icons/AgentIcons.tsx:114` | 11 / 14 / 10 | 11 / 14 / 10 | 7 / 7 / 7 | 7 / 7 / 7 | 8 / 8 / 8 | 8 / 8 / 8 | 8 / 8 / 8 | 8 / 8 / 8 |
| `OperatorFocusProvider — apps/web/src/app/operator-focus.tsx:38` | 1 / 1 / 1 | 1 / 1 / 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| `PaneChrome — apps/web/src/app/Workspace.tsx:1161` | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `PanelDeck — apps/web/src/app/PanelDeck.tsx:103` | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `PanelVisible — apps/web/src/app/panel-visible.tsx:10` | 4 / 4 / 4 | 4 / 4 / 4 | 6 / 6 / 6 | 6 / 6 / 6 | 3 / 3 / 3 | 3 / 3 / 3 | 3 / 3 / 3 | 3 / 3 / 3 |
| `Paperclip — node_modules/lucide-react/dist/esm/createLucideIcon.mjs:14` | 4 / 4 / 4 | 4 / 4 / 4 | 6 / 6 / 6 | 6 / 6 / 6 | 3 / 3 / 3 | 3 / 3 / 3 | 3 / 3 / 3 | 3 / 3 / 3 |
| `PhaseTimer — apps/web/src/lib/motion/PhaseTimer.tsx:31` | 28 / 18 / 28 | 28 / 18 / 28 | 284 / 13 / 76 | 435 / 22 / 13 | 14 / 29 / 19 | 14 / 14 / 20 | 17 / 14 / 20 | 14 / 14 / 17 |
| `Pin — node_modules/lucide-react/dist/esm/createLucideIcon.mjs:14` | 1 / 1 / 1 | 1 / 1 / 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| `PinnedBrief — apps/web/src/features/chat/PinnedBrief.tsx:53` | 4 / 4 / 4 | 4 / 4 / 4 | 6 / 6 / 6 | 6 / 6 / 6 | 3 / 3 / 3 | 3 / 3 / 3 | 3 / 3 / 3 | 3 / 3 / 3 |
| `PinnedSectionLabel — apps/web/src/features/worklist/work-folds.tsx:167` | 1 / 1 / 1 | 1 / 1 / 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| `Plus — node_modules/lucide-react/dist/esm/createLucideIcon.mjs:14` | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `PoolEviction — apps/web/src/features/worklist/pool-sidebar.tsx:139` | 1 / 1 / 1 | 1 / 1 / 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| `PoolIssueExplorerProvider — apps/web/src/features/issues/explorer/explorer-context.tsx:312` | 2 / 2 / 2 | 2 / 2 / 2 | 0 | 0 | 0 | 0 | 0 | 0 |
| `PoolMotionRow — apps/web/src/features/worklist/pool-sidebar.tsx:580` | 793 / 793 / 793 | 793 / 793 / 793 | 0 | 0 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `ProducedAndDeferred — apps/web/src/features/issues/IssuePanelView.tsx:628` | 4 / 3 / 3 | 4 / 3 / 3 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `ProgressMeter — apps/web/src/features/issues/IssuePanelView.tsx:288` | 4 / 3 / 3 | 4 / 3 / 3 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `ProjectGroupLabel — apps/web/src/features/worklist/work-folds.tsx:141` | 11 / 11 / 11 | 11 / 11 / 11 | 0 | 0 | 0 | 0 | 0 | 0 |
| `ProposalRow — apps/web/src/app/FlightDeck.tsx:1887` | 170 / 116 / 170 | 170 / 116 / 170 | 85 / 85 / 85 | 85 / 85 / 85 | 85 / 85 / 85 | 85 / 85 / 85 | 85 / 85 / 85 | 85 / 85 / 85 |
| `RecentActivity — apps/web/src/features/issues/IssuePanelView.tsx:354` | 5 / 4 / 4 | 5 / 4 / 4 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `RightDock — apps/web/src/app/RightDock.tsx:107` | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `RightDockIssuePanel — apps/web/src/app/RightDockIssuePanel.tsx:7` | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 |
| `RoleWord — apps/web/src/app/FlightDeck.tsx:992` | 130 / 84 / 130 | 130 / 84 / 130 | 124 / 124 / 124 | 124 / 124 / 124 | 124 / 124 / 124 | 124 / 124 / 124 | 124 / 124 / 124 | 124 / 124 / 124 |
| `RowProgressMeter — apps/web/src/features/worklist/row-progress.tsx:150` | 2 / 2 / 2 | 2 / 2 / 2 | 0 | 0 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `S — apps/web/src/features/worklist/worklist-motion-layout.tsx:40` | 815 / 815 / 815 | 815 / 815 / 815 | 0 | 0 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `ScopedChatComposer — apps/web/src/features/chat/ChatView.tsx:98` | 4 / 4 / 4 | 4 / 4 / 4 | 6 / 6 / 6 | 6 / 6 / 6 | 3 / 3 / 3 | 3 / 3 / 3 | 3 / 3 / 3 | 3 / 3 / 3 |
| `ScrollText — node_modules/lucide-react/dist/esm/createLucideIcon.mjs:14` | 4 / 4 / 4 | 4 / 4 / 4 | 6 / 6 / 6 | 6 / 6 / 6 | 3 / 3 / 3 | 3 / 3 / 3 | 3 / 3 / 3 | 3 / 3 / 3 |
| `Search — node_modules/lucide-react/dist/esm/createLucideIcon.mjs:14` | 6 / 6 / 6 | 6 / 6 / 6 | 7 / 7 / 7 | 7 / 7 / 7 | 4 / 4 / 4 | 4 / 4 / 4 | 4 / 4 / 4 | 4 / 4 / 4 |
| `SeatChip — apps/web/src/app/FlightDeck.tsx:849` | 24 / 30 / 24 | 24 / 30 / 24 | 24 / 24 / 24 | 24 / 24 / 24 | 24 / 24 / 24 | 24 / 24 / 24 | 24 / 24 / 24 | 24 / 24 / 24 |
| `SectionBand — apps/web/src/features/worklist/work-folds.tsx:82` | 12 / 12 / 12 | 12 / 12 / 12 | 0 | 0 | 0 | 0 | 0 | 0 |
| `SessionDraftRef — apps/web/src/features/terminal/AgentPanel.tsx:191` | 4 / 4 / 4 | 4 / 4 / 4 | 6 / 6 / 6 | 6 / 6 / 6 | 3 / 3 / 3 | 3 / 3 / 3 | 3 / 3 / 3 | 3 / 3 / 3 |
| `SessionNeedsYou — apps/web/src/features/issues/IssueCompactControls.tsx:215` | 4 / 3 / 3 | 4 / 3 / 3 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `SessionRow — apps/web/src/app/FlightDeck.tsx:1041` | 178 / 130 / 178 | 178 / 130 / 178 | 172 / 172 / 172 | 172 / 172 / 172 | 172 / 172 / 172 | 172 / 172 / 172 | 172 / 172 / 172 | 172 / 172 / 172 |
| `SessionWatchers — apps/web/src/features/terminal/SessionWatchers.tsx:58` | 4 / 4 / 4 | 4 / 4 / 4 | 6 / 6 / 6 | 6 / 6 / 6 | 3 / 3 / 3 | 3 / 3 / 3 | 3 / 3 / 3 | 3 / 3 / 3 |
| `SidebarRow — apps/web/src/features/worklist/sidebar-measurements.tsx:47` | 2 / 2 / 2 | 2 / 2 / 2 | 0 | 0 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `SidebarUnified — apps/web/src/features/worklist/SidebarUnified.tsx:149` | 1 / 1 / 1 | 1 / 1 / 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| `SnoozedIssueFold — apps/web/src/features/worklist/work-folds.tsx:427` | 4 / 4 / 4 | 4 / 4 / 4 | 0 | 0 | 0 | 0 | 0 | 0 |
| `SortableTab — apps/web/src/app/Workspace.tsx:1543` | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 4 / 2 | 2 / 4 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 |
| `Square — node_modules/lucide-react/dist/esm/createLucideIcon.mjs:14` | 4 / 4 / 4 | 4 / 4 / 4 | 4 / 4 / 4 | 4 / 4 / 4 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 |
| `SquareTerminal — node_modules/lucide-react/dist/esm/createLucideIcon.mjs:14` | 4 / 4 / 4 | 4 / 4 / 4 | 4 / 4 / 4 | 4 / 4 / 4 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 |
| `StateLabel — apps/web/src/app/FlightDeck.tsx:628` | 239 / 226 / 239 | 239 / 226 / 239 | 239 / 239 / 239 | 239 / 239 / 239 | 239 / 239 / 239 | 239 / 239 / 239 | 239 / 239 / 239 | 239 / 239 / 239 |
| `StateMark — apps/web/src/app/FlightDeck.tsx:550` | 239 / 226 / 239 | 239 / 226 / 239 | 239 / 239 / 239 | 239 / 239 / 239 | 239 / 239 / 239 | 239 / 239 / 239 | 239 / 239 / 239 | 239 / 239 / 239 |
| `StatusGlyph — apps/web/src/features/issues/issue-glyphs.tsx:103` | 529 / 431 / 501 | 529 / 431 / 501 | 353 / 353 / 353 | 353 / 353 / 353 | 353 / 353 / 353 | 353 / 353 / 353 | 353 / 353 / 353 | 353 / 353 / 353 |
| `TaskCostSection — apps/web/src/features/cost/TaskCostSection.tsx:288` | 4 / 3 / 3 | 4 / 3 / 3 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `TaskRow — apps/web/src/app/FlightDeck.tsx:1495` | 239 / 226 / 239 | 239 / 226 / 239 | 239 / 239 / 239 | 239 / 239 / 239 | 239 / 239 / 239 | 239 / 239 / 239 | 239 / 239 / 239 | 239 / 239 / 239 |
| `Textarea — apps/web/src/components/ui/textarea.tsx:5` | 8 / 7 / 7 | 8 / 7 / 7 | 7 / 7 / 7 | 7 / 7 / 7 | 4 / 4 / 4 | 4 / 4 / 4 | 4 / 4 / 4 | 4 / 4 / 4 |
| `TranscriptCold — apps/web/src/features/chat/TranscriptCold.tsx:61` | 4 / 4 / 4 | 4 / 4 / 4 | 4 / 4 / 4 | 4 / 4 / 4 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 |
| `TranscriptFeed — apps/web/src/features/chat/TranscriptFeed.tsx:244` | 4 / 4 / 4 | 4 / 4 / 4 | 6 / 6 / 6 | 6 / 6 / 6 | 3 / 3 / 3 | 3 / 3 / 3 | 3 / 3 / 3 | 3 / 3 / 3 |
| `TranscriptStandby — apps/web/src/features/chat/TranscriptStandby.tsx:112` | 0 | 0 | 2 / 2 / 2 | 2 / 2 / 2 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `TranscriptTail — apps/web/src/features/chat/TranscriptTail.tsx:203` | 4 / 4 / 4 | 4 / 4 / 4 | 4 / 4 / 4 | 4 / 4 / 4 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 |
| `Unfilled — apps/web/src/features/usage/Unfilled.tsx:15` | 4 / 3 / 3 | 4 / 3 / 3 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `UnifiedRow — apps/web/src/features/issues/IssuePanelView.tsx:194` | 114 / 84 / 87 | 114 / 84 / 87 | 27 / 27 / 27 | 27 / 27 / 27 | 27 / 27 / 27 | 27 / 27 / 27 | 27 / 27 / 27 | 27 / 27 / 27 |
| `UnreadDot — apps/web/src/components/UnreadMark.tsx:12` | 59 / 50 / 59 | 59 / 50 / 59 | 57 / 57 / 57 | 57 / 57 / 57 | 58 / 58 / 58 | 58 / 58 / 58 | 58 / 58 / 58 | 58 / 58 / 58 |
| `UserPlus — node_modules/lucide-react/dist/esm/createLucideIcon.mjs:14` | 2 / 2 / 2 | 2 / 2 / 2 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `Users — node_modules/lucide-react/dist/esm/createLucideIcon.mjs:14` | 6 / 6 / 6 | 6 / 6 / 6 | 7 / 7 / 7 | 7 / 7 / 7 | 4 / 4 / 4 | 4 / 4 / 4 | 4 / 4 / 4 | 4 / 4 / 4 |
| `VoiceButton — apps/web/src/features/chat/VoiceButton.tsx:15` | 4 / 4 / 4 | 4 / 4 / 4 | 6 / 6 / 6 | 6 / 6 / 6 | 3 / 3 / 3 | 3 / 3 / 3 | 3 / 3 / 3 | 3 / 3 / 3 |
| `WhereTheWorkWent — apps/web/src/app/FlightDeck.tsx:2072` | 2 / 2 / 2 | 2 / 2 / 2 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `WorkRowShell — apps/web/src/features/worklist/WorkRowShell.tsx:86` | 2 / 2 / 2 | 2 / 2 / 2 | 0 | 0 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `WorkerLabel — apps/web/src/lib/WorkerLabel.tsx:140` | 202 / 149 / 196 | 202 / 149 / 196 | 180 / 182 / 180 | 180 / 182 / 180 | 180 / 180 / 180 | 180 / 180 / 180 | 180 / 180 / 180 | 180 / 180 / 180 |
| `WorkingMarkCell — apps/web/src/lib/motion/WorkingMark.tsx:36` | 2 / 2 / 2 | 2 / 2 / 2 | 0 | 0 | 0 | 0 | 0 | 0 |
| `WorklistMeasureLayout — apps/web/src/features/worklist/worklist-motion-layout.tsx:124` | 815 / 815 / 815 | 815 / 815 / 815 | 0 | 0 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `WorklistMotion — apps/web/src/features/worklist/worklist-motion.tsx:11` | 1 / 1 / 1 | 1 / 1 / 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| `Workspace — apps/web/src/app/Workspace.tsx:231` | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `X — node_modules/lucide-react/dist/esm/createLucideIcon.mjs:14` | 3 / 3 / 3 | 3 / 3 / 3 | 3 / 5 / 3 | 3 / 5 / 3 | 3 / 3 / 3 | 3 / 3 / 3 | 3 / 3 / 3 | 3 / 3 / 3 |
| `fastComponent — node_modules/@base-ui/utils/esm/fastHooks.js:14` | 1343 / 1137 / 1287 | 1343 / 1137 / 1287 | 724 / 724 / 724 | 724 / 724 / 724 | 716 / 716 / 716 | 716 / 716 / 716 | 716 / 716 / 716 | 716 / 716 / 716 |

</details>

## Arming control and evidence checks

Before the final capture, a temporary 200 ms busy loop was planted after the trusted mission pointerdown mark, using two small real mission targets (one retained sample per arm). Control SHA: `48e433ebfa36ea81b406371e4565f56b1601e42a`; product tree is identical to the final capture. In ON, `profileBusyLoop — apps/web/harness/full-screen-click-profile.browser.ts:9` is the top self-time function at 175.6 sampled ms, with a 200.123 ms trace interval. OFF is 168.8 sampled ms / 200.266 traced ms, second behind Proxy `get` at 276.4 sampled ms. The positive ON control proves arming and window placement. The plant, listener and flag were removed before the final SHA; these two control samples are excluded from every result table above.

All 24 recordings have the same source SHA, three distinct iterations per action/arm, one trusted-input/feed mark, one expected-DOM mark, a main-thread Paint, and matching gate/analyzer wall times. Clipped V8 interval coverage is 100% of each window within floating-point precision; exclusive categories partition those intervals. Fixture/page error lists are empty. OFF and ON renderer PIDs differ. Component coordinates were recovered from CPU source maps and CDP function/observer-closure locations; factory groups are labelled. The planted control is absent from the final build/source. Focused harness typecheck **green** on flatblock at `084cbb5d9dd45206761c7699165e93bc0b35b493`: `bun run typecheck -- --filter @podium/web --only -- -p harness/tsconfig.full-screen-profile.json`, one task successful, 2.19 seconds. Initial failures exposed missing ambient declarations and a nonportable inferred CDP type; both were corrected before the successful run. This is a focused typecheck, not the lean gate or full test suite; the production capture and planted control supply the interaction evidence required here.

## Reproduction and retained artifacts

```bash
# In an isolated flatblock checkout with pinned checkout-local Bun:
# To reproduce these product timings, use captured SHA 6cbbbc28a9 from the bundle.
podium lock acquire bench:flatblock --wait --ttl 20m --timeout 3h
# Keep an EXIT trap around the foreground command to release promptly.
bun apps/web/harness/full-screen-click-profile.ts --profile=all --lease-confirmed
podium lock release bench:flatblock

# Individual action selector: mission-switch / session-switch / issue-rename / background-update
# Analyze with the landed analyzer and the corresponding captured build/maps:
bun apps/web/harness/full-screen-profile-analyze.ts --profile=all
# Control analysis uses its matching archived build:
bun apps/web/harness/full-screen-profile-analyze.ts --profile=mission-switch-plant \
  --build-dir=.artifacts/full-screen-click-profile/control-build

# Focused typecheck from the repository root on flatblock:
bun run typecheck -- --filter @podium/web --only -- -p harness/tsconfig.full-screen-profile.json
```

The collector can own the lease itself when `--lease-confirmed` is omitted. It verifies the baseline host/browser tuple, production React, pane mode, fixture size, non-no-op expected state, trusted input, real DOM/Paint boundaries, and absence of fixture/page errors. A 15-minute capture budget aborts incomplete runs; the caller’s 920-second timeout is an additional foreground limit.

Raw evidence is attached to POD-5305 as **Full-screen CPU and trace recordings**: 24 original `.cpuprofile` files, their 24 clipped `.window.cpuprofile` companions and 24 source-named `.mapped.window.cpuprofile` views, 24 Chrome/Perfetto-compatible `.trace.json` files, action records, component function locations, manifest, full `analysis.json`, production assets/maps, the two arming controls and their matching maps, and a small Git source bundle preserving the measured commits. Raw files and generated build assets are not committed. Open the original, clipped or source-named CPU files in Chromium DevTools Performance; import traces in DevTools or Perfetto and locate `speed:input`, `speed:dom`, `speed:commit:*` on the renderer main thread. The reported window endpoints are also recorded as absolute microseconds in `analysis.json`.

POD-5090 owns the mission rows/archive read conversion; POD-5091 owns issue-page/compact controls. They received the scan attribution. This deliverable measures and ranks work; it changes no product behavior.
