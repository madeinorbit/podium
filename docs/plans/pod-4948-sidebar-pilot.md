# Sidebar pilot data contract

POD-4948 is the opt-in sidebar pilot under POD-4286. The existing sidebar, rows, menus, drag interactions and writes stay in place; the startup switch defaults off. POD-4953 supplies the row and section facts on the existing `IssueModel` and resident pool indexes. It does not turn on the switch or add another runtime, replica, outbox or mutation owner.

## Temporary feed input

`packages/client-graph/src/shared/temporary-issue-input.ts` is the single declared temporary adapter until POD-4949 supplies normalized homes. The normalized projection owns durable issue facts. The retained issue record supplies only `readAt`, `tuckedAt`, `pinned`, `gitState`, `repoPath` and `commentCount`; the adapter translates `asked`/`intentOrigin`/`isDraftVessel` to the compatibility payload's question/origin/draft spellings. A cleared normalized ask clears stale legacy text. Replacing these six inputs with their new homes changes this one file. Normalized dependency edges are indexed at the feed boundary; target completion is a small declared boolean summary, and edge removal remembers its owner. As in the replica, blocking uses server-truth target stages during optimistic edits.

The feed also declares a small raw-session summary: owner ID and two activity timestamps. Replica unread includes parked resume twins that disappear from the roster; continuation recency includes exited own sessions. The summary holds no full session records and updates only affected owners. Resident row/index readers continue to use the one pool reader. POD-4952's unscanned persisted repo fallback remains in feed snapshots and replacements.

Every row read still goes through `MobxPool.row`. Cold facts answer `LOADING` and schedule a batched load. The pool does not call legacy worklist selectors. `IssueModel.sidebar` is a cached group on the one existing issue object. It borrows the feed issue/session records and overlays the cursor, unread verdict and display ref; it creates no second record or row object. Timer anchors, fleet totals and error facts compose through the existing attention aggregate, so a clock redraw does not re-walk the subtree sessions. `pool.sidebar` exposes section, worktree roster and selection facts; `SidebarState` carries caller-owned project order, pins, persisted collapse and pane selection without reading storage.

Sessionless composition borrows the other branch's immutable facts and fleet instead of copying glyphs along every empty ancestor. `Residency.observe` creates a cold-row atom only inside a tracked derivation. Maintenance reads still go through the reader, but avoid immediately discarded atoms; observed cold reads retain their load and wake-up behavior.

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

The temporary and renamed issue inputs have the following individual homes. They enter the same borrowed `sidebar.issue` payload; the adapter owns their compatibility spellings.

| Input | Legacy source | Pool source | Test |
| --- | --- | --- | --- |
| `readAt` | retained per-user issue field, enriched by `useReplicaIssues`; pool cursor/write lane supplies optimistic mark-read | temporary adapter → existing cursor lane → `sidebar.issue.readAt` | corpus, gate `issueFacts`, reader/write checks |
| `tuckedAt` | retained per-user issue field through `useReplicaIssues` | temporary adapter → `sidebar.issue.tuckedAt` and tuck verdicts | corpus, gate `issueFacts`, adapter check |
| `pinned` | retained per-user issue field; `splitPinnedWork` | temporary adapter → root pinned lane and `sidebar.issue.pinned` | corpus, gate `issueFacts`, root plant |
| `gitState` | retained issue field; `issueAwaitingMerge` in `slices/issues.ts:348–438` | temporary adapter → `awaitingMergeOf`, `sidebar.gitState/issue.gitState` | corpus, gate `issueFacts`, adapter/merge checks |
| `repoPath` | retained issue field, then replica rich model and worklist grouping | temporary adapter → `sidebar.issue.repoPath` and group metadata | corpus, gate discovery/issue changes, adapter check |
| `commentCount` | retained issue record; replica rich model removes it | temporary adapter → `sidebar.issue.commentCount`; oracle explicitly borrows the retained record | corpus, gate `issueFacts`, adapter check |
| `humanQuestion` | replica rich issue field | normalized `asked.question` → adapter compatibility field | corpus, gate `issueFacts`, cleared-ask adapter check |
| `humanQuestionOptions` | replica rich issue field | normalized `asked.options` → adapter compatibility field | corpus, gate `issueFacts`, cleared-ask adapter check |
| `origin` | replica rich issue field | normalized `intentOrigin` → adapter compatibility field | corpus, gate `issueFacts`, adapter check |
| `draft` | replica rich issue field and draft-vessel predicate | normalized `isDraftVessel` → adapter compatibility field | corpus, gate `issueFacts`, adapter/selection checks |

## Validation and counts

All validation runs on flatblock in `~/podium-test-4953`, with Bun 1.4.2 and a WIP commit before each run. New checks are first exercised against a copied-aside planted mistake, then restored with `cp`. The prototype's package config is used. Browser evidence uses only the synthetic corpus and a private StoreProvider fixture; operator live data stays on ludovico.

Field parity at `1d7c83215` is green for all ten sidebar checks after the final immutable-constant lint fix: the full 1x/4x corpus, three observed seeds of 200 changes, adapter precedence, draft selection, cold/eviction recovery, roster provenance and forward/backward expiry. Each seed applies all eight issue-fact and all eight session-fact variants. All 28 row values, 28 compatibility-issue inputs, 21 session-content inputs, roster owners/partitions and section fields are compared with the actual legacy derivations. The two reader checks and the maintenance-probe check passed at `e57d1db425`; both overlay checks pass at `1d7c83215`. The rollup and group checks passed at `7097dc3ea` (10 tests). The expiry check was first red at `7c9146af8` after removing the fallback deadline publication: the expired last seat remained in its band. Restoring with `cp` passes the forward and backward clock assertions.

The empty-branch borrowing check was red at `357c91ac2` with the identity fast paths removed, then passed with all five composition checks at `5a8a80d274`. The cold-observer guard was red at `1babb3cc6` when removed, then passed at `e57d1db425`: 100 repeated absent/cold maintenance probes create zero atoms, while an observed cold row still answers `LOADING`, batches its load and wakes on hydration. Census attribution found and removed 15,629 temporary startup atoms at 1x and 61,236 at 4x before accepting the final counts.

Planted defects also made the new checks fail for incorrect row facts, sections, motion, normalized input precedence, progress, attention invalidation, composed fleet totals, ref/external identifier, parent/menu facts and represented-roster membership. In particular, `d1959e7df` caught 1,464 ref/identifier field differences, `c36c0926e` caught missing root lanes and `de37ea73a` caught extra represented-owner worktree rows. The exact redraw fence now compares the complete payload at every feed publication, including optimistic paint and rollback; its new transient-publication check was red with that collection disabled (`b050568ac`) and green after restoration (`32665cf4d`). No redraw or scaling allowance was relaxed.

The pre-change census at `30180e6a0` is green at 1x and 4x, including both write-layer variants. Counts below are per visible issue row, as the census reports them (not per resident row).

| Checkpoint | Scale | Computeds before | Reactions before | Computeds after | Reactions after |
| --- | --- | ---: | ---: | ---: | ---: |
| Startup | 1x | 18.23 | 3.74 | 15.99 | 3.26 |
| First paint | 1x | 19.61 | 3.82 | 17.46 | 3.35 |
| Startup | 4x | 18.18 | 3.75 | 15.97 | 3.28 |
| First paint | 4x | 18.64 | 3.77 | 16.45 | 3.30 |

POD-4947 landed while this work was in progress. Against the immediate integration parent `0a44022fb`, startup computeds change 11,730→11,707 at 1x and 46,837→46,746 at 4x. First-paint computeds change 12,749→12,783 and 48,187→48,173. Reactions are exactly unchanged at all four checkpoints (2,389/2,450 and 9,616/9,677). The larger before/after reductions above include POD-4947's cold-rule work; they are not attributed entirely to this issue.

Other tracking kinds below are absolute created-object/held-entry counts for the bare pool, before→after. The maintained indexes add eight maps. First-paint atoms increase by 188/788 versus the original baseline (0.26/0.27 per visible row); these are included rather than hidden behind the lower computed/reaction counts. The strict baseline retains every count key and POD-4947's history-census metadata, with a separate per-key sidebar comparison against `0a44022fb`.

| Kind | Startup 1x | Paint 1x | Startup 4x | Paint 4x |
| --- | ---: | ---: | ---: | ---: |
| Atoms | 6,561→5,961 | 6,684→6,872 | 26,290→23,711 | 26,435→27,223 |
| Maps | 31→39 | 31→39 | 31→39 | 31→39 |
| Sets | 3,756→3,197 | 3,756→3,197 | 15,243→12,928 | 15,243→12,928 |
| Arrays | 2,154→2,178 | 2,154→2,178 | 8,574→8,604 | 8,574→8,604 |
| Held map entries | 28,577→24,682 | 28,577→24,682 | 115,143→99,462 | 115,143→99,462 |
| Held set members | 14,642→13,174 | 14,642→13,174 | 59,340→52,834 | 59,340→52,834 |
| Held array elements | 5,823→6,107 | 5,823→6,107 | 23,292→24,396 | 23,292→24,396 |

Both write variants have identical computed/reaction counts. Each adds one map and one atom; the pending variant holds three extra overlay entries. The census uses the existing list observer and existing 20 row observers to consume the complete section/row payload. Removing that payload read first failed the strict census at `70df37250` (36 missing computeds, 21 missing map-has values and 183 missing reads).

Work-per-change is green at `93ee7f3f81` for all sixteen scenarios at both sizes, for the pool, its windowed list and both write-layer variants. The complete payload is consumed; optimistic paint and rollback count at each publication. Existing redraw, copy and 1x→4x work bounds are unchanged. A plain clock tick does zero row reads, zero derivations and one element of maintenance work at both sizes. Representative final cells are below; the acceptance artifact retains all before/after scenarios.

| Scenario/arm | Row reads 1x→4x | Derivations 1x→4x | Elements 1x→4x |
| --- | ---: | ---: | ---: |
| Parent reassignment, pool | 40→41 | 50→50 | 467→522 |
| Parent reassignment, write variants | 40→41 | 50→50 | 476→531 |
| Parent reassignment, window | 1→2 | 6→6 | 92→90 |
| Burst of 50, pool | 310→269 | 1,390→1,374 | 3,321→2,930 |
| Burst of 50, write variants | 310→269 | 1,390→1,374 | 3,664→3,273 |
| Burst of 50, window | 185→182 | 431→425 | 1,770→1,553 |

The default round-three L4b gate is green at `3cb72877eb`: three seeds of 200 changes, oracle/rebuild/relations/views/cold/full-residency checks and every built-in plant. All six strict census cells passed there too (9 checks passed, one baseline-update helper skipped). The final immutable-constant code also passes all six strict census cells at `93ee7f3f81`, with exactly the counts above.


## Closing validation and browser evidence

The graph, prototype and web targets and their prerequisites were checked uncached. Web passed at `74b4ad630`; a prototype test fixture needed a narrower issue literal, then the prototype and its prerequisites passed (10/10) at `0c2e85312`. After the immutable-constant fix, affected graph/prototype targets passed uncached (2/2) at `93ee7f3f81` with `--only` so unchanged prerequisites were not repeated. Every typecheck uses the operator-required `--uncached-because` reason; none uses `--force`.

Graph lint passes at `93ee7f3f81`. Prototype lint, `lint:shadowing` (5,419 files) and `lint:span-effects` (158 span bodies, zero unclassified effects) passed at `e424baf5bd`. The three flagged module containers became frozen values; no lint rule was disabled or weakened. Focused checks use the package's own `vitest.config.ts` through validation admission. The final work/census command ran 10 checks with five helpers/other-arm cases skipped; it is not a suite result. The existing lean and multi-instance lanes were not run: the changed data contract has focused acceptance, and the pilot's off switch cannot exercise the pool in the multi-instance lane (POD-4952 coordinator ruling).

The real StoreProvider fixture observes the complete section and issue payload before declaring readiness. Removing that readiness publication first fails at `3e23c8da3` with the 30-second browser wait; restoring the copied-aside file with `cp` passes both Chromium checks at `d8aac4bfb`. Old pool and row-model weak references have zero survivors after principal switch, explicit rebuild and sign-out. Forced-GC used heaps are 5,843,676 / 6,082,460 / 6,027,680 bytes respectively. The off-switch page requests neither graph nor MobX. Flatblock's missing audio library was supplied only under `~/podium-test-4953/.toolchain/lib`; the initial launch failure is not counted as a sensitivity proof.

Synthetic corpus Chromium measurements at `585e9f07bc` use the existing production-build driver, the bench lease, three measured samples plus one warm-up per scenario/size and `--check`. Both sizes pass redraw parity, snapshot parity, zero stray commits and old-principal forced-GC collection. Maximum observed host load is 1.87, below the unchanged ceiling of 8. Each table cell is an independent median; heaps are decimal MB.

| Scale | Click action (ms) | Click → next frame (ms) | Principal dispose + build (ms) | Dispose (ms) | Build (ms) | Principal heap before→after (MB) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1x | 10.2 | 10.7 | 515.0 | 66.8 | 449.6 | 55.2→51.7 |
| 4x | 71.5 | 72.1 | 1,477.0 | 218.9 | 1,259.9 | 187.6→170.9 |

These are candidate measurements of the complete data payload in the pilot renderer, plus real-provider lifetime evidence. They establish neither a before/after speedup nor acceptance of the real sidebar's future consumer cutover. That wiring remains under POD-4948; POD-4949 owns the normalized homes that retire the single temporary adapter. The product worklist UI files are untouched and the startup switch remains off by default. The issue's acceptance artifact retains the full synthetic corpus, random-gate, before/after census, before/after work and browser records.
