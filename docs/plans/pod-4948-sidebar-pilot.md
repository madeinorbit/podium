# Sidebar pilot data contract

POD-4948 is the opt-in sidebar pilot under POD-4286. The existing sidebar, rows, menus, drag interactions and writes stay in place; the startup switch defaults off. POD-4953 supplies the row and section facts on the existing `IssueModel` and resident pool indexes. It does not turn on the switch or add another runtime, replica, outbox or mutation owner.

## Temporary feed input

`packages/client-graph/src/shared/temporary-issue-input.ts` is the single declared temporary adapter until POD-4949 supplies normalized homes. The normalized projection owns durable issue facts. The retained issue record supplies only `readAt`, `tuckedAt`, `pinned`, `gitState`, `repoPath` and `commentCount`; the adapter translates `asked`/`intentOrigin`/`isDraftVessel` to the compatibility payload's question/origin/draft spellings. A cleared normalized ask clears stale legacy text. Replacing these six inputs with their new homes changes this one file. Normalized dependency edges are indexed at the feed boundary; target completion is a small declared boolean summary, and edge removal remembers its owner. As in the replica, blocking uses server-truth target stages during optimistic edits.

The feed also declares a small raw-session summary: owner ID and two activity timestamps. Replica unread includes parked resume twins that disappear from the roster; continuation recency includes exited own sessions. The summary holds no full session records and updates only affected owners. Resident row/index readers continue to use the one pool reader. POD-4952's unscanned persisted repo fallback remains in feed snapshots and replacements.

Every row read still goes through `MobxPool.row`. Cold facts answer `LOADING` and schedule a batched load. The pool does not call legacy worklist selectors. `IssueModel.sidebar` is a cached group on the one existing issue object. It borrows the feed issue/session records and overlays the cursor, unread verdict and display ref; it creates no second record or row object. Timer anchors, fleet totals and error facts compose through the existing attention aggregate, so a clock redraw does not re-walk the subtree sessions. `pool.sidebar` exposes section, worktree roster and selection facts; `SidebarState` carries caller-owned project order, pins, persisted collapse and pane selection without reading storage.

Root pinned/open/snoozed/closed lanes are maintained by the existing issue filing reaction. The same reaction supplies represented/excluded/finished ownership and retained unowned-seat claims to `worklist/sidebar-roster.ts`. Existing ingest/relation deltas maintain resident fallback-seat IDs, project-root IDs, project lane counts and sorted roster paths. There is no new per-issue or per-session reaction. A two-field cold-lane summary (`path`, `possible`) requests the existing batched reader only while unresolved; cold IDs do not enter the resident roster indexes. Forward clock ticks update only due fallback seats; clock rewind recomputes their retention. Per-project caches keep unrelated roster paths out of a changed band's work.

## Field inventory

The legacy sources were rechecked in `apps/web/src/features/worklist`, `useUnifiedWork`, `useReplicaIssues` and `packages/client-core/src/viewmodels/slices/worklist`. Colour tokens, ref formatting, timer formatting, status copy, glyph drawing, row styles and event handlers remain in the existing components. `harness/src/oracle/sidebar.ts` imports the exact legacy derivations exclusively for parity checks.

In the test column, **corpus** means `arms/mobx/pool/sidebar.test.ts` at 1x and 4x; **gate** means its observed three-seed, 200-change-per-seed gate; **R3** means the existing round-three row-view gate. The generator's `issueFacts` and `sessionFacts` mutations vary the previously constant inputs, with all eight variants forced in each sidebar gate seed.

| Value the real sidebar reads | Legacy source | Pool source | Test |
| --- | --- | --- | --- |
| ID square number/ref | `UnifiedIssueRow`: `issue.seq`, `issue.displayRef`; `useReplicaIssues` repo prefix | `IssueModel.seq`, `displayRef`; `sidebar.idNumber` | corpus, gate, R3 |
| ID tooltip/external identifier | `useReplicaIssues`: formatted repo ref and normalized `linearIdentifier` | borrowed `sidebar.issue.displayRef/linearIdentifier` | corpus, gate `issueFacts`, ref plant |
| ID square colour | `issue.color`; tokens in component | `sidebar.color` from projection | corpus, gate `issueFacts` |
| Title and draft placeholder | `issueDisplayTitle`, `sessionsForIssueNav`, session name/kind | existing `IssueModel.title`/label group | corpus, gate `sessionFacts`, draft-title test |
| PhaseTimer phase, anchor, accumulated time | `rowMotionPhase`, `rowMotionTiming` over own/nested sessions and decisions | existing attention aggregate; `sidebar.timing` | corpus, gate `sessionFacts`, R3 |
| WorkingMark and asking verdict | `rowHasWorkingSession`, `rowWaitingCount` | existing `IssueModel.working/asking`; `sidebar.working/asking` | corpus, gate, R3 |
| Merge/review decision | `rowPendingDecision`, `issuePendingDecision`; working/continuation suppression | existing own attention; `sidebar.decision` | corpus, gate, awaiting-merge tests |
| Merge commit count | `issue.gitState.ahead` when merge decision | `sidebar.mergeCommits`, temporary git input | corpus, gate `issueFacts` |
| Status line | `rowStatusLine`, continuation, issue workflow fields, root-only mission rollup, unstarted draft sessions | `sidebar.issue`, `continuation`, `progress`, `statusFromChildren`, `awaitingFirstPrompt`, own/aggregate sessions; formatting remains in row | corpus, gate (actual legacy formatter on payload) |
| RowProgressMeter distributions | `missionRollup.progress`: done/run/review/stall/block/wait/total | existing `unitOwn`/`unitsBelow` composition; `sidebar.progress` | corpus, gate, rollup tests |
| Child-derived meter | `missionRollup.fromChildren` | `sidebar.fromChildren` | corpus, gate |
| GitStamp branch, parent branch, shared/merged/ahead/dirty state | `useReplicaIssues` projection branch plus retained `gitState` | `sidebar.issue.branch/parentBranch`, `sidebar.gitState` | corpus, gate `issueFacts` |
| Unread emphasis | replica `unread` and `subtreeUnread` against root cursor, suppressed while working | existing cursor lane + aggregate timestamps; `sidebar.unread` | corpus, gate `issueFacts`/`sessionFacts`, reader tests |
| Agent-error line | `rowErrorLine`, first errored present session, suppressed when finished | `sidebar.errorClass`, aggregate session payload; copy remains in row | corpus, gate `sessionFacts` |
| Spin-off origin tick | `SidebarUnified.originById`/`legacyOriginTick`: discovered-from target ref/raw title/seq | `sidebar.originTick` through existing normalized dep relation and one reader; prototype `IssueModel.originTick` retains its display-title contract | corpus, gate, R3 |
| Fleet glyph kind/order and parked verdict | `IssueFleetSummary`: `deriveFleetPresence` over aggregate sessions | `sidebar.fleet.tiles` | corpus, gate `sessionFacts` |
| Fleet totals, parked count, native subagents | `deriveFleetPresence`: present seats, awake native counts | `sidebar.fleet.total/parkedCount/nativeCount` | corpus, gate `sessionFacts` |
| Internal badge | `issue.audience === 'agent'` | `sidebar.internal` | corpus, gate `issueFacts` |
| Unsnoozed mark | `issueReturnedFromDefer` | `sidebar.unsnoozed`, existing deadline clock | corpus, gate `issueFacts`/clock |
| Deferred dim treatment | `isIssueDeferred`, folded row presentation | `sidebar.deferred`, existing band/fold verdicts | corpus, gate `issueFacts`/clock |
| Tuck chip and bring-back eligibility | `rowAwaitsTuck`, `rowCanBringBack`, 24h grace, needsHuman, asking, merge state | `sidebar.awaitsTuck/canBringBack`; selected/fold verdicts remain caller context | corpus, gate `issueFacts`/clock, folds |
| Own session order/coordinator | `useUnifiedWork`: `sortSessionsForSidebar`, coordinator first | existing own attention session payload | corpus, gate `sessionFacts` |
| Aggregated nested sessions | row construction own + ordered visible subtree | existing attention composition | corpus, gate, rollup tests |
| Draft vessel click target and active selection | `draft && !worktreePath && sessions.length`; first own session/paneA | `sidebar.draftAgentOnly/firstSessionId`, `pool.sidebar.active` | corpus, gate, selection test |
| Compatibility issue content | `useReplicaIssues` model: question, origin, workflow, git, read/tuck/pin/repo/comment fields | `sidebar.issue` from normalized adapter and cursor lane | corpus, gate, adapter test |
| Parent relationship and menu eligibility | `useReplicaIssues.parentId`; `issueMenuEligibility.canSetColor` permits root issues | borrowed `sidebar.issue.parentId` from projection | corpus, gate reparent, exact redraw fence |
| Pinned band | `worklistSlice.pinned`, root `splitPinnedWork` | maintained root pinned lane, `sidebar.sections.pinnedIds` | corpus, gate `issueFacts`, root plant |
| Project bands and order | slice `groups/sections`, `orderProjectItems`/`orderedSidebarProjects` with saved aliases | maintained project/group/roster paths, `SidebarState.projectOrder/pinnedRepos` | corpus, gate |
| Empty project with StartFirstTaskRow | registered repos without unified work | `SidebarBand.startFirstTask` | corpus, gate |
| Snoozed fold | `group.snoozedRows`, defer deadline | `SidebarBand.snoozedIds`, existing band index | corpus, gate `issueFacts`/clock |
| Closed fold with Archive | `group.closedRows`, `rowInClosedFold` | existing closed index + latch; `SidebarBand.closedIds`; Archive action stays existing | corpus, gate, groups tests |
| Persisted band/fold collapse | `usePersistedBool` keys: pinned/project/snoozed/closed | `SidebarState.collapsed`, band keys/verdicts (same defaults) | corpus, gate |
| Closed-row fold latch | `useUnifiedWork` selection-at-click latch | existing `WorklistGroups` selected fold latch | groups tests, sidebar selection test |
| Eviction recovery | `useUnifiedWork` previously seen selection absent from current models | `sidebar.selectionEvicted`, cold known rows preserved; existing action clears selection | cold/eviction test |
| Worktree roster rows | `worklistSlice.work`, `UnifiedWorktreeRow`: retained unrepresented seats per lane | `sidebar.worktree`, resident candidate index, declared worktree/session relations and owner summaries | corpus, gate, represented-roster plant, expiry/rewind |
| Worktree branch/label/path | nav worktree from repo discovery | feed worktree lane fields | corpus, gate discovery |
| Worktree session order, visible/stale partition | `sortSessionsForSidebar`, `partitionStaleSessions` | `SidebarWorktree.sessions/visible/stale` | corpus, gate, roster test |
| Roster session ref, name, attribution, outcome, colour, draft/snooze and agent status | `PanelRow`/`WorkerLabel` session payload | borrowed resident `SidebarWorktree.sessions`, same payload on issue rosters | corpus, gate `sessionFacts` |
| Worktree attached issue ref and orphan provenance | `UnifiedWorktreeRow`: `useReplicaIssues` owner lookup; missing owner falls back to birth `session.displayRef` | `SidebarWorktree.issues` contains only retained roster owners through the one reader; missing-owner session retains birth ref | corpus, gate, roster test |
| Worktree activity and selection | `row.activityAt`, selected worktree and paneA | `SidebarWorktree.activityAt/active`; paneA stays caller data | corpus, gate, roster test |

## Validation and counts

All validation runs on flatblock in `~/podium-test-4953`, with Bun 1.4.2 and a WIP commit before each run. New checks are first exercised against a copied-aside planted mistake, then restored with `cp`. The prototype's package config is used. Browser evidence uses only the synthetic corpus and a private StoreProvider fixture; operator live data stays on ludovico.

Field parity at `472dbd2e3` is green for the full 1x/4x corpus and three observed seeds of 200 changes. Each seed applies all eight issue-fact and all eight session-fact variants. All 28 row values, 28 compatibility-issue inputs, 21 session-content inputs, roster owners/partitions and section fields are compared with the actual legacy derivations. The rollup and group checks are green at `7097dc3ea` (10 tests); the remaining five sidebar adapter/cold/selection/roster/expiry tests also passed there. The expiry check was first red at `7c9146af8` after removing the fallback deadline publication: the expired last seat remained in its band. Restoring with `cp` passes the forward and backward clock assertions.

Planted defects also made the new checks fail for incorrect row facts, sections, motion, normalized input precedence, progress, attention invalidation, composed fleet totals, ref/external identifier, parent/menu facts and represented-roster membership. In particular, `d1959e7df` caught 1,464 ref/identifier field differences, `c36c0926e` caught missing root lanes and `de37ea73a` caught extra represented-owner worktree rows. The exact redraw fence now compares the complete payload at every feed publication, including optimistic paint and rollback; its new transient-publication check was red with that collection disabled (`b050568ac`) and green after restoration (`32665cf4d`). No redraw or scaling allowance was relaxed.

The pre-change census at `30180e6a0` is green at 1x and 4x, including both write-layer variants. Counts below are per visible issue row, as the census reports them (not per resident row).

| Checkpoint | Scale | Computeds before | Reactions before | Computeds after | Reactions after |
| --- | --- | ---: | ---: | ---: | ---: |
| Startup | 1x | 18.23 | 3.74 | pending | pending |
| First paint | 1x | 19.61 | 3.82 | pending | pending |
| Startup | 4x | 18.18 | 3.75 | pending | pending |
| First paint | 4x | 18.64 | 3.77 | pending | pending |

The pre-change work-per-change gate is green for all sixteen scenarios at both sizes, for the pool, its windowed list and both write-layer variants. Final parity, sensitivity and after counts are recorded here when validation completes.
