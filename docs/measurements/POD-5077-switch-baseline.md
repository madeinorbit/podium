# POD-5077 — switch baseline and main-pane read inventory

Measured 2026-10-01 for POD-5087, at pilot tree `aa2b06005457d6c06e4e506f46682bbcce1c2ec2`. **No product code changed.** The deliverable is this report; collectors, profiles, traces, source maps and count files are attached to POD-5087 as `switch-baseline-evidence.tar.gz`.

The pool sidebar does not make a large mission switch cheap. With the ordinary production React renderer, the 362-row mission took **623.6–623.7 ms** from the trusted click to the two-animation-frame paint marker; the 135-row mission took **366.0–370.8 ms**. Single-row missions took **83.7–144.4 ms**. FlightDeck's row work, mounting/committing the large tree, and its synchronous brief geometry measurement dominate. Navigation and issue-chip work are smaller, but still read the legacy world.

**Both questioned APIs execute as consequences of the click.** `getBoundingClientRect` synchronously forces layout in FlightDeck's brief layout effect. IndexedDB `getAll` is an asynchronous **outbox** read for durable cursor staging, not a reload of the issue/session entity store. The trace does not support blaming a corpus-sized IndexedDB entity `getAll` for these switches.

## What was measured

This is an isolated real Chromium page on flatblock, not a Node timing loop and not the operator's running server. It mounts production `SidebarUnified`, a mission-keyed `FlightDeck`, `Workspace`, and `RightDock` with its issue tab, inside the real focus/explorer, store and pool providers. The shared engine navigation, selectors, viewmodels, DOM/CSS, IndexedDB adapter and durable kernel outbox are production implementations. The issue branch was created from `integrate/4286-pilot`; its product tree was unchanged throughout capture.

| Input | Value |
| --- | --- |
| Corpus | Canonical `buildCorpus(1, 1)`; 4,867 issues; 4,304 input sessions / **4,302 runtime sessions** after deduplication |
| Other corpus dimensions | 485 discovery repos; 468 worktrees; 9 logical repo rows; 2,969 parent edges; 3,539 `startedBySession` records; maximum depth 6 |
| Sidebar | Startup URL `mobxSidebar=1`; runtime mode asserted **pool**; 193 mounted issue-row nodes at the initial viewport |
| Browser | Headless Chromium **153.0.8010.12**, 1,800 × 1,000 viewport, reduced motion |
| Toolchain | Checkout-local frozen install; Bun **1.4.2**; flatblock's own `.toolchain`; no shared `node_modules` tree |
| Build | Vite production build, source conditions, source maps, no minification; ordinary renderer for headline timing and ordinary CPU trace |
| Timing | Six actual sidebar targets, six warm-up switches, then 12 retained ordinary-renderer switches: two visits per target, alternating large and small missions |
| Attribution | Separate ordinary-renderer run: six retained switches, CPU sampling interval **1,000 μs**, timeline and UserTiming; measurement-only helper wrappers and boundary stacks |
| Render attribution | Separate production **profiling-renderer** run: 12 switches, 100 μs sampling, four React Profiler subtrees; these durations are labelled separately below |
| Persistence | Fresh real browser IndexedDB `switch-baseline`, canonical seed installed before mount; real outbox staging/transactions |
| Clock | Corpus time anchored at 2026-09-20 12:00 UTC and **advancing with performance.now**; repeated visits receive distinct read timestamps |
| RPC/feed | RPC answers are synthetic; transcript/comments/events/cost answers are empty. Network/feed disabled. No operator server or daemon was restarted or reconfigured. |

The fixture includes the requested hot panes, rather than all AppShell routes, top chrome, resizable-column wrappers and every dock tab. The session panes execute their real lifecycle and chat paths against empty transcript replies; this is not a measurement of a long transcript, a live daemon/PTY attach, or remote request latency. A separate full-issue-page fixture is described below. These are controlled client baselines, not a claim that every operator switch has the same latency.

The click marker is captured by a document capture listener on the actual sidebar row. Two successive `requestAnimationFrame` callbacks provide the paint proxy; Chromium's timeline supplies actual layout/paint events. The collector watches the following 550 ms after Playwright's click returns, waits for IndexedDB to settle, and then records the state/counters. `lastPaint` is the last double-RAF scheduled by a DOM mutation in that observation window. It is **not** a settled-latency metric: timers, effects and animations can move it. No p95 is estimated from two samples per target, and large/small missions are not averaged together.

Early development/frozen-clock probes were diagnostic only. Their warmed visits often rebuilt no issue models because the cursor timestamp was identical. They are excluded from the headline baseline. A 100 μs ordinary-renderer trace attempt timed out; only the successful 1,000 μs capture is used for ordinary CPU attribution. All runs reporting new timings were foreground, bounded by `timeout`, on flatblock under `bench:flatblock`; each owned server/browser was closed by its recorded process handle. The lease was released after capture.

## Ordinary production switch times

| Actual clicked id | Full deck rows | Retained click → two-RAF samples (ms) | Rectangle calls per switch | IndexedDB `getAll` calls |
| --- | ---: | ---: | ---: | ---: |
| `i1884` | 362 | 623.7, 623.6 | 10, 11 | 1, 1 |
| `i3777` | 135 | 366.0, 370.8 | 11, 11 | 1, 1 |
| `i2979` | 1 | 144.4, 124.9 | 8, 8 | 1, 1 |
| `i4646` | 1 | 88.1, 92.9 | 6, 6 | 1, 1 |
| `i1313` | 1 | 90.2, 83.7 | 6, 6 | 1, 1 |
| `i4301` | 1 | 97.2, 114.6 | 8, 8 | 1, 1 |

Evidence: `timing-production-ordinary/samples.json` and `analysis.json`. The selected ids and runtime session-pane ids are recorded for every sample. The two largest **mounted selectable** roots were selected by their full deck size; the other four have one deck row. This is a size comparison, not random corpus sampling.

### Where the click-window CPU goes

This table uses the **separate ordinary-renderer trace**, bounded from `baseline:click` to its first two-RAF marker. A sample belongs to the nearest identifiable screen/engine source frame; shared viewmodel calls inherit that frame. Native rectangle calls have their own layout bucket. The remaining React/library, GC, native/program and fixture work is retained explicitly. CPU buckets sum to the observed interval; they are not added to timeline or React Profiler totals.

| Exclusive sampled source bucket (ms) | 362-row switch | 135-row switch | One-row `i4646` switch |
| --- | ---: | ---: | ---: |
| Sidebar/pool, including its handler | 6.4 | 6.1 | 6.4 |
| Shared engine navigation and its called derivations | 10.6 | 13.5 | 6.5 |
| Workspace/FlightDeck and their called derivations | 87.4 | 45.7 | 15.3 |
| Issue page/dock/shared issue controls | 26.0 | 36.7 | 15.8 |
| Session panes/header/chat, excluding chips | 8.0 | 6.7 | 4.7 |
| Issue chips | 2.5 | 1.1 | Below one sample |
| IndexedDB adapter JS | 5.2 | 0.7 | Below one sample |
| Native rectangle/layout time | 124.2 | 53.1 | 2.2 |
| React/framework/library work without a screen stack | 321.6 | 168.2 | 30.7 |
| Garbage collection | 41.6 | 17.7 | Below one sample |
| Native/program, other app/fixture and residual shared code | 103.3 | 61.7 | 11.8 |
| **Trace click → two-RAF marker** | **736.8** | **411.1** | **93.4** |

A 1 ms sample is too coarse to infer “zero” for a small bucket. Source attribution also cannot recover a pane owner once React is reconciling/committing without that component on the JS stack. The shared `IssueCompactControls` bucket includes controls rendered in the deck. The profiler cut below supplies actual subtree ownership; it is not a second additive accounting of these samples.

The matching timeline reports, before the same marker:

| Main-thread timeline event total (ms) | 362 rows | 135 rows | `i4646` |
| --- | ---: | ---: | ---: |
| Click/EventDispatch region | 638.5 | 356.5 | 84.8 |
| Style/update layout tree | 18.3 | 14.4 | 1.9 |
| Layout | 127.5 | 49.0 | 3.7 |
| PrePaint | 26.8 | 12.1 | 0.8 |
| Paint | 25.4 | 21.7 | 2.5 |

`EventDispatch` contains much of the render and forced layout: **do not sum these event totals**. The larger attribution wall values than the unprofiled 623.6/366.0 ms samples are capture overhead, not a product regression. Profiles include the script's before-click pointer setup, but analysis clips it out using the click mark. V8 emitted some negative time deltas; the analyzer sorts reconstructed absolute sample timestamps and integrates each interval once, then verifies that attributed time cannot exceed the wall span.

### Subtree ownership from the production profiling renderer

These are `actualDuration` sums for commits whose `commitTime` precedes the first paint proxy. Render excludes DOM commit/layout and can include work restarted by React. The profiling renderer itself adds work; these are useful for ownership, not ordinary-production latency estimates.

| React subtree | 362 rows, two captures (ms) | 135 rows, two captures (ms) | `i4646`, two captures (ms) |
| --- | ---: | ---: | ---: |
| Pool sidebar | 14.0, 14.6 | 14.0, 11.5 | 11.6, 12.1 |
| FlightDeck | **299.8, 276.6** | **130.5, 126.2** | 27.3, 19.5 |
| Workspace, including its session pane | 21.4, 18.2 | 22.8, 20.3 | 18.8, 11.4 |
| RightDock issue subtree | 37.2, 25.5 | 39.9, 43.6 | 25.2, 17.2 |

The evidence supports putting FlightDeck ahead of another sidebar-only optimization. It does **not** support treating mission derivation alone as the entire 624 ms: mounting/committing the large tree and synchronously measuring it remain substantial costs after a data-hook migration.

## The two boundary claims, with stacks

### IndexedDB

Every retained work-pane switch issued one `getAll` against **`outbox`**, returning nine queued records in these warmed fixtures. None issued `getAll` against the entity or metadata store in the click observation window. Initial seed/open hydration is outside the window.

Source-mapped production stack:

```text
IDBObjectStore.getAll [measurement wrapper]
IndexedDbSyncStore.rehydrateOutbox     packages/sync/src/adapters/indexeddb/store.ts:500
IndexedDbOutboxStore.read             packages/sync/src/adapters/indexeddb/store.ts:1181
Outbox.stage                         packages/sync/src/outbox/outbox.ts:1427
serialized staging continuation      packages/sync/src/outbox/outbox.ts:1377
```

The cause is the real sidebar read-mark action, with asynchronous staging between the top of the gesture and the request:

```text
createPoolWorkActions.selectIssue     apps/web/src/features/worklist/use-pool-unified-work.ts:32
markIssueRead                        packages/client-core/src/engine/actions.ts:1013
markRead / enqueueOverlayed          packages/client-core/src/engine/actions.ts:451
kernel outbox staging → outbox-store read → rehydrateOutbox → getAll
```

`rehydrateOutbox` opens an outbox-only readonly transaction (`store.ts:497`); the entity `getAll` belongs to full rehydration at `store.ts:779`, which did not run here. In the profiling capture, the first large/medium samples' getAll request-to-success intervals were 121.8/73.8 ms, while their JS enqueue duration rounded to 0.0 ms. That interval includes event-loop delay while the main thread renders and lays out; **it is not measured disk I/O or 121.8 ms of CPU**. The fixture does not measure server send/receipt/feed convergence.

### Rectangles and layout

The important synchronous stack is:

```text
Element.getBoundingClientRect [measurement wrapper]
readBriefMetrics                     apps/web/src/app/FlightDeck.tsx:2390
MissionBrief layout effect           apps/web/src/app/FlightDeck.tsx:2497
commitHookEffectListMount / commitHookLayoutEffects
React layout commit
```

`readBriefMetrics` reads the deck, brief and end rectangles at `FlightDeck.tsx:2390`, `:2392`, `:2393`. The first read in the large profiling capture spent **146.0 ms** synchronously inside `getBoundingClientRect`; the corresponding ordinary-renderer trace reports **127.5 ms of Layout** before the paint proxy. This is a forced layout on the switch's render/commit path, not a sidebar pointer-resize action.

Other captured callers include `use-transcript-scroll.ts:44`, chat minimap `chat.ts:65`, and, in the initial development/native-session probe, terminal `TerminalView.diagnosticSnapshot`, `proposeFitIn`, and `DomViewportSource.current`. Those are different lifecycle/layout readers. Workspace's resize-handle reads at `Workspace.tsx:1408` / `:1788` are present in source but were not the forcing caller in these switches. Raw full stacks, including async outbox frames, are preserved in each attribution `samples.json`; source maps accompany the profiles.

## Calls, cold computations, and corpus-sized work

The coordinator's repeated-call observation is confirmed; the implication that **each call** rebuilds a full mission index is refuted. `missionIssueIndex` already has a WeakMap plus same-row fallback (`mission.ts:910`), and membership/progress have slice-keyed memos (`:1008`). `useReplicaIssues` has a shared projection cache, too. Cursor optimism changes their inputs and causes fresh passes, but multiple consumers share those passes.

The successful ordinary trace's first large switch recorded three store publications, 2,407 subscriber wakes and 3,517 selector cache misses; the medium switch recorded 2,274 wakes / 3,411 misses. The store's `reactCommits` diagnostic was not wired to this fixture's Profiler callbacks; a value of zero there is not zero React commits. The raw publication keys and independent Profiler records are attached.

| Observation | 362-row switch | 135-row switch | Meaning |
| --- | ---: | ---: | --- |
| `archivedSessionsForIssue` invocations | 362 | 135 | Once per stable full deck row, even when the row has no archived session |
| Session candidates examined by that pass | **1,557,324** | **580,770** | Rows × 4,302 runtime sessions; `session-ownership.ts:334` filters the full slice |
| Full deck-row derivation | 1–2 calls per captured switch | 2 calls | `buildFlightDeckRows` still builds visible issue/children/session maps on entry |
| Mission index builds | 2 on first retained large visit; normally 4 across later client publications | Normally 4 | Separate raw/enriched issue slices and cursor generations; not one build per helper call |
| Membership/progress computations | 1 initially; normally 2 each | Normally 2 each | Shared cold computations, reused by callers within that generation |
| Issue view-model projection passes / constructed models | 1 / 6 initially; normally 2 / 12 | Normally 2 / 12 | Passes scan the projection world, but **do not construct 4,867 fresh models each time** |
| Per-render session indexes | 416 initially; up to 830 across the later large-switch publications | 334 | Includes fresh **partial** session arrays; not 830 full-corpus session scans |
| Issue-chip material scans | 3 initially; normally 6 | 6 | Whole 4,867-issue comparison per mounted chip consumer when the issue array changes |
| Issue-chip signature/lookup builds | 0 on these retained switches | 0 | Read timestamps are immaterial to the seven chip fields; existing selector reuses lookup/signature |

For the large **profiling** capture, wrapped archived roster filtering cost 39.0 ms on the first retained visit; full deck construction cost 6.7 ms. The one-time archived pass survives the other issue-only publications because FlightDeck reuses stable rows. The source of the multiplication is `FlightDeck.tsx:3338` calling `archivedSessionsForIssue` inside its row loop.

The shared per-row controls add another full-session filter: `IssueCompactControls.tsx:91` constructs a member-id Set and filters the full session slice. Its action/decision components subscribe to `sessions` and enriched issues. Moving only FlightDeck's top-level hooks would leave these legacy reads and subscriber fan-out alive; they belong to that screen's migration scope.

`missionRootFor` is formal parent walking. The **membership** derivation `missionIssueIds` separately includes the `startedBySession` provenance/absorption loop (`mission.ts:1093`, `:1126`). The pool sidebar's select handler walks parents (`use-pool-unified-work.ts:32–83`); this does not establish equivalent deck membership. Do not substitute the sidebar's nesting set for the deck's mission set without the screen parity check.

## Full issue page, separately

The primary work-switch mounts `IssuePanelView` in the dock. To cover `issue-page/*` at runtime as well as in the source inventory, a second fixture kept the real pool sidebar and selected-id engine action but replaced the work columns with **`IssuePage`**, passing the selected enriched row and corpus issue ordering as props. This isolates the page's switch/render/read costs; it is not a claim that the shipped work-sidebar gesture opens the full issue page.

After six warm-ups, six retained production **profiling-renderer** page switches took 302.1, 304.2, 76.6, 77.3, 78.6 and 78.1 ms for the same six target ids. In its separate attribution capture, full-page render through the first marker was **151.4 ms** for `i1884`, **105.7 ms** for `i3777`, and **27.7–48.7 ms** for the four single-row targets. Each page switch had **one outbox getAll and zero getBoundingClientRect calls**. The page still needs its own migration: parent/edge readers, member-session resolution, repo-mate pickers and label suggestions repeatedly consume the legacy issue/session world.

## Ludovico-only replay counts

A fresh export was read and replayed **only on ludovico**, using canonical replica-order session deduplication and the POD-4954 sidebar check. Only the following counts, positions and opaque ids were retained. No snapshot, titles, bodies, paths, diff values or private error text was transferred to flatblock or attached. The temporary export and raw export log were deleted after replay.

| Replay | Count |
| --- | ---: |
| Issues / enriched projection issues | 5,664 / 5,664 |
| Source sessions / runtime sessions | 5,047 / 5,037 |
| Compared sidebar sections / positions | 35 / 1,105 |
| Differences / pending loads | **0 / 0** |
| Non-archived/non-deleted parentless roots considered for deck ranking | 1,625 |

The next table is **offline count evidence**, not a private-data browser timing claim. It executes the current full-deck and archived-roster helpers once per selected root, on the replay's 5,037-session runtime slice. The biggest decks were ranked locally.

| Opaque issue id | Mission members | Deck rows / archived-helper calls | Session candidates | Archived matches |
| --- | ---: | ---: | ---: | ---: |
| `iss_133da723-a19a-4279-9497-679a22b1538f` | 668 | 648 / 648 | **3,263,976** | 9 |
| `iss_4fa0a407-df12-4542-9b62-9cf82d7c27e8` | 428 | 427 / 427 | **2,150,799** | 1 |
| `iss_ff1b7d50-ebfd-4d84-9c11-7f6b30ccfa41` | 315 | 315 / 315 | **1,586,655** | 0 |
| `iss_7849db93-a818-4460-9f49-538dd35b77d3` | 1 | 1 / 1 | 5,037 | 0 |
| `iss_17c5e387-2299-4464-8b17-aea2f95fbf45` | 1 | 1 / 1 | 5,037 | 0 |
| `iss_6ca3694b-0d1d-4cd1-add4-633f948fdeeb` | 1 | 1 / 1 | 5,037 | 0 |

These counts prove scale and current sidebar parity. They do **not** prove deck, issue-page, terminal-header or mobile parity. Each screen's side-by-side check must be extended to its semantics, including archived sessions, born-here/moved-on membership and typed edge visibility.

## Read inventory

Anchors below are to the measured pilot tree, not a moving integration head. `W` = `apps/web/src/`; `C` = `packages/client-core/src/`; `G` = `packages/client-graph/src/`. Every subscription in the named production files, their data hooks and the shared row/action controls is listed, along with pure viewmodel work consuming those reads. Test-support files are excluded. Prop-only issue-page files are included in the census rather than mistaken for new subscriptions.

Kinds: **R** = raw store/entity rows; **D** = computed value, index or viewmodel; **R←D** = scalar source fields read from an enriched issue-viewmodel prop, not directly from a raw store row; **L** = local UI/preference/transport state; **A** = action/API handle (not an entity read). A mixed selector is split in its inventory entry. In particular, `useReplicaIssues` is **D**, while AgentPanel's `s.issues` is **R**.

Pool answers: **P** = already declared row/relation/value for resident data; **C** = declared inputs exist but the screen-specific computation/parity still needs implementing; **S** = fields, relation/summary or entity kind still need declaring; **L/A** = local state, transport or existing mutation owner, not an entity replacement. “P” never permits a new peek caller or a whole-world scan: cold/absent input must return `LOADING` plus a batched load, or use a declared summary.

### Shared read seams and existing pool coverage

| Source / reader | Kind and legacy input | Pool answer today / migration constraint |
| --- | --- | --- |
| `W/app/store.tsx:172` `useReplicaIssueSources`; `:185` `useReplicaIssues` | R inputs `replica`, `issueProjections`, `issues`; D output `useAllIssueViewModels` | P for declared issue fields; **C/S** for the full screen model. This hook builds/shares enriched rows, dependency views, member ids and session summaries. |
| `C/replica/use-issue-views.ts:73`, `:96`; `issue-view-cache.ts:255`, `:329` | D `modelsFor` and `.all`; memo keyed on replica/projection/legacy inputs | Replace with addressed pool reads and declared computed values. Row reuse already exists; do not call the present path “all raw rows.” |
| `W/app/store.tsx:142` `useSession` | R `s.sessions`, D `sessionById(s.sessions).get(id)` | P addressed session and declared identity/status fields; **S** for the rest of SessionMeta used by panes/header. |
| `W/app/store.tsx:151` `useSessionDraft` | L `s.drafts[id]` | L local composer state; preserve one owner and addressed subscription. |
| `W/lib/use-persisted-ui-state.ts:36`, `:58` | L `s.uiState`, followed by addressed key reads/subscriptions for usePersistedUiValue/usePersistedUiState | L bounded preferences used by FlightDeck; no entity graph replacement. |
| `W/app/store.tsx:157` `useSessionExitKind` | D `s.replica.exitKind('session', id)` | S explicit exit/visibility answer. Missing, evicted/unshared and deleted must remain distinguishable. |
| `W/features/issues/use-issue-status-apply.tsx:39` / `:41`; `issue-lifecycle.tsx:84` | A update/close; R entire `sessions` for close guard; D member-id filter at `issue-lifecycle.tsx:55` | P issue/session membership inputs; C close eligibility; A writes unchanged. |
| `W/features/issues/issue-lifecycle.tsx:147`, `:248` | R `sessions` in single/bulk close dialogs; D unresolved-member checks | P/C addressed membership and lifecycle facts; S richer session/offer fields. The single dialog is mounted by these screens; bulk is a shared sibling reader. |
| `W/features/issues/IssueCompactControls.tsx:248`, `:345`, `:511`, `:521`, `:527` | A rename/trpc/update/close; R sessions, machines; D all issues and `issueSessions`/open sessions/action/placement/close guard | P/C membership and issue-stage inputs; S machines and richer action/offer fields; C placement needs declared provenance/typed edges, not an all-issue Map. Used by deck/dock rows. |
| `G/shared/schema.ts:133`, `:723`, `:932`, `:1057`, `:1118` | Pool currently has **issue, session, worktree, repo only** | No machine, message-record, pending-interaction, super-thread, activity/mail/cost or shipping-order entity is currently declared. |
| `G/shared/schema.ts:742`, `:791`, `:825`, `:835`, `:865`, `:873` | Issue fields; parent/children/tree/provenance/session/worktree/repo relations | P id/title/seq/stage/timestamps/cursors, archived/deleted, draft/pins/tuck, branches, coordinator/starter ids, compatibility deps and blocked input. **S** detail prose/labels/people/tracker/panel/full git fields and non-sidebar edge semantics. |
| `G/shared/schema.ts:944`, `:986`; `G/models.ts:579`, `:637`, `:661`, `:699` | Session subset; issue sidebar/facts/members/nested/progress values | P session id/issueId/cwd/kind/headless/status/archive/activity/read cursor, declared phase/timing/resume fields and offer.createdAt. C exact deck/issue-page values. S names/refs/machines/model configuration/condition/geometry/handover/complete offers and other pane metadata. |
| `G/shared/temporary-issue-input.ts:15` | Declared temporary legacy-record bridge | Old issue fields must continue through this one reader until POD-4949 retires it. Physical payload availability is not a declaration or permission to add another old-record reader. |

### Workspace

| Source / reader | Kind and what it reads/derives | Pool answer |
| --- | --- | --- |
| `W/app/Workspace.tsx:256` selector, fields at `:258` | R whole `sessions`, discovery `repos`; L selectedWorktree, selectedIssueId, fileTabs, dockShells, workspaces; D paneA and `s.workspaceKey()` | P addressed sessions/worktree/repo inputs; S pane metadata as above; L layout/file/dock mappings; **C engine workspace key** still resolves via legacy mission data. |
| Same selector `:256` | A closeFileTab, markSessionRead, open/promote/activate/close/move workspace tabs, split/close/focus pane, resize split | A preserve engine/outbox write ownership. |
| `Workspace.tsx:282` `useReplicaIssues` | D entire enriched issue world | P/C/S shared seam above; remove from switched screen. |
| `Workspace.tsx:287` activation draft; `:290` `readFirstTaskDraft`; `:291` operator focus | L addressed `uiState[FIRST_TASK_ACTIVATION_DRAFT_KEY]`, parsed launch draft and context focus | L bounded device/launch/focus state, not corpus entity derivation. |
| `Workspace.tsx:769`, `:770` | D `reposToViews(repos)`, flatten worktrees, resolve selected worktree | P worktree/repo rows and relation; C exact discovery-path fallback. |
| `Workspace.tsx:777`, `:780`, `:782`, `:785`, `:789` | D selected issue find; missionRootFor; missionIssueIds; filter all issues to members; focused issue find | C declared mission root/membership/focus computed with legacy absorption semantics. Sidebar `nested` alone is not a proved replacement. |
| `Workspace.tsx:812`, `:835`, `:836`, `:838` | L workspace layout; D full session Map, file-tab Map, session resolution for tabs | P addressed session ids; L file/layout maps; S session display/terminal metadata. |
| `Workspace.tsx:848`, `:862`, `:879` | D dock shell ids, tab models, coordinator role, all live non-shell session ids | P/C issue-session/coordinator relation; L dock mapping; C tab membership without corpus session filtering. |
| `Workspace.tsx:935`, `:948` | D pending first-task session existence; selectedMissionRoot/empty-draft eligibility | P/C addressed launch/membership facts; L launch state. |
| `Workspace.tsx:1039` tab focus; `:1569` SortableTab | R session prop issueId; D coordinator/session labels and tab flags; A renameSession | P/C identity/role; S display/model fields; A same owner. |
| `Workspace.tsx:1408`, `:1788` and layout helpers | L DOM geometry and pointer/resize state | No pool entity answer. These are layout reads; the captured forced read belongs to FlightDeck. |

### FlightDeck and its local row components

| Source / reader | Kind and what it reads/derives | Pool answer |
| --- | --- | --- |
| `W/app/FlightDeck.tsx:189` MissionAgentMenu; `:199` | R repos, machines; D repo/worktree host choices through reposToViews | P repo/worktree graph; S machines/host facts. |
| `FlightDeck.tsx:688` CrewCensus; `:1085` SessionRow | L coarseNow; D phase/timing over row sessions | P declared phase/timing inputs; C deck-specific census; use pool clock without a legacy slice derivation. |
| `FlightDeck.tsx:1075`, `:1093` SessionRow | A renameSession; L session-hover context | A/L no entity replacement. Display name/ref/model/offer fields from session props need S. |
| `FlightDeck.tsx:2459` MissionBrief; `:3011`, `:3020`, `:3037` | L persisted brief ratio, right panel, view and folds; preferences read through `W/lib/use-persisted-ui-state.ts` | L device preferences; keep bounded subscriptions. Geometry at `:2384`, `:2497` is separate from the entity pool. |
| `FlightDeck.tsx:2960` selector | R sessions, repos; L selectedIssueId, issueVisitBaseline; D paneA/paneB/split layout mirrors | P/C issue/session/worktree inputs; S session display facts; L selection/unread baseline/layout mirrors. |
| Same selector | A setSelectedWorktree, setSelectedIssueId, openSessionTab/AtTranscript, focusIssueSession, set/preferPanelMode, setView, markIssue/SessionRead, setIssueTucked, close/updateIssue, trpc | A keep the existing mutation/navigation owner. |
| `FlightDeck.tsx:2995`, `:2997` | D all enriched issues and allWorktreePaths from reposToViews | P/C graph; remove corpus-wide issue subscription and repeated map/filter work. |
| `FlightDeck.tsx:3001`, `:3010`, `:3019` | L operator focus, explorer current issue and development feature state | L focus/preferences; explorer's own legacy reads are listed below. |
| `FlightDeck.tsx:3066`, `:3067`, `:3074`, `:3078`, `:3089`, `:3094` | D selectedMissionRoot, root/row-status lookups; buildFlightDeckRows/stable row reuse; display titles; all-issue byId Map | C root, complete deck rows and titles. P resident relations are inputs; S missing session/detail fields. |
| `FlightDeck.tsx:3105`, `:3113`, `:3116`, `:3117`, `:3121` | D active session finds, mission membership, focus, progress and departures | C exact mission/progress/departure policy, including provenance and typed edge targets. |
| `FlightDeck.tsx:3133`, `:3169`, `:3197`, `:3202`, `:3210` | D mission session-name map; continuation, root roster/seat/presence/empty note | P/C identity/membership/presence; S full names, refs, continuation edge/detail fields. |
| `FlightDeck.tsx:3227`, `:3243`, `:3265`, `:3273`, `:3278`, `:3300`, `:3317` | D proposed/visible/folded rows, guide rails, lead issue set and ancestry | C deck computations over resident declared relations; no full-issue copy to recreate them. |
| `FlightDeck.tsx:3321`, `:3338`, `:3347` | D starter author session find; **archived sessions for each full row**; all mission session-id set | P issue.sessions includes archived/non-headless membership inputs; C indexed archived roster, preserving prefix and dedupe semantics. S session display data. |
| `FlightDeck.tsx:3358` | L useSessionDraft for root first prompt; D title/empty-note formatting | L composer; C/S title inputs. |
| `FlightDeck.tsx:3426`, `:3429`, `:3430`, `:3546`, `:3567`, `:3673`, `:3678` callbacks | R/D session/issue find, mission-root navigation, menu/current-title reads, continue/resume target | P addressed rows; C root policy; S richer session fields; A navigation/writes retained. These are read sites even when not executed by this switch. |
| `FlightDeck.tsx:3072`, `:3598` and mounted IssueCloseDialog | R sessions through useIssueStatusApply/useIssueCloseGuard/dialog; D close eligibility | P/C membership; S unresolved offer/lifecycle facts. |
| `W/features/issues/explorer/explorer-context.tsx:79`, `:89`, `:96`, `:110` | R sessions; L selectedIssueId/worktree and focus stack; D useReplicaIssues, selectedMissionRoot, missionIssueIds/resolveFocus | C shared root/membership/focus answer, rather than a fourth legacy spelling. |
| `W/app/RightDock.tsx:115`, `:128`, `:131` | R sessions, repos, shipOrders; L fileTabs/coarseNow; D paneA, enriched issues and resolveActiveWorktree; A trpc/selection | P/C worktree/session identity; **S shipping orders**; L file/layout; A writes. This enclosing reader exists even with the issue tab active. |

### IssuePanelView (work dock)

| Source / reader | Kind and what it reads/derives | Pool answer |
| --- | --- | --- |
| `W/features/issues/IssuePanelView.tsx:859` selector | R sessions, repos; A trpc/updateIssue/setPane/setView/setSelectedIssueId/markIssueRead/markSessionRead | P/C membership/worktrees; S full session fields; A same write owner. |
| `IssuePanelView.tsx:873`, `:877`, `:890`, `:894` | D enriched issues; issueForPanel id/session/cwd resolution; all-issue Map; allWorktreePaths | P addressed row; C exact panel/worktree fallback; S detail fields. |
| `IssuePanelView.tsx:900`, `:903` | D direct subIssuesOf and groupRelations | P declared children; C ordering/visibility; S full typed dependency relation policy and absent-target answers. |
| `IssuePanelView.tsx:921`, `:926` callbacks | D deckDestinationFor and issueSessions for open-in-deck | C formal/provenance destination and roster; A navigation remains shared. |
| `IssuePanelView.tsx:955`, `:987`, `:999` | D issueSessions, navigation/snoozed roster partitions, presenceNote, parent lookup, issueDisplayTitle | P/C membership/presence; S snooze, names, richer session and detail metadata. |
| `IssuePanelView.tsx:876`, InspectHead/IssueDecisionBand/IssueActionRow | R sessions and D all issues through shared status/action controls listed above | P/C eligibility; S machines/offers/detail fields. |
| `IssuePanelView.tsx:636` ProducedAndDeferred | L httpOrigin; A openFileInWorktree/openArtifact; R←D issue.panel artifacts/deferred, worktree/repo/machine data | S panel/detail declarations; P worktree/repo identity; L/A transport and writes. |
| `IssuePanelView.tsx:356`, `:560`, `:889` | A trpc handle; R API comments/events and task-cost replies; D activity/cost views; R←D legacy embedded comments/activityNotes/notesUpdatedAt fallback | S activity/comment/cost summary/kinds if these become pool data. Currently API-owned lazy reads; not an IndexedDB entity read. |
| Rendering helpers in `IssuePanelView.tsx:273`, `:1010` onward | R←D description, activity notes, panel, gitState, parentId, closedReason/archive/coordinator, timestamps/title/worktree/repo; D meter, refs, session labels | P stage/identity/cursor/membership subset; **S prose/panel/full git/detail fields**. Meter and presence need C, rather than raw IssueWire. |

### Full issue page: composition, model, every production `issue-page/*` file

| Source / reader | Kind and what it reads/derives | Pool answer |
| --- | --- | --- |
| `W/features/issues/IssuePage.tsx:71`, `:79`, `:90`, `:155` | D useIssuePageModel; eviction/close guards; repoMatesOf for page commands; R←D addressed issue prop | P/C/S model below. Local compose/edit/close/Escape state is L; commands are A. |
| `issue-page-model.ts:94`, `:110` | R sessions; D all enriched issues; L hub; A trpc/navigateToSession/update/delete/close/defer/undefer/setLabels/restore | P addressed membership inputs; S detail schema; A/L same owner/transport. |
| `issue-page-model.ts:124`, `:139`, `:165`, `:201`, `:221`, `:258` | R←D embedded comments; R lazy comments/mail/subject-paged events; L hub.onIssues; D buildActivityFeed | S activity/mail/message/event entity or explicit page summary; preserve lazy subject narrowing, not a replica-wide event scan. |
| `issue-page-model.ts:261`, `:265` | D memberSessionIds.map → sessions.find for each id; subIssuesOf | P declared member session/child inputs; C exact membership order/filter; S session detail fields. |
| `issue-page-model.ts:273`, `:298`, `:304`, `:312`, `:322` | R API merge style; D repoMatesOf (filter/sort), mateOptionsOf, assigneeOptionsOf (pure helper), labelPoolOf | P repo relation inputs; S people/labels fields and declared cold-data suggestion summary. `assigneeOptionsOf` is an exported helper, not an extra subscription. |
| `issue-page/IssueProperties.tsx:106`, `:115`, `:116`, `:117`, `:120` | R sessions/machines; D enriched issues/edge resolver/member sessions via sessionById; R API merge style; A trpc/navigate | P/C membership; S machines, session detail, edge exit/visibility policy and setting summary as appropriate. |
| `IssueProperties.tsx:130`, `:131`, `:132`, `:133`, `:143` | D repo mates/byId/options, whole-issue label pool; sessions.filter(refIssueId born here, now elsewhere, not archived) | P repo/current membership; **S refIssueId/born-here relation and labels/summary**; C moved-on semantics. |
| `IssueProperties.tsx:155` onward | R←D type/priority/labels/estimateMin/dueAt/deferUntil/parent/worktree and parent/member ids; D property options/format | P deferUntil/parent/worktree subset; S type/priority/labels/estimates/dueAt. |
| `issue-page/IssueDetailHeader.tsx:65`, `:66`, `:67` | D useReplicaIssues/parent find, motionPhase/working/waiting over member session props; R←D title/stage/branch/closed/childCount/member ids/linearUrl | P parent/basic status; C child counts/session census; S tracker/full session metadata. |
| `issue-page/issue-edges.tsx:114`, `:122`, `:127` | R replica handle; D exitKind('issue',id), all enriched issues Map and resolveIssueEdge | P resident addressed target; **S declared pending/evicted/deleted/unshared exit semantics**, without fabricating deletion for an absent row. |
| `issue-page/use-eviction-guard.ts:54`, `:58`, `:66` | D all issues and addressed id-presence checks | S explicit scope/eviction state plus Loading behavior; presence in a partial pool cannot mean revoked permission. |
| `issue-page/IssueBanners.tsx:91` | D edge resolver; R←D deletedAt/supersededBy/duplicateOf/suggestedStage/suggestedReason and needs-human props | P deleted/basic needs-human; C lifecycle; S continuation/suggestion/human-question fields and typed target relations. |
| `issue-page/IssueRelations.tsx:60`, `:61`, `:67` | D edge resolver/groupRelations; R←D dependencyNote/blockedByNotes and dependency targets/types | S all relation types and target visibility/Loading; C grouping and labels. Existing sidebar discovered-from relation alone is insufficient. |
| `issue-page/IssueSessionsBlock.tsx:132`, `:135` | D edge resolver and issue.sessionSummary.total; R session/member/moved-on props and session label/state/model/offer fields | P/C membership/current phase; S born-here relation, summary and full session/offer fields. |
| `issue-page/IssueSubIssues.tsx:150`, `:151` | R sessions through status close guard; D confirmedWorkingAgentCountsByIssue(subIssues,sessions,now); R←D childCount/childDoneCount and child props | P child/member inputs; C direct child ordering, counts and action policy; S child detail fields. |
| `issue-page/IssueAgentActivity.tsx:55`, `:69`, `:70`, `:75` | L httpOrigin; A file/artifact actions; R←D panel artifacts/deferred, createdBy, machineId, repo/worktree | S panel/attribution/machine fields; P repo/worktree subset. |
| `issue-page/IssueNow.tsx:52`, `:62` | No store hook. R member session props; D motionPhase/motionTiming, sorting and working/waiting census | P phase/timer subset; C page census; S session display/machine/model metadata. |
| `issue-page/IssueBody.tsx:37`, `:87`, `:125`, `:164`, `:235`, `:264` | No store hook. R←D title, description, brief, timestamps, status flags/origin/audience and dynamic design/acceptance/notes fields; D date/status formatting; L editing | P title/time/status/audience; S prose/long-form/origin declarations; C formatting. |
| `issue-page/IssueAbout.tsx:69` ABOUT_ROWS | No store hook. R←D createdBy/origin/audience/owner/visibility; D attribution phrases | P audience; S creation/owner/visibility fields. |
| `issue-page/IssueGitBlock.tsx:33`, `:48`, `:49`, `:82`, `:106` | No store hook. R←D worktreePath, branch, **full gitState**, parentBranch and prUrl; D IssueGitScope rendering | P worktree/branch and sidebar merge-axis subset; S complete git state, parent branch and PR fields. |
| `issue-page/IssueActivity.tsx:70`, `:297`, `:332`, `:336` | No store hook. R API mail/comment/event props; R←D activityNotes/notesUpdatedAt; D feed/time formatting; L disclosure/composer focus | S activity/mail/notes declarations; A posting remains existing owner. |
| `issue-page/IssueParentRow.tsx:62`, `:78` | No store hook. R←D parentId/owner and resolved parentEdge props; D cross-owner confirmation/provenance | P parent input; S owner/visibility and edge semantics. |
| `issue-page/NeedsHumanBanner.tsx:29` | No store hook. R←D asked/humanQuestion/humanQuestionAskedBy/needsHuman and timestamps; D question attribution | P needsHuman; S full asked/question/attribution fields. |
| `issue-page/issue-page-menu.ts:58` configuration/helpers | No store hook. R←D archived/deleted/pinned/branch/linearIdentifier/linearUrl; D action eligibility/ref; A provided commands | P archive/delete/pin/branch; S tracker fields; C eligibility. |
| `issue-page/issue-provenance.ts:1`, `AttributionPair.tsx:1` | No store hook. R←D creator/provenance pair props; D labels and metadata pairing | S provenance/attribution declarations. |
| `issue-page/DateProperty.tsx:1` | No store hook. R←D addressed date/estimate props; D date choices/format; L custom-edit state | S due/estimate where undeclared; P defer input. |
| `issue-page/property-chrome.tsx:1`, `chrome.tsx:1` | No store hooks or row lookups. Prop renderers/constants/local controls | L/A; no hidden entity reader. |

### Session panes and the actual chat/header composition

There is no separate store-reading ChatHeader in this tree. `ChatView` owns transcript/composer content; the shared session header is inline in **AgentPanel** (`AgentPanel.tsx:881`). Its model/machine/effort pickers have the additional API data hooks listed here.

| Source / reader | Kind and what it reads/derives | Pool answer |
| --- | --- | --- |
| `W/features/terminal/AgentPanel.tsx:225` selector | R machines; L hub/uiState/selectedIssueId; A trpc/startBtw/setSessionDraft/hibernateSession/dismissOffer/sendChat/openFile/navigateToSession | S machines; L transport/prefs/focus; A unchanged mutation owner. |
| `AgentPanel.tsx:245`, `:249` | R addressed session and pending login session through useSession | P addressed identity/status subset; S pane/header metadata. |
| `AgentPanel.tsx:197` SessionDraftRef | L addressed draft via useSessionDraft | L composer state. |
| `AgentPanel.tsx:272`, `:273` | D !pendingSpawnIds.has(id); R/L pendingSpawnPrompts.get(id), held first-prompt local seed | S declared launch summary if made pool input; preserve optimism/launch owner, no second draft replica. |
| `AgentPanel.tsx:307`, `:310`, `:853` | **R s.issues**, ref-held array for native issue reference/color binding | P addressed issue/ref inputs; C declared resident reference lookup + cold summary. This intentionally avoids useReplicaIssues' session rollups. |
| `AgentPanel.tsx:312`; `W/lib/hooks/use-session-guard.ts:43`, `:52` | D scoped isSessionWorking via s.sessions.find; R whole sessions only for unscoped guard; A kill/archive/end | P addressed status; C scoped guard; A retained owner. |
| `AgentPanel.tsx:334` useHandoverView; `:352` usePanelSurface | R session prop handover, condition/driver/lifecycle facts; D arbitration | S richer session fields; C identical lifecycle precedence. useHandoverView itself adds no legacy store selector. |
| `W/features/terminal/use-panel-surface.ts:115`, `:138`, `:164` | R machines; L panelMode/uiState per-session and device defaults; R API roles.coding.startScreen; D chat/native/ended/parked/offline arbitration; A setPanelMode/trpc | S machines/condition/terminal-outlook/config fields; L preferences; C three-valued capability/lifecycle, not an absent-row guess. |
| `AgentPanel.tsx:575`; `use-terminal-appearance.ts:23`, `:26` | L uiState terminal appearance blob + its subscription; D parsed appearance | L device UI configuration. |
| `AgentPanel.tsx:618`, `:807`, `:842` | L terminal connection/viewport/mount state, hub transcript/input subscriptions; R session geometry and issue-reference inputs; D native runtime setup | S geometry/terminal metadata; L live terminal/transcript transport stays outside a new replica. |
| `AgentPanel.tsx:881`, `:902`, `:1184` header | R session props name/ref/agentKind/machine/model/effort/snooze/condition/offer; D sessionDisplayName and runtime choices; L machine connectivity and local menus | P kind/status/activity subset; **S names/refs/machine/model/config/snooze/complete offer fields**. |
| `W/lib/ModelEffortPicker.tsx:121`, `:164`, `:218`; `C/react/use-model-catalog.ts:129`; `C/react/use-harness-descriptors.ts:80` | A trpc selector; R API models.catalog/machines.descriptors; D cached catalog/descriptors by machine/agent | S model/catalog/machine summary if pool owns these facts; no issue/session graph answer today. Writes stay existing actions. |
| `W/features/terminal/DockShellPanel.tsx:52`, `:65`, `:66`, `:67`, `:85` | R sessions/machines; L hub/dockShells/reposLoaded; A trpc/setDockShell/setDockVisibleSession; D mapped session find, machine name, pending session existence and dead/parked/alive | P addressed session status/worktree relation; S machines, names and terminal lifecycle fields; L mapping/loaded fence. |
| `DockShellPanel.tsx:120`, `:199` | R API shells.forWorktree return; D session.machineName/id → machines.find fallback; A return-or-create shell | S machine/display facts; preserve idempotent write owner. |
| `DockShellPanel.tsx:220`, `:222`, `:225` DockShellTerminal | L terminal appearance/connection/viewport; **D useReplicaIssues** for native refs; R session.geometry prop | P/C addressed refs; S geometry/reference summary. Unlike AgentPanel, this still subscribes to enriched issue rows. |
| `W/features/terminal/SessionLifecyclePanes.tsx:74` | **A only** resurrectSession/killSession; R session prop; D exited/hibernated/offline/handover presentation, time/reason/restore eligibility | No direct entity-store subscription; S lifecycle/session fields; C states; A actions unchanged. |
| `W/features/chat/ChatView.tsx:195`, `:111`, `:217`, `:222` | D useChatSurface; L draft; D pendingInteractions.some(session,status asked); D all enriched issue rows for refs | S pending-interaction kind/declared addressed summary; C reference lookup; remove all-issue dependency. |
| `W/features/chat/use-chat-surface.ts:241` selector | R machines/superThreads; L hub/replica/httpOrigin/attachedSessionId/transcriptReveal; A trpc/setDraft/sendChat/chatSendsFor/discard/dismiss/panelMode/openFile/tldr/getUserFocus/clearAttached/clearReveal | S machines/super-thread summary; L transport/reveal/focus; A retain existing write/outbox owner. `chatSendsFor` is also a read port, listed below. |
| `use-chat-surface.ts:265`, `:266`, `:280`, `:296`, `:728` | R addressed session/attached session; D replica session exit kind, chatSessionReference and machines.find/session label | P session identity; S exit/scope/machine/full header metadata; C partial-world referent behavior. |
| `use-chat-surface.ts:270`, `:554` imperative storeHandle.getSnapshot | **R raw issues.find(id).seq** callback; L drafts[id] initial composer seed | P addressed seq; L draft. Switching the hook while leaving these callbacks would leave legacy reads alive. |
| `use-chat-surface.ts:352`, `:395`, `:437`, `:457`, `:534`, `:655` | L transcript controller/reveal; D pendingAskFromState, selected super thread/all-thread id Set; R pendingInteractions.find for current question | S interaction/thread summaries and richer session ask/offer fields; L transcript transport/controller. |
| `W/features/chat/useTranscriptWindow.ts:181`, `:209` | R lazy sessions.transcriptRead reply; D bounded transcript controller snapshot/blocks/live tail | Transport/lazy history, not legacy entity-list reads. No pool transcript entity is declared; do not create a second transcript runtime/replica. |
| `W/features/chat/use-chat-send.ts:277`, `:284`, `:321`, `:322`, `:362` | R chatSendsFor(id), message records and held outbox sends via conversation ports; D addressed conversation controller snapshot; L draft | S message-record/session-delivery summary; preserve existing outbox mutation owner and conversation controller. |
| `C/conversation/store-ports.ts:42`, `:51`, `:66`, `:67` | R getSnapshot().messageRecords → filter(sessionId); D chatSendsFor(id); L outboxDeadLetters subscription trigger | S messageRecord kind/addressed relation or summary; A/L existing durable queue. No current pool equivalent. |
| `W/features/chat/IssueChipLiveness.tsx:15`, `:27`, `:34` | D useReplicaIssues, selector.select(issues), layout-effect decorateIssueRefAnchors/MutationObserver | P title/seq/stage/archive/delete + repo prefix; C addressed/resident ref lookup and Loading summary for unseen references. |
| `W/features/chat/issue-chip-refs.ts:75`, `:77`, `:111` | D whole-array material comparison of prefix/seq/displayRef/stage/archive/deletedAt/title, signature and lookup | P declared issue/repo inputs; C leaf/addressed reference computed. Immaterial array replacements still scan; they do not rebuild signature/lookup. |

This inventory separates entity facts from local layout, drafts, transport and action handles. It does not authorize extending the pool by reading legacy IssueWire directly. Rich issue fields and relations must be declared before a screen uses them; all row reads go through the pool's one reader, resident indexes stay resident-only, cold records need summaries, and absent records produce `LOADING` plus a batched load.

## Proposed per-step targets

These are proposed acceptance budgets for the coordinator, not achieved results or a promise that data migration removes DOM cost. Compare using this same corpus, geometry, targets, ordinary renderer and advancing clock. Screen rollout still follows the required default-OFF startup switch, extended side-by-side check, private replay, zero switched-path legacy derivation counters, operator default-on decision, then deletion of that screen's fallback about a week later.

| Step / scope | Count/correctness target | Proposed performance target |
| --- | --- | --- |
| 01 navigation/read seam | One declared mission-root policy for engine/Workspace/explorer/mobile; zero legacy mission-root/index work on the switched path; preserve cold/empty/archived behavior | Engine/navigation attributed work ≤5 ms per synthetic target; no corpus scan needed to resolve one selected id |
| 02 Workspace/FlightDeck — first priority | Zero legacy mission/deck/session-roster derivations; archived roster work proportional to selected members/session edges, never deckRows × allSessions; exact absorption/departure/order parity including private large decks | Ordinary click → marker ≤450 ms for 362 rows, ≤260 ms for 135 rows, ≤90 ms for one-row targets; separately show DOM/layout remainder rather than crediting all savings to MobX |
| 03 header/status strip | Addressed issue/session facts; zero useReplicaIssues/full-session-list reads for header/status derivation; declare machines and missing configuration/lifecycle fields | ≤1 ms addressed data derivation per header; no regression of the ordinary switch wall samples |
| 04 issue page/dock | Zero enriched-issue-world reads; addressed parents/edges/members; typed target Loading/visibility preserved; repo-mate/label suggestions use resident indexes or declared summaries | Profiling subtree render ≤20 ms for the small dock target, ≤75 ms for large full-page target; repeat ordinary-renderer wall measurement before default-on |
| 05 session panes/chat/chips | Zero raw or derived all-issue reads, including imperative callbacks and native link binding; no chip whole-world material scans for a cursor-only change; message/interaction/thread reads declared; keep one transcript runtime and one outbox | ≤1 ms reference/header data work; zero chip signature/lookup/material rebuild on read-cursor change; measure long-transcript/native-attach cases separately before claiming their latency |
| 06 mobile screens | Screen-specific parity and private counts; identical formal/provenance mission policy; zero mobile legacy mission derivations; no second runtime/replica/outbox | Provisional ≤16 ms data work per navigation; set device wall budget from the first real-device baseline rather than extrapolating desktop browser times |
| 07 legacy deletion | Every migrated screen fallback removed after its rollout window; old viewmodels/slices/snapshot publish pipeline gone; zero legacy row builds/derivations for switch and feed | Re-run the ordinary browser targets; remove remaining legacy subscriber fan-out and show the residual pool/DOM/transport work |

Layout is an adjacent performance concern as well as a migration measurement. It is filed, unclaimed, as **POD-5104 FlightDeck brief layout flush**, with a `discovered-from` edge to POD-5087. Set a separate **≤20 ms forced-layout budget** on the largest switch and demonstrate that the brief measurement no longer synchronously forces a corpus-sized deck layout. A data-hook switch alone is not proof of that result. The private count evidence makes the indexed archived roster mandatory, even though its 39 ms synthetic filter cost is only one part of the current wall time.

Development React also reported duplicate issue keys for `i1884`, `i3777`, `i1313`. It caused no page exception in accepted captures; origin is not established. It is filed, unclaimed, as **POD-5101 Synthetic issue key duplicates**, with a `discovered-from` edge to POD-5087. Membership differences from sidebar-versus-deck provenance remain a mandatory screen parity case, not a product fix in this report.

## Evidence and verification

The issue artifact bundle contains the ordinary timing/trace, separate profiling-renderer work-pane and full-page samples, raw CDP `.cpuprofile`/`.trace.json`, corresponding source maps, the synthetic fixture/collector/analyzer, and the ludovico-safe count JSON. Open a timeline in Chrome DevTools or Perfetto; the UserTiming marks delimit the accepted window. The source-mapped stacks above can be checked against the unmodified measured tree.

The collector's pool-on guard was proven **red** on flatblock by copying the script aside, planting `mobxSidebar=0`, running the smoke probe, observing `pool sidebar not on`, and restoring the exact script. Accepted captures were pool-on and have zero page exceptions/fatal store errors. The analysis rejects a missing/duplicate click mark and intervals exceeding the wall span; its planted-mistake results are included in the evidence verification log.

The committed change is documentation only. No product tests, whole test lane, typecheck or lint were run: they would not validate a prose-only deliverable. Measurement/analysis checks are focused, and the final report/evidence consistency check runs in the isolated flatblock checkout. Private replay is the required ludovico-only exception, reports counts only, and leaves no raw export behind.
