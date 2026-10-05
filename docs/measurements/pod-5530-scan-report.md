# Whole-data scan sweep report

2026-10-05 · POD-5530 · source snapshot `a11ccc804aaf848ebc3b498b48d997d14493d130` on `integrate/4286-pilot`.

The largest remaining opportunities are the legacy state publication boundary, Tasks board materialization, and mission projection. Fold those into their existing owners. The transcript model migration has landed, but retained merge and row-shaping algorithms still need explicit accounting: replacing subscriptions alone does not remove them. The smallest independent candidates are the shell dock's scope lookup and fetching only the selected diff file.

This is the single reporting deliverable requested by the coordinator's 2026-10-05 16:18 UTC comment. No product fixes, architecture changes, new measurements, or finding issues were made in this reporting slice. There is no unlanded fix WIP; shipping fallback was already landed at `d56b642ec6` before the order changed. POD-4286 owns filing and scheduling the findings below.

## Evidence and interpretation

- **Census C:** [interaction-scan-census.json](../../scripts/interaction-scan-census.json), SHA-256 `570c203cceb380a2e2a11c22b41734a934df16b41a1207ada37edff6b0b91fe4`. Six roots: web, mobile source and routes, client-graph, client-core, and mobx-helpers. It contains **2,371 fingerprints / 2,378 occurrences**, of which **2,306 / 2,313 in 253 files** are `REQUIRED REPAIR`. A fingerprint is conservative collection taint, not a measured live scan or a separate fix. Counts are scan-site multiplicities, never rows per action.
- **Matrix M:** this issue's artifact 13, `structural-scan-inventory.json`, source `78fcb97c5e7c4a955061f9ae01adfbf5ba20c891`: 48 modeled readers, nine actions, 4,870 issues / 4,338 sessions at 1× and 19,471 / 17,346 at 4×. It reported 160 known failing counters, 61 resolved counters, and two unexpected detail-page element counters. This snapshot predates later fixes and the Conversation landing. Numeric estimates below are explicitly historical area envelopes; they are not measurements of the report snapshot or promised savings from one fix.
- **Traced inventory T:** artifact 1, `whole-data-scan-census.md`, baseline `90f8056a7e`. Its larger starting totals include repairs already landed. Use its call-chain traces and exclusions, not those totals as current costs. Modeled readers can deliberately retain a legacy facade that the production screen has stopped using.
- **Idle evidence:** artifacts 11 and 14 (`empty-workspace-idle-evidence.json`, `active-conversation-idle-evidence.json`). The latter used an empty transcript and did not mount the complete AppShell. Its quiet windows read zero rows with 11 / 19 derivations; ten unrelated heartbeats read zero rows with 12 / 19 derivations. These narrow fixtures do not establish that the operator's reported 17,888 derivations and approximately 15 seconds per minute have disappeared. Earlier empty-window cache-copy costs were subsequently fixed.
- **Repair evidence:** artifacts 15 and 16 (`point-lookup-evidence.json`, `header-count-evidence.json`), earlier per-fix artifacts 2–10 and 17–21, plus the shipping fallback guard and local `.review/` proof. These supersede matching old matrix failures.

M estimates are sums of `rowsBy` and `elementsBy` entries with the named `consumer:` prefix in the saved action cell. Attribution buckets overlap between findings; **do not add them**. Derivation counts can remain flat while each body walks four times as many elements. No wall-clock captures were run for this report.

For unmeasured paths, **code-read estimate** means collection visits implied by the current implementation, not measured row calls or elapsed time. Symbols: I/S = all issues/sessions; D/A = mission descendants/member sessions; W = worktrees; Q = shipping orders; R/H = repositories/hosts; N = retained transcript items; P = proposed issues; B = candidates matched by search; F = changed files; L = notice/event history. A pass over X at 1× becomes a pass over 4X in a hypothetical fourfold input with the same visible demand; sorting adds comparison work. A requested full list can legitimately have output proportional to X. Its first enumeration is distinguished from repeatedly rebuilding it on a single-row update or while hidden.

Effort S = localized existing question or demand bound; M = incremental relation/result plus consumer changes; L = screen/state ownership migration. Ranking weighs repeated update/keystroke exposure and historical work, then confidence and visibility. Unknown-size code estimates are ordered approximately, not presented as measured comparisons.

## Ranked findings

| Rank | Finding: one fix boundary | Impact evidence, 1× → 4× | Effort | Recommendation |
| ---: | --- | --- | :---: | --- |
| 1 | F01 Incremental legacy state publication | M navigation: 100,490 → 397,576 elements; 45 → 45 row calls | L | Fold into POD-5620 implementation after design approval |
| 2 | F02 Incremental Tasks board and windowed cards | M heartbeat: 4,909 → 19,606 rows; 46,674 → 188,823 elements | L | Fold into POD-5555 |
| 3 | F03 Per-issue mission projection and rollups | M navigation: 11,251 → 44,761 rows; 6,269 → 24,254 elements | L | Fold into POD-5575 |
| 4 | F04 Addressed issue detail and explorer projection | M navigation: 7,309 → 29,218 rows; 12,463 → 49,171 elements | M | Fold into POD-5618; explorer portion into POD-5555 |
| 5 | F05 Incremental retained transcript merge/prepend | Code-read: N → 4N held-item copy/index passes | M | Fold follow-up into POD-5621; retained algorithms survive its landing |
| 6 | F06 Incremental web transcript row shaping/search | Code-read: N → 4N pairing/shaping/search input | L | Fold into POD-5622; explicitly retain worker algorithm follow-up |
| 7 | F07 Incremental phone transcript row shaping | Code-read: N → 4N raw/model projection | L | Fold into POD-5623 |
| 8 | F08 Incremental sidebar/worktree membership | Code-read: I+S → 4I+4S legacy grouping; indexed group size on newer paths | M | Fold into POD-5424; coordinate POD-5575 |
| 9 | F09 Phone mission and Tasks projection | Code-read: D+A and matching board set → fourfold sets | M | Fold into POD-5575 / POD-5555 phone follow-up |
| 10 | F10 Visible waterfall geometry and activity demand | Code-read: D+A → 4D+4A projected geometry/activity IDs | M | Fold into POD-5575 follow-up |
| 11 | F11 Short-string phone Work search | Code-read: one row paint per candidate; S+I → 4(S+I) | M | Fix now using landed POD-5561 matcher; coordinate POD-5572 |
| 12 | F12 Addressed shell dock scope and shipping | Code-read: containing candidates + W+Q → fourfold scans | S | Fix now; coordinate POD-5620 |
| 13 | F13 Deferred startup indexes and hydration | Code-read: I+S+edges+joins → fourfold bootstrap input | L | Fold into POD-5592 |
| 14 | F14 Addressed phone inspector catalogs | Code-read: open inspector I+S → 4I+4S | M | Fold into POD-5623 / POD-5618 |
| 15 | F15 Addressed workspace/warm-pane membership | Code-read: S+tabs → 4S+fourfold tab set | M | Fold into POD-5620 |
| 16 | F16 Incremental header reclaim/occupancy aggregates | Code-read: reclaim candidates × occupied-path tests, plus fleet metrics | M | Fold into POD-5424; coordinate POD-5620 |
| 17 | F17 Incremental open launcher option catalogs | Historical M launcher heartbeat envelope: 19,316 → 75,946 elements | M | Fold into POD-5424; exclude unsupported palette optimization |
| 18 | F18 Incremental proposal screening queue | Code-read: P plus ancestor walks and queue copies → fourfold proposal set | M | Fix now; coordinate POD-5555 phone scope |
| 19 | F19 Incremental issue activity history | Code-read: L → 4L dedupe/append-history rebuilding | S | Fold into POD-5618 |
| 20 | F20 Incremental automation target ordering | M automations heartbeat: 3 → 3 rows; 1,952 → 7,568 elements | M | Fold into POD-5424 |
| 21 | F21 Incremental machine/status panel rows | Code-read: H+host sessions → fourfold fleet/roster | M | Fold into POD-5620 |
| 22 | F22 Incremental visible cost/usage totals | Code-read: D+A or usage-history set → fourfold set | M | Fold into POD-5575 / POD-5620 |
| 23 | F23 Fetch only the selected diff payload | Code-read: eventually F → 4F payload requests; rail scan on each completion | S | Fix now |
| 24 | F24 Bound table-file search and projection | Code-read: file rows × searched columns → fourfold file rows | M | Fix now |
| 25 | F25 Demand-bound full notice log | Code-read: L → 4L notices when full log is requested | S | Fold into POD-5622 / POD-5623; preserve scalar banner |
| 26 | F26 Addressed menu/handoff action inputs | Code-read: target/candidate rosters → fourfold candidate set | M | Fold into POD-5575 / POD-5618 |
| 27 | F27 Incremental settings/project option panels | Code-read: open repository/device/project catalog → fourfold options | M | Fold into POD-5424 / POD-5620 |
| 28 | F28 Incremental per-owner attention/unread totals | Code-read: owner session/item roster → fourfold owner roster | M | Fold into POD-5424; coordinate POD-5575 |
| 29 | F29 Shared handoff transcript ownership | Code-read: N → 4N separate held-history merge/question passes | M | Fold into POD-5622 and retained merge follow-up F05 |
| 30 | F30 Prove generic query and comparison bounds | C only: transitive taint; no defensible per-action row estimate | M | Fold into POD-5424 |

### F01 — Repeated legacy publication still rebuilds collection-wide state for a named navigation change

**Area/files:** `packages/client-core/src/engine/{actions,navigation,reactions,runtime,state,wiring}.ts`, `values/workspace-layout.ts`, `values/dock-panel.ts`, session ownership and link helpers. **Trigger:** click/navigation, incoming update, lifecycle reaction; idle only where a timer actually invokes the reader. **Impact:** historical M `navigation` navigate-by-ref 45/45 rows but 100,490/397,576 elements and 13/13 derivations. This is the broad publication/pruning envelope, not 397,576 payload reads or a current isolated measurement. Current pure helpers still copy/filter arrays and layout trees. **Overlap/recommendation:** L; fold into POD-5620 after its design is approved. That issue is design-only today; the report cannot promise automatic disappearance. Moving just one consumer to MobX can leave publication running for the others. Draft code and the write queue were not changed or proposed as fixes here.

### F02 — Tasks board computes and materializes the matching board before the viewport limits rendering

**Area/files:** `client-graph/src/issue-board-source.ts`, `client-core/src/values/{issue-board-rows,board-scope,issue-board-filter}.ts`, web `IssuesKanban.tsx`, hierarchy/list/display and drag helpers. **Trigger:** keystroke, selection/menu state, incoming issue/session update, heartbeat. **Impact:** historical M `board` heartbeat 4,909/19,606 rows and 46,674/188,823 elements; lane change 42,073/169,580 elements. Candidate comparison/materialization can scale even when only a small viewport is shown. **Overlap/recommendation:** L; fold into POD-5555's per-issue cards, per-column IDs and virtualization. POD-5561 is already done (`faa18afc8a`): do not reopen the removed lettergram index or claim per-row fact reads in its short-string matching pass. Many-match projection/rendering remains board work; a genuine local title/ref search may inspect its short-string candidate set.

### F03 — Mission views and action inputs recompute descendant/session collections instead of observing individual visible rows

**Area/files:** `client-graph/src/mission-view.ts`, `client-core/src/values/mission.ts`, web `mission-pane-reader.ts`, `FlightDeckPool.tsx`, `FlightDeck.tsx`; folded header mission traversal in `header-views.ts`. **Trigger:** mission/issue click, menu context demand, incoming member update and heartbeat. **Impact:** historical M `mission` navigation 11,251/44,761 rows, 6,269/24,254 elements; selection 10,248/40,854 rows. T's operator trace reported 5,546 issue and 3,897 session summaries on a warm switch. Neither is a current measurement. The old `mission.menu` catalog dominates much of M and must disappear rather than be separately optimized after its replacement. **Overlap/recommendation:** L; fold into POD-5575's per-issue deck children/rollups, root IDs and visible row observers. The named files, including FlightDeckRows, remain reserved for that owner. Bounded addressed mission readers already repaired below are not reopened.

### F04 — Detail properties, inspector lists and explorer rows still request broad catalogs for one issue

**Area/files:** graph `issue-page.ts` explorer reader; web `issue-page-model.ts`, `IssuePanelView.tsx`, `issue-page/{IssueProperties,IssueDetailHeader,issue-edges,issue-page-data,use-eviction-guard}.tsx`, `explorer/explorer-list.ts`. **Trigger:** page/inspector click, property picker open, issue/session update. **Impact:** historical M `issue-page` navigation 7,309/29,218 rows and 12,463/49,171 elements includes legacy catalogs, not the now-addressed page-title/worktree path. `explorerSessions` still orders and visits its whole query; property/mate/label option construction has candidate-wide output/comparison. The old unexpected 55/151 and 49/145 detail element counts are historical, not newly reproduced failures. **Overlap/recommendation:** M; fold detail into POD-5618 and explorer/board materialization into POD-5555. A full opened option list may need candidate IDs; an ordinary page should read only named relations and shown options. Fold generic structural comparison into POD-5424.

### F05 — Transcript prepend, dedupe and reconciliation retain whole-history algorithm work

**Area/files:** `client-core/src/transcript/merge.ts` (`freshOlderTranscriptPage`, `dedupeTranscriptItems`, reconciliation and indexed-frame insertion), transcript controller's retained merge calls. **Trigger:** incoming frame/update, authoritative reset, older-page demand. **Impact:** code-read estimate: constructing `new Set(held.map(id))`, filtering/deduping and slicing retained tails visit/copy N held items, then 4N for fourfold history. Insertion can shift/update positions through the retained suffix. Normal append is not claimed to run every helper or have quadratic cost. **Overlap/recommendation:** M; fold a retained-algorithm follow-up into POD-5621 coordination. POD-5621 landed `a11ccc804a` and explicitly reused merge helpers unchanged, so these will not disappear merely because TranscriptLog now has observable IDs/byId. Keep authoritative resets and paging semantics; do not create another store or touch this reserved code from this issue.

### F06 — The web transcript compute pipeline still shapes a full loaded input

**Area/files:** `client-core/src/values/transcript-compute.ts`, `values/compose/chat.ts`; web `chat.ts`, `use-chat-surface.ts`, `use-chat-context.ts`, ChatView and worker/model callers traced in T. Some shaping holders are absent from C despite the trace. **Trigger:** transcript update, verbosity change, open search/keystroke, panel activation. **Impact:** code-read estimate: `computeTranscript` copies items, pairs tools, builds rows and supplies the block/row graph to search: N/4N input visits per full computation. Existing closed Find/cursor and matched-row guards do not establish incremental producer work. No new row-shaping count or current worker timing is available. **Overlap/recommendation:** L; fold screen observation/deletion into POD-5622. Its brief keeps the graph worker delta feed; parsing/pairing and row production need an explicit retained-algorithm follow-up rather than a promise that the screen rewrite fixes them. Old use-chat-surface/use-chat-send wrappers **will disappear with POD-5622** when their last callers move.

### F07 — Phone transcript/model production can revisit raw history even though cursor and viewport lookup are bounded

**Area/files:** mobile `lib/{transcript-feed,superagent-transcript}.ts`, SessionConversation and SuperagentScreen, shared conversation projection/controller and transcript shaping functions. **Trigger:** streaming/incoming update, paging, model change, optimistic-send reconciliation. **Impact:** code-read estimate N/4N raw/model traversal, with pending-turn × retained-user echo checks on legacy helpers. Previously repaired assistant-tail, raw question/prompt/echo/time facts and viewport anchors are flat; do not charge their planted old loops as present cost. **Overlap/recommendation:** L; fold into POD-5623's row observers and Conversation cache. Legacy screen controller acquisition and five-second Superagent polling **will disappear with POD-5623** as specified by that issue. Native layout measurement and retained shaping algorithms are not promised away by that deletion; coordinate F05/F06.

### F08 — Sidebar/worktree sections rebuild membership and comparison outputs beyond the visible row window

**Area/files:** graph `worklist/{visible,sidebar-row,mobile,sorted-lanes}.ts`, core `compose/worklist/{rows,nav,session-groups,project-order}.ts`, web `pool-sidebar.tsx`, `pool-sidebar-rail.tsx`, `use-pool-unified-work.ts`, UnifiedWorktreeRow. **Trigger:** click/fold/reorder, membership or session update, observed timing change. **Impact:** code-read estimate: legacy group composition visits I+S; newer relations restrict this to a group or descendant set, which can still grow while the window stays fixed. Re-sorting, grouping and structural equality of those outputs remain. Dormant `use-sidebar-projects.ts` is listed under C01, not used to claim live sidebar cost. **Overlap/recommendation:** M; fold into POD-5424's stable per-row outputs and coordinate POD-5575's model ownership. Keep existing closed/folded-row demand guards; the remaining fix is incremental membership/output, not undoing their lazy mount.

### F09 — Phone mission and Tasks screens derive complete member/board projections before displaying a subset

**Area/files:** graph `mobile-screens.ts`, mobile MissionDeck, MissionScreen, IssuesScreen, TaskSheet, core mission/board helpers. **Trigger:** route/mission click, expansion, search and incoming issue/session update. **Impact:** code-read estimate D+A member visits or matching board set visits, fourfold with those sets; phone layouts may window rendering without bounding source projection. The historical mobile inbox/session numbers are not evidence for this screen. **Overlap/recommendation:** M; fold mission models into POD-5575 and Tasks projection into a POD-5555 phone follow-up. Shared per-row ownership is reusable; desktop virtualization does not automatically change a separate phone selector.

### F10 — Waterfall geometry and activity loading use all projected rows while responding to viewport controls

**Area/files:** web `FlightDeckWaterfall.tsx`, `flight-deck-waterfall.ts`, `useWaterfallActivity`. **Trigger:** pointer movement, wheel/keyboard pan/zoom, fit-all click, activity arrival and timeline clock update. **Impact:** code-read estimate D+A/4D+4A across sessions, projected row metrics, focus/duration calculations and activity ID fingerprints. Full fit-all bounds may legitimately inspect its requested domain once; repeated pan/zoom and offscreen activity payload demand need narrower inputs. No isolated M counter exists for geometry. **Overlap/recommendation:** M; fold into POD-5575 follow-up with its row IDs, keeping the geometry/payload boundary explicit. Mission membership migration alone does not delete these helpers.

### F11 — Phone Work search paints each candidate row to answer a text query

**Area/files:** mobile `lib/work-sections.ts` (`MobileSearchSections.update`), WorkScreen, graph mobile row readers. **Trigger:** nonempty-query keystroke and candidate row update while searching. **Impact:** code-read estimate one `pool.mobileWork.row`/paint per source row across bands, snoozed and closed sections: I+S/4(I+S) if those sets scale. Historical M mobile-work long-press is flat at 3 rows and 8 elements; it does not exercise text search. **Overlap/recommendation:** M; fix now by sharing POD-5561's landed short title/ref candidate matcher and painting only matched/visible rows. Coordinate POD-5572 for phone visibility; do not optimize a genuine short-string matching pass out of existence or reopen Tasks owner files.

### F12 — The shell dock still rebuilds global worktree/shipping scope for one active cwd

**Area/files:** graph `shell-views.ts` (`dock`, `shipping`, worktrees), web `shell-data.ts`, RightDock/RightRail. **Trigger:** pane/file/session click, active cwd/issue update, observed shipping/worktree update. **Impact:** code-read estimate: iterate `containingIssues` and read its candidates, walk all worktree groups to find one path, then `headerIds('shipOrder').flatMap` and filter for counts. Cost is candidate count + W + Q, fourfold if those grow. Historical M shell navigation elements 1,365/3,194 includes other now-repaired shell consumers and is not an isolated estimate for this fix. **Overlap/recommendation:** S; fix now using existing containingIssueId, addressed path/worktree questions and maintained scope counts; coordinate POD-5620. This is a separate shell facade from **header-views.shipping**, whose fallback was just fixed. Do not report the latter as open.

### F13 — Source attachment still seeds global facts and joins before focused demand

**Area/files:** graph `shared/row-source.ts` (`ensureSessionFacts`, `ensureEdges`, seed issue/session joins, initial flush/enumerate), cold-index/schema/residency; core replica/feed/socket initialization and reference/session indexes; MobileSyncBoundary. **Trigger:** startup, principal/source replacement, authoritative refresh. **Impact:** code-read estimate I+S+dependency edges+user-state joins on full initial attachment. Ordinary changed-row flush is intended to be delta-sized; no evidence here establishes every update rescans the catalog. Source data sync is different from an unseen screen's warmed index. **Overlap/recommendation:** L; fold into POD-5592's active-first hydration, history batches and completeness markers, with POD-5620 data ownership. Delayed loading needs LOADING/completeness semantics; this is not a local permission to change protocol/server architecture.

### F14 — Opening the phone issue inspector still borrows all issues and sessions

**Area/files:** SessionConversation's `useIssues(peekIssue !== null)` / `useSessions(peekIssue !== null)`, mobile `use-session-context.ts`, graph `chat-context.ts` mobile context readers; SessionScreen helpers. **Trigger:** inspector click and incoming catalog update while it is open. **Impact:** code-read estimate I+S/4I+4S open catalog projection. It is already closed-gated, so historical M `mobile-session` navigation 28,182/112,602 rows is an old envelope containing closed costs subsequently repaired. Do not claim that envelope is today's chat or unopened inspector cost. **Overlap/recommendation:** M; fold into POD-5623 and addressed detail work POD-5618. Dormant Sessions/Inbox routes and diagnostic chat context comparisons are C01, not extra live demand.

### F15 — Workspace and terminal warm-set preparation derive a universe before choosing named panes

**Area/files:** web Workspace, `workspace-inputs.ts`, `panel-deck.ts`, `use-warm-set.ts`, `warm-set.ts`, dock-shell-lifecycle, workspace-tabs and close-tab helpers; core terminal composition/workspace layout. **Trigger:** pane/route click, tab drag/close, session membership or ownership change. **Impact:** code-read estimate global session/group joins plus tab sets, S+tabs/4S+fourfold tabs in legacy branches. Requested open tabs themselves are legitimate output; orphan resolution/warmUniverse and recomposition must not require unrelated session payloads. Existing named close-tab and link fixes remain in place. **Overlap/recommendation:** M; fold into POD-5620's UI-state/plain-service boundary. No terminal process behavior or write queue change is proposed.

### F16 — Reclaim and occupancy questions aggregate a whole candidate fleet on repeated observed changes

**Area/files:** graph `header-views.ts` (`occupancyKey`, `reclaimCounts`, machines/metrics/quotas list views), header entity/source callbacks. **Trigger:** visible fleet/reclaim panel demand, machine/metric/occupancy update and observed clock deadline. **Impact:** code-read estimate one reclaim-candidate pass with occupied-path `.some` tests, plus metric lists: potentially candidates × occupied paths, not a measured quadratic wall-clock claim. Offline machines, hibernation cap and shipping counters already have addressed/scalar guards and are not open findings. **Overlap/recommendation:** M; fold aggregate/demand work into POD-5424 and coordinate fleet ownership POD-5620. A requested full fleet list is valid output; maintain totals and reevaluate affected deadline/candidate neighbors rather than rebuilding that list for a scalar.

### F17 — Open New Work launchers still collect and compare broad option catalogs

**Area/files:** mobile NewWorkButton, NewIssueScreen, use-launch-inputs, LaunchConfigurationFields and launch helpers; graph command-launch views/source; web NewPanelMenu and launch origin readers. **Trigger:** opening a supported launcher, repository/machine choice, relevant catalog/usage update. **Impact:** historical M launcher heartbeat 1,043/3,947 rows and 19,316/75,946 elements includes unsupported palette/legacy readers and predates derived command session companions. Current code-read estimate is repositories/worktrees plus displayed machine/model option sets and ordering; not every exact-fingerprint callback remains a global payload scan. **Overlap/recommendation:** M; fold supported open option list deltas/bounds into POD-5424. Closed phone menus and addressed repository choices are already fixed. The unsupported CommandPalette is C01: preserve zero demand while closed, do not optimize its open projection. New command companion landings on the pilot supersede that part of M.

### F18 — Proposal screening recomputes the full queue and copies it after a single proposal change

**Area/files:** graph `mobile-inbox-views.ts` screening, mobile `use-inbox-data.ts` `reconcileScreeningIds`, routed ProposalScreeningScreen (`app/screen-proposed.tsx`). **Trigger:** screen activation, proposal/ancestor update, decision click. **Impact:** code-read estimate P summary reads, ancestor walks, sort, and old/new queue sets/copies; P/4P with a fixed visible card. The selected `screeningRows` input is small and should stay addressed. Historical full mobile-inbox group counters refer mainly to the dormant Inbox, not this queue. **Overlap/recommendation:** M; fix now with incremental eligible root IDs/order and narrow queue reconciliation, coordinated with phone Tasks/POD-5555. The screen legitimately needs queue IDs; it need not reproject every proposal's payload.

### F19 — Issue activity feeds rebuild retained event history when a page arrives

**Area/files:** web issue-page-model activity absorb/drain, mobile `lib/use-issue-detail.ts`, core issue-activity helper. **Trigger:** incoming event batch/update and older-page demand. **Impact:** code-read estimate L/4L retained-event ID collection/filter/copy, plus the new page; no 1×/4× guard for this producer is available. Sorting/displaying the requested history once is separate from rebuilding it per small append. **Overlap/recommendation:** S; fold into POD-5618's detail model, with an owned ID/order relation and append/reset semantics shared by phone.

### F20 — Automation target options rebuild and sort roots on usage/catalog changes

**Area/files:** graph `automation-views.ts` targets/roots; web `automation-form.ts` targetChoices/usageAt. **Trigger:** open form demand, repository/machine update, recency/usage update. **Impact:** historical M automations heartbeat 3/3 rows but 1,952/7,568 elements and 4/4 derivations. Setup session/cardinality scans were separately repaired; this is remaining option/output work. **Overlap/recommendation:** M; fold into POD-5424's per-target computed output, stable ordering and caller-bound template; coordinate POD-5620 if data ownership is replaced. A full target list is legitimate when requested, but one update should not rebuild every option.

### F21 — Fleet and machine panels repeatedly filter whole machine/session collections for status and choices

**Area/files:** web MachinesPanel, HostMemoryView, mobile connected-devices/Pulse live summaries; core `compose/machines/{facts,authority,placement}.ts`, fleet/quota/host aggregate helpers. **Trigger:** visible panel, health/session update, pairing/transfer click. **Impact:** code-read estimate H plus per-host session roster/usage entries, fourfold if those sets grow. Pulse reads real fleet output; dormant Inbox counters cannot establish its cost. Addressed offline membership/deadline neighbors already landed. **Overlap/recommendation:** M; fold into POD-5620 data/consumer ownership and POD-5424 stable per-host rows. Exclude unseen host payloads from scalar status/transfer target decisions; preserve deliberately displayed fleet choices.

### F22 — Cost chips and usage pages can aggregate all members/records for each visible total

**Area/files:** MissionCostChip, useMissionCost/useTaskCost/useTaskCosts, UsageTasks/UsageView, core cost/usage/repository-usage values. **Trigger:** visible total/page demand and incoming usage/session update. **Impact:** code-read estimate D+A for a mission/task or all records in a requested usage range, fourfold with those sets. Existing counters do not isolate this area; server-returned visible range aggregation is not automatically an interaction-boundary bug. **Overlap/recommendation:** M; fold mission totals into POD-5575 rollups and remaining usage data into POD-5620. Use incremental totals/windowed rows where the output is a scalar or a small viewport.

### F23 — Opening one diff starts fetching every changed file's payload

**Area/files:** web `features/git/DiffSheet.tsx` `useDiffs` pump. **Trigger:** diff-sheet click, selection and every fetch completion. **Impact:** code-read estimate eventually F/4F payload requests despite one selected file; each pump filters the whole rail twice and completion copies the diff-state record. Concurrency limits simultaneous requests, not total unseen work. This trace from T still exists even though DiffSheet has no REQUIRED REPAIR entry in C. **Overlap/recommendation:** S; fix now: selected/actually requested payload demand, keep already visited results under the sheet owner. No dependency on the mission/chat/store migrations.

### F24 — Table preview rebuilds all indexed/matching rows for each filter keystroke

**Area/files:** web `features/files/TableFilePanel.tsx` (`indexed`, `matching`, `filtered`, visibleHeaders/visibleRows). **Trigger:** filter keystroke, column selection and file update. **Impact:** code-read estimate file rows × searched columns per query, plus matching-row materialization, fourfold with file row count. The visible row slice bounds rendering, not necessarily projection. File data is a separate corpus from M's issue/session dataset; do not reuse M row counts here. **Overlap/recommendation:** M; fix now with bounded materialization and a declared file-search owner/window; keep a genuine whole-file search's work explicit rather than promising constant-time arbitrary text search.

### F25 — A full message-log reader still materializes all attention notices

**Area/files:** graph `notice-views.ts` noticeMessages, core message-notices/operations-status/tray helpers; web/mobile use-pool-notices full-list exports. **Trigger:** explicit full log demand and notice/session-label update while it is observed. **Impact:** code-read estimate L/4L notice reads, label lookups and sort. Current production banner/newest-message users have scalar/addressed replacements; export existence alone does not prove an always-mounted call. Historical M notices navigation is already flat (15/15 rows, 1/1 elements) and is not an outstanding global notice claim. **Overlap/recommendation:** S; fold demand/window bounds into POD-5622/5623 only if a live full-log caller remains, otherwise C01 cleanup. Preserve addressed per-session interaction cards and recovery controls; the write queue is out of scope.

### F26 — Remaining action helpers accept catalog rosters when a menu or handoff needs named targets

**Area/files:** web issue-context-menu, issue-menu-{config,commands,readers,pool-inputs,palette}, IssueCompactControls, issue-lifecycle, use-session-guard; core handoff, ask-question, spawn-agent, issue-close/relations/task-state; phone close blocker helpers. **Trigger:** context-menu/close/handoff click and observed eligibility update. **Impact:** code-read estimate candidate/target session+issue passes, fourfold if an unconstrained caller supplies the catalog. Bulk selected targets are legitimate work proportional to selection. Old global mission-menu counts are F03; close/menu/reference guards already fixed cannot be counted again. **Overlap/recommendation:** M; fold mission actions into POD-5575 and detail actions into POD-5618. Replace broad inputs at their live callers, then retain pure bounded helpers or remove dormant legacy ones; do not infer global behavior from every tainted `.some` over a selected roster.

### F27 — Settings and project dialogs still materialize complete open option/history collections

**Area/files:** web SettingsView/readers/sections, ManageProjectsDialog, mobile SettingsScreen/device feeds and model options; graph settings-views/mobile-settings. **Trigger:** panel/dialog open, setting/device/repository update. **Impact:** code-read estimate repository/device/project options or explicitly requested history range, fourfold with those sets. Setting scalar changes, setup counts and root prefix synchronization already have flat guards; C's remaining settings callbacks also include generic memo/cleanup taint. **Overlap/recommendation:** M; fold option/history projection into POD-5424 and UI/data ownership into POD-5620. Mount full choices only when requested and maintain row-level deltas, keeping scalar screens on scalar readers.

### F28 — Attention, unread and timing helpers aggregate an owner's entire roster

**Area/files:** core `compose/worklist/row-attention.ts`, session-urgency/status, unread, focus/session-values; graph sidebar-row/seat-verdicts/mobile-row; sidebar time indicators and row shortcuts. **Trigger:** visible owner row, member heartbeat, message/read-state change and observed clock. **Impact:** code-read estimate owner session/item roster size, fourfold if one owner's historical set grows; this is not necessarily all world sessions. Newer row model companion getters already landed on the pilot; remaining pure helper callers and whole-roster outputs must be verified against them. **Overlap/recommendation:** M; fold remaining totals/timing/attention into POD-5424 with POD-5575 ownership. Requested visible seats may grow with output; a badge/timestamp should use a maintained aggregate, and a hidden row should not keep history warm.

### F29 — Handoff chat holds another transcript history and merge path

**Area/files:** web `use-handoff-transcript.ts`, FlightDeckHandoff/useReviewReturns; core handoff/transcript functions. **Trigger:** handoff pane demand, older-page fetch, subscription update and returned-turn selection. **Impact:** code-read estimate N/4N older-page seen-ID sets, seeded/merged arrays and question/return searches. No isolated saved meter result. General Conversation ownership does not guarantee a separate handoff hook has moved. **Overlap/recommendation:** M; fold into POD-5622's shared Conversation owner, coordinating F05 retained merging. Its implementation should disappear with that integration; current planned hook deletions do not explicitly name every handoff caller.

### F30 — Generic collection helpers still lack a proven caller cardinality or demand contract

**Area/files:** graph reader-queries, enumerate, query-result, cached, shared reader-questions/schema/models, mobx-helpers/keyed-computed; generic holder callbacks within the above view files. **Trigger:** invocation at a caller's demand/update; some catalog initialization is F13. **Impact:** C-only transitive debt; there is no defensible numeric row estimate for an arbitrary callback. A `.map` in a generic memo is not itself proof of whole-world work. `knownIds` has test-only callers in this snapshot; headerIds is broad where F12 consumes all shipping orders, and legitimate when a visible catalog really needs IDs. **Overlap/recommendation:** M; fold into POD-5424. One fix boundary is an explicit source/bucket query contract and proof of caller demand/cardinality, preserving all unproven fingerprints until a bounded replacement or valid classification has evidence. POD-5541/5542 helper/derived companions already landed; do not reintroduce private MobX APIs, a second cache layer, or mistake those landings for clearance of every generic flag.

## Coverage dispositions outside the impact ranking

**C01 — Dormant routes, unsupported open palette, fixtures and diagnostics.** Includes unmounted phone Inbox, the unused `useSidebarProjectSections`, chat-context/file-viewer comparison checkers, mocks, fixtures, and perf helpers. The T exclusions and current route/caller reads do not support assigning these live interaction cost. The phone proposal screen and Pulse are active and belong to F18/F21; do not group them with dormant Inbox. Historical M mobile-inbox navigation (18,269/71,469 rows), mobile-session envelopes and open-palette costs must not be used as current production idle costs. Effort S/M; fold deletion or documented bounded diagnostic classification into POD-5424, and keep unsupported palette closed demand zero. Recommendation: **will disappear with POD-5622/POD-5623** only for legacy chat fixtures/helpers actually made unreachable by their deletions; other diagnostics should remain available if useful. No product optimization issue is justified solely by these flags.

**C02 — Candidate bounded or output-sized collections still awaiting explicit classification proof.** Includes attachment arrays, small pending-send/approval selections, model/effort choices, voice fragments, painted minimaps/reference previews, windowed row handlers and dynamic generic callback taint in otherwise repaired paths. Trigger is their named action or visible output; code-read estimate is the requested local collection K/4K if that output itself grows, not I/S/N. No existing counter establishes an unrelated-data slope. Effort S; fold proof/classification into POD-5424, or the owning F finding for a genuinely unbounded caller. Do not file one new bug per fingerprint, waive exact census debt, or claim that every row in the appendix is a confirmed live scan. `ref-miniview` and mention-chip paths have addressed guards; user-requested matching options are permitted output.

## Repairs already landed by this sweep

These are pilot ancestor commits, not outstanding work. A final SHA can contain earlier WIP commits for the same fix; the table identifies the completed landing, not every intermediate commit. The report does not claim sole authorship of other pilot migrations.

| Completed mechanism | Landed SHA(s) | Scope of existing proof |
| --- | --- | --- |
| Addressed query/predicate and count questions | `d13769664f` | Named demand rather than global issue/session catalogs |
| Explorer counts and ancestor relations | `aa04a75e80`, `a825ca5e74` | Maintained scoped count/ancestor answers; legacy full explorer materialization remains F04 |
| Close eligibility | `4b04eebdc5` | Named selected targets and maintained concern counts |
| Native shell link targets | `561252320c` | Addressed identity winners and activation/retry |
| Addressed navigation | `04aac91f32` | Named ref navigation; legacy publication remains F01 |
| Phone close/link and machine presence | `5795515a80`, `a85b6ca2cb` | Addressed named phone controls and hosts |
| Terminal/shared references and notices/menu controls | `35a3842362`, `9755ee65e0`, `9117340cbe`; child `407c7775e7`, `41ffc7c7cc`, `4b58a73e1e` | Painted reference demand, scoped notices, scalar banners and closed menu demand |
| Setup/settings first-demand aggregate questions | `85bc46b6a7` | Settings/setup counts avoid all-session scans |
| Issue title worktree, transcript heartbeat position and setting-key deltas | `1674db3041` | Named lookups/deltas; artifact 15 |
| Header working count, source deltas and shipping counts | `89d3e1aba1`, `0c00bdf154` | First count 1/1 row and 37/37 elements; closed roster zero; artifact 16 |
| Hibernation cap scalar | `d644b49ff7` | Maintained cardinality and inactive-tab demand bound |
| Root repository change token and unique prefix scalar; canonical catalog fetch removal | `549ba9b995`, `20ff5c092f`, `09d579c169` | 128/512 repositories; changed-path token 1/1 row, 4/4 elements; root prefix fetch demand zero |
| Closed phone Find, cursor, assistant tail and viewport anchor positions | `3c62e708f6`, `92594b278f`, `cdb338b1a7` | Closed Find zero history; next/previous only cursor question; fixed viewport reads flat at 512/2,048 rows |
| Raw pending question/operator prompt and Superagent echo/time facts | `c244d7a630`, `187117824a` | Named queries one addressed row or maintained scalar; actual phase/status actions zero legacy scans |
| Closed phone launch fallback sheets and addressed repository choices | `541f3ceee2`, `81614f4fee` | Closed choices no demand; named repository lookup rather than full catalog |
| Phone Find matched-block row relation | `8244be1bae` | Only matching/visible block relations projected |
| Shipping scope and file-tab containing-issue winner | `de61ddaace`, `90e61795b4` | Maintained scoped shipping answers and cold addressed path winner |
| Offline fleet membership/deadline neighbors | `62a616d61d` | Only affected offline membership/deadline crossings; generic caller debt retained |
| Shipping fallback via containingIssueId | `d56b642ec6` | First demand 3/3 total rows, one issue summary, 46/46 elements; former loop 133/517 issue summaries and 704/2,624 elements; 16 actions flat |
| Changed-key client cache publication (child POD-5589) | `7f403f1f49` | Removes whole-Map draft/cache copies seen in earlier idle capture |

Other overlapping work is already integrated: POD-5561 search `faa18afc8a`, POD-5541/POD-5542 shared machinery/companions (including `f83bd8c29c`), and POD-5621 Conversation `a11ccc804a`. Their changes are reflected in the source snapshot; older synthetic envelopes above are not evidence against their completed guards. Reports/idle captures themselves are evidence, not additional fixes.

## Census coverage appendix

The following table accounts for **all 253 files, 2,306 REQUIRED REPAIR fingerprints and 2,313 occurrences** in C. Paths are relative to the repository root. Each fingerprint appears in its file exactly once in these totals. Multiple disposition IDs mean a file contains helpers serving more than one fix boundary; they do not multiply the count. Main live mechanisms and caller restrictions are described above. C01/C02/F30 preserve conservative debt rather than inventing unmeasured bugs. Traced scans absent from the census, notably F23 and parts of F06/F07, remain in the ranked findings.

| File | Fingerprints | Occurrences | Finding / disposition |
| --- | ---: | ---: | --- |
| `apps/mobile/src/client/MobileSyncBoundary.tsx` | 1 | 1 | F13 |
| `apps/mobile/src/client/connected-devices.ts` | 1 | 1 | F21 |
| `apps/mobile/src/client/issue-fixtures.ts` | 1 | 1 | C01 |
| `apps/mobile/src/client/mobile-handoff.ts` | 1 | 1 | F26 |
| `apps/mobile/src/client/mobile-pool.ts` | 3 | 3 | F30 |
| `apps/mobile/src/client/test-support.tsx` | 2 | 2 | C01 |
| `apps/mobile/src/client/use-inbox-data.ts` | 9 | 9 | F18, C01 |
| `apps/mobile/src/client/use-launch-inputs.ts` | 6 | 6 | F17 |
| `apps/mobile/src/client/use-session-context.ts` | 4 | 4 | F14 |
| `apps/mobile/src/components/ConfiguredIssueLaunchSheet.tsx` | 1 | 1 | F17, C02 |
| `apps/mobile/src/components/LaunchConfigurationFields.tsx` | 20 | 20 | F17, C02 |
| `apps/mobile/src/components/MissionDeck.tsx` | 8 | 8 | F09 |
| `apps/mobile/src/components/NewWorkButton.tsx` | 31 | 31 | F17 |
| `apps/mobile/src/components/SessionConversation.tsx` | 4 | 4 | F07, F14, C02 |
| `apps/mobile/src/components/TaskSheet.tsx` | 1 | 1 | F09, F26 |
| `apps/mobile/src/components/WorkIssueMenu.tsx` | 1 | 1 | F26 |
| `apps/mobile/src/hooks/usePendingQuestion.ts` | 1 | 1 | F07, C02 |
| `apps/mobile/src/hooks/voice-transcript.ts` | 2 | 2 | C02 |
| `apps/mobile/src/lib/agent-models.ts` | 4 | 4 | F17, C02 |
| `apps/mobile/src/lib/configured-issue-launch.ts` | 2 | 2 | F17 |
| `apps/mobile/src/lib/launch-configuration.ts` | 2 | 2 | F17 |
| `apps/mobile/src/lib/mission-session.ts` | 2 | 2 | F09 |
| `apps/mobile/src/lib/new-work.ts` | 1 | 1 | F17 |
| `apps/mobile/src/lib/offer-artifacts.ts` | 1 | 1 | C02 |
| `apps/mobile/src/lib/superagent-transcript.ts` | 2 | 2 | F07 |
| `apps/mobile/src/lib/transcript-feed.ts` | 3 | 3 | F07 |
| `apps/mobile/src/lib/use-issue-detail.ts` | 6 | 6 | F19 |
| `apps/mobile/src/lib/work-sections.ts` | 4 | 4 | F11, F28 |
| `apps/mobile/src/screens/InboxScreen.tsx` | 1 | 1 | C01 |
| `apps/mobile/src/screens/IssueScreen.tsx` | 3 | 3 | F04, F26 |
| `apps/mobile/src/screens/IssuesScreen.tsx` | 1 | 1 | F09, F26 |
| `apps/mobile/src/screens/MissionScreen.tsx` | 1 | 1 | F09, F26 |
| `apps/mobile/src/screens/NewIssueScreen.tsx` | 2 | 2 | F17 |
| `apps/mobile/src/screens/PulseScreen.tsx` | 1 | 1 | F21 |
| `apps/mobile/src/screens/SessionScreen.tsx` | 3 | 3 | F14, F26 |
| `apps/mobile/src/screens/SettingsScreen.tsx` | 4 | 4 | F27 |
| `apps/mobile/src/screens/SuperagentScreen.tsx` | 1 | 1 | F07, C02 |
| `apps/mobile/src/screens/WorkListRow.tsx` | 2 | 2 | F08, F28, C02 |
| `apps/mobile/src/screens/WorkScreen.tsx` | 2 | 2 | F08, F11 |
| `apps/web/src/app/AppShell.tsx` | 1 | 1 | F01, F12, C02 |
| `apps/web/src/app/ApprovalDialog.tsx` | 2 | 2 | C02 |
| `apps/web/src/app/BrowserOpenOverlay.tsx` | 1 | 1 | C02 |
| `apps/web/src/app/CommandPalette.tsx` | 2 | 2 | C01 |
| `apps/web/src/app/FlightDeck.tsx` | 19 | 19 | F03 |
| `apps/web/src/app/FlightDeckHandoff.tsx` | 4 | 4 | F29 |
| `apps/web/src/app/FlightDeckPool.tsx` | 3 | 3 | F03 |
| `apps/web/src/app/FlightDeckWaterfall.tsx` | 49 | 49 | F10 |
| `apps/web/src/app/MachinesPanel.tsx` | 12 | 12 | F21 |
| `apps/web/src/app/MissionCostChip.tsx` | 1 | 1 | F22 |
| `apps/web/src/app/NewPanelMenu.tsx` | 1 | 1 | F17 |
| `apps/web/src/app/RightDock.tsx` | 1 | 1 | F12 |
| `apps/web/src/app/RightRail.tsx` | 1 | 1 | F12 |
| `apps/web/src/app/Workspace.tsx` | 27 | 27 | F15 |
| `apps/web/src/app/flight-deck-waterfall.ts` | 27 | 27 | F10 |
| `apps/web/src/app/header-data.ts` | 2 | 2 | F16, F21, F30 |
| `apps/web/src/app/mission-pane-reader.ts` | 3 | 3 | F03 |
| `apps/web/src/app/panel-deck.ts` | 13 | 13 | F15 |
| `apps/web/src/app/shell-data.ts` | 2 | 2 | F12, F21 |
| `apps/web/src/app/use-desktop-close-tab.ts` | 7 | 7 | F15, C02 |
| `apps/web/src/app/use-handoff-transcript.ts` | 22 | 22 | F29 |
| `apps/web/src/app/workspace-inputs.ts` | 19 | 19 | F15 |
| `apps/web/src/app/workspace-tabs.ts` | 2 | 2 | F15, C02 |
| `apps/web/src/features/automations/automation-form.ts` | 5 | 5 | F20 |
| `apps/web/src/features/chat/ChatComposer.tsx` | 2 | 2 | F06, C02 |
| `apps/web/src/features/chat/ChatView.tsx` | 1 | 1 | F06 |
| `apps/web/src/features/chat/chat-context-check.ts` | 14 | 14 | C01 |
| `apps/web/src/features/chat/chat-context-test-fixture.ts` | 21 | 22 | C01 |
| `apps/web/src/features/chat/chat.ts` | 3 | 3 | F06, C02 |
| `apps/web/src/features/chat/offer-artifacts.ts` | 1 | 1 | C02 |
| `apps/web/src/features/chat/test-support/pool-fixture.ts` | 1 | 1 | C01 |
| `apps/web/src/features/chat/use-attachments.ts` | 1 | 1 | C02 |
| `apps/web/src/features/chat/use-chat-context.ts` | 2 | 2 | F06 |
| `apps/web/src/features/chat/use-chat-send.ts` | 2 | 2 | F06, C02 |
| `apps/web/src/features/chat/use-chat-surface.ts` | 3 | 3 | F06, C02 |
| `apps/web/src/features/cost/useMissionCost.ts` | 1 | 1 | F22 |
| `apps/web/src/features/cost/useTaskCost.ts` | 1 | 1 | F22 |
| `apps/web/src/features/files/TableFilePanel.tsx` | 10 | 10 | F24 |
| `apps/web/src/features/files/file-viewer-check.ts` | 8 | 8 | C01 |
| `apps/web/src/features/issues/IssueCompactControls.tsx` | 23 | 23 | F26 |
| `apps/web/src/features/issues/IssueContextMenu.tsx` | 3 | 3 | F26 |
| `apps/web/src/features/issues/IssuePage.tsx` | 2 | 2 | F04, F26 |
| `apps/web/src/features/issues/IssuePanelView.tsx` | 16 | 16 | F04 |
| `apps/web/src/features/issues/IssuesKanban.tsx` | 5 | 5 | F02 |
| `apps/web/src/features/issues/explorer/IssueExplorerList.tsx` | 2 | 2 | F04, C02 |
| `apps/web/src/features/issues/explorer/explorer-list.ts` | 27 | 27 | F04 |
| `apps/web/src/features/issues/issue-context-menu.ts` | 21 | 21 | F26 |
| `apps/web/src/features/issues/issue-hierarchy.ts` | 7 | 7 | F02 |
| `apps/web/src/features/issues/issue-lifecycle.tsx` | 6 | 6 | F26 |
| `apps/web/src/features/issues/issue-list.ts` | 4 | 4 | F02 |
| `apps/web/src/features/issues/issue-menu-commands.ts` | 11 | 11 | F26 |
| `apps/web/src/features/issues/issue-menu-config.ts` | 18 | 18 | F26 |
| `apps/web/src/features/issues/issue-menu-palette-commands.ts` | 2 | 2 | F26, C01 |
| `apps/web/src/features/issues/issue-menu-palette.ts` | 8 | 8 | F26, C01 |
| `apps/web/src/features/issues/issue-menu-pool-inputs.tsx` | 7 | 7 | F26 |
| `apps/web/src/features/issues/issue-menu-readers.ts` | 6 | 6 | F26 |
| `apps/web/src/features/issues/issue-page-model.ts` | 33 | 33 | F04, F19 |
| `apps/web/src/features/issues/issue-page.ts` | 2 | 2 | F04 |
| `apps/web/src/features/issues/issue-page/IssueBanners.tsx` | 1 | 1 | F04, C02 |
| `apps/web/src/features/issues/issue-page/IssueDetailHeader.tsx` | 6 | 6 | F04 |
| `apps/web/src/features/issues/issue-page/IssueProperties.tsx` | 12 | 12 | F04 |
| `apps/web/src/features/issues/issue-page/IssueRelations.tsx` | 1 | 1 | F04, C02 |
| `apps/web/src/features/issues/issue-page/IssueSessionsBlock.tsx` | 1 | 1 | F04, C02 |
| `apps/web/src/features/issues/issue-page/IssueSubIssues.tsx` | 1 | 1 | F04, C02 |
| `apps/web/src/features/issues/issue-page/issue-edges.tsx` | 3 | 3 | F04 |
| `apps/web/src/features/issues/issue-page/issue-page-data.tsx` | 2 | 2 | F04 |
| `apps/web/src/features/issues/issue-page/use-eviction-guard.ts` | 2 | 2 | F04 |
| `apps/web/src/features/issues/issues-display.ts` | 14 | 14 | F02, F09 |
| `apps/web/src/features/issues/issues-keys.ts` | 4 | 4 | F02, C02 |
| `apps/web/src/features/issues/issues-view-model.ts` | 2 | 2 | F02 |
| `apps/web/src/features/issues/kanban-dnd.ts` | 9 | 9 | F02 |
| `apps/web/src/features/issues/use-issue-status-apply.tsx` | 1 | 1 | F26 |
| `apps/web/src/features/machines/HostMemoryView.tsx` | 4 | 4 | F21 |
| `apps/web/src/features/merge-queue/merge-queue-model.ts` | 2 | 2 | F12, C02 |
| `apps/web/src/features/mobile-handoff/MobileHandoffChip.tsx` | 1 | 1 | F26, C02 |
| `apps/web/src/features/mobile-handoff/MobilePromoCard.tsx` | 1 | 1 | F26, C02 |
| `apps/web/src/features/settings/SettingsView.tsx` | 6 | 6 | F27 |
| `apps/web/src/features/settings/readers.ts` | 4 | 4 | F27 |
| `apps/web/src/features/settings/sections/connected-devices.tsx` | 1 | 1 | F27 |
| `apps/web/src/features/settings/sections/privacy.tsx` | 1 | 1 | F27, C02 |
| `apps/web/src/features/settings/sections/updates-view.ts` | 1 | 1 | F27, C02 |
| `apps/web/src/features/settings/sections/workflow.tsx` | 1 | 1 | F27, C02 |
| `apps/web/src/features/setup/FirstTaskActivation.tsx` | 1 | 1 | F17, C02 |
| `apps/web/src/features/superagent/concierge.ts` | 4 | 4 | F06, F07, C02 |
| `apps/web/src/features/terminal/dock-shell-lifecycle.tsx` | 4 | 4 | F15 |
| `apps/web/src/features/terminal/test-support/presence-mock.ts` | 1 | 1 | C01 |
| `apps/web/src/features/terminal/use-warm-set.ts` | 5 | 5 | F15 |
| `apps/web/src/features/terminal/warm-set.ts` | 11 | 11 | F15 |
| `apps/web/src/features/usage/UsageTasks.tsx` | 1 | 1 | F22 |
| `apps/web/src/features/usage/UsageView.tsx` | 4 | 4 | F22 |
| `apps/web/src/features/usage/useTaskCosts.ts` | 1 | 1 | F22 |
| `apps/web/src/features/worklist/ManageProjectsDialog.tsx` | 10 | 10 | F27 |
| `apps/web/src/features/worklist/UnifiedWorktreeRow.tsx` | 4 | 4 | F08 |
| `apps/web/src/features/worklist/pool-sidebar-rail.tsx` | 17 | 17 | F08 |
| `apps/web/src/features/worklist/pool-sidebar.tsx` | 37 | 37 | F08 |
| `apps/web/src/features/worklist/row-shortcuts.ts` | 4 | 4 | F28, C02 |
| `apps/web/src/features/worklist/sidebar-common.tsx` | 3 | 3 | F08, C02 |
| `apps/web/src/features/worklist/time-indicators.tsx` | 1 | 1 | F28 |
| `apps/web/src/features/worklist/use-pool-unified-work.ts` | 12 | 12 | F08 |
| `apps/web/src/features/worklist/use-sidebar-projects.ts` | 13 | 13 | C01 |
| `apps/web/src/lib/PoolSessionContextMenu.tsx` | 1 | 1 | F26, C02 |
| `apps/web/src/lib/at-mention/mention-sources.ts` | 1 | 1 | C02 |
| `apps/web/src/lib/hooks/use-session-guard.ts` | 5 | 5 | F26 |
| `apps/web/src/lib/issue-chip-liveness.ts` | 1 | 1 | C02 |
| `apps/web/src/lib/ref-miniview.ts` | 13 | 13 | C02 |
| `apps/web/src/perf/kernel-fixture.ts` | 2 | 2 | C01 |
| `apps/web/src/perf/large-state.frontend-perf.tsx` | 11 | 15 | C01 |
| `apps/web/src/test-support/mock-command-launch.ts` | 3 | 3 | C01 |
| `apps/web/src/test-support/mock-screen-pool.ts` | 45 | 45 | C01 |
| `apps/web/src/test-support/normalized-issues.ts` | 11 | 11 | C01 |
| `apps/web/src/test-support/pool-fixture.ts` | 17 | 17 | C01 |
| `packages/client-core/src/conversation/controller.ts` | 9 | 9 | F06, F07, C02 |
| `packages/client-core/src/conversation/projection.ts` | 10 | 10 | F06, F07, C02 |
| `packages/client-core/src/engine/actions.ts` | 18 | 18 | F01 |
| `packages/client-core/src/engine/navigation.ts` | 11 | 11 | F01 |
| `packages/client-core/src/engine/reactions.ts` | 12 | 12 | F01 |
| `packages/client-core/src/engine/runtime.ts` | 13 | 13 | F01 |
| `packages/client-core/src/engine/session-link.ts` | 4 | 4 | F01 |
| `packages/client-core/src/engine/state.ts` | 12 | 12 | F01 |
| `packages/client-core/src/engine/wiring.ts` | 2 | 2 | F01 |
| `packages/client-core/src/focus.ts` | 6 | 6 | F28, C01 |
| `packages/client-core/src/perf/header-perf.ts` | 2 | 2 | C01 |
| `packages/client-core/src/replica/kernel/issue-ref-index.ts` | 2 | 2 | F13 |
| `packages/client-core/src/replica/legacy-wire-v1-feed.ts` | 1 | 1 | F13 |
| `packages/client-core/src/replica/replica.ts` | 6 | 6 | F13 |
| `packages/client-core/src/session-index.ts` | 2 | 2 | F13 |
| `packages/client-core/src/session-values.ts` | 9 | 9 | F28 |
| `packages/client-core/src/socket-transport/socket-hub.ts` | 3 | 3 | F13 |
| `packages/client-core/src/sound/notification-sounds.ts` | 3 | 3 | F28 |
| `packages/client-core/src/spawn-agent.ts` | 7 | 7 | F26 |
| `packages/client-core/src/test-support/normalized-issue-fixture.ts` | 6 | 6 | C01 |
| `packages/client-core/src/transcript/controller.ts` | 1 | 1 | F05 |
| `packages/client-core/src/transcript/merge.ts` | 41 | 41 | F05 |
| `packages/client-core/src/values/ask-question.ts` | 2 | 2 | F26 |
| `packages/client-core/src/values/board-scope.ts` | 15 | 15 | F02 |
| `packages/client-core/src/values/chat.ts` | 1 | 1 | F06, F07 |
| `packages/client-core/src/values/compose/chat.ts` | 1 | 1 | F06, F07 |
| `packages/client-core/src/values/compose/issues.ts` | 22 | 22 | F04, F26 |
| `packages/client-core/src/values/compose/machines/authority.ts` | 7 | 7 | F21 |
| `packages/client-core/src/values/compose/machines/facts.ts` | 23 | 23 | F21 |
| `packages/client-core/src/values/compose/machines/placement.ts` | 10 | 10 | F21 |
| `packages/client-core/src/values/compose/terminal.ts` | 18 | 18 | F15 |
| `packages/client-core/src/values/compose/worklist/nav.ts` | 31 | 32 | F08 |
| `packages/client-core/src/values/compose/worklist/project-order.ts` | 2 | 2 | F08 |
| `packages/client-core/src/values/compose/worklist/row-attention.ts` | 35 | 35 | F28 |
| `packages/client-core/src/values/compose/worklist/row-types.ts` | 7 | 7 | F08, F28 |
| `packages/client-core/src/values/compose/worklist/rows.ts` | 55 | 55 | F08 |
| `packages/client-core/src/values/compose/worklist/session-groups.ts` | 20 | 20 | F08 |
| `packages/client-core/src/values/cost.ts` | 10 | 10 | F22 |
| `packages/client-core/src/values/cursor-order.ts` | 4 | 4 | F08, C02 |
| `packages/client-core/src/values/dock-panel.ts` | 9 | 9 | F01, F15 |
| `packages/client-core/src/values/fleet.ts` | 4 | 4 | F21 |
| `packages/client-core/src/values/handoff.ts` | 64 | 64 | F26, F29 |
| `packages/client-core/src/values/host-session-aggregates.ts` | 1 | 1 | F21 |
| `packages/client-core/src/values/issue-activity.ts` | 1 | 1 | F19 |
| `packages/client-core/src/values/issue-board-filter.ts` | 1 | 1 | F02 |
| `packages/client-core/src/values/issue-board-rows.ts` | 29 | 29 | F02 |
| `packages/client-core/src/values/issue-close.ts` | 2 | 2 | F26 |
| `packages/client-core/src/values/issue-reference.ts` | 1 | 1 | C02 |
| `packages/client-core/src/values/issue-relations.ts` | 6 | 6 | F04, F26 |
| `packages/client-core/src/values/message-notices.ts` | 3 | 3 | F25 |
| `packages/client-core/src/values/mission.ts` | 213 | 213 | F03, F09 |
| `packages/client-core/src/values/operations-status.ts` | 6 | 6 | F25 |
| `packages/client-core/src/values/optimistic-spawn.ts` | 1 | 1 | F26, C02 |
| `packages/client-core/src/values/quota.ts` | 1 | 1 | F21 |
| `packages/client-core/src/values/repository-usage.ts` | 2 | 2 | F22 |
| `packages/client-core/src/values/session-ownership.ts` | 28 | 28 | F01, F15, F26 |
| `packages/client-core/src/values/session-status.ts` | 1 | 1 | F28 |
| `packages/client-core/src/values/session-urgency.ts` | 8 | 8 | F28 |
| `packages/client-core/src/values/shipping-panel.ts` | 2 | 2 | F12 |
| `packages/client-core/src/values/task-state.ts` | 11 | 11 | F26 |
| `packages/client-core/src/values/transcript-compute.ts` | 9 | 9 | F06, F07 |
| `packages/client-core/src/values/tray.ts` | 9 | 9 | F25 |
| `packages/client-core/src/values/unread.ts` | 8 | 8 | F28 |
| `packages/client-core/src/values/usage.ts` | 3 | 3 | F22 |
| `packages/client-core/src/values/workspace-layout.ts` | 99 | 99 | F01, F15 |
| `packages/client-graph/src/automation-views.ts` | 2 | 2 | F20 |
| `packages/client-graph/src/cached.ts` | 1 | 1 | F30 |
| `packages/client-graph/src/chat-context.ts` | 16 | 16 | F14, C01, C02 |
| `packages/client-graph/src/command-launch-source.ts` | 13 | 13 | F17, F30 |
| `packages/client-graph/src/command-launch-views.ts` | 20 | 20 | F17, F30 |
| `packages/client-graph/src/enumerate.ts` | 13 | 13 | F30, C01 |
| `packages/client-graph/src/header-entities.ts` | 1 | 1 | F16, F30 |
| `packages/client-graph/src/header-source.ts` | 1 | 1 | F13, F16, F30 |
| `packages/client-graph/src/header-views.ts` | 19 | 19 | F03, F16, F21, F30 |
| `packages/client-graph/src/issue-board-source.ts` | 15 | 15 | F02 |
| `packages/client-graph/src/issue-page.ts` | 3 | 3 | F04 |
| `packages/client-graph/src/mission-view.ts` | 20 | 20 | F03 |
| `packages/client-graph/src/mobile-inbox-views.ts` | 4 | 4 | F18, C01 |
| `packages/client-graph/src/mobile-screens.ts` | 18 | 18 | F09 |
| `packages/client-graph/src/mobile-settings.ts` | 2 | 2 | F27, F30 |
| `packages/client-graph/src/models.ts` | 6 | 6 | F30 |
| `packages/client-graph/src/notice-views.ts` | 1 | 1 | F25 |
| `packages/client-graph/src/pool.ts` | 1 | 1 | F30 |
| `packages/client-graph/src/query-result.ts` | 2 | 2 | F30 |
| `packages/client-graph/src/reader-queries.ts` | 12 | 12 | F30 |
| `packages/client-graph/src/residency.ts` | 5 | 5 | F13, F30 |
| `packages/client-graph/src/session-pane.ts` | 3 | 3 | F15 |
| `packages/client-graph/src/settings-views.ts` | 2 | 2 | F27, F30 |
| `packages/client-graph/src/shared/cold-index.ts` | 3 | 3 | F13, F30 |
| `packages/client-graph/src/shared/issue-identities.ts` | 1 | 1 | F13, F30 |
| `packages/client-graph/src/shared/reader-questions.ts` | 1 | 1 | F30 |
| `packages/client-graph/src/shared/row-source.ts` | 18 | 18 | F13 |
| `packages/client-graph/src/shared/schema.ts` | 9 | 9 | F13, F30 |
| `packages/client-graph/src/shell-source.ts` | 2 | 2 | F13, F30 |
| `packages/client-graph/src/shell-views.ts` | 42 | 42 | F12, F15, F21 |
| `packages/client-graph/src/superagent.ts` | 4 | 4 | F07, C02 |
| `packages/client-graph/src/worklist/mobile-row.ts` | 13 | 13 | F11, F28 |
| `packages/client-graph/src/worklist/mobile.ts` | 6 | 7 | F08 |
| `packages/client-graph/src/worklist/seat-verdicts.ts` | 1 | 1 | F28 |
| `packages/client-graph/src/worklist/sidebar-row.ts` | 39 | 39 | F08, F28 |
| `packages/client-graph/src/worklist/sorted-lanes.ts` | 1 | 1 | F08 |
| `packages/client-graph/src/worklist/visible.ts` | 28 | 28 | F08 |
| `packages/mobx-helpers/src/keyed-computed.ts` | 24 | 24 | F30 |
| **Total: 253 files** | **2306** | **2313** | All REQUIRED REPAIR entries accounted for |
