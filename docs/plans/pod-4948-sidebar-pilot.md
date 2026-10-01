# Sidebar pilot data contract

POD-4948 is the opt-in sidebar pilot under POD-4286. The existing sidebar, rows, menus, drag interactions and writes stay in place; the startup switch defaults off. POD-4953 supplies the row and section facts on the existing `IssueModel` and resident pool indexes. It does not turn on the switch or add another runtime, replica, outbox or mutation owner.

## Temporary feed input

`packages/client-graph/src/shared/temporary-issue-input.ts` is the single declared temporary adapter until POD-4949 supplies normalized homes. The normalized projection owns durable issue facts. The retained issue record supplies only `readAt`, `tuckedAt`, `pinned`, `gitState`, `repoPath` and `commentCount`; the adapter translates `asked`/`intentOrigin`/`isDraftVessel` to the compatibility payload's question/origin/draft spellings. Replacing these six inputs with their new homes changes this one file. Normalized dependency edges are indexed at the feed boundary; target completion is a small declared boolean summary, and edge removal remembers its owner.

Every row read still goes through `MobxPool.row`. Cold facts answer `LOADING` and schedule a batched load. The pool does not call legacy worklist selectors. A plain `IssueModel.sidebar` getter reuses the existing cached groups; `pool.sidebar` exposes section, worktree roster and selection facts over resident indexes. `SidebarState` carries caller-owned project order, pins, persisted collapse and pane selection without reading storage.

## Field inventory

The legacy sources were rechecked in `apps/web/src/features/worklist`, `useUnifiedWork`, `useReplicaIssues` and `packages/client-core/src/viewmodels/slices/worklist`. Colour tokens, ref formatting, timer formatting, status copy, glyph drawing, row styles and event handlers remain in the existing components. `harness/src/oracle/sidebar.ts` imports the exact legacy derivations exclusively for parity checks.

In the test column, **corpus** means `arms/mobx/pool/sidebar.test.ts` at 1x and 4x; **gate** means its observed three-seed, 200-change-per-seed gate; **R3** means the existing round-three row-view gate. The generator's `issueFacts` and `sessionFacts` mutations vary the previously constant inputs, with all eight variants forced in each sidebar gate seed.

| Value the real sidebar reads | Legacy source | Pool source | Test |
| --- | --- | --- | --- |
| ID square number/ref | `UnifiedIssueRow`: `issue.seq`, `issue.displayRef`; `useReplicaIssues` repo prefix | `IssueModel.seq`, `displayRef`; `sidebar.idNumber` | corpus, gate, R3 |
| ID square colour | `issue.color`; tokens in component | `sidebar.color` from projection | corpus, gate `issueFacts` |
| Title and draft placeholder | `issueDisplayTitle`, `sessionsForIssueNav`, session name/kind | existing `IssueModel.title`/label group | corpus, gate `sessionFacts`, draft-title test |
| PhaseTimer phase, anchor, accumulated time | `rowMotionPhase`, `rowMotionTiming` over own/nested sessions and decisions | existing attention aggregate; `sidebar.timing` | corpus, gate `sessionFacts`, R3 |
| WorkingMark | `rowHasWorkingSession` | existing `IssueModel.working` | corpus, gate, R3 |
| Merge/review decision | `rowPendingDecision`, `issuePendingDecision`; working/continuation suppression | existing own attention; `sidebar.decision` | corpus, gate, awaiting-merge tests |
| Merge commit count | `issue.gitState.ahead` when merge decision | `sidebar.mergeCommits`, temporary git input | corpus, gate `issueFacts` |
| Status line | `rowStatusLine`, continuation, issue workflow fields, mission rollup, unstarted draft sessions | `sidebar.issue`, `continuation`, `progress`, `fromChildren`, `awaitingFirstPrompt`, own/aggregate sessions; formatting remains in row | corpus, gate (actual legacy formatter on payload) |
| RowProgressMeter distributions | `missionRollup.progress`: done/run/review/stall/block/wait/total | existing `unitOwn`/`unitsBelow` composition; `sidebar.progress` | corpus, gate, rollup tests |
| Child-derived meter | `missionRollup.fromChildren` | `sidebar.fromChildren` | corpus, gate |
| GitStamp branch, parent branch, shared/merged/ahead/dirty state | `useReplicaIssues` projection branch plus retained `gitState` | `sidebar.issue.branch/parentBranch`, `sidebar.gitState` | corpus, gate `issueFacts` |
| Unread emphasis | replica `unread` and `subtreeUnread` against root cursor, suppressed while working | existing cursor lane + aggregate timestamps; `sidebar.unread` | corpus, gate `issueFacts`/`sessionFacts`, reader tests |
| Agent-error line | `rowErrorLine`, first errored present session, suppressed when finished | `sidebar.errorClass`, aggregate session payload; copy remains in row | corpus, gate `sessionFacts` |
| Spin-off origin tick | `useUnifiedWork`/`legacyOriginTick`: discovered-from target ref/title/seq | existing `IssueModel.originTick`, normalized dep index | corpus, gate, R3 |
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
| Pinned band | `worklistSlice.pinned`, root `splitPinnedWork` | existing pinned index, root filter in `sidebar.sections` | corpus, gate `issueFacts` |
| Project bands and order | slice `groups/sections`, `orderProjectItems`/`orderedSidebarProjects` with saved aliases | existing group + worktree lanes, `SidebarState.projectOrder/pinnedRepos` | corpus, gate |
| Empty project with StartFirstTaskRow | registered repos without unified work | `SidebarBand.startFirstTask` | corpus, gate |
| Snoozed fold | `group.snoozedRows`, defer deadline | `SidebarBand.snoozedIds`, existing band index | corpus, gate `issueFacts`/clock |
| Closed fold with Archive | `group.closedRows`, `rowInClosedFold` | existing closed index + latch; `SidebarBand.closedIds`; Archive action stays existing | corpus, gate, groups tests |
| Persisted band/fold collapse | `usePersistedBool` keys: pinned/project/snoozed/closed | `SidebarState.collapsed`, band keys/verdicts (same defaults) | corpus, gate |
| Closed-row fold latch | `useUnifiedWork` selection-at-click latch | existing `WorklistGroups` selected fold latch | groups tests, sidebar selection test |
| Eviction recovery | `useUnifiedWork` previously seen selection absent from current models | `sidebar.selectionEvicted`, cold known rows preserved; existing action clears selection | cold/eviction test |
| Worktree roster rows | `worklistSlice.work`, `UnifiedWorktreeRow`: retained unrepresented seats per lane | `sidebar.worktree`, declared worktree/session relations and owner summaries | corpus, gate |
| Worktree branch/label/path | nav worktree from repo discovery | feed worktree lane fields | corpus, gate discovery |
| Worktree session order, visible/stale partition | `sortSessionsForSidebar`, `partitionStaleSessions` | `SidebarWorktree.sessions/visible/stale` | corpus, gate, roster test |
| Worktree activity and selection | `row.activityAt`, selected worktree and paneA | `SidebarWorktree.activityAt/active`; paneA stays caller data | corpus, gate, roster test |

## Validation and counts

All validation runs on flatblock in `~/podium-test-4953`, with the pinned Bun toolchain and a WIP commit before each run. New checks are first exercised against a copied-aside planted mistake, then restored with `cp`. The prototype's package config is included. No operator live data or browser interaction is involved in this data-contract change.

The pre-change census at `30180e6a0` is green at 1x and 4x, including both write-layer variants. Counts below are per visible issue row, as the census reports them (not per resident row).

| Checkpoint | Scale | Computeds before | Reactions before | Computeds after | Reactions after |
| --- | --- | ---: | ---: | ---: | ---: |
| Startup | 1x | 18.23 | 3.74 | pending | pending |
| First paint | 1x | 19.61 | 3.82 | pending | pending |
| Startup | 4x | 18.18 | 3.75 | pending | pending |
| First paint | 4x | 18.64 | 3.77 | pending | pending |

The pre-change work-per-change gate is green for all sixteen scenarios at both sizes, for the pool, its windowed list and both write-layer variants. Final parity, sensitivity and after counts are recorded here when validation completes.
