# POD-4286 performance code review

Source-only review, 2026-10-04, for POD-5511. Reviewed `integrate/4286-pilot` at **`d57f72dbf3f3fd414da1a7e8ca439dd44f56cddf`**. The initial detailed read was at `d59d5e169c`; the integration changes that arrived during review (reload durability, runtime formatting and working-mark simplification) were subsequently read, and affected citations were updated. Source and issue descriptions were read; no application, tests, builds, benchmarks, browser, or diagnostic harness was run. Production source was not changed. The report and requested tracker records are the deliverables.

The biggest remaining architectural problem is that a local selection can awaken whole-world shell projections and whole-mission presentation work. Moving data into MobX and answering cold questions through indexes has removed important legacy costs, but does not make a broad question, eager projection, or broad React subscription cheap.

## Ranked findings

Impact and confidence are scored 1–5; score is their product. Impact incorporates the operator's order: sidebar switching, mission clicking, chat typing, session tabs, startup, idle. Ties favor that order. An existing issue owning a symptom does not mean its fix has removed the cited mechanism.

**All costs in this report are estimates of work, not new timings.** A code-only review cannot honestly assign milliseconds to JavaScript, React, layout, storage, or GC. The exception is the literal 260 ms click timer. At 1×, I=4,900 issues and S=4,300 sessions; at 4×, I=19,600 and S=17,200. Resident counts H_I/H_S can be much smaller. M is the selected mission's members; L/R are loaded transcript items/rows; A is awaiting mutations; D is draft identities. Increasing the fleet fourfold does not automatically increase M, L, A or D: their scaling scenarios are identified separately. Sort estimates use n log2 n as a comparison-scale model, not an exact engine comparison count. Costs overlap and must not be added to predict end-to-end latency.

| Rank | Finding and first source location | Impact × confidence | When | Estimated cost: 1× → 4× | Existing coverage |
| --- | --- | --- | --- | --- | --- |
| R1 | Closed right rail demands global dock catalogs — `apps/web/src/app/RightRail.tsx:46` | 5×5=25 | Workspace mount, selection, summary updates, idle minute | S projections/~52k sort work → 17,200/~242k; I scans/projections 4,900 → 19,600 | New specific consumer; contributes to POD-5509; related POD-5422 |
| R2 | Activity maximum repeatedly sorts a frontier to skip residents — `packages/client-graph/src/shared/session-activity.ts:65` | 5×5=25 | Issue/root activity query, relevant updates | k rejected winners; up to 4,300 → 17,200 visits; worst frontier sorting superlinear | POD-5509 overlap; resident maxima alone are insufficient |
| R3 | Mission DOM is bounded by expanded data, not viewport — `apps/web/src/app/FlightDeck.tsx:4132` | 5×5=25 | Mission open, fold expansion, update/render/layout | M task rows plus session rows; historical example 230+176 → 920+704 if mission scales 4× | POD-5441 owns windowing; POD-5442 removed eager status menus |
| R4 | Mission-wide props defeat task-row memoization — `apps/web/src/app/FlightDeck.tsx:1839` | 5×4=20 | Session tab pick, fold, changed mission presentation | M memo misses/renders; example 500 → 2,000 if mission grows | POD-5451 broad CPU overlap; separate from R3's DOM bound |
| R5 | Mission single-click waits before navigation — `apps/web/src/app/click-intent.ts:20` | 4×5=20 | Each ordinary mission issue click | **260 ms → 260 ms**, before data/render work | New; mission interaction, not sidebar delay |
| R6 | Phone draft edits wake transcript shell and force web textarea layout — `apps/mobile/src/components/SessionConversation.tsx:380` | 4×5=20 | Every draft keystroke/edit | R row wrappers/comparisons plus one layout sequence/key; illustrative 80 → 320 rows if history grows | New phone gap after desktop POD-5506/POD-5443; WebKit lane adjacent |
| R7 | Filtered queries admit all residents; history warming accumulates — `packages/client-graph/src/reader-queries.ts:249` | 4×5=20 | New query demand, arguments, browsing | H_I/H_S probes; fully warmed ceiling 4,900/4,300 → 19,600/17,200 | Residual after POD-5406; cutoff overlap POD-5212/POD-5407 |
| R8 | Streaming transcript pipeline repeatedly handles whole loaded history — `packages/client-core/src/transcript/controller.ts:163` | 4×5=20 | Transcript deltas, paging, busy streams | Several L passes and full worker clones; illustrative L=200 → 800 with 4× history | New incremental-work gap; worker and DOM tail cap already mitigate |
| R9 | Folded tool runs eagerly compute complete edit diffs — `apps/web/src/features/chat/ToolBatchView.tsx:212` | 4×5=20 | Chat mount on issue/tab switch, changed block graph | Illustrative 20 → 80 near-cap hunks: ≤480k → ≤1.92m LCS cells | New; contributes to POD-5509's chat mount path |
| R10 | Cold start eagerly hydrates kinds, builds target arrays, parses held chats — `packages/client-core/src/engine/runtime.ts:670` | 4×5=20 | Startup, replacement/rescope | ≥9,200 → ≥36,800 entities; one-repo random target order ~6m → ~96m array shifts; cache capped 10k items | POD-5513/POD-5239/POD-5391 own startup; POD-5497 did not remove these paths |
| R11 | Mission rollups repeatedly traverse every row's descendants — `packages/client-graph/src/mission-view.ts:734` | 4×4=16 | Mission mount, changed member contribution | Θ(M×depth), worst Θ(M²); chain M=500 → 2,000: 124,750 → 1,999,000 visits | POD-5451 CPU overlap; POD-5441 alone will not fix derivation |
| R12 | Transcript cache serializes a 200-item shard on every changed frame — `packages/client-core/src/replica/kernel/side-cache.ts:485` | 4×4=16 | Durable transcript updates during streaming | Per stream rate u: up to 200u item serializations/s; same fixed cap at 4× fleet, 4× if busy stream count grows | New persistence contributor; different from R10 startup parsing |
| R13 | Phone search drains all history and web mounts all loaded rows — `apps/mobile/src/components/TranscriptList.tsx:1192` | 4×4=16 | Nonempty transcript search, each older page | H=10k → 40k: ~125 → 500 pages; ~625k → 10m cumulative item visits | New long-history path; native FlatList mitigates DOM |
| R14 | Sidebar gesture still probes every resident issue/session ID — `apps/web/src/features/worklist/use-pool-unified-work.ts:114` | 3×5=15 | Each sidebar selection | H_I+H_S probes; full ceiling 9,200 → 36,800, plus mission-local reads | POD-5509 overlap; not a whole payload-world read |
| R15 | Phone board builds cards for all logical rows before virtualization — `packages/client-graph/src/mobile-screens.ts:255` | 3×5=15 | Screen open, filter keys, affected updates | B card reads/derivations; possible 4,900 → 19,600, despite fixed viewport | New demand gap; SectionList windows rendering only |
| R16 | Palette scores whole catalogs and retains a closed guard roster — `apps/web/src/app/CommandPalette.tsx:368` | 3×5=15 | Palette open/keys; session updates after first open | Up to 9,200 → 36,800 navigation candidates; recent sort ~121k → ~558k | POD-5514 owns latency; POD-5422 whole-list observer overlap |
| R17 | Hidden warm chat pipelines keep shaping streams — `apps/web/src/features/chat/useTranscriptWindow.ts:552` | 3×5=15 | Background output while other tab visible | Up to 2 hidden pipelines plus visible; cap remains 3 at 4× fleet | New scheduling detail; bounded warm-set and hidden clocks already fixed |
| R18 | Pool transaction settlement scans all awaiting work per batch — `packages/client-graph/src/write/transactions.ts:663` | 3×5=15 | Replica batch and outbox transition while pending | A=100 → 400: ~100 → 400 truth reads; possible membership work 10k → 160k | New replacement-log cost after POD-5497; fixed A does not scale with fleet |
| R19 | Issue page waits for and repaints its neighborhood; activity is eager — `packages/client-graph/src/issue-page.ts:344` | 3×5=15 | Issue page switch, neighborhood updates, comment keys | K related rows plus full issue history; same K at 4× unrelated fleet; enlarged histories scale separately | Page catalog narrowing already landed; switch symptom overlaps POD-5509 |
| R20 | Draft dictionary copies depend on accumulated identities — `packages/client-core/src/engine/runtime.ts:1562` | 2×4=8 | Every local/remote draft edit; coalesced save | D properties/key; hypothetical 4,300 → 17,200; persisted nonempty bodies capped at 50 | Residual acknowledged by POD-5506; current D is unknown |

## Sidebar switching: path and remaining costs

The actual sidebar row invokes `createPoolWorkActions.selectIssue`, not necessarily the standalone issue page: `apps/web/src/features/worklist/pool-sidebar.tsx:665` and `:717` → `use-pool-unified-work.ts:140`. It resolves the mission root/members, builds pane candidates, navigates in one gesture, marks the issue read, and changes operator focus (`:141`, `:152`, `:170`, `:180`, `:184`). The resulting workspace can bring in the mission, selected chat and right rail. The context-menu “Open” instead sets `openIssueId` and changes to the issues view (`:223`). These two paths should not be conflated.

The supplied POD-5509 baseline is 0.2–2.3 s, with approximately 790 ms pool/data and 890 ms React work. Those are previous lane observations, not measurements of this review SHA and not attributed to an individual finding here. The code offers several ways to retain both a data floor and a render floor after local fixes: R1/R2/R7/R14 on the data side, and R3/R4/R8/R9 on the mission/chat side. A warm revisit avoids some mount work; it still processes relevant updates and selection changes.

### R1 — shipping badge and dock catalogs

`AppShell.tsx:1061` mounts `RightRail` whenever the workspace is active. `RightRail.tsx:46` calls `useShellShipping` even when the dock is closed or shipping's feature is disabled. `apps/web/src/app/shell-data.ts:56` → `packages/client-graph/src/shell-views.ts:340` → `dock():236`. That asks for sessions, issues, files and shipping lanes before computing a two-number badge.

`sessions():72` filters/sorts every session, reads its summary and copies declared fields; `issues():99` sorts and projects every issue. `dock():253` repeatedly searches crew, `:275` scans issues for containment, `:311` reads all ship orders, and `:330` observes the coarse clock. Any changed subscribed summary field can rebuild the corresponding global projection. This is metadata update work, not a claim that every raw output byte changes every summary. The 60-second tick from `engine/runtime.ts:285` reruns dock selection/scoping even when no data changes. `RightDock.tsx:109` also requests this full projection for every dock tab.

**Estimate:** at 1×, a changed session summary can cause 4,300 field projections and comparison-scale sorting around 52k; an issue summary can cause 4,900 projections. A window/clock change can reuse those arrays but still scan them to resolve scope. At 4× those become 17,200/~242k and 19,600, plus worktree/order work. Structural equality can prevent a React repaint; it cannot eliminate the derivation that precedes equality.

**Fix:** give the badge a scalar projection using the addressed active session/file, its owner, an indexed containment query and repository-local ship orders. Give each tab its own projection and release unused catalogs. A session count in `shell-views.ts:198` also should use cardinality rather than full session values. This specific shell demand survives the old-store deletion and is distinct actionable work beside POD-5509 and POD-5422.

### R2 — resident exclusions defeat the activity maximum

`reader-queries.ts:336` combines a maintained resident maximum with a source maximum, but passes **all resident activity IDs** as exclusions to the latter (`:345`). `shared/session-activity.ts:65` answers exclusions by sorting a growing frontier, taking its best entry, and expanding children whenever that entry is excluded. A long run of recent resident winners therefore walks far into the source heap even though the resident answer is already available.

**Estimate:** if k top candidates are excluded, it visits k+1 entries, or the whole bucket when no cold winner exists. Fully resident single-root ceilings are S=4,300 and 17,200. Summing repeated frontier sorts can reach O(k² log k) in unfavorable heap/exclusion shapes; 4× k can mean roughly 16× or worse work, rather than a constant-time maximum. Actual k and frontier width are unknown; a cold top winner is cheap.

**Fix:** maintain a cold-only maximum or incrementally update eligibility when rows warm/demote. A priority-queue frontier reduces traversal overhead but still does k visits, so it is a weaker fix. POD-5509's repository activity lane overlaps this finding; verify both the resident and excluded-source halves, not only resident maxima.

### R7 — resident candidate widening and lifetime growth

`reader-queries.ts:249` unions all resident IDs with a filtered source answer; `:99` treats any resident row as included. The narrow source-only exceptions are at `:91`. A containing-issue lookup (`issue-page.ts:479`, `header-views.ts:332`), header occupancy (`header-views.ts:111`), reclaim counts (`:446`), or unfiltered issue-session question (`command-launch-views.ts:368`) can process unrelated resident rows. Identity caches are released when unobserved (`reader-queries.ts:137`), so another demand initializes again. Some indexed results are maintained by changed key after initialization; this finding does not claim they rebuild every identity list on every payload delta.

Hydration compounds this: `residency.ts:537` installs requested cold payloads; `:444` retains already-resident rows during updates; `:592` checks warming/inheritance, without demotion after demand disappears. `pool.ts:847` retains a model when its table row remains. Browsing therefore increases H_I/H_S for the signed-in pool lifetime, not only the current viewport.

**Estimate:** 100 warmed issues yield roughly 100 containment probes plus actual candidates. Visiting the full corpus can raise that ceiling to 4,900 at 1× or 19,600 at 4×. Session candidate initialization may grow to 4,300/17,200 and ~52k/~242k sorting scale. Retained payload/model memory also grows with visited rows. These are ceilings, not a measured resident census.

**Fix:** admit source-unknown optimistic identities separately and apply predicates to resident corrections, rather than automatically admitting every resident. Preserve changed-key maintenance. Add demand pins for visible/live/pending targets and a bounded historical payload LRU; evict after final demand release while retaining compact identity/relation indexes. Predicate pruning and payload eviction are complementary. POD-5406 moved readers onto declared questions but leaves this widening; POD-5212's cutoff work overlaps the retention half.

### R14 — global ID probes inside the gesture

`use-pool-unified-work.ts:107` collects the mission's retained sessions, then `:114` walks every resident session key to preserve slice ordering. `selectIssue():155` similarly walks every resident issue key, checking membership before reading mission sessions.

**Estimate:** H_S+H_I membership probes per click, up to 9,200/36,800 at fully warmed 1×/4×. Only mission candidates incur payload reads. This likely has a smaller cost than R1/R2, and should not be described as the deleted legacy whole-world projection.

**Fix:** iterate retained candidate IDs, sorted by the existing order key, and order mission IDs using maintained source order. Preserve tie-breaking and pane selection. POD-5509 owns this gesture path.

## Mission clicking and session tabs

### R3 — unbounded expanded mission DOM

`FlightDeck.tsx:4132` maps every task row; roster payloads also remain mounted when folded in a `0fr` grid (`:1814`). The phone deck maps its spine, root agents and proposals inside `apps/mobile/src/components/MissionDeck.tsx:388`. Viewport size does not bound either deck's logical DOM/tree. Sidebar open groups likewise map all their rows (`pool-sidebar.tsx:449`, `:483`), and regrouping rescans items for each band (`:362`); this belongs to the sidebar/group lanes.

**Estimate:** M tasks plus their expanded/hidden agent rows at 1×, unchanged at 4× unrelated fleet size, or 4M if that same mission grows. POD-5441 records the historical example of 230 tasks, 176 sessions and 13,926 nodes for about 39 on-screen rows; that is existing evidence, not a current count after menu fixes. Proportional 4× content is 920 tasks and 704 sessions, with proportional row-related work; exact current node counts are unknown.

**Fix:** window the spine and roster with overscan, retaining keyboard focus, scroll anchoring and explicit find/search behavior. Release offscreen card/presentation demand as well as DOM. POD-5441 already owns this; POD-5442's lazy menus remove menu roots but leave the rest of each row.

### R4 — broad row invalidation

`mission-view.ts:836` allocates a new context `byId` map and `:839` new presentation entries when mission output changes. `FlightDeck.tsx:4132` passes them to every task. `TaskRow`'s memo comparator (`:1839`) requires their reference equality; preserved row objects from `reuseFlightDeckRows():3093` do not suffice. The global `activeSessionId` comparison (`:1854`) invalidates all tasks on a session pick; the whole folds map (`:1858`, changed at `:3391`) does so on a fold. Guides/rails and lookup maps are also rebuilt when their broad inputs change (`:3139`, `:3277`, `:3302`, `:3342`).

**Estimate:** M memo misses/possible task renders per relevant event, including hidden roster subtrees, rather than old/new highlights and changed rows. Illustrative mission growth 500→2,000 causes approximately 4× task work. A change that structural comparison suppresses before publication does not reach this render path. It is the changed visible mission output and global selection/fold props that matter.

**Fix:** stable per-row presentation computed values; ID-addressed row observers; row-local highlight/fold flags; stable topology-only guide/rail data. Lazy mount hidden rosters. POD-5451 covers the broad mission CPU floor; windowing alone still leaves all visible siblings invalidated.

### R5 — an intentional latency floor

`click-intent.ts:20` sets `DOUBLE_CLICK_MS=260`; `:39` schedules the single action after that timeout. Task rows (`FlightDeck.tsx:1729`), proposals (`:1909`) and mission header (`:3821`) use it. Navigation occurs later in `:3452`. Keyboard activation and the second click commit immediately.

**Estimate:** exactly 260 ms configured delay at both sizes, before scheduling delay, data reads and paint. This alone precludes an under-100-ms ordinary mission single-click response.

**Fix:** focus/show the selected issue immediately, then promote a second click idempotently. Separate fold toggling that must distinguish click intent from immediate inspector feedback; the row's single action currently also toggles its fold (`:4155`). Preserve the double-click contract explicitly. This is new mission behavior work, distinct from forced layout.

### R11 — repeatedly materialized subtree rollups

`mission-view.ts:734` performs a descendant DFS; `walk():745` invokes it for every row and then gathers, filters, deduplicates and sorts that subtree's crew (`:749`). It sorts a complete crew before retaining twelve. Folded/offscreen rows still receive these aggregates. A changed seated-session contribution can rerun `deriveMissionView():826`.

**Estimate:** sum of subtree sizes, normally M×average depth, worst M(M−1)/2. A chain of 500 members costs 124,750 descendant visits, versus 1,999,000 for 2,000 (16×). With fixed depth around four, the corresponding reference count is around 2,000/8,000, plus repeated aggregate passes and sorts. A mission spanning all I in a chain has about 12m/192m visits; that is a shape-dependent upper bound, not today's epic topology.

**Fix:** compose counts, state and bounded crew once in postorder and update changed ancestors. Use DFS intervals/lazy descendant IDs where a complete closure is truly requested. Existing root/mode caching (`:192`) already avoids recomputation on a selection within an unchanged mission; archived histories are separately lazy. POD-5451 is the appropriate existing broad CPU issue.

## Chat typing, streaming and reveals

### R6 — desktop isolation was not ported to phone

`SessionConversation.tsx:380` subscribes to the full controller snapshot, including draft. Its controlled composer receives that draft and calls `setDraft` (`:769`). `conversation/controller.ts:1007` publishes full-state subscribers on each draft edit. The phone also observes the pool draft (`SessionConversation.tsx:203`). `TranscriptList.tsx:901` lacks a component-level memo boundary; the web viewport maps every loaded row (`TranscriptViewport.web.tsx:77`).

Phone web additionally calls `useComposerMeasure` (`Composer.tsx:235`): `composer-measure.web.ts:46` changes flex/height/placeholder and then reads `scrollHeight` (`:57`) in a text-dependent layout effect. That is a write/read layout barrier each edit, even after desktop's native sizing fix.

**Estimate:** R row element/wrapper creations and memo comparisons per key on phone web plus one geometry sequence; illustrative loaded histories of 80/320 rows give approximately 80/320 comparisons per key. Four times as many unrelated issues does not multiply R. Native FlatList reduces row work, but the shell subscription remains. Inner rows and transcript derivations are memoized (`TranscriptList.tsx:559`, `:798`, `:1037`): settled Markdown is not all reparsed per key.

**Fix:** use the desktop draft-free surface subscription for the shell, with an addressed synchronous draft subscriber inside the phone composer. Use native field sizing where supported and retain a scoped fallback. This is a new phone-specific gap; POD-5506 fixed the desktop boundary, and POD-5443's transcript observer does not repair the phone textarea.

### R8 — full-history stream processing

`transcript/controller.ts:163` builds an ID-position map over held items per delta and copies arrays (`:176`). Live append (`:617`) does not trim held history. `useTranscriptWindow.ts:547` submits compute for changed arrays; effect cleanup suppresses stale results, but does not cancel submitted work. `transcript-compute-client.ts:188` sends full input to a shared worker; `transcript-compute.worker.ts:131` rebuilds graph/Markdown-source lists and returns full results. The graph cache holds the most recent source, so alternating sessions can displace each other.

`use-chat-send.ts:168` maps blocks into another transcript bridge. `conversation/controller.ts:896` scans all user items and patches even when none is new; `conversation/projection.ts:204` creates a transcript ID set and surface snapshot. These steps remain after removing the old replica publisher.

**Estimate:** several L passes, an L-reference copy and full input/output structured-clone bytes per changed frame. An illustrative 200→800 loaded-item history causes about 4× each pass and clone at the same event rate. Live growth can exceed the initial window; the rendered 300-row tail cap is not a held-history cap. Workers reduce main-thread parsing but do not eliminate copies, queued stale jobs or main-thread result processing.

**Fix:** retain ID-position/pairing/graph state incrementally; send keyed changes/revisions and return stable unchanged row identities. Coalesce latest pending work per session, prioritize visible sessions, and suppress bridge/projection publication when relevant user/delivery state has not changed. Preserve cached Markdown DOM islands (`ChatBlockView.tsx:202`, `:326`).

### R9 — diff work before expansion

`ToolBatchView.tsx:212` derives complete edit paths and diffs for all blocks; `:231` calls `toolEditUnifiedDiff(edit,2500)` before checking expansion at `:260`. `values/tool-edit.ts:112` and `:142` construct diff lines before capping them (`:165`); replacement hunks use an LCS table up to 24,000 cells (`:228`). Larger hunks have a fallback.

**Estimate:** E near-cap hunks × up to 24k cell evaluations plus parsing/string creation. Illustrative E=20/80 yields up to 480k/1.92m cells on a mount or refreshed block array. A 2,500-line output cap bounds output, not the preceding work. Actual E is unknown; a session without edits avoids it.

**Fix:** compute cheap edit identity/path metadata while folded; build/cache text when the diff sheet opens. Key the cache by immutable edit content/revision so unrelated appends preserve it. This is new eager work on the issue/session chat mount path.

### R12 — persistence coalesces after stringification

`replica/kernel/side-cache.ts:485` keeps the newest 200 transcript items and calls `writeJson` at `:490`; `:169` stringifies synchronously before backing storage/coalescing. Thus a native async storage adapter does not remove main-thread JSON work on each changed cache frame.

**Estimate:** at event rate u, up to 200u item serializations/sec per busy conversation, with cost proportional to text bytes. The 200-item cap stays fixed at 4× fleet size; four times as many simultaneously updated chats multiplies aggregate work about 4×. Four times longer messages can similarly increase bytes without changing item count.

**Fix:** coalesce before serialization and flush the latest snapshot at a bounded cadence, with explicit close/background flush semantics. Prefer incremental item shards where supported. Keep crash/offline durability guarantees explicit. This is distinct from eager cache parsing at startup.

### R13 — phone transcript search is exhaustive by construction

`TranscriptList.tsx:1192` calls `onLoadOlder` while search is nonempty and paging remains; item growth retriggers it. Pages are 80 items (`SessionConversation.tsx:231`). Each larger array rebuilds the transcript feed (`TranscriptList.tsx:1037` → `lib/transcript-feed.ts:62`), and `TranscriptViewport.web.tsx:77` maps all rows in a ScrollView. Native uses FlatList (`TranscriptViewport.native.tsx:50`).

**Estimate:** H/80 requests and approximately H²/(160) cumulative shaping/prepend visits while draining. Illustrative H=10k/40k gives 125/500 requests and ~625k/10m visits (16×). Web also retains H shaped-row subtrees, subject to grouping; native virtualization bounds mounted rows. Increasing unrelated fleet size leaves a fixed session history unchanged.

**Fix:** bound automatic deepening, or use indexed/server transcript search and fetch neighborhoods around hits. Window phone web rows with anchoring. Keep “search older history” an explicit continuation rather than an automatic complete download.

### R17 — warm tabs retain more than transport

`PanelDeck.tsx:139` keeps warm panels mounted with `active=false`. `AgentPanel.tsx:1281` still starts background chat transcript subscriptions; `useTranscriptWindow.ts:315` and compute effect `:552` have no active gate. Matching preview frames also call React state setters (`use-turn-preview.ts:76`). Hidden feeds can therefore shape worker results and render tool rows.

**Estimate:** the desktop cap is three resident panels (`use-warm-set.ts:15`), so at most two hidden plus one visible pipeline in this budget, at both fleet sizes. If those three histories grow fourfold, their per-event work grows roughly 4×; this is not 4,300 mounted chats. Hidden clocks and heartbeat/activity reads already stop or gate (`useNow.ts:17`, `useTranscriptWindow.ts:495`, `:514`).

**Fix:** retain transport/controller state but suspend hidden React/worker presentation publication. Mark the surface dirty and reconcile once on reveal. Prioritize the newly selected tab over hidden work.

### R20 — draft identities accumulate outside the saved-body cap

`engine/runtime.ts:1562` spreads the entire `state.drafts` dictionary for one draft update. Persistence is coalesced (`:1621`), and nonempty saved drafts are capped at 50 (`:323`). Cap removal deletes ledger entries but does not prune the state dictionary (`:1657`); `draft-ledger.ts:198` also walks ledger entries, skipping empty content after visiting it.

**Estimate:** D properties copied per key. At hypothetical D=4,300/17,200 that is the corresponding property work; current D is unknown and can be small. The 50-body persistence cap means it would be false to claim that every save serializes all 4,300 draft bodies.

**Fix:** addressed draft entries/Map storage, prune empty identities when safe, and maintain dirty keys or bounded persisted shards. Preserve draft survival across reload/offline and local edit ordering. POD-5506 deliberately left runtime persistence intact, so desktop per-key render isolation does not remove this copy.

## Startup, other screens and idle

### R10 — three eager startup paths remain

**Compatibility projection.** `engine/runtime.ts:670` calls `replica.hydrate()` and discards its result. `replica/kernel/facade.ts:552` projects all kinds. Even an earlier request for a missing kind (`:400`) invokes `cache.readEntities()`, constructs all missing kind arrays, sorts them and seeds the reference index. `issue-ref-index.ts:13` performs two full record passes.

**Estimate:** N≥9,200/36,800 normalized issue/session entities, plus messages/events/companions; at least one N scan and two N reference-index passes. Issue/session sorting alone has comparison-scale work ~112k/523k. Removing the explicit hydrate call alone does not fix the earlier all-kind build. **Fix:** readiness separate from projection; requested-kind lazy materialization; unsorted keyed iteration/compact inputs for graph setup; issue references sourced from issue/repo identities only.

**Cold target arrays.** `shared/row-source.ts:1122` builds full joined session/issue/worktree snapshots (`:851`); `shared/cold-index.ts:660` replaces the reader index. `shared/reader-questions.ts:223` lowercases target titles and calls sorted insertion. `addTarget():107` uses binary search plus array `splice`. This phone-target metadata is built on desktop without a target-picker demand.

**Estimate:** expected shifts with random insertion order relative to sequence are sum over paths n_p(n_p−1)/4. One repository with 4,900/19,600 eligible issues gives ~6m/96m shifts; reverse order doubles that, already-sorted order largely eliminates shifts. Distribution/order are unmeasured. Also I lowercasing operations. **Fix:** bulk collect and sort per path once on replacement; keep incremental insertion for individual deltas; initialize optional target search metadata on demand.

**Transcript cache.** `replica-assembly/assembly.ts:244` constructs the side cache before visible conversation choice. `replica/kernel/side-cache.ts:406` parses every retained shard via `readJson():100`, up to 50 windows of 200 items. **Estimate:** up to 50 parses/10k items at either fleet size; text bytes can grow independently. **Fix:** load the small LRU index first; read windows on demand; optionally prefetch a few after first paint.

These mechanisms fit POD-5513's startup investigation, with POD-5239/POD-5391 related. The request cites 1.9→3.3 s; POD-5513 describes a different matched baseline, 2.5→3.3 s at an older SHA. Neither pair is evidence that a specific mechanism above causes the latest regression. POD-5497 removed legacy ordinary whole-kind publishing, not all these startup paths.

### R15 — phone board visibility does not narrow card demand

`apps/mobile/src/screens/IssuesScreen.tsx:133` → `hooks.ts:140` → `mobile-screens.ts:84` enumerates matches/ancestors, sorts and builds sections. `:255` requests `issueBoardCard` progress/fleet/session presentation for every logical row. Stage folds apply later (`IssuesScreen.tsx:396`) and SectionList renders at `:420`; there is no visible-ID demand feeding the reader.

**Estimate:** B card reads and fleet/progress derivations per aggregate update, up to I=4,900/19,600, although filters/closed trees often reduce B. A fixed screen viewport does not reduce this derivation. This is not a claim of I simultaneously mounted native views.

**Fix:** separate membership/order/counts from card presentation; mounted/viewable rows demand their own cards. Apply stage collapse before presentation demand and keep only explicit ancestors. Existing phone pool migration preserved output but left this aggregation broad.

### R16 — palette preparation and a retained closed observer

`apps/web/src/app/CommandPalette.tsx:368` builds navigation commands and duplicate recent candidates for eligible issues/sessions. `:410` globally sorts recents before taking six. `apps/web/src/app/command-palette.ts:174` scores all commands, repeatedly partitions per group, sorts matches and then takes six tasks/five agents; zero-cap groups are still scored at rest. The synchronous query call is at `CommandPalette.tsx:709`; scoring repeatedly lowercases fields (`command-palette.ts:125`). Rendered result counts are already bounded.

After first opening, `CommandPaletteBoundary.tsx:17` retains the component; `CommandPalette.tsx:152` still reads guard sessions when closed. `command-launch-data.ts:67` → `command-launch-views.ts:103` updates entries, copies the full session answer (`:124`) and structurally compares it (`:101`) on observed updates. It can perform event CPU while visually idle.

**Estimate:** up to I+S=9,200/36,800 eligible navigation candidates, plus duplicates/static actions; recent sorting scale ~121k/558k. Label/keyword scoring and repeated group partitions are linear in this candidate count per key. Eligibility lowers actual work. Closed guard publication can copy/compare S=4,300/17,200 entries, though changed entry reads are keyed.

**Fix:** pre-normalize row search fields, use indexed questions, maintain bounded recents/top-k matches, skip zero-cap groups before scoring, and release the closed guard roster or make it target-specific. POD-5514 already owns palette/group latency; its latest notes say palette median is already below the old baseline, so this code finding is not a claim that current palette timing still regresses. POD-5422 covers always-mounted broad observers.

### R18 — awaiting transaction work on unrelated batches

`write/transactions.ts:663` invokes `settle()` before filtering batch addresses. `settle():395` scans awaiting targets and reads their truth, with further full pending/spawn scans (`:331`, `:369`). Retirement uses `includes`/`some` (`:419`, `:426`, `:431`). Queue transitions reconcile/adopt/sort pending work (`:642`); shipping `engine/kernel-outbox.ts:408` publishes even sending/accepted changes to every subscriber (`:477`).

**Estimate:** with A=100 distinct awaiting rows, an unrelated batch can cause about 100 truth reads plus roughly four awaiting passes. A=400 gives about 400 reads/1,600 checks; nested membership retirement can reach A², approximately 10k/160k comparisons. Fixed A or empty pending state does not become 4× more costly merely because I/S grows. This risk matters during offline/reconnect or many optimistic commands with frequent unrelated agent metadata.

**Fix:** address/mutation indexes for awaiting/spawns, settle only changed keys, reserve full sweeps for replace/expiry, use sets for retirement, and emit overlay-relevant keyed queue changes. The old JSON-array `outbox.ts` is not the shipping kernel queue and is excluded from this finding.

### R19 — issue page neighborhoods, eager history and broad composition

The latest page correctly avoids the global issue catalog while selectors are closed (`issue-page.ts:408`; `issue-page-data.tsx:36`). What remains is `data():344` requesting complete child issue presentations (`:361`), walking all reachable spin-offs (`:378`), gathering related sessions (`:395`), ancestor references (`:417`) and presence before returning. One slow/loading related row can hold the page behind `LOADING` (`:400`). The memo releases when unobserved (`:67`), so visits can rebuild these page values. `worktreePaths():129` additionally scans resident worktrees for title derivation.

`pool-issue-page.tsx:19` supplies a page-wide context and plain `IssuePageBody`. Relevant neighborhood changes can repaint all sections. Both mobile-hidden and desktop-hidden properties trees are mounted (`IssuePage.tsx:269`, `:302`), each with hooks and merge-style fetch (`IssueProperties.tsx:121`); CSS hiding is not demand release. Comment text lives at page level (`IssuePage.tsx:94`, `:286`), so each comment key rebuilds the composition and activity feed (`issue-page-model.ts:281`). This is the issue-comment composer, separate from agent chat.

History is fetched on each open: comments and mail refetch on any `updatedAt` (`issue-page-model.ts:134`, `:157`), and events drain in 200-item pages to the end (`:183`, `:219`). Each absorb rebuilds a seen-ID set over existing events (`:191`); `values/issue-activity.ts:200` sorts the complete feed, `IssueActivity.tsx:311` regroups it, and `:353` renders all day entries/mail (`:76`). Hidden bookkeeping events are filtered for display, but are still fetched/visited.

**Estimate:** K neighborhood payload/session work on open; a fixed K does not scale with unrelated 4× fleet. If one issue's history has H=2k/8k events, the 200-page drain costs 10/40 requests and cumulative seen-set work on the order of H²/(400), about 10k/160k visits, plus repeated feed sorts/renders. A comment key can sort/process H rows again. These are illustrative histories, not observed operator counts. Two properties trees approximately double that subsection's mount/update work at either fleet size.

**Fix:** progressively render the selected issue's core, give sections their own addressed subscriptions/loading states, request child cards/sessions only when visible, cache/page history with bounded initial demand, refetch on actual comment/mail changes, and maintain ordered feed/seen IDs incrementally. Put comment state inside its composer and mount one responsive properties surface. Do not undo the newly landed catalog narrowing. The switch symptoms belong beside POD-5509, but these page-local costs are narrower than the former whole-world catalog.

## Existing fixes and idle conclusions

| Lane | What was checked | Remaining overlap |
| --- | --- | --- |
| POD-5509 | Sidebar gesture, issue page, activity and ensuing workspace/chat | R1/R2/R7/R14 are data contributors; R3/R4/R8/R9 can be downstream render/mount work. Keep the whole click budget; avoid duplicate sidebar implementation issues. |
| POD-5442 | Lazy `IssueStatusPicker` roots landed at `6009e5acaa` | Eager status menus are excluded. R3/R4 concern remaining rows, hidden rosters and subscriptions. |
| POD-5443 | Transcript observer change and measurement handoff landed (`9f9be4d761`, `c0156bfcf2`) | Prior synchronous scroll-controller geometry is excluded. Phone composer sizing is separate. Remaining ChatView mount geometry already has Proposed POD-5523; no duplicate filed. |
| POD-5506 | Draft-free desktop surface, native sizing, latest caret synchronization through `071b0dfaca` | Removed transcript-per-key desktop path is excluded. R6 phone isolation and R20 draft dictionary copies remain; settled Markdown memoization is acknowledged. |
| POD-5508 | WebKit mask/compositing lane, still in progress | Do not label its already identified SVG/mask costs new. No source-only claim of its current latency or visual acceptance. |
| POD-5497 | Old publisher/slices/ledger deleted (`e22a8b6bd93`) | No legacy whole-kind ordinary publication finding. Remaining facade startup, kernel cache, conversation pipeline and PoolTransactions are active replacements. |
| Other known work | POD-5441 windowing, POD-5451 mission CPU, POD-5513 startup, POD-5514 palette/groups, POD-5422 broad subscribers, POD-5212 cutoff | Reuse these scopes; the new follow-ups identify distinct, concrete gaps rather than reopening completed migrations. |

At idle with no incoming data, the strongest source-visible unnecessary work is R1's minute-driven global dock scoping and mounted offscreen surfaces. With busy agents but no operator interaction, R1, R12, R16 and R17 perform work while the user is idle. No evidence supports claiming that all 4,300 sessions poll or all rows rebuild on every clock tick: `client-graph/src/clock.ts:103` notifies crossed deadlines only, header bookkeeping is incremental (`header-sessions.ts:109`), hidden panel clocks stop, and transaction expiry schedules a single next deadline (`transactions.ts:467`). Animation/compositing costs and exact idle CPU cannot be quantified without execution, which this review deliberately did not do.

## Follow-up tracking

Eight distinct new findings are filed as unclaimed sub-issues under POD-5076, with `discovered-from` edges to POD-5511. Existing overlap issues are left in their current scope/stage. No production fixes are included in this review.

| Finding | New sub-issue |
| --- | --- |
| R1 | POD-5529 — Shell badge catalog demand |
| R5 | POD-5531 — Immediate mission click feedback |
| R6 | POD-5532 — Phone composer update isolation |
| R7 | POD-5533 — Resident query candidate bounds |
| R8/R17 | POD-5534 — Incremental transcript stream processing |
| R9 | POD-5535 — Lazy collapsed tool diffs |
| R12 | POD-5536 — Transcript cache serialization cadence |
| R15 | POD-5537 — Phone board visible demand |

R3/R4/R11, R10 and R16 are left with their existing mission, startup and palette scopes. Lower-ranked R13/R18/R19/R20 are documented for triage rather than starting more lanes. The top ten were sent to POD-4286 by issue mail (`msg_f8297cef-30c6-4773-a935-8b725012a151`). Validation is source review only, as requested; no runtime speed or acceptance claim is made.

Delivery limitation: automatic approval review rejected full-report artifact upload as data sharing without specific authorization. The document remains in the requested owning-worktree path; permission to attach it is pending. Direct notification to POD-5509 was also rejected because only POD-4286 was an explicitly authorized mail destination; no other lane mail was sent. Its relevant findings are already included in the authorized coordinator summary.
