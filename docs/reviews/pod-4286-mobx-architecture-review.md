# MobX data layer: architecture review (POD-5417, 2026-10-03)

**Scope.** `packages/client-graph` (pool, models, relations, residency, enumerate, row source, cold index,
host, worklist, readers, sources), the web and mobile pool adapters (`apps/web/src/app/pool-*`,
`apps/web/src/lib/*-data-layer.ts`, `apps/mobile/src/client/mobile-pool.ts` and the pool hooks), the startup
switches, and how React reads the pool. Includes the seam to `packages/client-core` where the pool depends on
it. All `file:line` references are at `ea5214c4c5` (`integrate/4286-pilot`).

**Bar.** All data is local and every change is incremental, so most clicks should be close to instant.
Any work on a click or a single row change that grows with TOTAL data (all issues, all sessions, cold
history) instead of with what changed and what is visible is a defect.

**Method.** I read the core myself (`pool.ts`, `tables.ts`, `enumerate.ts`, `create.ts`, `cached.ts`,
`models.ts`, `relations.ts`, `residency.ts`, `shared/row-source.ts`, `shared/cold-index.ts`,
`shared/overlay-row.ts`, `worklist/visible.ts` filing). Three read-only helper reviews covered the readers
and worklist, the app adapters and React, and the inputs, writes and old-store seam. I re-read the code
behind every finding in the top half of the list (1–14) before including it. Lower findings marked
*medium* were traced but not fully proven.

**Evidence labels.** **READ** = from code. **RUN** = measured in this review. **This review ran nothing**:
the `bench:flatblock` lease had a queue three deep during it. Two numbers come from a census already
recorded in the repo, and they are labelled as recorded: `packages/worklist-proto/harness/src/tracking-counts.baseline.json`,
last updated by POD-5388 at `117b440bc4`.

**Owners.**
- POD-5416: overlay-row Proxy.
- POD-5405: cold row indexes.
- POD-5406: readers onto cold queries.
- POD-5407: resident-only attach.
- POD-5403: warm-start read-state marker.
- POD-5081: mobile issue and mission screens.

"none" means no lane covers the finding today.

## Verdict

The pool is much better than the round-three prototype. At 1x first paint the recorded census shows
11,237 computeds and 2,450 reactions for 732 visible rows (READ, recorded baseline). The prototype had
89,637 computeds and 8,448 reactions. Models are built on first access. Groups are cached per object and
dropped when unobserved. The row feed is row-granular, and each publication is one action. The parts the
old review called sound are still sound: the schema as data, kernel rows by reference, `DeadlineClock`,
pure roll-up combines, and the read-state lane.

What still breaks the bar is not the core tables. It is six recurring shapes:

1. **Coarse inputs.** Single observables bundle unrelated values: the shell, header, command and mobile
   session "window" rows, a global epoch, and a repo slot that holds a whole lane. A click, a tick or an
   outbox change therefore wakes computeds that hold whole lists.
2. **Per-selection whole-subtree recomputes.** These are keyed by the selected id, or not cached at all:
   the mission pane, the navigation `activityAt` walk, the header `folded` closure, and the mobile
   long-press. A click costs O(mission and its history).
3. **Always-mounted subscribers to whole lists.** Root components keep "every known session/issue"
   readers alive for the app's lifetime, only to answer an event-time lookup or a count. POD-5406 fixes
   the readers but not the subscribers.
4. **Work that follows memory, not the screen.** Every in-memory issue has a filing reaction. That
   reaction keeps its visibility graph alive, and the graph walks the issue's whole session history. One
   heartbeat re-derives every nest ancestor. The pool still rides on the legacy whole-kind publish.
5. **The same machinery written many times.** There are seven or more hand-written `computedFn` copies
   built on a private MobX API. There are 17 hand-written sources from two copied templates, and five
   copies of the relation-bucket logic. The cold rule's state is mirrored in three places, and two
   optimism systems exist.
6. **Contracts that live in comments.** The untracked-read inventory is incomplete. The per-screen
   schemas are not interpreted by any code. Hooks are only reactive inside an `observer` caller.

The structural guards in the last section would stop each shape from coming back. The cheapest one with
the most leverage is a **per-click work counter** in the speed gate, run over every pool screen. Today the
counter exists for the worklist arm only.

## Findings, ordered by impact

| # | Severity | Finding | Owner |
|---|---|---|---|
| 1 | blocks instant clicks | Coarse "window" rows make clicks, ticks and edits wake whole-list computeds | none (commandWindow known) |
| 2 | blocks instant clicks | Mission pane re-derives the whole mission per click; mission memos are never released | none |
| 3 | blocks instant clicks | Navigation re-walks the whole formal subtree, uncached, several times per click | none |
| 4 | blocks instant clicks | Header `folded` walks the mission closure and loads every member session per selection | POD-5406 (in part) |
| 5 | blocks instant clicks | Mobile long-press builds every issue and session and queues cold children | none |
| 6 | blocks instant clicks | Overlay Proxy: per-read indirection and a fresh identity per read | POD-5416 |
| 7 | blocks instant clicks | Always-mounted components keep whole-list readers alive | POD-5406 (readers); subscribers none |
| 8 | scales badly | One filing reaction per in-memory issue keeps the worklist graph and its session history alive on every screen | POD-5407 (in part) |
| 9 | scales badly | One session heartbeat re-derives attention and the sidebar row of every nest ancestor | none |
| 10 | scales badly | Sidebar `sections` is one computed over all bands, with copies per caller | none |
| 11 | scales badly | Every issue publication re-syncs all of that issue's cold sessions in the roster | none |
| 12 | scales badly | Companion joins: one machine or repo change re-emits every joined row, cold included | none |
| 13 | scales badly | The pool still rides on the legacy whole-kind publish | none (epic level) |
| 14 | scales badly | The cold rule's state is mirrored three times | POD-5407 (in part) |
| 15 | scales badly | `createPoolProjection` recomputes and deep-compares every mounted reader, hidden tabs included | none |
| 16 | scales badly | Mobile Work first paint waits on roll-up loads in every band | none (POD-5407 adjacent) |
| 17 | scales badly | `PreferenceSource` re-reads every key ever demanded on any ui-state change | none |
| 18 | complexity | `computedFn` hand-written seven times on a private MobX API, with deep equality and silent full recompute | none |
| 19 | complexity | Two optimism systems; the pool's write stack is harness-only but sits in the hot reader | none |
| 20 | complexity | `MobxPool` and `IssueModel` hold screen concerns; `row()` serves data, services and stores | none |
| 21 | complexity | 17 hand-written sources, non-executable screen schemas, repeated relation and index code | none |
| 22 | complexity | The untracked-read inventory is incomplete | none |
| 23 | complexity | Duplicate rules, several of which already disagree | none |
| 24 | complexity | Measurement scaffolding and diagnostics in the product path | none |
| 25 | complexity | Five React integration idioms; hooks reactive only inside observers | none |
| 26 | complexity | 16 switches, 98 legacy hook twins, three-way dispatchers | none |
| 27 | complexity | The row source silently swallows a pool's apply error | none |
| 28 | complexity | The sidebar roster keeps a second deadline clock | none |
| 29 | style | Smaller items | none / POD-5416 |

---

### 1. Coarse "window" rows make clicks, ticks and edits wake whole-list computeds

- **Severity:** blocks instant clicks
- **Where:**
  - `packages/client-graph/src/shell-source.ts:25`, with readers at `shell-views.ts:33`, `:132-152`, `:154-190`
  - `header-source.ts:40-44`, with the reader at `header-views.ts:171-205`
  - `mobile-session-context.ts:105-131`
  - the known `commandWindow` row
- **Evidence:** READ.
  - `this.change('shellWindow', 'window', { view, paneA, selectedIssueId, selectedWorktree, reposLoaded, superOpen, paletteOpen, autoContinuePromptSessionId, coarseNow })`
  - `const window = { view, paneA, fileTabs, outboxSize }`
- **What is wrong:** Several unrelated locals share one observable slot, so a change to any of them is a
  change to all of them.
  - **`shellWindow`** holds nine locals. A selection click, a pane switch, opening the palette or the
    60 s tick each replaces the slot. The shell `dock()` and `chrome()` computeds re-run on every one of
    those. `dock()` scans every known session and every issue. Its result embeds the full issues list,
    so its `compareStructural` deep-compares about 6,100 issue objects.
  - **Header `window`** carries `outboxSize`. A stage click enqueues and later drains, so the header
    `shipping` computed re-runs twice per click even though it reads only `paneA` and `fileTabs`. With no
    pane active, each run walks every known session and issue (`header-views.ts:183`, `:197`).
  - **`mobileSessionWindow`** pairs the replica cursor, which moves on every kernel batch, with
    `pendingSpawnPrompts`. Every `spawnPrompt(id)` reader therefore re-runs on every batch.
- **Best-practice shape:**
  - One observable per local, or per-key rows the way `pool.selection` and the locals channel already
    work (`shared/locals-source.ts`). A computed should depend only on the fields it reads.
  - Never put whole collections in a value compared with `comparer.structural`.
- **Owner:** none. The whole-list loops inside these readers belong to POD-5406, but the coarse rows that
  turn every click into a trigger for those loops have no lane.

### 2. The mission pane re-derives the whole mission per click, and mission memos are never released

- **Severity:** blocks instant clicks
- **Where:**
  - `mission-view.ts:55-59`, `:79-81`
  - `apps/web/src/app/FlightDeckPool.tsx:32-52`
  - `mission.ts:38-47`
- **Evidence:** READ.
  - `full: cachedGroup('missionPaneFull', (node) => deriveMissionView(node.view, node.id, 'full'))`, where
    the node is the **selected** issue's
  - `stops.push(reaction(() => value!.get(), () => {}))`
- **What is wrong:**
  - **The pane is cached per selected issue, not per mission.** Clicking another row of the same mission
    builds a new computed and runs `deriveMissionView` from scratch. That run walks the formal closure
    and spin-offs, reads every member and its sessions, rebuilds rows, tips and progress, and sorts all
    member sessions. The cost is O(mission and its session history) on a click that changed nothing in
    the mission.
  - **Every member heartbeat re-runs the whole pane** while it is open. The default `compareStructural`
    then deep-compares maps that contain overlay Proxies.
  - **One coarse computed wraps the result** in `FlightDeckPool.tsx`. It runs `reposToViews` over every
    repo scan to find one repo, and swaps the whole deck for `SettlingDeck` whenever any part answers
    LOADING.
  - **Mission memos are never released.** `mission.ts`'s `memo` pins every `rootFor(id)` and
    `members(rootId)` computed with a no-op reaction until pool dispose. The click handler, the navigation
    provider, the issue page and the pane all call it. The set of permanently live computeds therefore
    grows with every issue and mission the user visits, and each one re-runs on any change to the buckets
    it read, cold history included.
- **Best-practice shape:**
  - Cache the pane by mission root and mode, with the selection as a separate cheap input.
  - Use the drop-when-unobserved memo (`cachedGroup`) for `rootFor` and `members`. Never keep a computed
    alive with a dummy reaction.
  - Split the deck computed into the mission, an addressed repo-by-path lookup, and machines. Show
    loading per row, and keep the last good value.
- **Owner:** none. POD-5416 owns the Proxies at `mission-view.ts:91/163`, and POD-5406 owns `:846`.

### 3. Navigation re-walks the whole formal subtree, uncached, several times per click

- **Severity:** blocks instant clicks
- **Where:**
  - `apps/web/src/app/pool-navigation-provider.ts:33-48`, `:50-75`
  - `packages/client-core/src/engine/runtime.ts:1036-1056`
- **Evidence:** READ.
  - `activityAt(id) { const stack = [id] ... stack.push(...pool.graph.many('issue', current, 'treeChildren')); for (const sessionId of pool.graph.many('issue', current, ...sessions)) ...`
  - `session(id) { ... for (const key of knownSessionIds(pool)) { const summary = pool.row('session', key, 'summary') ...`
- **What is wrong:**
  - **`activityAt` is a plain function.** It walks every descendant, closed ones included, plus every
    session of every node. If a summary lacks `updatedAt`, it falls back to a full-row load that hydrates
    the cold row.
  - **The navigation watch rebuilds itself on every navigation click.** Each rebuild creates a new
    projection, and the read reactions and the next wake run the walk again. That is several full-subtree
    walks per click, plus a full re-walk on any row change inside the subtree.
  - **Opening a session by its birth ref** sorts and scans every known session. While that ref is
    unresolved, every session change re-runs the scan.
- **Best-practice shape:**
  - A memoised per-issue roll-up computed (latest activity of self, children and seats), so a change
    re-evaluates only its path.
  - Keep the foreground id as an observable input instead of rebuilding the watch.
  - A `displayRef → sessionId` declared query, in ColdQueries or the way `pool.references` works for
    issues.
- **Owner:** none.

### 4. Header `folded` walks the mission closure and loads every member session per selection

- **Severity:** blocks instant clicks
- **Where:** `header-views.ts:85-169`
- **Evidence:** READ. It reads `pool.selection.keys().next().value`, then
  `for (const sid of pool.graph.many('issue', queue[index]!, 'sessions'))` and `pool.row('session', sid)` in
  the default `'load'` mode.
- **What is wrong:**
  - Each selection change re-runs a formal-plus-provenance closure of the mission.
  - It queues a load for every historical session of every member.
  - It restates mission membership with a rule that differs from `mission.ts:105-110` (finding 23).
- **Best-practice shape:** Read crew and asking state from the root's existing attention aggregate and the
  rail's waiting count. Drop the closure walk.
- **Owner:** POD-5406 owns `header-views.ts`. The duplicate membership rule is new.

### 5. Mobile long-press builds every issue and session and queues cold children

- **Severity:** blocks instant clicks
- **Where:** `apps/mobile/src/screens/WorkScreen.tsx:639-664`
- **Evidence:** READ.
  - `[...pool.tables.issue.keys()].flatMap(id => { ... children.filter(child => { const detail = pool.row('issue', child) ...`
  - `[...pool.tables.session.keys()].flatMap(id => pool.model('session', id)?.verdict ...)`
- **What is wrong:**
  - One long-press visits every resident issue and every child of each. The `'load'` mode queues a
    hydration for every closed child.
  - It forces `verdict` on every resident session.
  - It does all of this in an event handler, outside any reaction. Every `cachedGroup` read there is
    therefore a silent full recompute (finding 18).
  - All of this only feeds the legacy-shaped `WorkIssueMenu` props, which then builds a Map over all
    issues (`WorkIssueMenu.tsx:72`).
- **Best-practice shape:** Pass the menu one addressed target, and compute placement and close concerns
  per issue, as the web board's `usePoolGuard` already does (`board-pool-row.tsx:57-69`).
- **Owner:** none.

### 6. Overlay Proxy: per-read indirection and a fresh identity per read

- **Severity:** blocks instant clicks
- **Where:**
  - `shared/overlay-row.ts`
  - `pool.ts:670-672`, `:866-874`, `:313`
  - `models.ts:660-668`, `:464-473`
  - `worklist/sidebar.ts:156`
- **Evidence:** READ.
  - `return pending === undefined ? server : overlayRow(server, pending)`
  - The header comment says "The overlaid object is transient, never stored."
  - `return { ...record, value: overlayRow(record.value, { setupOrder: ... }) }`
- **What is wrong:** The per-field trap cost is known. Two effects make it worse than "a slower read":
  - **Every read of a pending row returns a new object.** Identity equality downstream can never hold,
    so each `cachedGroup` falls back to `compareStructural`, which walks the whole row through the Proxy
    traps. `sameSidebar` does this on every sidebar recompute, including every heartbeat-driven ancestor
    recompute (finding 9).
  - **With settings on, `apply` wraps every session record of every publication in a new Proxy and
    stores it in the table.** `put`'s same-object short-circuit then never fires, a `replace` rewrites
    every resident session slot, and every later field read of every session goes through traps.
- **Best-practice shape:** A plain frozen object built once per (row, overrides) pair and memoised by both
  identities, as the POD-5416 brief says. Compare borrowed rows by identity plus the overlay scalars, as
  `sameAggregate` already does. Keep `setupOrder` in its own keyed map, not on the row.
- **Owner:** POD-5416. The identity and `put` effects should go into its acceptance.

### 7. Always-mounted components keep whole-list readers alive

- **Severity:** blocks instant clicks (once POD-5406 lands, scales badly)
- **Where:**
  - `apps/web/src/components/PodiumLinkHost.tsx:76`, `:233`
  - `apps/web/src/app/shell-data.ts:84-90`
  - `BrowserOpenOverlay.tsx:60-64`, `:92`
  - `AppShell.tsx:409`, `:1109`, `:1116`
  - `RefMiniview.tsx:82-86`
  - `CommandPalette.tsx:142`
  - `NewPanelMenu.tsx:123`
  - `apps/mobile/src/components/NewWorkButton.tsx:74-90`
  - `apps/mobile/src/client/use-session-context.ts:91-107`
  - `issue-page.ts:122-138`
- **Evidence:** READ.
  - `const sessions = views?.sessions(), issues = views?.issues()` in `usePoolLinks`
  - `sessionsRef.current = sessions`, used only in an event handler
  - `sessionCount: crew?.length`
- **What is wrong:** Root components subscribe for the app's lifetime to readers that enumerate every
  known session and issue, sorted and deep-compared.
  - **Link host and browser-open overlay** use the lists only for an event-time `.find`.
  - **AppBody** uses the session list only for a count.
  - **The palette's close guard** keeps the whole launch catalog alive although it needs one issue's
    members at click time. The same applies to the always-mounted New buttons (one web, three mobile).
  - **The root ref-miniview host** subscribes to all sessions even when no miniview is open.
  - **Mobile conversation and terminal screens** take whole issue and session lists only to find one by
    seq or id.
  - **Opening any issue page** subscribes to an `issues()` world built over all ~6,100 known issues.

  POD-5406 makes the readers cheaper. These subscribers would still re-run and re-render on every change
  to any listed row.
- **Best-practice shape:**
  - Resolve event-time lookups imperatively with an addressed read (`pool.row`, a ref index).
  - Serve counts from a count query.
  - Subscribe to catalogs when the menu opens.
  - Give consumers addressed hooks (`useSession(id)`, `useIssueBySeq(seq)`) instead of ported
    `useSessions()` / `useIssues()` lists.
- **Owner:** POD-5406 owns the readers. The subscribers have no owner. The POD-5406 scan counter will not
  see them, because the subscribers are consumers, not readers.

### 8. One filing reaction per in-memory issue keeps the worklist graph and its session history alive on every screen

- **Severity:** scales badly
- **Where:**
  - `worklist/visible.ts:1296-1320`
  - `pool.ts:599-604`, `:919-930`
  - `worklist/visible.ts:596-668` (`membersOf`)
  - `pool.ts:347-391` (the seat list)
- **Evidence:**
  - READ: `reaction(() => { const filing = filingOf(issue) ... represented ... laneMemberIds ... retainedSeatIds ... standing ... }, ({ filing, owner }) => { this.file(id, filing); this.host.fileSidebarOwner?.(id, owner) }, { fireImmediately: true, equals: compareStructural })`
  - Recorded census, 1x first paint: `IssueModel.reactions` 2,429 across `IssueModel.owners` 2,827,
    against 732 visible rows. That is 432 reactions on closed issues and 438 cold issue owners.
- **What is wrong:**
  - **The reaction exists whether the worklist is mounted or not.** Every resident, non-archived issue
    gets one the moment its row enters the table. Header-only, mobile-only and settings screens all pay
    for the whole visibility graph of every in-memory issue: facts, members, presence, nesting and rank.
  - **The graph walks each issue's whole session history.** The seat list is the `issue.sessions`
    bucket, which holds cold members too. `membersOf` builds a `SessionModel` plus a `retention` computed
    for every historical session of every resident issue. The comment at `pool.ts:370` assumes
    "family-small (2-3 ids)", which fails for coordinator and epic issues with hundreds of sessions.
  - **It mixes two jobs.** The reaction also files sidebar roster ownership, building a `Set` and
    filtering the lane on each run.
  - **It is two-phase propagation.** A computed changes, a reaction writes an observable, and another
    computed re-runs. MobX's guidance is to derive with computeds and use reactions for effects.
- **Best-practice shape:**
  - Let the mounted list own the derivation. Either a computed visible set over the candidate set,
    observed only while a list is mounted, or keep the filing reaction but start it when a worklist view
    mounts and stop it when the last one unmounts.
  - Decide session retention at ingest as a declared summary. The seat list the worklist reads should be
    resident seats plus cold seats still inside their window, never closed history.
  - Give sidebar ownership its own computed.
- **Owner:** POD-5407 in part ("relations seed a hot target's cold members lazily"). Whether that removes
  cold ids from the seat list is unconfirmed; POD-5407 should state it. The mounted-or-not part is none.

### 9. One session heartbeat re-derives attention and the sidebar row of every nest ancestor

- **Severity:** scales badly
- **Where:**
  - `worklist/rollup.ts:226-238`, `:318-331`, `:356-367`, `:995-1003`
  - `models.ts:438-473`, `:552-556`
- **Evidence:** READ.
  - The comment at `rollup.ts:999-1001` says "a heartbeat never runs `aggregate`". But
    `attention: cachedGroup('attention', (issue) => attentionOf(...), sameAttention)` returns
    `{ ownAttention, aggregate, seatActivity }` as one cached group.
  - `sessions: [...(own.sessions ?? []), seat.sidebarSession]`
- **What is wrong:**
  - Tables hold borrowed feed rows, so a `lastActiveAt` heartbeat replaces the session's row object. That
    breaks the seat verdict's identity and changes its `sidebarFacts` and activity.
  - The row's attention group then re-runs everything at once: own attention (re-sorting its sessions),
    aggregate (copying the subtree's session array) and seat activity.
  - Because activity and the session arrays both changed, `sameAttention` fails at every level, and the
    re-run repeats for each nest ancestor, each one copying a larger array.
  - Each ancestor's `sidebar` group then fails `sameSidebar` and its row re-renders.
  - The cost per heartbeat is O(depth × subtree sessions), plus a re-render per ancestor.
- **Best-practice shape:**
  - Split seat activity and the session payload into their own groups, away from the phase, working and
    asking flags.
  - Carry session ids (or a version) in aggregates, not row objects.
  - Let the row component read the sessions it draws by id.
- **Owner:** none.

### 10. Sidebar `sections` is one computed over all bands, with copies per caller

- **Severity:** scales badly
- **Where:**
  - `worklist/sidebar.ts:169-236`
  - `worklist/mobile.ts:113-133`
  - `apps/web/src/features/worklist/pool-sidebar.tsx:96-99`, `:158`, `:226-241`
  - `use-sidebar-projects.ts:26-43`
  - `pool-sidebar-rail.tsx:32-33`
- **Evidence:** READ.
  - `let view = this.sectionViews.get(state); if (!view) { view = computed(() => this.sectionValues(state), { equals: compareStructural }) ...`
  - `const repos = [...index.projects].map(path => this.pool.row('worktree', path))...sort(...)`
- **What is wrong:**
  - One computed reads every project's worktree row, every group's rows and every roster band. It
    rebuilds every band object and deep-compares the whole output.
  - Any of these triggers the full rebuild:
    - one row changing lanes (a stage change or a fold crossing)
    - any group's head changing
    - a git-scan update to any of the ~500 resident worktree rows
  - The memo is keyed by the identity of the caller's state object. Each hook instance gets its own state
    object, so up to five equal copies run per change (medium confidence: assumes one selector object per
    hook instance).
  - On mobile, each project header calls `sections().bands.find(...)`, which is O(bands²) per change.
- **Best-practice shape:**
  - Memoise by value (pinned repos, pinned worktrees, order), one per pool.
  - Split into a band-key list plus one computed per band, so a lane move re-runs only its band.
- **Owner:** none.

### 11. Every issue publication re-syncs all of that issue's cold sessions in the roster

- **Severity:** scales badly
- **Where:**
  - `pool.ts:901-905`
  - `worklist/sidebar-roster.ts:126-130`, `:151-193`
- **Evidence:** READ. `this.sidebarRosters.queueIssue(record.id)`, then
  `for (const id of this.pool.relations.many('issue', owner, 'sessions')) { if (!this.seats.has(id)) this.dirty.add(id) }`
- **What is wrong:**
  - Any issue record marks its issue dirty, including a title edit or an `updatedAt` bump.
  - `flush` then re-syncs every session in the issue's bucket that is not a resident seat, which means
    its cold history.
  - The comment calls this cheap ("only cold/absent seats reconsidered"), but cold seats are the bulk.
- **Best-practice shape:** Keep a per-issue set of the cold seats that can still qualify (the per-session
  lane summary exists). Re-sync only when an owner fact those seats read changes.
- **Owner:** none. POD-5407 covers the roster at attach only.

### 12. Companion joins: one machine or repo change re-emits every joined row, cold included

- **Severity:** scales badly
- **Where:**
  - `shared/row-source.ts:437-438`, `:1060-1076`
  - `shared/issue-input.ts:23-48`
  - `shared/repo-from-lane.ts:158-161`
  - `command-launch-source.ts:82-107`
- **Evidence:** READ.
  - `machine: value.machineId ? authority('machines', value.machineId) : undefined`
  - `for (const id of machineSessions.get(address.id) ?? EMPTY) addressed.set(...)`
- **What is wrong:**
  - **Machine and repo fields are baked into every row.** The feed copies the machine row (`name`,
    `loggedOutHarnesses`) into every session and the repo row (`prefix`, `repoPath`) into every issue and
    session. When a harness logs in or out on one machine, every session that ever ran there is
    re-composed, re-emitted and ingested (usually thousands, mostly cold). A repo change does the same.
  - **The pool's `repo` slot holds a whole lane** ("latest lane wins"), so any lane change wakes about ten
    readers that only want `prefix`.
  - **A fresh `repos` RPC array on each machine status change** is walked again by four or five
    adapters, one of them O(repos²) (`command-launch-source.ts:94`).
- **Best-practice shape:**
  - Keep feed rows raw and declare `session.machine` and `issue.repo` as schema relations.
  - Derive the display fields in per-row computeds, so a change wakes only mounted readers.
  - Store the repo row as its own small object.
  - Ingest discovery once as keyed rows.
- **Owner:** none.

### 13. The pool still rides on the legacy whole-kind publish

- **Severity:** scales badly
- **Where:**
  - `packages/client-core/src/engine/replica-binding.ts:154-165`
  - `client-core/src/engine/runtime.ts:1547-1555`
  - `client-core/src/engine/optimism.ts:238`
  - `shared/row-source.ts:1252`
  - `chat-context-source.ts:29-48`
  - `issue-page-source.ts:11-24`
  - `apps/web/src/app/store-worklist-pool.ts:27`
- **Evidence:** READ.
  - `(next as Record<ReplicaKind, unknown>)[kind] = replica.rows(kind)`
  - `const rows = base.slice()`
  - `offs.push(runtime.subscribe(mode === 'overlaid' ? onRuntimePublication : onTruthPublication))`
  - In chat context: `let ids = [...previous.ids] ... this.set(key, { ids })`, where `set` compares
    structurally.
  - In issue page: `epoch.get(); return { kind: owner.replica.exitKind?.('issueProjection', id) }`
- **What is wrong:**
  - **Overlays and locals still arrive through the old publish.** Entity rows reach the pool row by row,
    but optimistic overlays, locals, window rows, discovery and the outbox arrive only through the legacy
    "something changed" publish. About 13 pool adapters subscribe to `runtime.subscribe` and diff
    `getSnapshot()`.
  - **The legacy engine keeps rebuilding whole arrays.** While those subscriptions exist it must keep
    publishing: per batch it re-materialises `replica.rows(kind)`, folds the ledger over whole arrays, and
    rebuilds `sessionViews` over every session. No switch turns that off, so with pool screens on, each
    such publication costs O(all sessions) before the pool's per-row work starts.
  - **Two adapters add whole-history work on top:**
    - `ChatContextSource` copies and structurally compares every issue id and every session id (~11,000)
      on every kernel batch, whether or not the batch touches them.
    - `issueExit` reads the replica untracked behind one global epoch that any issue change bumps.
- **Best-practice shape:**
  - Give the pool keyed inputs for everything it consumes: ledger overlay changes, locals and discovery
    rows. Then switch the legacy publish off path by path.
  - Model `issueExit` on `session-exit-source.ts`, which already uses a per-id demanded set.
  - Have chat context read the pool's own tables and residency instead of a parallel id list.
- **Owner:** none. This is epic-level; it decides when the legacy pipeline can be deleted.

### 14. The cold rule's state is mirrored three times

- **Severity:** scales badly (memory) and complexity
- **Where:**
  - `residency.ts:166-168`, `:935-969` (cold registry, per-row summary, finish deadline, dependents, member
    deadlines, lane state)
  - `relations.ts:202-208`, `:332-334`, `:1084-1097` (plain twins `coldForward` / `coldBuckets`, plus its
    own per-cold-row summary with a different field set)
  - `shared/cold-index.ts:1-40` (POD-5405: rule rows, keeps by owner, lane seats, `via` targets, collapse
    groups)
  - `shared/row-source.ts:308-400`, `:534-700` (join indexes `repoSessions`, `machineSessions`,
    `repoIssues`, `sessionsByOwner`, dependency edges)
- **Evidence:** READ. Each module documents its own per-cold-row copy. `cold-index.ts` says "Nothing here
  restates the rule", but it re-implements lane seating and collapse upkeep, as residency and relations
  each already do.
- **What is wrong:**
  - The kernel already holds every row.
  - Three more modules each keep an incremental, per-cold-row copy of the facts the cold rule reads, and
    each updates it on every publication.
  - They are kept consistent only by gates that compare them.
  - POD-5407's brief changes residency and relations to answer through the row source, but it does not
    say the pool-side registries and twins are deleted. If they stay, the cutoff ends with four copies.
- **Best-practice shape:**
  - One owner of cold facts: the ColdIndex behind ColdQueries. Residency and the relation engine ask it,
    and keep observable state only for resident rows.
  - Treat deleting the pool-side summaries and twins as POD-5407's done condition, measured by a heap
    census.
- **Owner:** POD-5407 in part; the deletion should be added to its acceptance.

### 15. `createPoolProjection` recomputes and deep-compares every mounted reader, hidden tabs included

- **Severity:** scales badly (for readers that return lists)
- **Where:**
  - `runtime-pool.ts:84-113`
  - `host/pool-host.ts:163-180`
- **Evidence:** READ. `!compareStructural(state.snapshot.value, next)`, run inside the reaction on each
  invalidation.
- **What is wrong:**
  - Each mounted projection re-runs its read synchronously at the end of every batch that touches its
    inputs, then deep-compares the result. An `observer` would only schedule a render.
  - Readers that build lists pay the build plus a full deep compare per hook instance. Mobile keeps
    Inbox, Work, Sessions and Superagent mounted, so all of them pay on every change.
  - The hook itself is well built: one reaction per hook, stable readers at all 83 web call sites, and
    disposed at zero listeners.
- **Best-practice shape:**
  - Readers return identities owned by memoised per-row or per-band computeds, so the projection compare
    is a reference check.
  - Keep structural equality for small scalars.
  - Pause projections on unfocused tabs.
- **Owner:** none.

### 16. Mobile Work first paint waits on roll-up loads in every band

- **Severity:** scales badly
- **Where:**
  - `apps/mobile/src/screens/WorkScreen.tsx:669`
  - `worklist/mobile.ts:139-146`, `:177-185`
- **Evidence:** READ. `const loading = booting || pool === null || split.pending > 0`, where `pending`
  sums `issue.aggregate.pending` over every row of every band.
- **What is wrong:** The skeleton holds until every open row's roll-up has nothing pending, including
  rows far below the fold and roll-ups that reach cold children. Time to first paint grows with open work
  and its history.
- **Best-practice shape:** Gate first paint on section structure plus the first viewport's rows, and show
  row placeholders for the rest (`PoolWorkRowSlot` already has a loading view).
- **Owner:** none. POD-5407 is adjacent.

### 17. `PreferenceSource` re-reads every key ever demanded on any ui-state change

- **Severity:** scales badly (mild)
- **Where:** `preference-source.ts:18-36`
- **Evidence:** READ. On any `ui.subscribe` notification it runs
  `for (const key of this.homes.keys()) this.pending.add(key)`. `homes` only grows.
- **What is wrong:** Any ui-state write (a fold toggle, a resize) costs O(every preference key read since
  sign-in), which includes three fold keys per project band ever shown. Its microtask publication is also
  why mobile adds its own optimistic preference overlay (`mobile-preferences.ts:50-90`), a third
  optimism layer.
- **Best-practice shape:** A per-key change signal; drop a key when it becomes unobserved; publish the
  written key synchronously.
- **Owner:** none. Confidence medium.

### 18. `computedFn` hand-written seven times on a private MobX API, with deep equality and silent full recompute

- **Severity:** complexity (with performance traps)
- **Where:**
  - `cached.ts:39-79`
  - `issue-page.ts:35-46`
  - `settings-views.ts:13-22`
  - `automation-views.ts:19-28`
  - `header-views.ts:28-37`
  - `issue-board-source.ts:93-101`
  - `mission.ts:38-47`
  - related private-API reads: `relations.ts:546`, `residency.ts:295`, `:993`
- **Evidence:** READ. `if (!_isComputingDerivation()) return read()`, then
  `computed(read, { equals: compareStructural })`.
- **What is wrong:** The same keyed-computed memo exists seven times, with drift between the copies.
  - **It depends on MobX private internals** (`_isComputingDerivation`, `_getGlobalState`), on a pinned
    MobX 7.
  - **Every copy defaults to `compareStructural`.** Each recompute deep-walks its whole output; for list
    readers that is a walk of thousands of objects per change.
  - **Outside a reaction it silently recomputes from scratch.** That covers every event handler, every
    `useMemo` in a non-observer, and the mobile long-press (finding 5). Nothing warns in production.
  - **One copy (`mission.ts`) never releases its computeds** (finding 2).
  - **Keys are strings.** Some are built with `JSON.stringify(args)`.
  - **`settings-views.ts` nests a computed per session id** inside a computed over all known sessions,
    which means about 5,200 computeds for one list.
- **Best-practice shape:**
  - One shared `keyedComputed(fn, { equals })` on the public API: `onBecomeUnobserved` plus a
    `computed` created inside a tracked read, or `mobx-utils`' `computedFn` once it supports MobX 7.
  - Default to identity equality. Use structural equality only on small results.
  - Make the outside-reaction read loud in development builds, and give event handlers addressed reads
    instead.
- **Owner:** none.

### 19. Two optimism systems; the pool's write stack is harness-only but sits in the hot reader

- **Severity:** complexity
- **Where:**
  - `runtime-pool.ts:125-127`
  - `write/edit.ts`, `write/overlay.ts`, `write/pending.ts`, `write/create.ts`
  - `shared/write-contract.ts` (566 lines), `shared/receipts.ts` (250 lines)
  - `pool.ts:670-672`, `:704-710`, `:762-767`
  - `models.ts:637-639`
- **Evidence:** READ. "A read-only attachment: optimism and every write still belong to the runtime."
  `createWritableWorklistPool` is used only by `packages/worklist-proto`.
- **What is wrong:**
  - **Production optimism is the legacy runtime ledger**, delivered through the row source in `overlaid`
    mode. A stage click goes through: store action, outbox, ledger, `recomputeFor` (`base.slice()` over
    all issues), legacy publish, row source `readPending()` (four passes over the outbox), emit, cold
    index, `pool.apply`.
  - **The pool's own write stack has no production caller.** That is 1,448 lines (`write/*`, the write contract and receipts).
    Yet `MobxPool.row` asks `writes?.pending()` on every row read, `readCursor` checks pending `readAt`,
    and `IssueModel.update` exists but throws in production.
- **Best-practice shape:** Decide the owner of optimism.
  - **If the pool will own writes** (Linear's shape: mutate the model, record the transaction): wire
    `truth` mode and the write seam in production, then retire the ledger fold.
  - **If not:** move `write/*` into the harness, so the pool's reader has one path.
- **Owner:** none. This is a POD-4286 decision.

### 20. `MobxPool` and `IssueModel` hold screen concerns; `row()` serves data, services and stores

- **Severity:** complexity
- **Where:**
  - `pool.ts:219-607`
  - `pool.ts:638-673`
  - `models.ts:483-591`
  - `chat-context-schema.ts:7`, `:18`
  - `mobile-session-context.ts:129`
  - `issue-board-source.ts:795-810`
- **Evidence:** READ.
  - The pool constructs or holds: `sidebar`, `mobileWork`, `sidebarRosters`, `header`, `headerViews`,
    `settingsViews`, `sessionPanes`, `preferenceSource`, `references`, the `firstTask` counters and
    `foldLatch`.
  - `makeObservable` lists 64 members, every one of them as `false`.
  - `row()` dispatches across core tables, header entities, setup sessions, preferences and registered
    sources, with five absent-read modes.
  - `IssueModel` carries `sidebar` and `mobileWork` groups.
- **What is wrong:**
  - **The pool is a composition root and a screen registry at once.** Each new screen edits `pool.ts`.
  - **The class is not MobX-observable at all.** The 64 `false` annotations are noise that hides this.
  - **The entity model knows about the sidebar and the phone work list.**
  - **`row()` is the "one reader" in name only.** It also returns function bags (`chatContextReader`,
    `mobileSessionReader`) and stores (`issueBoardProjection`, keyed by JSON), so the name hides service
    lookups.

  Linear's split is simpler: the object pool holds models with fields and relations, and views and
  stores compute screen state over them.
- **Best-practice shape:**
  - A small `Pool` with tables, relations, residency and `row()` for rows only.
  - Screen indexes registered as views (`pool.sources.view`, as `missionView` already does).
  - Screen groups on the screen's view, not on `IssueModel`.
  - A plain class with no `makeObservable`, with the observable members created as observables.
- **Owner:** none.

### 21. 17 hand-written sources, non-executable screen schemas, repeated relation and index code

- **Severity:** complexity
- **Where:**
  - `shell-source.ts:58-79`, `command-launch-source.ts:124-140`, `notice-source.ts:67-95`,
    `automation-source.ts:53-76`, `header-entities.ts:22-46`
  - the `*-schema.ts` files
  - `issue-reference.ts:103-160`, `issue-board-source.ts:236-280`, `header-sessions.ts:43-67`
- **Evidence:** READ.
  - `header-entities.ts:36`: `const remaining = (members.get(key) ?? []).filter((member) => member !== id)`
    and `:42` `members.set(key, [...(members.get(key) ?? []), id])`, repeated in the other four.
  - `SHELL_SCHEMA`, `NOTICE_SCHEMA` and the rest are referenced only in their own files.
- **What is wrong:**
  - `PoolRelations` already interprets the core schema. Yet five screen sources each re-implement
    relation buckets as copy-on-write arrays, two of them sorting on each add, with differing tracking.
  - The 17 adapters follow two copied templates:
    - "relation table": shell, command launch, notice, automation, header entities
    - "demand + microtask + snapshot diff": nine sources
  - The per-screen schemas' `source`, `key` and `residency` fields are comments shaped like
    configuration. No code reads them.
  - Three modules repeat a further pattern (observe a table, seed by enumerating it, one reaction per row
    writing an inverse index): references, the board's n-gram index, and header sessions.
- **Best-practice shape:**
  - One `defineSource({ schema, readById, addressedKinds, relations })` that the pool interprets, with
    relations registered in `PoolRelations`.
  - One shared "filed index" helper, or computeds keyed by query.
  - Delete schema fields no code reads, or make them executable.
- **Owner:** none. The board n-gram index and `seedHeaderSessions` are in POD-5406's files.

### 22. The untracked-read inventory is incomplete

- **Severity:** complexity (latent correctness)
- **Where:**
  - `clock.ts:24-59` (the inventory)
  - `worklist/visible.ts:695-837` (rescue walk)
  - `models.ts:934-937`, `:976-985`
  - `worklist/sidebar.ts:121-129`
  - `worklist/mobile.ts:190-193`
  - `pool.ts:478-479` with `shared/row-source.ts:1196-1203` (peek)
  - `apps/mobile/src/client/mobile-pool.ts:155-162`
- **Evidence:** READ.
  - `clock.ts:55`: "Nothing else: every table, bucket, forward, lane and overlay read is an observable
    read."
  - `models.ts:935`: `if (untracked(() => this.host.row('issue', this.id, 'mark')) !== LOADING) return this.standing?.parentId ?? null`
- **What is wrong:** The inventory is meant to make every "observe X, read Y untracked" trick auditable.
  It misses these:
  1. **Rescue-walk state.** A mutable `active` map and `cycles` weak map, shared across derivations,
     choose presence's branch, so the answer depends on evaluation order.
  2. **Branches chosen by untracked residency reads** in `parentRef`, `hidden` and the roster. These rely
     on the invariant that only a `replace` makes a hot row cold.
  3. **`selectionEvicted()` mutates state** and is called during an observer render.
  4. **A computed prunes plain maps as a side effect** (`mobile.ts`).
  5. **`peek` reads a cold row untracked inside computeds.** Each read runs `readPending()`, four passes
     over the outbox. It is correct only if every change to a cold row, ledger-only included, comes back
     as a feed record so residency notifies its atom. That invariant is not written down.
  6. **Mobile's `readLaunch` reads a module global** after a tracked row. It is correct only because of
     assignment order.

  None of these is proven wrong today. Each one is a bug waiting for a refactor.
- **Best-practice shape:**
  - List each one with the tracked read it pairs with, or remove it.
  - Make cycle detection a pure function of the tracked parent chain.
  - Make eviction an action triggered by the selection change.
  - Read pending overlays once per flush, not once per peek.
- **Owner:** none. Confidence medium: all of these reads were found, but no staleness was proven.

### 23. Duplicate rules, several of which already disagree

- **Severity:** complexity
- **Where:**
  - close reasons: `views.ts:219-247` vs `shared/schema.ts:596-614`
  - excluded: `worklist/visible.ts:217-224` vs `shared/schema.ts:557-564`
  - "finished": `visible.ts:264`, `rollup.ts:427`, `:537`, `:683`, `:730`, `schema.ts:568`, `:625`,
    `issue-board-source.ts:187`, `:221`, `header-views.ts:154`, `:236`
  - mission membership: `mission.ts:105-110` vs `header-views.ts:108-120`
  - progress: `rollup.ts:888-933` vs `mission-view.ts:522-552`
  - roster candidacy: `worklist/sidebar.ts:67-106` vs `worklist/sidebar-roster.ts:175-226`
- **Evidence:** READ.
  - `rollup.ts:537`: `facts.stage === 'done' || Boolean(facts.closedReason)` vs `visible.ts:264`:
    `issue.stage === 'done' || issue.closedReason != null`. An empty-string reason counts as finished in
    one and not in the other.
  - `schema.ts` calls its close-reason map "A third copy".
- **What is wrong:** One rule change needs edits in several places, and some places already differ. The
  mission header's progress and the sidebar's progress can show different counts for the same mission.
- **Best-practice shape:** One predicate module in `shared/` that every caller imports. `mission-view`
  should read the root's `unitsBelow` instead of recounting.
- **Owner:** none. Confidence: high that the copies exist; medium that each divergence shows in practice.

### 24. Measurement scaffolding and diagnostics in the product path

- **Severity:** complexity
- **Where:**
  - `worklist/visible.ts:82-85`, `:1273`, `:1333-1336`
  - `worklist/groups.ts:297-324`, `:350-356`, `:394-405`
  - `worklist/visible.ts:1071-1237`, `views.ts:472`
  - `diagnostics/runtime-check.ts:99-101`
- **Evidence:** READ. `visible.ts:84`: "No reader of the product reads it (the list reads the groups);
  the snapshot and the tests do."
- **What is wrong:**
  - Each filing splices the row into nine sorted observable lanes. The product reads five of them. The
    `visible` order and the non-root `pinned`, `open` and `closed` lanes are read only by the harness and
    tests.
  - `directVisibility`, `directNested`, `sortByRank` and `directParts` are rebuild oracles that live in
    the product package.
  - With the sidebar on the pool, the sidebar check installs capture-phase pointer and key listeners on
    `window`, even when no check runs.
- **Best-practice shape:**
  - Move oracles and harness-only lanes into `worklist-proto`; the harness derives its layout from the
    product's lanes.
  - Install diagnostics only on request.
- **Owner:** none. Confidence high, from a grep (which proves positives only; check for dynamic access
  before deleting).

### 25. Five React integration idioms; hooks reactive only inside observers

- **Severity:** complexity
- **Where:**
  - `apps/web/src/app/shell-data.ts:72-116`
  - `apps/web/src/features/issues/board-pool-projection.ts:11-21`
  - `use-chat-context.ts:173-201` and mobile `use-session-context.ts:258+`
  - `IssueChipLiveness.tsx:30-43`
  - `board-pool-data.ts:99-104`
- **Evidence:** READ. `function usePoolChrome() { const pool = useWorklistPool(), value = pool ? shellViews(pool).chrome() : LOADING ...`
  is reactive only because its callers are wrapped in `observer`.
- **What is wrong:** Components subscribe five different ways:
  1. `observer`
  2. `usePoolProjection`
  3. a projection that returns a store read by a second `useSyncExternalStore` (the board)
  4. imperative `createPoolProjection().subscribe`
  5. bridge stores fed by `useLayoutEffect`, which cause two render passes per new message, written once
     per app

  On top of that:
  - The shell `usePool*` hooks silently never update when called from a non-observer.
  - The board keeps its catalog alive by calling a projection and discarding the result, which
    re-renders the whole board on each catalog change.
- **Best-practice shape:**
  - Observers reading memoised computeds.
  - `usePoolProjection` only for non-observer leaves.
  - A dev assertion that MobX-reading hooks run inside an observer.
  - Transcript stores fed directly from a reaction.
  - Keep-alive owned by the source, not by React.
- **Owner:** none.

### 26. 16 switches, 98 legacy hook twins, three-way dispatchers

- **Severity:** complexity
- **Where:**
  - `apps/web/src/lib/mobx-pilot.ts:7-15`
  - `apps/web/src/lib/*-data-layer.ts`
  - `host/switches.ts:3-4`, `:36-49`
  - `use-sidebar-projects.ts:64-110`
  - `header-data.ts:43-46`
  - `store-worklist-pool.ts:33-39`
- **Evidence:** READ.
  - 16 `webPoolSwitch('mobx…')` keys, all defaulting to the one device flag.
  - 72 `useLegacy*` functions on web and 26 on mobile.
  - `shellDataLayer()==='pool' ? useShellShipping : headerDataLayer()==='pool' ? usePoolShipping : useLegacyShipping`
- **What is wrong:**
  - The latching is correct: each switch is read once, hook order is stable, and no component runs both
    derivations.
  - But because one device flag turns every screen on together, the per-screen split adds only URL
    override combinations, and those need dedicated bridges. One example is `usePoolSections`, which
    scans every worktree with `'load'` reads and is reachable only with commands on legacy and the
    sidebar on the pool.
  - Forward-only layers (data-layer accessors, renaming re-exports, dispatchers) sit between the row and
    the component.
  - The name "worklist pool" is used app-wide, which hides that it is the one app-wide pool.
- **Best-practice shape:**
  - One app-wide decision, as mobile already has.
  - Delete each screen's twin, dispatcher and data-layer file when that screen is accepted.
  - Name the pool for what it is.
- **Owner:** none. This is the delete step the epic rules already require ("legacy code is DELETED"); it
  needs scheduling.

### 27. The row source silently swallows a pool's apply error

- **Severity:** complexity (latent correctness)
- **Where:** `shared/row-source.ts:1156-1175`
- **Evidence:** READ. `for (const listener of [...listeners]) { try { listener(event) } catch { /* One throwing arm must not stop the others */ } }`.
  A failing `coldIndex.apply` drops the index the same way.
- **What is wrong:**
  - The throw comes out of `pool.apply`'s single `runInAction`, so MobX has already committed any table
    and relation writes made before it. The rest of the batch, `graph.flush` and the roster flush never
    run.
  - Every later event then lands on that partly applied pool, with no log, no counter and no
    resync.
  - This is a debugging trap, and on a pool it is a silent stale screen.
- **Best-practice shape:** Report the error (console plus a diagnostic counter) and mark the pool for a
  `replace` resync. Never swallow silently.
- **Owner:** none.

### 28. The sidebar roster keeps a second deadline clock

- **Severity:** complexity
- **Where:**
  - `worklist/sidebar-roster.ts:46-48`, `:104-124`, `:281-303`
  - `pool.ts:946`
- **Evidence:** READ. `const index = this.deadlines.indexOf(previous); if (index >= 0) this.deadlines.splice(index, 1)`
- **What is wrong:**
  - The roster keeps its own expiry registry beside `DeadlineClock`, and the pool advances it
    separately.
  - A reschedule is a linear search over every scheduled seat, cold ones included.
  - A clock rewind re-files every seat.
- **Best-practice shape:** Register these deadlines with `DeadlineClock`.
- **Owner:** none.

### 29. Smaller items (style)

| Item | Where | Shape | Owner |
|---|---|---|---|
| Every group's `sidebarRows` reads the global `latchedOpenId`, so a latch change re-runs every group | `worklist/groups.ts:280-295`, `:326-331` | A per-group latch computed | none |
| `SidebarIndex.worktree()` is an uncached method: it re-sorts and builds Proxies per call, and mobile calls it unwrapped from each split | `worklist/sidebar.ts:138-167`, `worklist/mobile.ts:48-52` | A `cachedGroup` on `WorktreeModel` | none (Proxy: POD-5416) |
| Issue-board `facts` uses identity equality over a fresh object, so a heartbeat re-tokenises title and description | `issue-board-source.ts:91-140`, `:207-262` | Field-wise equality over the declared fields | none |
| Catalog and order rows are rebuilt by full scans on batches that do not name their kind | `shell-source.ts:42-54`, `notice-source.ts:106-109`, `automation-source.ts:78-82`, `header-source.ts:75-76` | Skip unnamed kinds; keep membership at the delta | none |
| Mobile attach builds every source eagerly and in series (5 awaits) | `apps/mobile/src/client/mobile-pool.ts:69-134` | Lazy `ensure` per screen | none (attach cost: POD-5407) |
| Machine lists are written four ways, plus a copied `settingsMachine` row set | `header-views.ts:250`, `session-pane.ts:14-19`, `chat-context.ts:84-89`, `shell-views.ts:81-86`, `settings-source.ts:47` | One `pool.machines()` computed | none |
| `residency.ids(entity, true)` is one atom per entity and copies every cold id; `knownSessionIds` sorts them all per call | `residency.ts:294-315`, `enumerate.ts:91-99` | Disappears with POD-5406's declared queries; delete the helpers afterwards | POD-5406 |
| Relation reads build a template-string key per call (`` `${from}.${relation}` ``) | `relations.ts:451`, `:497-505` | Typed links resolved once (`shared/links.ts` already does this for the getters) | none |

## Against Linear's client model

| Aspect | Linear | Here | Change |
|---|---|---|---|
| Model objects | One object per entity with decorated properties and relation getters; observable on access | One object per row on first access, with schema-installed fields and relation getters | Keep |
| Screen state | Views and stores compute over models | Sidebar and mobile groups live on `IssueModel`; screen indexes live in `MobxPool` (finding 20) | Move to views |
| Inputs | Sync actions carry changed properties per model | Rows by id, but locals, overlays and discovery arrive through the legacy whole-snapshot publish, and companion rows are baked in (findings 12, 13) | Keyed inputs |
| Derived lists | Computed and virtualised at render time | Filed by one reaction per in-memory issue, mounted or not (finding 8) | Mount-scoped |
| Optimism | Mutate the model, record a transaction, roll back on reject | The legacy ledger ships; the pool's own write layer is harness-only (finding 19) | Decide one owner |
| Lazy data | Partial bootstrap; lazy collections hydrate on access | Residency and a 50 ms load window over an in-memory kernel; cold facts mirrored three times (finding 14) | One cold owner |

## Things that are good and should be kept

- **The row feed** is row-granular: one `update` per microtask, one action per publication, and identity
  kept end to end. `put` skips the same object, and `retain` keeps a shallow-equal value.
- **`cachedGroup`'s idea:** a computed per object, built on first reactive read and dropped when
  unobserved. Keep the idea; consolidate the copies (finding 18).
- **`DeadlineClock`, `SortedLanes`, the pure roll-up combines, and the read-state lane.** A mark-read
  re-validates only its own row.
- **The schema as data.** One relation engine maintains declared inverses with netted bucket moves.
- **`usePoolProjection`'s lifecycle:** one reaction per hook, a stable reader, and disposal at zero
  listeners. All 83 web readers are stable.
- **Per-row leaf observers** (`PoolRowSlot`, `PoolWorkRowSlot`, board cards) and `session-exit-source.ts`
  as the per-id source shape.
- **Switches** latched once per app load, with no double derivation in a component.

## Status of the round-three review (`docs/decisions/pod-4545-round-three-mobx-linear-review.md`)

| Old finding | Now |
|---|---|
| Two per-issue objects (`IssueNode` and `IssueModel`) | **Fixed.** `IssueModel` is the one object (`models.ts:479`). |
| A second untracked evaluator (`plainScope`/`expandRoots`) | **Fixed in the pool.** The `direct*` oracles remain in the product package (finding 24). |
| Four reactions per node | **Partly fixed.** One per in-memory issue remains (finding 8); the same pattern recurs in three other modules (finding 21). |
| `groups.keys` kept the full sort alive | **Fixed.** The `visible` order it kept alive is now written and never read (finding 24). |
| `childrenBy` duplicated the engine's bucket | **Fixed** (`pool.ts:488`). |
| Duplicate close and closed rules | **Partly fixed.** A copy remains in `shared/schema.ts`, and new divergences exist (finding 23). |
| The model's getters ignore pending edits | **Fixed.** The one reader overlays pending edits; its Proxy cost is finding 6. |

## Structural guards: what would stop each class from coming back

| Class (findings) | Guard |
|---|---|
| Per-click or per-change work that grows with total data (1–5, 7, 9–12) | **Extend the existing per-change work meter** (`worklist-proto/harness/src/work-per-change.test.tsx`, `work-meter.ts`) from the worklist arm to **every pool screen reader and its app consumers**. Count derivation runs and row reads per scripted click (select, stage change, pane switch, open menu, long-press, navigate by ref) and per single-row delta (heartbeat, machine flip, lane change) at 1x and 4x. Fail on any count whose 4x/1x ratio exceeds the visible-neighbourhood ratio. Keep the legacy control arm that must fail. |
| Always-mounted whole-list subscribers (7, 15) | In the app speed gate, count **live observed computeds per reader name at idle**, with every menu and miniview closed, and fail on any reader whose output size scales with the corpus. A census already exists (`debug-name-census`); add the idle-mounted assertion. |
| Coarse observables (1, 12, 13) | A unit check over every source: for each declared row, **a write that changes one field may invalidate only that field's declared readers.** Simpler: a lint rule refusing source rows that bundle more than one local, plus a "no `compareStructural` on values holding collections" rule. |
| Work that follows memory, not the screen (8, 14) | Keep `tracking-counts.baseline.json`, and add **`reactions.live` and per-owner computeds with no screen mounted**: the target is near zero. Add a heap census after POD-5407 that fails if per-cold-row structures exist outside the ColdIndex. |
| Hand-rolled MobX helpers and private APIs (18) | A lint rule refusing `_isComputingDerivation`, `_getGlobalState` and any `mobx` underscore import outside one helper module, plus one rule refusing `reaction(() => x.get(), () => {})` keep-alives. In development builds, warn when `cachedGroup` or `keyedComputed` is read outside a reaction. |
| Untracked tricks (22) | A lint rule that every `untracked(` call and every `'peek'` read carries an inventory tag, and a test that the `clock.ts` inventory lists every tag (the worklist-proto `no-table-walk` fence already polices table walks the same way). |
| Duplicate rules (23) | One predicates module, plus a lint rule refusing literal `stage === 'done'` / `closedReason` checks outside it. |
| Swallowed errors (27) | A test that a throwing listener increments a visible counter and triggers a resync. |
| Legacy twins and switches (26) | A per-screen expiry date in `switches.ts`, and a CI check that fails once a screen has been default-on past its week with its `useLegacy*` twin still present. |

## Open questions for POD-4286

1. **Does POD-5407's lazy cold-member seeding take cold ids out of `issue.sessions` and the seat list?**
   That decides whether findings 8 and 11 close with it.
2. **Will optimism move into the pool?** Finding 19 is dead code or the future, and finding 13's legacy
   publish can only go once overlays arrive keyed.
3. **Heartbeat and machine-flip rates on the live corpus** were not measured. Findings 9 and 12 cost one
   ancestor-chain re-run per heartbeat and one joined-row fan-out per flip, whatever the rate.
4. **Does the per-screen URL-override matrix still serve testing?** If not, finding 26's bridges can go
   now.
