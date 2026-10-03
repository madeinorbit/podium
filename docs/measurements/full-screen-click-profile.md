# Full-screen click CPU profiles

The original POD-5305 capture is preserved below. The post-fix rerun and remaining targets are in [After the fixes](#after-the-fixes).

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

## After the fixes

The multi-second session read Proxy cost is gone. **Every action/arm wall median is 53.4–85.0% lower than POD-5305.** OFF still runs the archive filter, now 152.2–179.2 mean inclusive ms instead of 1,483.5–1,714.8 ms; ON has no sampled archive-filter work. The remaining costs are broad issue-model derivation, child session membership scans, repeated mission-row rendering, pool projection subscriptions, transcript layout and allocation/GC. Session-switch's dominant task is now **747.1–765.0 ms OFF / 769.9–1,093.5 ms ON**, down from 2.54–3.13 s. It is still one synchronous task.

Capture SHA: **`7a05ddf5826b96553ab29c01450b5b9c53536616`**; product base: **`ef9fd79799988d0aee49eaa9543775bdbdde1d76`**, on `integrate/4286-pilot`. Product files, the acceptance fixture, shared Vite configuration, Paint helper and speed-gate baseline are unchanged by this issue. The sibling collector and analyzer from POD-5305 are reused with measurement-only arm orchestration, startup assertions and longest-task attribution. The recorded source coordinates below refer to this captured tree.

### Capture contract and comparability

Same 4× seed-4443 full-screen fixture, 1800×1000 headless Chromium 153.0.8010.12, ordinary minified production React 19.2.7, reduced motion, chat panels, fixed browser `Date.now()` anchor, two unretained warmups and three retained samples per action/arm. Runtime counts match POD-5305: 19,468 issues, 17,208 sessions; generated input has 17,216 sessions, 1,889 repositories and 1,872 worktrees. Mission targets are `i13916` / `i19016` with 325 / 285 rows; session targets are `s8608` / `s11337`; rename is `i13916`; background delivery updates visible unrelated `i19016`. Mission and session retained samples alternate target 0 / 1 / 0, and session `s11337` is restored before rename/background.

**Pilot definition for this rerun:** `mobxPane=mobxSessionPane=mobxChips=0` (OFF) versus all three `=1` (ON), with `mobxSidebar=1` fixed throughout. Fresh contexts have no saved pilot setting. These explicit startup overrides select the converted mission/navigation, session-pane and issue-reference readers named in the request; each record includes and asserts their actual startup modes. POD-5305's ON arm toggled only `mobxPane`; session-pane/chips stayed legacy. The original pane-only collector remains available without `--pool-readers`. Other screen overrides are unset, so this is not an all-screens device-setting rollout or a separate issue-page-pool measurement.

For each action, warmup pairs run OFF→ON, ON→OFF; retained pairs run **OFF→ON (0), ON→OFF (1), OFF→ON (2)**. Both contexts remain open in one browser, and only one generator advances at a time. Context setup, hover, scrolling, editor preparation, warmups, post-Paint work and component-location collection are outside measured windows. The input/feed → expected-DOM → first main-thread Paint-end boundary, 1,000 µs requested CDP CPU interval and trace categories are unchanged. `manifest.json` records the complete interleaved order; all 24 records share the captured SHA and have three distinct iterations per action/arm.

Host: flatblock, AMD EPYC, Linux x64, eight logical CPUs, pinned Bun 1.4.2 and checkout-local dependencies. The lease was held only for the arming control plus capture, approximately **02:21–02:25 UTC on 2026-10-03**, and released before transfer, offline analysis or typecheck. The retained collector ran **02:22:16.454–02:24:52.115 UTC**, 155.661 seconds including its build, warmups and metadata. Sample one-minute load averages were **5.10–6.77**, versus POD-5305's 3.52–5.25. The control-time process audit found this named timing collector and background host activity; the host was not idle. No other named timing collector was observed in that audit. The lease serializes participating timing jobs, not all services or validation work.

These are instrumented windows, with observer overhead included in wall time and excluded from product CPU attribution. They are not unprofiled gate results; no gate report or baseline was promoted. n=3, changed product code, expanded ON switches, the interleaved two-context protocol and different host load limit causal before/after claims. Every retained sample, including the GC outliers, is reported. Means rank sampled functions; independently computed medians describe wall/category/trace columns. Inclusive entries overlap and must not be added.

Offline source-map entry matching now recognizes the prefix/indentation before a call's first callback. This separates transcript scroll reconciliation (`useDomTranscriptScroll / useCallback callback@147`) and its layout-effect caller (`:202`) from the enclosing hook. Lucide factories without a runtime name retain their mapped callback name. The correction changes offline labels/rank attribution only, not raw files, windows, categories or rendered-instance totals. The analyzer revision is preserved in the evidence bundle alongside the captured commits.

### What still costs time, and where to target the next fixes

1. **Remaining global issue-model reads.** `modelsFor` (`packages/client-core/src/replica/issue-view-cache.ts:203`) costs 112.3 / 105.1 inclusive ms on mission-switch, 94.3 / 107.8 on session-switch, 97.2 / 142.9 on rename and 283.0 / 254.4 on background-update (OFF / ON means). Its tree/input derivation is now a principal background-update cost. `AgentPanel.tsx:303` and `ChatView.tsx:222` still call `useReplicaIssues()` even with their converted readers enabled; `AgentPanel` itself is 110.8 inclusive ms in the ON session task and 147.9 on ON rename. The next target is the full issue-model input/cache work retained by those consumers, and the global issue snapshot invalidation on an unrelated visible title. ON background updates render only 655–658 composite instances, down from POD-5305's 8,659–8,662, yet `modelsFor` still costs about 254 ms. Addressed rendering has not removed this derivation.
2. **Child issue session membership.** Mission-switch `issueSessions` (`IssueCompactControls.tsx:88`, filter `:94`) falls from POD-5305's **732.7 / 724.5 ms** to **174.0 / 222.7 ms**, but remains a large mission cost. `IssuePanelView.tsx:825` is 182.0 / 235.4 inclusive ms; its `openChildren.map` (`:1132`) is 155.3 / 201.5 ms. This fixture still mounts that issue-panel reader. Narrow its per-child session inputs rather than repeat global filtering; POD-5091 already owns the issue-page conversion.
3. **ON mission-row rendering and subscriptions.** A session switch renders `TaskRow` (`FlightDeck.tsx:1513`) **239 OFF / 478 ON**, `HungRows` (`:1444`) **240 / 480**, app `Button` **448 / 878**, and `DropdownMenu` **362 / 692**, identically in all three samples. Total committed composites are 8,869–8,930 OFF / 17,137–17,485 ON. Mission-switch totals are 13,999–15,415 / 21,074–23,623. Pool projection `subscribe` (`packages/client-graph/src/runtime-pool.ts:20`) is 139.0 mean inclusive ms on ON mission-switch and 85.1 inside the ON session task; `deriveMissionView` (`mission-view.ts:558`) is 132.3 / 69.3 ms respectively. The next target is why selecting a session causes a second full mission-row pass and subscription/derivation work. The doubled source-function render counts are observed and are consistent with a second mission-row pass; keyed per-instance logs were not collected, and the exact invalidation or projection-identity cause still needs a focused follow-up. These subscription, derivation and render figures overlap.
4. **Transcript geometry and DOM work on mission switch.** Scroll reconciliation (`packages/client-core/src/react/use-dom-transcript-scroll.ts:147`, called by the layout effect at `:202`) is **135.0 OFF / 120.5 ON mean self ms**. The source reads `clientHeight`/`scrollHeight` and writes scroll position. Main-thread trace Layout is **140.8 / 117.1 median ms**, with style/layout/prepaint/paint union **215.4 / 188.9 ms**. The sampled scroll call and native layout overlap; they are not separate additive budgets. Target when the geometry reads force layout and whether repeated work can be avoided while preserving scroll anchoring.
5. **Allocation/GC and residual legacy scans.** The frozen `sessionView` factory/WeakMap join (`session-values.ts:94`) remains **45.8 OFF / 25.8 ON self ms** inside the session task; the removed Proxy accessor has zero observed time in every action. OFF still repeats archive filtering, now 152–179 ms, and the legacy issue-reference `select` (`issue-chip-refs.ts:75`) is 110.3 ms on rename / 114.6 ms on background update; neither path is sampled in ON. The ON rename's 1,062.7 ms sample contains **386.1 ms GC**, and the 802.6 ms ON background sample contains **408.0 ms GC**, whereas their other two samples contain 19.2/58.8 ms and 13.6/10.1 ms GC. Keep those outliers visible and inspect allocation sources after the broad reads/repeated rendering are narrowed; sampled GC alone does not identify the allocating function.

The separate follow-up proposals are **POD-5336 (Pane issue model reads)**, **POD-5337 (Mission pane render churn)** and **POD-5338 (Transcript scroll layout cost)**, each with a `discovered-from` dependency on this measurement issue. They remain unclaimed in Proposed; the child session scans belong to the existing POD-5091 work.

### What the session-switch task is made of now

OFF's longest task averages **754.1 ms**: React render/derivations **522.4**, commit/layout **44.2**, passive effects **8.5**, MobX **1.7**, GC **23.4**, measurement observer **32.4**, and other JS/native **121.6 ms**. `FlightDeckContent` is 358.7 inclusive ms, containing the 156.6 ms archive pass; the click/navigation/batch path is 115.6 inclusive ms, and `modelsFor` is 94.3 ms. These function figures overlap the categories and each other. This is a smaller legacy mission/render task, not the old Proxy-heavy 2.54–3.13 s pass.

ON's longest task averages **900.7 ms**: render/derivations **399.7**, commit/layout **115.0**, passive effects **107.8**, MobX reactions **32.1** plus other tracking/scheduling **11.0**, GC **83.2**, observer **57.7**, and other JS/native/idle **94.3 ms**. The named application work includes `AgentPanel` **110.8**, its global issue-model chain/`modelsFor` **107.8**, `FlightDeckContent` **94.9**, click/navigation/batch **91.8**, and pool projection subscription **85.1 inclusive ms**. The archive filter and session Proxy `get` are absent. The remaining task combines broad issue reads, doubled mission-row render counts, pool subscription work, DOM mutation/layout/passive effects and GC; the per-sample partition below gives the exact task composition.

The dominant task starts **295.8–366.2 ms after input OFF** and **291.8–962.1 ms ON**. ON sample 1 has 37 commits and a 962.1 ms prefix, of which **598.5 ms is the measurement observer**, before its 769.9 ms main task. The entire 1,755.5 ms wall must not be called one product long task. Observer time inside the longest task is shown separately too. Prefix timers/idle/native intervals and observer work explain why session wall time exceeds the main task; the profiler cannot turn those intervals into a causal product CPU budget.

### Latency, tasks and direct wall comparison

| Action / pilot | Wall samples 0 / 1 / 2 (ms) | Median ms | POD-5305 median ms | Change | Commits 0 / 1 / 2 | Tasks 0 / 1 / 2 | Long tasks 0 / 1 / 2 | Longest task 0 / 1 / 2 (ms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| mission-switch OFF | 1,772.9 / 1,521.4 / 1,547.7 | 1,547.7 | 3,813.3 | -59.4% | 7 / 7 / 7 | 6 / 4 / 5 | 2 / 1 / 1 | 1,679.1 / 1,490.6 / 1,509.5 |
| mission-switch ON | 1,995.1 / 1,535.5 / 1,775.1 | 1,775.1 | 4,038.9 | -56.1% | 7 / 7 / 7 | 8 / 6 / 5 | 1 / 1 / 1 | 1,949.0 / 1,503.5 / 1,774.4 |
| session-switch OFF | 1,090.4 / 1,135.9 / 1,075.0 | 1,090.4 | 3,166.4 | -65.6% | 10 / 5 / 3 | 118 / 73 / 63 | 1 / 1 / 1 | 747.1 / 750.3 / 765.0 |
| session-switch ON | 1,187.0 / 1,755.5 / 1,409.0 | 1,409.0 | 3,025.0 | -53.4% | 11 / 37 / 3 | 118 / 475 / 57 | 1 / 1 / 1 | 838.6 / 769.9 / 1,093.5 |
| issue-rename OFF | 797.9 / 820.8 / 845.8 | 820.8 | 2,828.4 | -71.0% | 2 / 2 / 2 | 7 / 3 / 7 | 1 / 1 / 1 | 787.7 / 805.2 / 834.6 |
| issue-rename ON | 539.8 / 507.6 / 1,062.7 | 539.8 | 2,464.8 | -78.1% | 2 / 2 / 2 | 7 / 5 / 6 | 1 / 1 / 2 | 529.9 / 499.5 / 983.7 |
| background-update OFF | 1,013.8 / 1,117.4 / 1,154.5 | 1,117.4 | 2,638.9 | -57.7% | 2 / 2 / 2 | 1 / 1 / 1 | 1 / 1 / 1 | 1,013.8 / 1,117.4 / 1,154.5 |
| background-update ON | 350.7 / 404.3 / 802.6 | 404.3 | 2,686.5 | -85.0% | 2 / 2 / 2 | 1 / 1 / 1 | 1 / 1 / 1 | 350.7 / 404.3 / 802.6 |

### Direct comparison of the former hot paths

Mean sampled ms, observer excluded, as in POD-5305. Archive columns are inclusive; Proxy columns are self. A zero means no sampled interval attributed to that function. The removed Proxy function no longer exists in this product source.

| Action / pilot | Archive before | Archive after | Session Proxy get before | Session Proxy get after | issueSessions after (inclusive) |
| --- | ---: | ---: | ---: | ---: | ---: |
| mission-switch OFF | 1,507.4 | 161.6 | 1,318.9 | 0.0 | 174.0 |
| mission-switch ON | 1,686.3 | 0.0 | 1,409.7 | 0.0 | 222.7 |
| session-switch OFF | 1,657.8 | 156.6 | 1,225.1 | 0.0 | 16.3 |
| session-switch ON | 1,543.7 | 0.0 | 1,074.6 | 0.0 | 15.7 |
| issue-rename OFF | 1,714.8 | 152.2 | 1,138.9 | 0.0 | 36.5 |
| issue-rename ON | 1,495.0 | 0.0 | 1,036.1 | 0.0 | 14.7 |
| background-update OFF | 1,483.5 | 179.2 | 1,015.7 | 0.0 | 6.1 |
| background-update ON | 1,634.7 | 0.0 | 1,074.7 | 0.0 | 12.2 |

### Sampled categories and browser work

Independent median ms per column. Observer time is separated from product attribution; style/layout/paint is a trace union and overlaps sampled stacks.

| Action / pilot | React render | React commit/layout | React passive | MobX reactions | Other MobX | GC | Observer | Other/idle | Style/layout/paint union |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| mission-switch OFF | 936.2 | 224.5 | 49.7 | 0.0 | 0.5 | 69.7 | 119.0 | 180.1 | 215.4 |
| mission-switch ON | 876.1 | 240.2 | 196.2 | 34.1 | 11.2 | 90.5 | 129.4 | 175.7 | 188.9 |
| session-switch OFF | 519.3 | 43.2 | 8.6 | 1.1 | 0.6 | 22.3 | 93.3 | 412.4 | 59.1 |
| session-switch ON | 385.5 | 112.5 | 109.8 | 34.4 | 11.2 | 52.0 | 174.0 | 421.1 | 84.3 |
| issue-rename OFF | 608.4 | 36.6 | 1.3 | 2.2 | 0.0 | 47.6 | 39.4 | 78.8 | 16.8 |
| issue-rename ON | 336.8 | 40.5 | 0.9 | 42.5 | 2.2 | 58.8 | 36.9 | 66.4 | 14.7 |
| background-update OFF | 735.4 | 42.2 | 1.4 | 3.2 | 0.0 | 71.6 | 38.3 | 226.8 | 14.0 |
| background-update ON | 136.1 | 3.3 | 0.0 | 1.1 | 0.0 | 13.6 | 30.5 | 216.8 | 10.2 |

### Functions by action

Each ranking is the arithmetic mean of three retained samples. Self counts the leaf; inclusive counts descendants and overlaps other inclusive entries. All-function inclusive roots are retained for comparability, followed by application inclusive costs that identify actionable work. Runtime pseudo-frames have no source coordinate. Coordinates refer to the new captured tree.

#### mission-switch OFF

Top five self costs.

| Function — declaration file:line | Mean self ms | Mean inclusive ms |
| --- | ---: | ---: |
| `archivedSessionsForIssue — packages/client-core/src/viewmodels/session-ownership.ts:333` | 135.3 | 161.6 |
| `useDomTranscriptScroll / useCallback callback@147 — packages/client-core/src/react/use-dom-transcript-scroll.ts:147` | 135.0 | 135.0 |
| `(program)` | 124.4 | 124.4 |
| `issueSessions / sessions.filter callback@94 — apps/web/src/features/issues/IssueCompactControls.tsx:94` | 98.1 | 98.1 |
| `issueSessions — apps/web/src/features/issues/IssueCompactControls.tsx:88` | 75.9 | 174.0 |

Top five inclusive costs, all functions.

| Function — declaration file:line | Mean self ms | Mean inclusive ms |
| --- | ---: | ---: |
| `processRootScheduleInMicrotask — node_modules/react-dom/cjs/react-dom-client.production.js:11966` | 0.0 | 1,229.8 |
| `scheduleImmediateRootScheduleTask / scheduleMicrotask callback@12089 — node_modules/react-dom/cjs/react-dom-client.production.js:12089` | 0.0 | 1,229.8 |
| `performSyncWorkOnRoot — node_modules/react-dom/cjs/react-dom-client.production.js:12084` | 1.3 | 1,229.8 |
| `flushSyncWorkAcrossRoots_impl — node_modules/react-dom/cjs/react-dom-client.production.js:11918` | 0.0 | 1,229.8 |
| `performWorkOnRoot — node_modules/react-dom/cjs/react-dom-client.production.js:10681` | 0.0 | 1,228.5 |

Top five application inclusive costs.

| Function — declaration file:line | Mean self ms | Mean inclusive ms |
| --- | ---: | ---: |
| `FlightDeckContent — apps/web/src/app/FlightDeck.tsx:3013` | 11.2 | 277.6 |
| `measureLegacyMission — apps/web/src/app/mission-pane-perf.ts:36` | 0.4 | 243.3 |
| `measureWork — apps/web/src/app/mission-pane-perf.ts:12` | 0.4 | 242.9 |
| `IssuePanelView — apps/web/src/features/issues/IssuePanelView.tsx:825` | 2.0 | 182.0 |
| `FlightDeckContent / useCallback callback@3021 — apps/web/src/app/FlightDeck.tsx:3021` | 0.4 | 181.7 |

#### mission-switch ON

Top five self costs.

| Function — declaration file:line | Mean self ms | Mean inclusive ms |
| --- | ---: | ---: |
| `issueSessions / sessions.filter callback@94 — apps/web/src/features/issues/IssueCompactControls.tsx:94` | 131.8 | 131.8 |
| `useDomTranscriptScroll / useCallback callback@147 — packages/client-core/src/react/use-dom-transcript-scroll.ts:147` | 120.5 | 120.5 |
| `(program)` | 119.5 | 119.5 |
| `issueSessions — apps/web/src/features/issues/IssueCompactControls.tsx:88` | 91.0 | 222.7 |
| `(garbage collector)` | 90.5 | 90.5 |

Top five inclusive costs, all functions.

| Function — declaration file:line | Mean self ms | Mean inclusive ms |
| --- | ---: | ---: |
| `processRootScheduleInMicrotask — node_modules/react-dom/cjs/react-dom-client.production.js:11966` | 0.0 | 1,336.2 |
| `scheduleImmediateRootScheduleTask / scheduleMicrotask callback@12089 — node_modules/react-dom/cjs/react-dom-client.production.js:12089` | 0.0 | 1,336.2 |
| `performWorkOnRoot — node_modules/react-dom/cjs/react-dom-client.production.js:10681` | 0.0 | 1,336.2 |
| `performSyncWorkOnRoot — node_modules/react-dom/cjs/react-dom-client.production.js:12084` | 0.0 | 1,336.2 |
| `flushSyncWorkAcrossRoots_impl — node_modules/react-dom/cjs/react-dom-client.production.js:11918` | 0.0 | 1,336.2 |

Top five application inclusive costs.

| Function — declaration file:line | Mean self ms | Mean inclusive ms |
| --- | ---: | ---: |
| `IssuePanelView — apps/web/src/features/issues/IssuePanelView.tsx:825` | 0.9 | 235.4 |
| `issueSessions — apps/web/src/features/issues/IssueCompactControls.tsx:88` | 91.0 | 222.7 |
| `IssuePanelView / openChildren.map callback@1132 — apps/web/src/features/issues/IssuePanelView.tsx:1132` | 0.0 | 201.5 |
| `subscribe — packages/client-graph/src/runtime-pool.ts:20` | 0.0 | 139.0 |
| `createPoolProjection / computed callback@16 — packages/client-graph/src/runtime-pool.ts:16` | 0.0 | 133.1 |

#### session-switch OFF

Top five self costs.

| Function — declaration file:line | Mean self ms | Mean inclusive ms |
| --- | ---: | ---: |
| `(idle)` | 134.2 | 134.2 |
| `archivedSessionsForIssue — packages/client-core/src/viewmodels/session-ownership.ts:333` | 127.2 | 156.6 |
| `(program)` | 121.4 | 121.4 |
| `sessionView — packages/client-core/src/session-values.ts:94` | 45.8 | 45.8 |
| `archivedSessionsForIssue / sessions.filter callback@341 — packages/client-core/src/viewmodels/session-ownership.ts:341` | 29.1 | 29.5 |

Top five inclusive costs, all functions.

| Function — declaration file:line | Mean self ms | Mean inclusive ms |
| --- | ---: | ---: |
| `performWorkOnRoot — node_modules/react-dom/cjs/react-dom-client.production.js:10681` | 0.0 | 575.4 |
| `performSyncWorkOnRoot — node_modules/react-dom/cjs/react-dom-client.production.js:12084` | 0.0 | 575.1 |
| `flushSyncWorkAcrossRoots_impl — node_modules/react-dom/cjs/react-dom-client.production.js:11918` | 0.0 | 575.1 |
| `processRootScheduleInMicrotask — node_modules/react-dom/cjs/react-dom-client.production.js:11966` | 0.0 | 575.1 |
| `scheduleImmediateRootScheduleTask / scheduleMicrotask callback@12089 — node_modules/react-dom/cjs/react-dom-client.production.js:12089` | 0.0 | 575.1 |

Top five application inclusive costs.

| Function — declaration file:line | Mean self ms | Mean inclusive ms |
| --- | ---: | ---: |
| `FlightDeckContent — apps/web/src/app/FlightDeck.tsx:3013` | 11.8 | 358.7 |
| `measureWork — apps/web/src/app/mission-pane-perf.ts:12` | 1.4 | 220.9 |
| `measureLegacyMission — apps/web/src/app/mission-pane-perf.ts:36` | 0.0 | 220.9 |
| `archivedSessionsForIssue — packages/client-core/src/viewmodels/session-ownership.ts:333` | 127.2 | 156.6 |
| `selectSession — apps/web/src/app/FlightDeck.tsx:3699` | 0.0 | 115.6 |

#### session-switch ON

Top five self costs.

| Function — declaration file:line | Mean self ms | Mean inclusive ms |
| --- | ---: | ---: |
| `(program)` | 182.3 | 182.3 |
| `(idle)` | 92.5 | 92.5 |
| `(garbage collector)` | 83.2 | 83.2 |
| `deriveIssueViews — packages/client-core/src/replica/issue-views.ts:303` | 27.5 | 38.1 |
| `sessionView — packages/client-core/src/session-values.ts:94` | 25.8 | 25.8 |

Top five inclusive costs, all functions.

| Function — declaration file:line | Mean self ms | Mean inclusive ms |
| --- | ---: | ---: |
| `performWorkOnRoot — node_modules/react-dom/cjs/react-dom-client.production.js:10681` | 0.0 | 627.6 |
| `processRootScheduleInMicrotask — node_modules/react-dom/cjs/react-dom-client.production.js:11966` | 0.0 | 622.5 |
| `scheduleImmediateRootScheduleTask / scheduleMicrotask callback@12089 — node_modules/react-dom/cjs/react-dom-client.production.js:12089` | 0.0 | 622.5 |
| `performSyncWorkOnRoot — node_modules/react-dom/cjs/react-dom-client.production.js:12084` | 0.0 | 622.5 |
| `flushSyncWorkAcrossRoots_impl — node_modules/react-dom/cjs/react-dom-client.production.js:11918` | 0.0 | 622.5 |

Top five application inclusive costs.

| Function — declaration file:line | Mean self ms | Mean inclusive ms |
| --- | ---: | ---: |
| `AgentPanel — apps/web/src/features/terminal/AgentPanel.tsx:208` | 0.4 | 110.8 |
| `useIssueModelsSelection / useCallback callback@72 — packages/client-core/src/replica/use-issue-views.ts:72` | 0.4 | 108.1 |
| `useIssueModelsSelection — packages/client-core/src/replica/use-issue-views.ts:65` | 0.0 | 108.1 |
| `useAllIssueViewModels — packages/client-core/src/replica/use-issue-views.ts:96` | 0.0 | 108.1 |
| `useReplicaIssues — apps/web/src/app/store.tsx:186` | 0.0 | 108.1 |

#### issue-rename OFF

Top five self costs.

| Function — declaration file:line | Mean self ms | Mean inclusive ms |
| --- | ---: | ---: |
| `archivedSessionsForIssue — packages/client-core/src/viewmodels/session-ownership.ts:333` | 125.3 | 152.2 |
| `select — apps/web/src/features/chat/issue-chip-refs.ts:75` | 52.3 | 110.3 |
| `issueReferenceLookup — apps/web/src/lib/issue-chip-liveness.ts:102` | 47.9 | 58.0 |
| `(garbage collector)` | 45.8 | 45.8 |
| `(program)` | 45.0 | 45.0 |

Top five inclusive costs, all functions.

| Function — declaration file:line | Mean self ms | Mean inclusive ms |
| --- | ---: | ---: |
| `performWorkOnRoot — node_modules/react-dom/cjs/react-dom-client.production.js:10681` | 0.0 | 654.7 |
| `performSyncWorkOnRoot — node_modules/react-dom/cjs/react-dom-client.production.js:12084` | 0.0 | 654.7 |
| `flushSyncWorkAcrossRoots_impl — node_modules/react-dom/cjs/react-dom-client.production.js:11918` | 0.0 | 654.7 |
| `processRootScheduleInMicrotask — node_modules/react-dom/cjs/react-dom-client.production.js:11966` | 0.0 | 654.7 |
| `scheduleImmediateRootScheduleTask / scheduleMicrotask callback@12089 — node_modules/react-dom/cjs/react-dom-client.production.js:12089` | 0.0 | 654.7 |

Top five application inclusive costs.

| Function — declaration file:line | Mean self ms | Mean inclusive ms |
| --- | ---: | ---: |
| `FlightDeckContent — apps/web/src/app/FlightDeck.tsx:3013` | 9.2 | 231.0 |
| `FlightDeckContent / useCallback callback@3021 — apps/web/src/app/FlightDeck.tsx:3021` | 0.5 | 212.4 |
| `measureWork — apps/web/src/app/mission-pane-perf.ts:12` | 1.4 | 211.9 |
| `measureLegacyMission — apps/web/src/app/mission-pane-perf.ts:36` | 0.0 | 211.9 |
| `FlightDeckContent / useMemo callback@3397 — apps/web/src/app/FlightDeck.tsx:3397` | 0.4 | 154.0 |

#### issue-rename ON

Top five self costs.

| Function — declaration file:line | Mean self ms | Mean inclusive ms |
| --- | ---: | ---: |
| `(garbage collector)` | 154.7 | 154.7 |
| `deriveIssueViews — packages/client-core/src/replica/issue-views.ts:303` | 46.9 | 61.8 |
| `(program)` | 46.3 | 46.3 |
| `issueSessions / sessions.filter callback@94 — apps/web/src/features/issues/IssueCompactControls.tsx:94` | 35.3 | 35.3 |
| `modelsFor — packages/client-core/src/replica/issue-view-cache.ts:203` | 26.5 | 142.9 |

Top five inclusive costs, all functions.

| Function — declaration file:line | Mean self ms | Mean inclusive ms |
| --- | ---: | ---: |
| `performWorkOnRoot — node_modules/react-dom/cjs/react-dom-client.production.js:10681` | 0.0 | 396.8 |
| `performSyncWorkOnRoot — node_modules/react-dom/cjs/react-dom-client.production.js:12084` | 0.0 | 396.8 |
| `flushSyncWorkAcrossRoots_impl — node_modules/react-dom/cjs/react-dom-client.production.js:11918` | 0.0 | 396.8 |
| `processRootScheduleInMicrotask — node_modules/react-dom/cjs/react-dom-client.production.js:11966` | 0.0 | 396.8 |
| `scheduleImmediateRootScheduleTask / scheduleMicrotask callback@12089 — node_modules/react-dom/cjs/react-dom-client.production.js:12089` | 0.0 | 396.8 |

Top five application inclusive costs.

| Function — declaration file:line | Mean self ms | Mean inclusive ms |
| --- | ---: | ---: |
| `AgentPanel — apps/web/src/features/terminal/AgentPanel.tsx:208` | 0.4 | 147.9 |
| `useIssueModelsSelection / useCallback callback@72 — packages/client-core/src/replica/use-issue-views.ts:72` | 1.5 | 144.3 |
| `useIssueModelsSelection — packages/client-core/src/replica/use-issue-views.ts:65` | 0.0 | 144.3 |
| `useAllIssueViewModels — packages/client-core/src/replica/use-issue-views.ts:96` | 0.0 | 144.3 |
| `useReplicaIssues — apps/web/src/app/store.tsx:186` | 0.0 | 144.3 |

#### background-update OFF

Top five self costs.

| Function — declaration file:line | Mean self ms | Mean inclusive ms |
| --- | ---: | ---: |
| `archivedSessionsForIssue — packages/client-core/src/viewmodels/session-ownership.ts:333` | 179.2 | 179.2 |
| `deriveIssueViews — packages/client-core/src/replica/issue-views.ts:303` | 81.7 | 112.5 |
| `modelsFor — packages/client-core/src/replica/issue-view-cache.ts:203` | 73.4 | 283.0 |
| `(garbage collector)` | 73.3 | 73.3 |
| `select — apps/web/src/features/chat/issue-chip-refs.ts:75` | 53.0 | 114.6 |

Top five inclusive costs, all functions.

| Function — declaration file:line | Mean self ms | Mean inclusive ms |
| --- | ---: | ---: |
| `performWorkOnRoot — node_modules/react-dom/cjs/react-dom-client.production.js:10681` | 0.0 | 745.4 |
| `performSyncWorkOnRoot — node_modules/react-dom/cjs/react-dom-client.production.js:12084` | 0.0 | 745.4 |
| `flushSyncWorkAcrossRoots_impl — node_modules/react-dom/cjs/react-dom-client.production.js:11918` | 0.0 | 745.4 |
| `processRootScheduleInMicrotask — node_modules/react-dom/cjs/react-dom-client.production.js:11966` | 0.0 | 745.4 |
| `scheduleImmediateRootScheduleTask / scheduleMicrotask callback@12089 — node_modules/react-dom/cjs/react-dom-client.production.js:12089` | 0.0 | 745.4 |

Top five application inclusive costs.

| Function — declaration file:line | Mean self ms | Mean inclusive ms |
| --- | ---: | ---: |
| `useIssueModelsSelection / useCallback callback@72 — packages/client-core/src/replica/use-issue-views.ts:72` | 1.5 | 284.5 |
| `modelsFor — packages/client-core/src/replica/issue-view-cache.ts:203` | 73.4 | 283.0 |
| `FlightDeckContent — apps/web/src/app/FlightDeck.tsx:3013` | 18.6 | 262.5 |
| `measureWork — apps/web/src/app/mission-pane-perf.ts:12` | 0.4 | 240.2 |
| `measureLegacyMission — apps/web/src/app/mission-pane-perf.ts:36` | 0.0 | 240.2 |

#### background-update ON

Top five self costs.

| Function — declaration file:line | Mean self ms | Mean inclusive ms |
| --- | ---: | ---: |
| `(garbage collector)` | 143.9 | 143.9 |
| `deriveIssueViews — packages/client-core/src/replica/issue-views.ts:303` | 80.1 | 110.8 |
| `modelsFor — packages/client-core/src/replica/issue-view-cache.ts:203` | 52.1 | 254.4 |
| `readViewInputs — packages/client-core/src/replica/issue-views.ts:460` | 30.4 | 37.4 |
| `deriveIssueViewsSnapshot — packages/client-core/src/replica/issue-view-models.ts:86` | 28.8 | 197.4 |

Top five inclusive costs, all functions.

| Function — declaration file:line | Mean self ms | Mean inclusive ms |
| --- | ---: | ---: |
| `useIssueModelsSelection / useCallback callback@72 — packages/client-core/src/replica/use-issue-views.ts:72` | 1.4 | 255.8 |
| `modelsFor — packages/client-core/src/replica/issue-view-cache.ts:203` | 52.1 | 254.4 |
| `deriveIssueViewsSnapshot — packages/client-core/src/replica/issue-view-models.ts:86` | 28.8 | 197.4 |
| `(native/unmapped)` | 0.1 | 189.1 |
| `patch — apps/web/test/sidebar-acceptance.browser.tsx:319` | 0.0 | 189.0 |

Top five application inclusive costs.

| Function — declaration file:line | Mean self ms | Mean inclusive ms |
| --- | ---: | ---: |
| `useIssueModelsSelection / useCallback callback@72 — packages/client-core/src/replica/use-issue-views.ts:72` | 1.4 | 255.8 |
| `modelsFor — packages/client-core/src/replica/issue-view-cache.ts:203` | 52.1 | 254.4 |
| `deriveIssueViewsSnapshot — packages/client-core/src/replica/issue-view-models.ts:86` | 28.8 | 197.4 |
| `patch — apps/web/test/sidebar-acceptance.browser.tsx:319` | 0.0 | 189.0 |
| `backgroundTitle — apps/web/test/sidebar-acceptance.browser.tsx:377` | 0.0 | 189.0 |

### Committed components

Rendered instance counts include repeated renders over the in-window commits. The complete matrix names every observed committed composite source function, resolving observer wrappers to their underlying component as in the original report. Hosts/providers, reused bailout fibers and abandoned attempts are excluded. Library factories are source-function groups; Lucide rows retain runtime icon names.

| Action / pilot | Rendered instances 0 / 1 / 2 | Observer walk wall ms 0 / 1 / 2 |
| --- | ---: | ---: |
| mission-switch OFF | 15415 / 13999 / 15415 | 116.6 / 107.8 / 157.7 |
| mission-switch ON | 23623 / 21074 / 23623 | 123.4 / 124.7 / 138.4 |
| session-switch OFF | 8930 / 8892 / 8869 | 164.2 / 91.1 / 47.7 |
| session-switch ON | 17199 / 17485 / 17137 | 168.1 / 649.3 / 63.2 |
| issue-rename OFF | 8662 / 8662 / 8662 | 38.8 / 37.2 / 31.4 |
| issue-rename ON | 8859 / 8859 / 8859 | 35.5 / 31.9 / 35.1 |
| background-update OFF | 8668 / 8665 / 8665 | 39.8 / 34.1 / 37.3 |
| background-update ON | 658 / 655 / 655 | 30.4 / 35.1 / 29.1 |

<details>
<summary>Complete post-fix component counts and mapped source functions</summary>

| Composite source function / factory group | mission-switch OFF | mission-switch ON | session-switch OFF | session-switch ON | issue-rename OFF | issue-rename ON | background-update OFF | background-update ON |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `AgentPanel — apps/web/src/features/terminal/AgentPanel.tsx:208` | 4 / 4 / 4 | 6 / 6 / 6 | 6 / 6 / 6 | 9 / 9 / 9 | 3 / 3 / 3 | 6 / 6 / 6 | 3 / 3 / 3 | 4 / 4 / 4 |
| `AgentPanelBoundary — apps/web/src/features/terminal/AgentPanelBoundary.tsx:33` | 4 / 4 / 4 | 6 / 6 / 6 | 6 / 6 / 6 | 9 / 9 / 9 | 3 / 3 / 3 | 3 / 3 / 3 | 3 / 3 / 3 | 0 |
| `AgentStatusGlyph — apps/web/src/lib/motion/AgentStatusGlyph.tsx:22` | 2 / 2 / 2 | 3 / 3 / 3 | 2 / 4 / 2 | 3 / 6 / 3 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 0 |
| `AlertDialog — apps/web/src/components/ui/alert-dialog.tsx:7` | 6 / 6 / 6 | 7 / 7 / 7 | 2 / 2 / 2 | 3 / 3 / 3 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 1 / 1 / 1 |
| `AlertDialogContent — apps/web/src/components/ui/alert-dialog.tsx:39` | 6 / 6 / 6 | 7 / 7 / 7 | 2 / 2 / 2 | 3 / 3 / 3 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 1 / 1 / 1 |
| `AlertDialogPortal — apps/web/src/components/ui/alert-dialog.tsx:17` | 6 / 6 / 6 | 7 / 7 / 7 | 2 / 2 / 2 | 3 / 3 / 3 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 1 / 1 / 1 |
| `AlertDialogRoot — node_modules/@base-ui/react/esm/alert-dialog/root/AlertDialogRoot.js:10` | 6 / 6 / 6 | 7 / 7 / 7 | 2 / 2 / 2 | 3 / 3 / 3 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 1 / 1 / 1 |
| `Archive — node_modules/lucide-react/dist/esm/createLucideIcon.mjs:16` | 2 / 2 / 2 | 3 / 3 / 3 | 1 / 1 / 1 | 2 / 2 / 2 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 0 |
| `ArrowSwipeKey — packages/terminal-client-react/src/ArrowSwipeKey.tsx:866` | 4 / 4 / 4 | 6 / 6 / 6 | 4 / 4 / 4 | 6 / 6 / 6 | 2 / 2 / 2 | 4 / 4 / 4 | 2 / 2 / 2 | 3 / 3 / 3 |
| `ArrowUp — node_modules/lucide-react/dist/esm/createLucideIcon.mjs:16` | 4 / 4 / 4 | 6 / 6 / 6 | 6 / 6 / 6 | 9 / 9 / 9 | 3 / 3 / 3 | 6 / 6 / 6 | 3 / 3 / 3 | 4 / 4 / 4 |
| `ArrowUpRight — node_modules/lucide-react/dist/esm/createLucideIcon.mjs:16` | 46 / 56 / 46 | 67 / 82 / 67 | 22 / 22 / 22 | 43 / 43 / 43 | 22 / 22 / 22 | 22 / 22 / 22 | 22 / 22 / 22 | 1 / 1 / 1 |
| `AtMentionMenu — apps/web/src/lib/at-mention/AtMentionMenu.tsx:34` | 4 / 4 / 4 | 6 / 6 / 6 | 6 / 6 / 6 | 9 / 9 / 9 | 3 / 3 / 3 | 6 / 6 / 6 | 3 / 3 / 3 | 4 / 4 / 4 |
| `AttachmentStrip — apps/web/src/features/chat/AttachmentStrip.tsx:27` | 4 / 4 / 4 | 6 / 6 / 6 | 6 / 6 / 6 | 9 / 9 / 9 | 3 / 3 / 3 | 6 / 6 / 6 | 3 / 3 / 3 | 4 / 4 / 4 |
| `BranchGuides — apps/web/src/app/FlightDeck.tsx:781` | 239 / 226 / 239 | 478 / 452 / 478 | 239 / 239 / 239 | 478 / 478 / 478 | 239 / 239 / 239 | 239 / 239 / 239 | 239 / 239 / 239 | 0 |
| `Button — apps/web/src/components/ui/button.tsx:50` | 455 / 394 / 455 | 880 / 759 / 880 | 448 / 448 / 448 | 878 / 878 / 878 | 433 / 433 / 433 | 448 / 448 / 448 | 433 / 433 / 433 | 23 / 23 / 23 |
| `Button — node_modules/@base-ui/react/esm/button/Button.js:12` | 455 / 394 / 455 | 880 / 759 / 880 | 448 / 448 / 448 | 878 / 878 / 878 | 433 / 433 / 433 | 448 / 448 / 448 | 433 / 433 / 433 | 23 / 23 / 23 |
| `ChatComposer — apps/web/src/features/chat/ChatComposer.tsx:110` | 4 / 4 / 4 | 6 / 6 / 6 | 6 / 6 / 6 | 9 / 9 / 9 | 3 / 3 / 3 | 6 / 6 / 6 | 3 / 3 / 3 | 4 / 4 / 4 |
| `ChatRail — apps/web/src/features/chat/ChatRail.tsx:35` | 4 / 4 / 4 | 6 / 6 / 6 | 6 / 6 / 6 | 9 / 9 / 9 | 3 / 3 / 3 | 6 / 6 / 6 | 3 / 3 / 3 | 4 / 4 / 4 |
| `ChatView — apps/web/src/features/chat/ChatView.tsx:158` | 4 / 4 / 4 | 6 / 6 / 6 | 6 / 6 / 6 | 9 / 9 / 9 | 3 / 3 / 3 | 6 / 6 / 6 | 3 / 3 / 3 | 4 / 4 / 4 |
| `Check — node_modules/lucide-react/dist/esm/createLucideIcon.mjs:16` | 19 / 15 / 19 | 38 / 30 / 38 | 19 / 19 / 19 | 38 / 38 / 38 | 19 / 19 / 19 | 19 / 19 / 19 | 19 / 19 / 19 | 0 |
| `CheckoutPart — apps/web/src/features/issues/IssuePanelView.tsx:326` | 4 / 4 / 4 | 4 / 4 / 4 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `ChevronDown — node_modules/lucide-react/dist/esm/createLucideIcon.mjs:16` | 122 / 96 / 122 | 239 / 187 / 239 | 118 / 118 / 118 | 235 / 235 / 235 | 118 / 118 / 118 | 118 / 118 / 118 | 118 / 118 / 118 | 1 / 1 / 1 |
| `ChevronLeft — node_modules/lucide-react/dist/esm/createLucideIcon.mjs:16` | 2 / 2 / 2 | 3 / 3 / 3 | 1 / 1 / 1 | 2 / 2 / 2 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 0 |
| `ChevronRight — node_modules/lucide-react/dist/esm/createLucideIcon.mjs:16` | 73 / 70 / 73 | 122 / 116 / 122 | 50 / 50 / 50 | 99 / 99 / 99 | 50 / 50 / 50 | 50 / 50 / 50 | 50 / 50 / 50 | 1 / 1 / 1 |
| `ChevronsDownUp — node_modules/lucide-react/dist/esm/createLucideIcon.mjs:16` | 2 / 2 / 2 | 3 / 3 / 3 | 1 / 1 / 1 | 2 / 2 / 2 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 0 |
| `ClaudeCodeIcon — apps/web/src/lib/icons/AgentIcons.tsx:15` | 126 / 92 / 126 | 235 / 167 / 235 | 112 / 112 / 112 | 221 / 221 / 221 | 113 / 113 / 113 | 113 / 113 / 113 | 113 / 113 / 113 | 4 / 4 / 4 |
| `ClosedIssueFold — apps/web/src/features/worklist/work-folds.tsx:492` | 6 / 6 / 6 | 6 / 6 / 6 | 0 | 0 | 0 | 0 | 0 | 0 |
| `ColdTurn — apps/web/src/features/chat/TranscriptCold.tsx:42` | 16 / 16 / 16 | 24 / 24 / 24 | 16 / 16 / 16 | 24 / 24 / 24 | 8 / 8 / 8 | 16 / 16 / 16 | 8 / 8 / 8 | 12 / 12 / 12 |
| `CollapsedPayload — apps/web/src/app/FlightDeck.tsx:828` | 49 / 46 / 49 | 98 / 92 / 98 | 49 / 49 / 49 | 98 / 98 / 98 | 49 / 49 / 49 | 49 / 49 / 49 | 49 / 49 / 49 | 0 |
| `Columns2 — node_modules/lucide-react/dist/esm/createLucideIcon.mjs:16` | 2 / 2 / 2 | 3 / 3 / 3 | 2 / 2 / 2 | 3 / 3 / 3 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 0 |
| `CommandPaletteBoundary — apps/web/src/app/CommandPaletteBoundary.tsx:17` | 1 / 1 / 1 | 1 / 1 / 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| `CrewCensus — apps/web/src/app/FlightDeck.tsx:706` | 49 / 46 / 49 | 98 / 92 / 98 | 49 / 49 / 49 | 98 / 98 / 98 | 49 / 49 / 49 | 49 / 49 / 49 | 49 / 49 / 49 | 0 |
| `DeckSection — apps/web/src/app/FlightDeck.tsx:1998` | 6 / 6 / 6 | 9 / 9 / 9 | 3 / 3 / 3 | 6 / 6 / 6 | 3 / 3 / 3 | 3 / 3 / 3 | 3 / 3 / 3 | 0 |
| `DepartedState — apps/web/src/app/FlightDeck.tsx:2049` | 42 / 52 / 42 | 63 / 78 / 63 | 21 / 21 / 21 | 42 / 42 / 42 | 21 / 21 / 21 | 21 / 21 / 21 | 21 / 21 / 21 | 0 |
| `DialogPortal — node_modules/@base-ui/react/esm/dialog/portal/DialogPortal.js:18` | 6 / 6 / 6 | 7 / 7 / 7 | 2 / 2 / 2 | 3 / 3 / 3 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 1 / 1 / 1 |
| `DockCommentComposer — apps/web/src/features/issues/IssuePanelView.tsx:558` | 4 / 4 / 4 | 4 / 4 / 4 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `DockPart — apps/web/src/features/issues/IssuePanelView.tsx:122` | 29 / 29 / 29 | 29 / 29 / 29 | 7 / 7 / 7 | 7 / 7 / 7 | 7 / 7 / 7 | 7 / 7 / 7 | 7 / 7 / 7 | 7 / 7 / 7 |
| `DpadGlyphs — packages/terminal-client-react/src/ArrowSwipeKey.tsx:568` | 8 / 8 / 8 | 12 / 12 / 12 | 8 / 8 / 8 | 12 / 12 / 12 | 4 / 4 / 4 | 8 / 8 / 8 | 4 / 4 / 4 | 6 / 6 / 6 |
| `DropdownMenu — apps/web/src/components/ui/dropdown-menu.tsx:50` | 538 / 471 / 538 | 867 / 760 / 867 | 362 / 362 / 362 | 692 / 692 / 692 | 358 / 358 / 358 | 361 / 361 / 361 | 358 / 358 / 358 | 32 / 32 / 32 |
| `DropdownMenuContent — apps/web/src/components/ui/dropdown-menu.tsx:62` | 538 / 471 / 538 | 867 / 760 / 867 | 362 / 362 / 362 | 692 / 692 / 692 | 358 / 358 / 358 | 361 / 361 / 361 | 358 / 358 / 358 | 32 / 32 / 32 |
| `DropdownMenuTrigger — apps/web/src/components/ui/dropdown-menu.tsx:58` | 538 / 471 / 538 | 867 / 760 / 867 | 362 / 362 / 362 | 692 / 692 / 692 | 358 / 358 / 358 | 361 / 361 / 361 | 358 / 358 / 358 | 32 / 32 / 32 |
| `Ellipsis — node_modules/lucide-react/dist/esm/createLucideIcon.mjs:16` | 447 / 386 / 447 | 860 / 739 / 860 | 424 / 424 / 424 | 838 / 838 / 838 | 421 / 421 / 421 | 424 / 424 / 424 | 421 / 421 / 421 | 11 / 11 / 11 |
| `Fixture — apps/web/test/sidebar-acceptance.browser.tsx:216` | 1 / 1 / 1 | 1 / 1 / 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| `FlightDeck — apps/web/src/app/FlightDeck.tsx:2975` | 1 / 1 / 1 | 1 / 1 / 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| `FlightDeckContent — apps/web/src/app/FlightDeck.tsx:3013` | 2 / 2 / 2 | 3 / 3 / 3 | 1 / 1 / 1 | 2 / 2 / 2 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 0 |
| `FloatingTree — node_modules/@base-ui/react/esm/floating-ui-react/components/FloatingTree.js:81` | 538 / 471 / 538 | 867 / 760 / 867 | 362 / 362 / 362 | 692 / 692 / 692 | 358 / 358 / 358 | 361 / 361 / 361 | 358 / 358 / 358 | 32 / 32 / 32 |
| `FoldPanel — apps/web/src/features/worklist/work-folds.tsx:269` | 22 / 22 / 22 | 22 / 22 / 22 | 0 | 0 | 0 | 0 | 0 | 0 |
| `FoldRow — apps/web/src/features/issues/IssuePanelView.tsx:167` | 6 / 6 / 6 | 6 / 6 / 6 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `Folder — node_modules/lucide-react/dist/esm/createLucideIcon.mjs:16` | 8 / 8 / 8 | 10 / 10 / 10 | 7 / 7 / 7 | 10 / 10 / 10 | 4 / 4 / 4 | 7 / 7 / 7 | 4 / 4 / 4 | 5 / 5 / 5 |
| `GitStamp — apps/web/src/components/GitStamp.tsx:13` | 4 / 4 / 4 | 6 / 6 / 6 | 6 / 6 / 6 | 9 / 9 / 9 | 3 / 3 / 3 | 6 / 6 / 6 | 3 / 3 / 3 | 4 / 4 / 4 |
| `GrokIcon — apps/web/src/lib/icons/AgentIcons.tsx:59` | 8 / 10 / 8 | 16 / 20 / 16 | 8 / 8 / 8 | 16 / 16 / 16 | 8 / 8 / 8 | 8 / 8 / 8 | 8 / 8 / 8 | 0 |
| `HibernatedBanner — apps/web/src/features/terminal/SessionLifecyclePanes.tsx:228` | 0 | 0 | 2 / 2 / 2 | 3 / 3 / 3 | 1 / 1 / 1 | 2 / 2 / 2 | 1 / 1 / 1 | 1 / 1 / 1 |
| `Hint — apps/web/src/features/issues/IssuePanelView.tsx:75` | 9 / 9 / 9 | 9 / 9 / 9 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 |
| `Hourglass — node_modules/lucide-react/dist/esm/createLucideIcon.mjs:16` | 103 / 80 / 103 | 202 / 157 / 202 | 99 / 99 / 99 | 198 / 198 / 198 | 99 / 99 / 99 | 99 / 99 / 99 | 99 / 99 / 99 | 0 |
| `Hung — apps/web/src/app/FlightDeck.tsx:742` | 178 / 130 / 178 | 350 / 255 / 350 | 172 / 172 / 172 | 344 / 344 / 344 | 172 / 172 / 172 | 172 / 172 / 172 | 172 / 172 / 172 | 0 |
| `HungRows — apps/web/src/app/FlightDeck.tsx:1444` | 241 / 228 / 241 | 481 / 455 / 481 | 240 / 240 / 240 | 480 / 480 / 480 | 240 / 240 / 240 | 240 / 240 / 240 | 240 / 240 / 240 | 0 |
| `IdGutter — apps/web/src/features/worklist/WorkRowShell.tsx:405` | 2 / 2 / 2 | 2 / 2 / 2 | 0 | 0 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `ImageLightbox — apps/web/src/features/chat/ImageLightbox.tsx:7` | 4 / 4 / 4 | 6 / 6 / 6 | 6 / 6 / 6 | 9 / 9 / 9 | 3 / 3 / 3 | 6 / 6 / 6 | 3 / 3 / 3 | 4 / 4 / 4 |
| `InspectHead — apps/web/src/features/issues/IssuePanelView.tsx:451` | 4 / 4 / 4 | 4 / 4 / 4 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `IssueChipLiveness — apps/web/src/features/chat/IssueChipLiveness.tsx:18` | 4 / 4 / 4 | 6 / 6 / 6 | 6 / 6 / 6 | 9 / 9 / 9 | 3 / 3 / 3 | 6 / 6 / 6 | 3 / 3 / 3 | 4 / 4 / 4 |
| `IssueCloseDialog — apps/web/src/features/issues/issue-lifecycle.tsx:139` | 6 / 6 / 6 | 7 / 7 / 7 | 2 / 2 / 2 | 3 / 3 / 3 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 1 / 1 / 1 |
| `IssueCompactControls — apps/web/src/features/issues/IssueCompactControls.tsx:490` | 4 / 4 / 4 | 4 / 4 / 4 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `IssueDecisionBand — apps/web/src/features/issues/IssueCompactControls.tsx:341` | 4 / 4 / 4 | 4 / 4 / 4 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `IssueExplorer — apps/web/src/features/issues/explorer/IssueExplorer.tsx:43` | 3 / 3 / 3 | 3 / 3 / 3 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `IssueExplorerCrumbs — apps/web/src/features/issues/explorer/IssueExplorer.tsx:113` | 2 / 2 / 2 | 2 / 2 / 2 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `IssueExplorerProvider — apps/web/src/features/issues/explorer/explorer-context.tsx:90` | 1 / 1 / 1 | 1 / 1 / 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| `IssueFleetSummary — apps/web/src/components/IssueFleetSummary.tsx:39` | 2 / 2 / 2 | 2 / 2 / 2 | 0 | 0 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `IssueGitScope — apps/web/src/features/issues/IssueCompactControls.tsx:174` | 4 / 4 / 4 | 4 / 4 / 4 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `IssueNoteChip — apps/web/src/app/FlightDeck.tsx:593` | 72 / 73 / 72 | 144 / 146 / 144 | 72 / 72 / 72 | 144 / 144 / 144 | 72 / 72 / 72 | 72 / 72 / 72 | 72 / 72 / 72 | 0 |
| `IssuePanelView — apps/web/src/features/issues/IssuePanelView.tsx:825` | 4 / 4 / 4 | 4 / 4 / 4 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `IssueSessionRow — apps/web/src/features/issues/IssueCompactControls.tsx:238` | 22 / 22 / 22 | 22 / 22 / 22 | 6 / 6 / 6 | 6 / 6 / 6 | 6 / 6 / 6 | 6 / 6 / 6 | 6 / 6 / 6 | 6 / 6 / 6 |
| `IssueStatusPicker — apps/web/src/features/issues/IssueStatusPicker.tsx:55` | 525 / 458 / 525 | 850 / 743 / 850 | 352 / 352 / 352 | 677 / 677 / 677 | 352 / 352 / 352 | 352 / 352 / 352 | 352 / 352 / 352 | 27 / 27 / 27 |
| `KindIcon — apps/web/src/lib/WorkerLabel.tsx:87` | 255 / 204 / 255 | 479 / 378 / 479 | 235 / 237 / 235 | 460 / 463 / 460 | 232 / 232 / 232 | 235 / 235 / 235 | 232 / 232 / 232 | 10 / 10 / 10 |
| `LayoutGroup — node_modules/framer-motion/dist/es/components/LayoutGroup/index.mjs:11` | 1 / 1 / 1 | 1 / 1 / 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| `LazyMotion — node_modules/framer-motion/dist/es/components/LazyMotion/index.mjs:42` | 1 / 1 / 1 | 1 / 1 / 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| `LegacyFlightDeck — apps/web/src/app/FlightDeck.tsx:2998` | 1 / 1 / 1 | 0 | 1 / 1 / 1 | 0 | 1 / 1 / 1 | 0 | 1 / 1 / 1 | 0 |
| `LegacyIssueChipLiveness — apps/web/src/features/chat/IssueChipLiveness.tsx:51` | 4 / 4 / 4 | 0 | 6 / 6 / 6 | 0 | 3 / 3 / 3 | 0 | 3 / 3 / 3 | 0 |
| `LegacyMissionAgentMenu — apps/web/src/app/FlightDeck.tsx:197` | 2 / 2 / 2 | 0 | 1 / 1 / 1 | 0 | 1 / 1 / 1 | 0 | 1 / 1 / 1 | 0 |
| `LifecycleButton — apps/web/src/features/terminal/SessionLifecyclePanes.tsx:57` | 0 | 0 | 2 / 2 / 2 | 3 / 3 / 3 | 1 / 1 / 1 | 2 / 2 / 2 | 1 / 1 / 1 | 1 / 1 / 1 |
| `ListTree — node_modules/lucide-react/dist/esm/createLucideIcon.mjs:16` | 2 / 2 / 2 | 2 / 2 / 2 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `MenuPortal — node_modules/@base-ui/react/esm/menu/portal/MenuPortal.js:16` | 538 / 471 / 538 | 867 / 760 / 867 | 362 / 362 / 362 | 692 / 692 / 692 | 358 / 358 / 358 | 361 / 361 / 361 | 358 / 358 / 358 | 32 / 32 / 32 |
| `MessageSquareText — node_modules/lucide-react/dist/esm/createLucideIcon.mjs:16` | 4 / 4 / 4 | 6 / 6 / 6 | 4 / 4 / 4 | 6 / 6 / 6 | 2 / 2 / 2 | 4 / 4 / 4 | 2 / 2 / 2 | 3 / 3 / 3 |
| `Mic — node_modules/lucide-react/dist/esm/createLucideIcon.mjs:16` | 8 / 8 / 8 | 12 / 12 / 12 | 10 / 10 / 10 | 15 / 15 / 15 | 5 / 5 / 5 | 10 / 10 / 10 | 5 / 5 / 5 | 7 / 7 / 7 |
| `Minimap — apps/web/src/features/chat/Minimap.tsx:88` | 4 / 4 / 4 | 6 / 6 / 6 | 6 / 6 / 6 | 9 / 9 / 9 | 3 / 3 / 3 | 6 / 6 / 6 | 3 / 3 / 3 | 4 / 4 / 4 |
| `MissionAgentMenu — apps/web/src/app/FlightDeck.tsx:191` | 2 / 2 / 2 | 3 / 3 / 3 | 1 / 1 / 1 | 2 / 2 / 2 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 0 |
| `MissionAgentMenuContent — apps/web/src/app/FlightDeck.tsx:219` | 2 / 2 / 2 | 3 / 3 / 3 | 1 / 1 / 1 | 2 / 2 / 2 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 0 |
| `MissionBrief — apps/web/src/app/FlightDeck.tsx:2480` | 2 / 2 / 2 | 3 / 3 / 3 | 1 / 1 / 1 | 2 / 2 / 2 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 0 |
| `MissionCostChip — apps/web/src/app/MissionCostChip.tsx:94` | 3 / 3 / 3 | 4 / 4 / 4 | 1 / 1 / 1 | 2 / 2 / 2 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 0 |
| `MissionGauge — apps/web/src/app/MissionGauge.tsx:148` | 2 / 2 / 2 | 3 / 3 / 3 | 1 / 1 / 1 | 2 / 2 / 2 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 0 |
| `MobilePromoCard — apps/web/src/features/mobile-handoff/MobilePromoCard.tsx:28` | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 0 | 0 | 0 | 0 |
| `Moon — node_modules/lucide-react/dist/esm/createLucideIcon.mjs:16` | 0 | 0 | 2 / 2 / 2 | 3 / 3 / 3 | 1 / 1 / 1 | 2 / 2 / 2 | 1 / 1 / 1 | 1 / 1 / 1 |
| `MotionConfig — node_modules/framer-motion/dist/es/components/MotionConfig/index.mjs:26` | 1 / 1 / 1 | 1 / 1 / 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| `MotionDOMComponent — node_modules/framer-motion/dist/es/motion/index.mjs:38` | 1644 / 1644 / 1644 | 1644 / 1644 / 1644 | 0 | 0 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 |
| `NativeRows — apps/web/src/app/FlightDeck.tsx:898` | 178 / 130 / 178 | 350 / 255 / 350 | 172 / 172 / 172 | 344 / 344 / 344 | 172 / 172 / 172 | 172 / 172 / 172 | 172 / 172 / 172 | 0 |
| `NewPanelMenu — apps/web/src/app/NewPanelMenu.tsx:122` | 2 / 2 / 2 | 3 / 3 / 3 | 2 / 2 / 2 | 3 / 3 / 3 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 0 |
| `NewPanelMenuBody — apps/web/src/app/NewPanelMenu.tsx:128` | 3 / 3 / 3 | 4 / 4 / 4 | 2 / 2 / 2 | 3 / 3 / 3 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 0 |
| `ObservedPoolWorkSections — apps/web/src/features/worklist/pool-sidebar.tsx:217` | 1 / 1 / 1 | 1 / 1 / 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| `OpenAIcon — apps/web/src/lib/icons/AgentIcons.tsx:41` | 116 / 94 / 116 | 217 / 173 / 217 | 108 / 110 / 108 | 210 / 213 / 210 | 106 / 106 / 106 | 109 / 109 / 109 | 106 / 106 / 106 | 7 / 7 / 7 |
| `OpenCodeIcon — apps/web/src/lib/icons/AgentIcons.tsx:114` | 11 / 14 / 11 | 17 / 24 / 17 | 7 / 7 / 7 | 13 / 13 / 13 | 8 / 8 / 8 | 8 / 8 / 8 | 8 / 8 / 8 | 2 / 2 / 2 |
| `OperatorFocusProvider — apps/web/src/app/operator-focus.tsx:38` | 1 / 1 / 1 | 1 / 1 / 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| `PaneChrome — apps/web/src/app/Workspace.tsx:1145` | 2 / 2 / 2 | 3 / 3 / 3 | 2 / 2 / 2 | 3 / 3 / 3 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 0 |
| `PanelDeck — apps/web/src/app/PanelDeck.tsx:103` | 2 / 2 / 2 | 3 / 3 / 3 | 2 / 2 / 2 | 3 / 3 / 3 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 0 |
| `PanelVisible — apps/web/src/app/panel-visible.tsx:10` | 4 / 4 / 4 | 6 / 6 / 6 | 6 / 6 / 6 | 9 / 9 / 9 | 3 / 3 / 3 | 3 / 3 / 3 | 3 / 3 / 3 | 0 |
| `Paperclip — node_modules/lucide-react/dist/esm/createLucideIcon.mjs:16` | 4 / 4 / 4 | 6 / 6 / 6 | 6 / 6 / 6 | 9 / 9 / 9 | 3 / 3 / 3 | 6 / 6 / 6 | 3 / 3 / 3 | 4 / 4 / 4 |
| `PhaseTimer — apps/web/src/lib/motion/PhaseTimer.tsx:31` | 28 / 18 / 28 | 41 / 26 / 41 | 75 / 22 / 14 | 88 / 352 / 26 | 14 / 14 / 14 | 14 / 14 / 14 | 20 / 17 / 17 | 7 / 4 / 4 |
| `Pin — node_modules/lucide-react/dist/esm/createLucideIcon.mjs:16` | 1 / 1 / 1 | 1 / 1 / 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| `PinnedBrief — apps/web/src/features/chat/PinnedBrief.tsx:53` | 4 / 4 / 4 | 6 / 6 / 6 | 6 / 6 / 6 | 9 / 9 / 9 | 3 / 3 / 3 | 6 / 6 / 6 | 3 / 3 / 3 | 4 / 4 / 4 |
| `PinnedSectionLabel — apps/web/src/features/worklist/work-folds.tsx:167` | 1 / 1 / 1 | 1 / 1 / 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| `Plus — node_modules/lucide-react/dist/esm/createLucideIcon.mjs:16` | 2 / 2 / 2 | 3 / 3 / 3 | 2 / 2 / 2 | 3 / 3 / 3 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 0 |
| `PoolEviction — apps/web/src/features/worklist/pool-sidebar.tsx:139` | 1 / 1 / 1 | 1 / 1 / 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| `PoolFlightDeck — apps/web/src/app/FlightDeckPool.tsx:24` | 0 | 2 / 2 / 2 | 0 | 2 / 2 / 2 | 0 | 1 / 1 / 1 | 0 | 0 |
| `PoolIssueChipLiveness — apps/web/src/features/chat/IssueChipLiveness.tsx:22` | 0 | 6 / 6 / 6 | 0 | 9 / 9 / 9 | 0 | 6 / 6 / 6 | 0 | 4 / 4 / 4 |
| `PoolIssueExplorerProvider — apps/web/src/features/issues/explorer/explorer-context.tsx:313` | 2 / 2 / 2 | 2 / 2 / 2 | 0 | 0 | 0 | 0 | 0 | 0 |
| `PoolMotionRow — apps/web/src/features/worklist/pool-sidebar.tsx:580` | 793 / 793 / 793 | 793 / 793 / 793 | 0 | 0 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `ProducedAndDeferred — apps/web/src/features/issues/IssuePanelView.tsx:628` | 4 / 4 / 4 | 4 / 4 / 4 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `ProgressMeter — apps/web/src/features/issues/IssuePanelView.tsx:288` | 4 / 4 / 4 | 4 / 4 / 4 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `ProjectGroupLabel — apps/web/src/features/worklist/work-folds.tsx:141` | 11 / 11 / 11 | 11 / 11 / 11 | 0 | 0 | 0 | 0 | 0 | 0 |
| `ProposalRow — apps/web/src/app/FlightDeck.tsx:1912` | 170 / 116 / 170 | 255 / 174 / 255 | 85 / 85 / 85 | 170 / 170 / 170 | 85 / 85 / 85 | 85 / 85 / 85 | 85 / 85 / 85 | 0 |
| `RecentActivity — apps/web/src/features/issues/IssuePanelView.tsx:354` | 5 / 5 / 5 | 5 / 5 / 5 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `RightDock — apps/web/src/app/RightDock.tsx:107` | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `RightDockIssuePanel — apps/web/src/app/RightDockIssuePanel.tsx:7` | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 |
| `RoleWord — apps/web/src/app/FlightDeck.tsx:1010` | 130 / 84 / 130 | 254 / 163 / 254 | 124 / 124 / 124 | 248 / 248 / 248 | 124 / 124 / 124 | 124 / 124 / 124 | 124 / 124 / 124 | 0 |
| `RowProgressMeter — apps/web/src/features/worklist/row-progress.tsx:150` | 2 / 2 / 2 | 2 / 2 / 2 | 0 | 0 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `S — apps/web/src/features/worklist/worklist-motion-layout.tsx:40` | 815 / 815 / 815 | 815 / 815 / 815 | 0 | 0 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `ScopedChatComposer — apps/web/src/features/chat/ChatView.tsx:98` | 4 / 4 / 4 | 6 / 6 / 6 | 6 / 6 / 6 | 9 / 9 / 9 | 3 / 3 / 3 | 6 / 6 / 6 | 3 / 3 / 3 | 4 / 4 / 4 |
| `ScrollText — node_modules/lucide-react/dist/esm/createLucideIcon.mjs:16` | 4 / 4 / 4 | 6 / 6 / 6 | 6 / 6 / 6 | 9 / 9 / 9 | 3 / 3 / 3 | 6 / 6 / 6 | 3 / 3 / 3 | 4 / 4 / 4 |
| `Search — node_modules/lucide-react/dist/esm/createLucideIcon.mjs:16` | 6 / 6 / 6 | 9 / 9 / 9 | 7 / 7 / 7 | 11 / 11 / 11 | 4 / 4 / 4 | 7 / 7 / 7 | 4 / 4 / 4 | 4 / 4 / 4 |
| `SeatChip — apps/web/src/app/FlightDeck.tsx:867` | 24 / 30 / 24 | 48 / 60 / 48 | 24 / 24 / 24 | 48 / 48 / 48 | 24 / 24 / 24 | 24 / 24 / 24 | 24 / 24 / 24 | 0 |
| `SectionBand — apps/web/src/features/worklist/work-folds.tsx:82` | 12 / 12 / 12 | 12 / 12 / 12 | 0 | 0 | 0 | 0 | 0 | 0 |
| `SessionDraftRef — apps/web/src/features/terminal/AgentPanel.tsx:192` | 4 / 4 / 4 | 6 / 6 / 6 | 6 / 6 / 6 | 9 / 9 / 9 | 3 / 3 / 3 | 6 / 6 / 6 | 3 / 3 / 3 | 4 / 4 / 4 |
| `SessionNeedsYou — apps/web/src/features/issues/IssueCompactControls.tsx:215` | 4 / 4 / 4 | 4 / 4 / 4 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `SessionRow — apps/web/src/app/FlightDeck.tsx:1059` | 178 / 130 / 178 | 350 / 255 / 350 | 172 / 172 / 172 | 344 / 344 / 344 | 172 / 172 / 172 | 172 / 172 / 172 | 172 / 172 / 172 | 0 |
| `SessionWatchers — apps/web/src/features/terminal/SessionWatchers.tsx:58` | 4 / 4 / 4 | 6 / 6 / 6 | 6 / 6 / 6 | 9 / 9 / 9 | 3 / 3 / 3 | 6 / 6 / 6 | 3 / 3 / 3 | 4 / 4 / 4 |
| `SidebarRow — apps/web/src/features/worklist/sidebar-measurements.tsx:47` | 2 / 2 / 2 | 2 / 2 / 2 | 0 | 0 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `SidebarUnified — apps/web/src/features/worklist/SidebarUnified.tsx:149` | 1 / 1 / 1 | 1 / 1 / 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| `SnoozedIssueFold — apps/web/src/features/worklist/work-folds.tsx:427` | 4 / 4 / 4 | 4 / 4 / 4 | 0 | 0 | 0 | 0 | 0 | 0 |
| `SortableTab — apps/web/src/app/Workspace.tsx:1527` | 2 / 2 / 2 | 3 / 3 / 3 | 2 / 4 / 2 | 3 / 6 / 3 | 2 / 2 / 2 | 2 / 2 / 2 | 2 / 2 / 2 | 0 |
| `Square — node_modules/lucide-react/dist/esm/createLucideIcon.mjs:16` | 4 / 4 / 4 | 6 / 6 / 6 | 4 / 4 / 4 | 6 / 6 / 6 | 2 / 2 / 2 | 4 / 4 / 4 | 2 / 2 / 2 | 3 / 3 / 3 |
| `SquareTerminal — node_modules/lucide-react/dist/esm/createLucideIcon.mjs:16` | 4 / 4 / 4 | 6 / 6 / 6 | 4 / 4 / 4 | 6 / 6 / 6 | 2 / 2 / 2 | 4 / 4 / 4 | 2 / 2 / 2 | 3 / 3 / 3 |
| `StateLabel — apps/web/src/app/FlightDeck.tsx:646` | 239 / 226 / 239 | 478 / 452 / 478 | 239 / 239 / 239 | 478 / 478 / 478 | 239 / 239 / 239 | 239 / 239 / 239 | 239 / 239 / 239 | 0 |
| `StateMark — apps/web/src/app/FlightDeck.tsx:568` | 239 / 226 / 239 | 478 / 452 / 478 | 239 / 239 / 239 | 478 / 478 / 478 | 239 / 239 / 239 | 239 / 239 / 239 | 239 / 239 / 239 | 0 |
| `StatusGlyph — apps/web/src/features/issues/issue-glyphs.tsx:103` | 529 / 462 / 529 | 854 / 747 / 854 | 353 / 353 / 353 | 678 / 678 / 678 | 353 / 353 / 353 | 353 / 353 / 353 | 353 / 353 / 353 | 28 / 28 / 28 |
| `TaskCostSection — apps/web/src/features/cost/TaskCostSection.tsx:288` | 4 / 4 / 4 | 4 / 4 / 4 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `TaskRow — apps/web/src/app/FlightDeck.tsx:1513` | 239 / 226 / 239 | 478 / 452 / 478 | 239 / 239 / 239 | 478 / 478 / 478 | 239 / 239 / 239 | 239 / 239 / 239 | 239 / 239 / 239 | 0 |
| `Textarea — apps/web/src/components/ui/textarea.tsx:5` | 8 / 8 / 8 | 10 / 10 / 10 | 7 / 7 / 7 | 10 / 10 / 10 | 4 / 4 / 4 | 7 / 7 / 7 | 4 / 4 / 4 | 5 / 5 / 5 |
| `TranscriptCold — apps/web/src/features/chat/TranscriptCold.tsx:61` | 4 / 4 / 4 | 6 / 6 / 6 | 4 / 4 / 4 | 6 / 6 / 6 | 2 / 2 / 2 | 4 / 4 / 4 | 2 / 2 / 2 | 3 / 3 / 3 |
| `TranscriptFeed — apps/web/src/features/chat/TranscriptFeed.tsx:244` | 4 / 4 / 4 | 6 / 6 / 6 | 6 / 6 / 6 | 9 / 9 / 9 | 3 / 3 / 3 | 6 / 6 / 6 | 3 / 3 / 3 | 4 / 4 / 4 |
| `TranscriptStandby — apps/web/src/features/chat/TranscriptStandby.tsx:112` | 0 | 0 | 2 / 2 / 2 | 3 / 3 / 3 | 1 / 1 / 1 | 2 / 2 / 2 | 1 / 1 / 1 | 1 / 1 / 1 |
| `TranscriptTail — apps/web/src/features/chat/TranscriptTail.tsx:203` | 4 / 4 / 4 | 6 / 6 / 6 | 4 / 5 / 4 | 6 / 7 / 6 | 2 / 2 / 2 | 4 / 4 / 4 | 2 / 2 / 2 | 3 / 3 / 3 |
| `Unfilled — apps/web/src/features/usage/Unfilled.tsx:15` | 4 / 4 / 4 | 4 / 4 / 4 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `UnifiedRow — apps/web/src/features/issues/IssuePanelView.tsx:194` | 114 / 114 / 114 | 114 / 114 / 114 | 27 / 27 / 27 | 27 / 27 / 27 | 27 / 27 / 27 | 27 / 27 / 27 | 27 / 27 / 27 | 27 / 27 / 27 |
| `UnreadDot — apps/web/src/components/UnreadMark.tsx:12` | 59 / 50 / 59 | 116 / 98 / 116 | 57 / 57 / 57 | 114 / 114 / 114 | 58 / 58 / 58 | 58 / 58 / 58 | 58 / 58 / 58 | 1 / 1 / 1 |
| `UserPlus — node_modules/lucide-react/dist/esm/createLucideIcon.mjs:16` | 2 / 2 / 2 | 3 / 3 / 3 | 1 / 1 / 1 | 2 / 2 / 2 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 0 |
| `Users — node_modules/lucide-react/dist/esm/createLucideIcon.mjs:16` | 6 / 6 / 6 | 9 / 9 / 9 | 7 / 7 / 7 | 11 / 11 / 11 | 4 / 4 / 4 | 7 / 7 / 7 | 4 / 4 / 4 | 4 / 4 / 4 |
| `VoiceButton — apps/web/src/features/chat/VoiceButton.tsx:15` | 4 / 4 / 4 | 6 / 6 / 6 | 6 / 6 / 6 | 9 / 9 / 9 | 3 / 3 / 3 | 6 / 6 / 6 | 3 / 3 / 3 | 4 / 4 / 4 |
| `WhereTheWorkWent — apps/web/src/app/FlightDeck.tsx:2097` | 2 / 2 / 2 | 3 / 3 / 3 | 1 / 1 / 1 | 2 / 2 / 2 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 0 |
| `WorkRowShell — apps/web/src/features/worklist/WorkRowShell.tsx:86` | 2 / 2 / 2 | 2 / 2 / 2 | 0 | 0 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `WorkerLabel — apps/web/src/lib/WorkerLabel.tsx:140` | 202 / 154 / 202 | 375 / 280 / 375 | 180 / 182 / 180 | 353 / 356 / 353 | 180 / 180 / 180 | 180 / 180 / 180 | 180 / 180 / 180 | 6 / 6 / 6 |
| `WorkingMarkCell — apps/web/src/lib/motion/WorkingMark.tsx:36` | 2 / 2 / 2 | 2 / 2 / 2 | 0 | 0 | 0 | 0 | 0 | 0 |
| `WorklistMeasureLayout — apps/web/src/features/worklist/worklist-motion-layout.tsx:124` | 815 / 815 / 815 | 815 / 815 / 815 | 0 | 0 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| `WorklistMotion — apps/web/src/features/worklist/worklist-motion.tsx:11` | 1 / 1 / 1 | 1 / 1 / 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| `Workspace — apps/web/src/app/Workspace.tsx:229` | 2 / 2 / 2 | 3 / 3 / 3 | 2 / 2 / 2 | 3 / 3 / 3 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 0 |
| `X — node_modules/lucide-react/dist/esm/createLucideIcon.mjs:16` | 3 / 3 / 3 | 4 / 4 / 4 | 3 / 5 / 3 | 4 / 7 / 4 | 3 / 3 / 3 | 3 / 3 / 3 | 3 / 3 / 3 | 1 / 1 / 1 |
| `fastComponent — node_modules/@base-ui/utils/esm/fastHooks.js:14` | 1343 / 1199 / 1343 | 2001 / 1777 / 2001 | 724 / 724 / 724 | 1384 / 1384 / 1384 | 716 / 716 / 716 | 722 / 722 / 722 | 716 / 716 / 716 | 64 / 64 / 64 |
| `forwardRef callback@17 — node_modules/lucide-react/dist/esm/Icon.mjs:17` | 880 / 773 / 880 | 1629 / 1412 / 1629 | 807 / 809 / 807 | 1565 / 1568 / 1565 | 772 / 772 / 772 | 805 / 805 / 805 | 772 / 772 / 772 | 58 / 58 / 58 |

</details>

### Session-switch longest task: measured composition

This table clips the same V8 intervals again to each recording’s single longest top-level task. Columns are per-sample values, not independent medians, so sampled categories sum to that task’s wall duration within rounding. The observer is removed from product costs using the same trace-anchored walk intervals.

| Pilot / sample | Task wall ms | Prefix wall ms | Prefix observer ms | React render | React commit/layout | React passive | MobX reactions | Other MobX | GC | Observer | Other/idle |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| OFF 0 | 747.1 | 324.4 | 131.9 | 518.2 | 42.7 | 8.6 | 1.1 | 0.0 | 22.3 | 33.6 | 120.7 |
| OFF 1 | 750.3 | 366.2 | 58.5 | 513.9 | 47.0 | 8.9 | 2.2 | 1.1 | 21.3 | 32.9 | 123.0 |
| OFF 2 | 765.0 | 295.8 | 18.3 | 535.1 | 42.8 | 8.1 | 0.0 | 0.6 | 26.6 | 30.6 | 121.1 |
| ON 0 | 838.6 | 330.1 | 119.1 | 382.9 | 112.5 | 109.8 | 34.4 | 9.3 | 52.0 | 51.1 | 86.7 |
| ON 1 | 769.9 | 962.1 | 598.5 | 368.0 | 95.6 | 87.1 | 25.8 | 12.6 | 47.2 | 53.0 | 80.6 |
| ON 2 | 1,093.5 | 291.8 | 0.0 | 448.1 | 136.9 | 126.6 | 36.0 | 11.2 | 150.3 | 69.0 | 115.5 |

#### session-switch OFF inside the longest task

Top five self costs in the task.

| Function — declaration file:line | Mean self ms | Mean inclusive ms |
| --- | ---: | ---: |
| `archivedSessionsForIssue — packages/client-core/src/viewmodels/session-ownership.ts:333` | 127.2 | 156.6 |
| `sessionView — packages/client-core/src/session-values.ts:94` | 45.8 | 45.8 |
| `archivedSessionsForIssue / sessions.filter callback@341 — packages/client-core/src/viewmodels/session-ownership.ts:341` | 29.1 | 29.5 |
| `deriveIssueViews — packages/client-core/src/replica/issue-views.ts:303` | 27.0 | 35.2 |
| `IssuePanelView — apps/web/src/features/issues/IssuePanelView.tsx:825` | 25.7 | 43.5 |

Top five application inclusive costs in the task.

| Function — declaration file:line | Mean self ms | Mean inclusive ms |
| --- | ---: | ---: |
| `FlightDeckContent — apps/web/src/app/FlightDeck.tsx:3013` | 11.8 | 358.7 |
| `measureWork — apps/web/src/app/mission-pane-perf.ts:12` | 1.4 | 220.9 |
| `measureLegacyMission — apps/web/src/app/mission-pane-perf.ts:36` | 0.0 | 220.9 |
| `archivedSessionsForIssue — packages/client-core/src/viewmodels/session-ownership.ts:333` | 127.2 | 156.6 |
| `<anonymous@1243> / intent.press callback@1245 — apps/web/src/app/FlightDeck.tsx:1245` | 0.0 | 115.6 |

#### session-switch ON inside the longest task

Top five self costs in the task.

| Function — declaration file:line | Mean self ms | Mean inclusive ms |
| --- | ---: | ---: |
| `(garbage collector)` | 83.2 | 83.2 |
| `deriveIssueViews — packages/client-core/src/replica/issue-views.ts:303` | 27.5 | 38.1 |
| `sessionView — packages/client-core/src/session-values.ts:94` | 25.8 | 25.8 |
| `commitHostUpdate — node_modules/react-dom/cjs/react-dom-client.production.js:8725` | 25.4 | 54.3 |
| `modelsFor — packages/client-core/src/replica/issue-view-cache.ts:203` | 24.9 | 107.8 |

Top five application inclusive costs in the task.

| Function — declaration file:line | Mean self ms | Mean inclusive ms |
| --- | ---: | ---: |
| `AgentPanel — apps/web/src/features/terminal/AgentPanel.tsx:208` | 0.4 | 110.8 |
| `useIssueModelsSelection — packages/client-core/src/replica/use-issue-views.ts:65` | 0.0 | 108.1 |
| `useIssueModelsSelection / useCallback callback@72 — packages/client-core/src/replica/use-issue-views.ts:72` | 0.4 | 108.1 |
| `useReplicaIssues — apps/web/src/app/store.tsx:186` | 0.0 | 108.1 |
| `useAllIssueViewModels — packages/client-core/src/replica/use-issue-views.ts:96` | 0.0 | 108.1 |


### Profiler arming proof and recording validity

The same 4× mission targets and both reader arms were used for a separate one-sample-per-arm control at **`98a0eabbbeeb6f0e7f308a00042a8eed6ef0eac6`**. `profileBusyLoop` (`apps/web/harness/full-screen-click-profile.browser.ts:12`) runs after the trusted input mark and plants 200 ms before the app handles the mission click. It is visible in both source-mapped CPU recordings and lies entirely inside each input-to-Paint window.

| Arm | Loop trace interval ms | Loop sampled self ms | Loop sampled inclusive ms | Self rank | Control wall ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| OFF | 200.118 | 109.965 | 200.195 | 5 | 1,902.776 |
| ON | 200.039 | 104.391 | 195.313 | 4 | 1,935.274 |

Inclusive loop attribution approximately matches the planted duration; self excludes native/child work in the loop. The control proves that CDP CPU profiling was armed before trusted input and the measured window includes the planted work. The loop and listener were reverted before the clean capture; all 24 retained traces have no plant marks or sampled loop function. Control files are excluded from every result above.

The analyzer and evidence checks verify one input/feed mark, one expected-DOM mark, a qualifying main-renderer Paint, matching gate/analyzer wall time, same SHA, 24 distinct retained records, actual reader startup modes, interleaved order, and complete clipped CPU coverage. Exclusive sampled categories partition both each wall window and each longest-task window within floating-point precision. Rendered-instance totals equal the summed complete component lists. Both contexts preserve the fixture census and target shapes, and the collector checked empty fixture/page error lists. The requested interval is 1,000 µs; observed retained interval medians are 1,073–1,148 µs with occasional gaps up to 22.031 ms. These remain sampled elapsed-time estimates, not CPU-cycle or invocation counts.

Focused measurement-harness typecheck: **green** on flatblock at candidate `2c1e74e826555a68777f22d85b6fc518d5286cc8`: `bun run typecheck -- --filter @podium/web --only -- -p harness/tsconfig.full-screen-profile.json`, one task successful, 7.946 seconds. This is a focused compiler check, not the lean gate or full suite. Product files and the standard gate/baseline are unchanged; no product test sweep or speed-gate promotion is part of this measurement issue.

### Post-fix reproduction and evidence

```bash
# Same pinned, checkout-local setup on flatblock; caller owns the capture lease.
podium lock acquire bench:flatblock --wait --ttl 20m --timeout 3h
# Use an EXIT trap to release immediately, including on capture failure.
bun apps/web/harness/full-screen-click-profile.ts --profile=all --interleave --pool-readers --lease-confirmed
podium lock release bench:flatblock

# Offline, after releasing the lease:
bun apps/web/harness/full-screen-profile-analyze.ts --profile=all
bun apps/web/harness/full-screen-profile-analyze.ts --profile=mission-switch-plant \
  --build-dir=.artifacts/full-screen-click-profile/control-build

# The one focused compiler check, from the repository root:
bun run typecheck -- --filter @podium/web --only -- -p harness/tsconfig.full-screen-profile.json
```

To reproduce the arming control, use the recorded control SHA with `--profile=mission-switch --interleave --pool-readers --lease-confirmed`, preserve its build as `control-build`, then switch to the clean captured SHA and run the four-action command. The control has one retained sample per arm; the clean capture has three. The optional flags leave the landed gate and fixture untouched.

The report and **Post-fix CPU profiles and traces** archive are attached to POD-5327. The archive `.artifacts/full-screen-click-profiles-7a05ddf5.tar.gz` contains all 24 original CPU profiles, clipped and source-named companions, 24 Chrome/Perfetto traces, action records, component function coordinates, interleaved manifest, complete `analysis.json`, two matching arming-control recordings/maps, production assets/maps, capture log/audit, verification results and offline table-generation scripts. A small Git bundle preserves the captured/control/analysis commits with prerequisite base `ef9fd79799988d0aee49eaa9543775bdbdde1d76`. Raw/generated evidence is not committed. Import CPU files in Chromium DevTools and traces in DevTools or Perfetto; locate `speed:input`, `speed:dom` and `speed:commit:*`. `analysis.json` also records each longest task's absolute bounds and its exclusive partition/rankings.
