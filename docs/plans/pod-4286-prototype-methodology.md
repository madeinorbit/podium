# POD-4286 — Prototype round two: the shape that makes today's problems hard to repeat

Status: proposal, revision 4 · 2026-09-20 · reviewed against `integrate/4286-frontend-perf` @
`717785d52`, `dev/mw` @ `6645cc283`, `main` @ `692d8c8e8`.
Written for someone who did not follow round one. Terms are explained where first used.

## 1. The answer in four sentences

Round one compared three copies of the same design, so it could only measure how much each
library charges for bookkeeping, and the cheapest bookkeeping won. The design itself is what
is slow and what is unsafe: one whole-corpus worklist calculation with a hand-maintained input
list, consumed by a list where every row re-renders. The goal you stated, a system where these
problems are hard to have again, is a property of the *shape*: a derivation must be correct
because of how it is built, not because someone remembered to list its inputs. Each approach
has its own way to get there (typed exhaustive deltas, a tracked object graph, declarative
queries), and none has been built properly yet. Round two therefore builds three independent,
first-principles arms (hand-rolled, MobX, TanStack DB), each as good as its approach allows and
none bolted onto the current code, and judges them on which mistakes they make loud before it
judges them on speed.

## 1a. The performance goal, stated first

This epic exists because the client is slow. Round two must therefore show, in a browser, at
the live corpus and beyond it, that the chosen shape is fast and stays fast as the corpus grows.
The budgets frozen in the epic design (§5 of `pod-4286-frontend-store-performance.md`) still
apply; the Stage 0 control (`POD-4286-stage0-baseline.md`) is what the arms must beat.

| Goal | Budget the arms must meet | Control today |
|---|---|---|
| Idle client | zero derivation work except on the clock tick | one derive per minute |
| Unrelated change (a heartbeat anywhere) | zero rows committed, zero derivations, publish ≤ 2 ms | worklist untouched since B5, ~280 subscriber checks |
| Any single hot-path event | ≤ 8 ms main-thread, p95, at live corpus | 2 derives per click before Stage 0, 1 after |
| Row click, input to paint, inside the slice | ≤ 16 ms p95 at live corpus, ≤ 32 ms at 4× corpus | 407 ms p50 for the whole app switch (includes transcript load and layout) |
| Cost follows the change, not the corpus | per-event cost slope across 1×, 2×, 4× corpus ≤ 1.2 (near flat) | whole-world derive: slope ≈ 1.0 per corpus multiple (linear in N) |
| Bootstrap at live corpus | ≤ 1.1× control; principal switch ≤ 2× control | control measured in Stage 0 |
| Memory | retained heap ≤ 1.1× control at live corpus, no growth after rescope | — |
| Bundle | ≤ +60 KB gzip on web, no native-incompatible dependency | — |

Performance is a gate every arm must pass, and the growth slope is the performance
differentiator among arms that pass: an arm whose per-event cost stays flat from 1× to 4×
corpus has headroom the frontend will need; one whose cost grows with N has rebuilt the problem.

## 2. What is actually slow today

Numbers are from the post-Phase-B live capture (`docs/measurements/POD-4358-post-b-baseline.md`,
4,887 issues / 4,323 sessions / 211 visible rows, Chromium, production build). Phase B is on
`dev/mw`.

| Window | Publishes | Subscriber wakes | Worklist derives | Switch p50 / p95 |
|---|---:|---:|---:|---:|
| Connected idle, 66 s | 28 | 7,840 | 1 (90 ms) | — |
| Ordinary activity, 66 s | 30 | 8,400 | 1 (57 ms) | — |
| Warm switching, 14 clicks in 51 s | 68 | 20,071 | 28 (4,098 ms) | 1,047 / 4,471 ms |
| Cold switching, 30 clicks in 136 s | 195 | 76,206 | 75 (9,676 ms) | 1,172 / 1,960 ms |

**Idle is solved.** The "eight seconds of rebuilding per minute" in the earlier summary was the
pre-Phase-B app. It is now one derive per minute on the clock tick.

**The switch is the problem, and it is not mainly the store.** Per warm click: about 5
publications, ~1,400 subscriber checks, 2 whole-corpus worklist derives (~290 ms), and about
1.6 s of React render. Largest self-time frames in the warm profile, per 14 clicks:

| Frame | Self ms | What it is |
|---|---:|---|
| garbage collector | 3,932 | allocation churn from the rows below |
| IndexedDB `requestAsPromise` | 2,347 | transcript load on switch (legitimate) |
| `getBoundingClientRect` | 1,658 | layout reads during render |
| `mission.ts` (`missionRootFor`, `byId`, `computeMissionIssueIds`, …) | ~4,000 | mission walks that rebuild an all-issues map per call |
| `UnifiedIssueRow` + `origin` | 943 | 211 rows re-rendered per click |
| `issue-chip-liveness` | 897 | a signature over all 4,887 issues per transcript render |
| `buildUnifiedRows` | 318 | the worklist derive proper |

### The read path in one paragraph

One snapshot object with every collection; one listener set; `apply()` computes the changed
keys and throws them away before notifying everyone (`engine/runtime.ts:884-891`). The worklist
slice re-derives when any of six collection identities moves (`sessions` moves on every session
delta because `dedupeSessions` allocates a fresh array) and returns a fresh object with no
equality guard, so its six readers re-render. Selection is one of the six inputs, so a click
rebuilds the world. The web sidebar renders all visible rows with no windowing and no
`React.memo`; each row receives the whole `issues` and `sessions` arrays as props and does its
own O(issues) scans. Mobile virtualises and memoizes rows but passes the same whole arrays, so
its own comment concedes the memo is defeated on every tick. The one per-entity cache in the
tree, `replica/issue-view-cache.ts`, is keyed on snapshot identity for evict and rescope safety.

## 3. Why round one proved nothing

The pilot (D2–E7) and the three-way comparison (POD-4403) all implemented the same
`PresentationModel` interface with the same `readWorklist()` body: enumerate every issue,
rebuild every issue model, run the shared builders, return a fresh slice. Compare
`presentation/model.ts:234-268` with `proofs/mobx-presentation/mobx-model.ts:359-393`; they are
the same function. So the arms differed only in how they *tracked* dependencies for a
calculation that depends on everything:

- The hand-written arm dirties one cell and recomputes lazily. Cheapest bookkeeping.
- The MobX arm wrapped ~15,000 rows in observables, marked every computed `keepAlive: true`
  (MobX's docs warn against it), and put the whole worklist under one computed. Every publish
  re-validated a graph of tens of thousands of nodes. A misuse, not a measurement of MobX.
- The TanStack arm re-read every coarse cell per publish.

The acceptance run (F1) then wired the pilot to the existing consumers unchanged: the
`useReplicaIssues` tail subscribed 14,601 cells in one component and a principal switch became
285 million cache reads (POD-4411); the unguarded `readWorklist` cost 380–620 ms per dirty read
(POD-4410). Neither is a property of any library.

The first D1 proof (`proofs/d1/mobx.tsx`, 76 lines) had the right shape: an observable per row,
a computed per summary, `observer` rows, zero unrelated reads. It ran only on a 200-issue toy
group and the production-scope arms did not carry it forward.

Keep from round one: the one-mutation-owner seam (kernel → effective post-optimism rows → read
model), the parity suite and counts-first method, the silent-failure exercise, the live-scale
fixture and the kernel scenarios.

## 4. Do we have the right shape? The foot-gun test

Your goal is not a faster worklist; it is a frontend where the class of problem we just spent
three weeks on is hard to create. So the question to ask of a shape is: *which mistakes does it
make impossible, which does it make loud, and which stay silent?*

### 4.1 Today's foot-guns, named

| Foot-gun | Instance in the code | Failure when someone slips |
|---|---|---|
| A derivation declares its inputs by hand | `worklistSlice.sourceEqual` lists six fields (`published.ts:185-205`); the pilot's `WORKLIST_INPUTS`; the cell input lists in `presentation/model.ts` | Forgotten input: silent stale screen, every test green (proved in POD-4403 for all three arms) |
| Invalidation at collection granularity | `sessions !== sessions` triggers a whole-world derive | Any heartbeat rebuilds everything; the fix is another hand-written guard |
| Whole-array props | `renderWorkRow` passes `issues` and `sessions` to every row | Memo cannot work; a new field added to a row multiplies its cost by 211 |
| Deriving inside render over the corpus | `missionRootFor` in `Workspace.tsx:780`, `issues.find` in `UnifiedIssueRow.tsx:168`, chip signature | A component author cannot tell an O(1) read from an O(N) one; nothing warns |
| Identity-keyed caches that miss together | `issueModelsBySnapshot`, `sessionIndexes`, `missionMemberSets`, `sessionSliceLookups` all keyed on the array | One allocation upstream (`dedupeSessions`) defeats four caches nobody sees |
| Five places that derive | store slices, view-models, per-component `useMemo`, the replica view cache, the presentation model | A new feature picks one at random; no rule says which |

None of these is a bug. Each is the design working as built. That is why "fix it again" is not
the plan.

### 4.2 The property we want

A derivation is correct **by construction** if it reads only tracked state, and a component
re-renders **only** for the state it read. Then:

- there is no input list to forget (the tracker records what was read);
- invalidation is at the granularity of what was read (a session's `lastActiveAt`, not "the
  sessions array");
- a row component that reads `issue.title` and `issue.phase` is not touched by any other field;
- an O(N) read inside a component is still possible, but it is visible: it reads N things, and
  the isolation fence in the test suite (rows committed ≤ rows affected) fails loudly.

This is the Linear shape: an object graph of models with observable fields and computed
getters, relations resolved through the graph (`issue.children`, `issue.sessions`,
`session.issue`), a sync engine as the only writer, `observer` components, and virtualised
lists. It is one model layer, not five.

### 4.3 How the three candidates score on the property

| | Hand-written keyed store | TanStack DB | MobX object graph |
|---|---|---|---|
| Dependency discovery | None. Every cell declares inputs; omission is silent. This *is* today's foot-gun rebuilt with smaller cells. | Automatic inside a query; manual for everything procedural (rollups, nesting, provenance), which is two thirds of the worklist | Automatic for everything read through an observable |
| Granularity | Whatever the author declared | Per query result (a new array per change to that query) | Per property |
| Row isolation | By discipline | Needs one live query per row; measured 10× heap and 20–30× bootstrap in D1 | Native (`observer`) |
| What stays silent | Unlisted input; missed release on evict | Misrouted staging; a memo that heals on read but never wakes | Untracked state (a plain variable where an observable belongs); a read outside a reaction |
| What can be made loud | Mutation oracles for *listed* inputs only | Nothing for the routing omission | `enforceActions: 'always'`, `computedRequiresReaction`, `observableRequiresReaction`, `reactionRequiresObservable` turn every silent case in the table into a thrown error or a console warning; `eslint-plugin-mobx` (`missing-observer`, `exhaustive-make-observable`) covers the component and model side |
| Cost of a new derived field | Type, staging list, input inventory, validator, read, inventory test (6 places, POD-4403) | 6 places incl. a second namespace list | A getter (1 place) |

Read as predictions, not verdicts: the round-one hand-written arm could not deliver the property
because it relied on input lists; a first-principles hand-rolled arm must find another route
(§5.2 proposes exhaustive typed deltas plus a rebuild oracle). TanStack DB delivers it for the
relational part and must handle the recursive part explicitly (§5.4). MobX delivers it through
tracking, and its silent cases each have an enforcement switch (§5.3). The exercise in §5.8
tests all three claims.

So: **the shape in the first revision of this document was right on performance and wrong on
safety.** It framed a substrate-neutral hooks contract the three arms would adapt to, which
keeps the read model as a layer beside the store. The operator's answer is to build each arm
from first principles in its own idiom (§5) and let the foot-gun exercise say which shape holds.

### 4.4 What MobX does not solve, said plainly

- **Indexes.** `issue.children`, `issue.sessions`, `worktree.sessions` need maintained maps.
  In an object graph they live in the store's write path (one `runInAction` per publication
  updates the row and the index buckets). MobX makes reading them tracked; it does not write them.
- **Subtree rollups and provenance walks.** Computed getters over `children` and `parent`
  express them naturally and invalidate along the chain; the code is still ours.
- **Scale discipline.** A computed that reads all 4,887 issues is still a whole-world computed.
  The guard is the isolation fence in tests and a lint against enumerating a table inside a
  component.
- **Lifecycle.** Computeds suspend when unobserved; a fresh store per principal handles
  sign-out; evict is `map.delete`, and every computed that read the row re-evaluates to
  undefined. Simpler than the keyed design's explicit release, but it must be proved under the
  D6 lifecycle contracts.
- **Optimism.** Stays in the kernel; the graph receives effective rows. Moving optimism onto the
  graph is a later decision, not round two.

## 5. What to build: three first-principles arms

The operator's decision (2026-09-20): three prototypes, each built from the ground up in its
own idiom, each as good as its approach allows, none bolted onto the current code. The
comparison is between three complete answers, not between three adapters to one design.

### 5.1 Shared ground, so they are comparable

- Each arm is a greenfield package fed only by the kernel's effective row stream (upsert,
  delete, replace, per entity). No imports from the current view-model, slice or mission code.
  The domain rules (visibility, ownership by worktree prefix, subtree rollup, provenance,
  ordering, grouping, bands) are re-expressed in each arm's idiom.
- The current derivation, run on the same fixture, is the executable spec: a parity oracle
  checks visible rows, order, per-row fields and groups after every scenario.
- Each arm owns its own UI for the worklist path (list, group, row) in its idiom, windowed, and
  its own lifecycle: a new store per principal, evict is a delete, rescope is one replace.
- Same fixture, scenarios, browser harness, foot-gun exercise and change exercise for all three.

### 5.2 Hand-rolled, perfect: incremental view maintenance with typed deltas

- Normalised entity tables keyed by id. Every derived structure (index, summary, visible set,
  order, groups) is a module with one `apply(delta)` that updates its output in place and emits
  typed deltas downstream: a dataflow of deltas, not a cache of snapshots.
- Correctness by exhaustiveness, not by dependency lists: delta kinds are a closed union and
  every handler switches over all of them, so the compiler refuses a derivation that ignores a
  kind. A from-scratch rebuild test asserts incremental output equals full recompute after every
  scenario. That is the hand-rolled substitute for tracking.
- Subscriptions per key (row id, group key, order); components bind with `useSyncExternalStore`
  per key. Nothing publishes a whole-world object.
- One publication, one delta batch, one notification pass, ordered by dataflow topology.
- Honest cost: every new derived field is a new delta handler; omission is loud, but the
  handler's logic is yours.

### 5.3 MobX, perfect: the tracked object graph

- Domain models as classes with observable fields and computed getters; a store per principal
  holding shallow observable maps and observable relation buckets. Relations resolve through
  the graph: `issue.parent`, `issue.children`, `issue.sessions`, `worktree.sessions`.
- Every derived value is a getter. Rollups walk `children` and invalidate along the chain
  automatically. Visible set, order and groups are computeds with structural equality, so the
  list re-renders only when order changes.
- One `runInAction` per publication, rows and index buckets atomically. Enforcement on
  (`enforceActions: 'always'`, `computedRequiresReaction`, `observableRequiresReaction`,
  `reactionRequiresObservable`), no `keepAlive`, `eslint-plugin-mobx` for missing `observer`
  and non-exhaustive observables.
- `observer` components read model fields directly; a windowed list reads the ordered id array.
- Honest cost: indexes are maintained by hand in the write path, and a getter that enumerates a
  table is legal, so the isolation fence in tests guards against whole-world computeds.

### 5.4 TanStack DB, perfect: everything is a query

- One collection per entity type, keyed and explicitly indexed, fed through the sync interface.
  Its optimistic transactions are not used; the kernel owns optimism.
- Every relational derivation is a live query, and live-query outputs are collections later
  queries read: sessions per issue via join, children per parent, counts and latest activity via
  groupBy, visible set via where, order via orderBy, groups via groupBy. The differential engine
  maintains all of it per changed row.
- The recursive part the query language cannot express (subtree rollup, provenance closure) is
  one custom derived collection with its own small sync. That is the only imperative code.
- Rows subscribe to the derived rows collection by key (`findOne` per row or a keyed change
  subscription); the list subscribes to the ordered-ids query. Garbage-collection times explicit.
- Honest cost: per-query reactivity, bootstrap and heap overhead that lost twice already, and a
  second derivation vocabulary next to the custom collection.

### 5.5 The control

The current store, unchanged, behind the same harness. The isolation fence (rows committed ≤
rows affected on an unrelated heartbeat) must fail on it, which proves the detector.

### 5.6 The slice: pick by mechanism, not by feature

The arms must prove that each approach handles every *kind* of hard thing the frontend has,
not every instance of it. So the slice is one vertical path containing one representative of
each mechanism, built at full fidelity for the mechanisms and a deliberately cut rule set.

| Mechanism to prove | Representative in the slice | Left out |
|---|---|---|
| Per-entity invalidation at live scale | session heartbeat on 4,300 sessions | — |
| Composite entity from two row kinds | issue = wire row + projection row | — |
| Key relation, maintained by delta | children by parent, sessions by issue | — |
| Non-key relation | sessions by worktree path prefix | machine scope |
| Graph edge | discovered-from origin | continuation walk, dependency edges |
| Recursive derivation with chain invalidation | subtree rollup: progress, working, asking | provenance nesting, started-by nesting |
| Membership predicate | visible = not archived, not deleted, root or has own session | snooze, tuck, defer |
| Ordering and grouping | pinned first, then activity, grouped by repo with one closed fold | worktree rows, nav tree |
| Local state that must not touch data | selection | pane, focus |
| Time as an input | activity band from the coarse clock | overnight snooze lapse |
| Lifecycle | fresh store per principal, replace, evict without tombstone, optimism echo and rejection from the kernel | drafts, offline hydration |
| Render isolation | windowed list, group header, row, click | everything else on screen |

Three entity types, four relations, about eight rules, three components; roughly 800–1,500
lines per arm including its UI. The parity oracle is the current derivation projected onto
exactly the fields and rows the slice claims, so the cut rule set does not weaken the check.

Where it lives: a standalone worklist screen per arm, fed by the real kernel replica through
its effective row stream, mounted in a harness for web and the React Native unit renderer. Not
inside the app shell and not behind a flag in the current sidebar. The real kernel is what
keeps it from being a toy: optimism, rollback, evict and rescope arrive as in production.

How the slice proves it generalises: the change exercise (§5.9) takes its changes from the
"left out" column (the continuation walk, snooze, worktree rows). The cost of each is the
measured price of growing the slice toward the rest of the frontend.

What would make the slice too small: skipping the recursive rollup or the prefix relation.
Those are where the three approaches differ; without them the comparison is bookkeeping again.

### 5.7 Fixed ground so the measurement is fair (performance evidence rules)

- **Stage 0 first** (§7): the store-independent fixes land before the candidate is timed.
- **Fixture** = the live-shaped synthetic corpus (4,867 / 4,304) *with* the 500-repo /
  468-worktree tree; the empty tree in POD-4403 hid the nav-tree cost. Plus the 674 ci corpus.
- **Browser, not happy-dom.** Chromium via CDP, production build, input-to-paint for the click,
  long-task accounting, heap endpoints. happy-dom for counts in CI.
- **Three corpus sizes.** The live-shaped fixture at 1×, 2× and 4× (4,867 / 9,734 / 19,468
  issues) so the growth slope in §1a is measured, not argued.
- **Counts first, walls second.** Rows committed, computed re-evaluations, reactions run, index
  bucket updates; walls interleaved with arm order rotated and load recorded, under the bench
  lease.
- **Parity oracle** after every scenario: visible row ids, order, per-row text, group
  membership identical to the control.

### 5.8 Scenarios and budgets

| # | Scenario | Rows committed | Computed re-evaluations | Wall |
|---|---|---|---|---|
| 1 | Unrelated session heartbeat | 0 | 0 | publish ≤ 2 ms |
| 2 | Session on a visible row changes phase | 1 (+ ancestors if rollup changes) | that chain | ≤ 8 ms |
| 3 | Selection click | 2 | 0 | input→paint p95 ≤ 100 ms |
| 4 | Title rename on a visible row | 1 | 1 | ≤ 8 ms |
| 5 | Stage change moving a row across groups | affected rows + order | chain + order | ≤ 16 ms |
| 6 | New issue / archive / authority evict without revision | order + row | bounded | ≤ 16 ms |
| 7 | Parent reassignment | both chains | both chains | ≤ 16 ms |
| 8 | Coarse clock tick | rows whose band moved | bands | ≤ 8 ms |
| 9 | Optimistic echo and rejection | as 2 | as 2 | no full rebuild |
| 10 | 50-event burst through `batch()` | bounded | bounded | one action |
| 11 | Principal switch over a fresh replica | full, once | full, once | ≤ 2× control |
| 12 | Cold bootstrap at live corpus | full, once | full, once | ≤ 1.1× control; heap ≤ 1.1× |
| 13 | Rescope growth then back | full, once each | full | no leak after disposal |

| 14 | Growth: scenarios 1, 2, 3 and 5 repeated at 2× and 4× corpus | same as at 1× | same | slope ≤ 1.2 |
| 15 | Coexistence: arm screen mounted beside the legacy sidebar on one kernel | arm counts unchanged from 1–3; legacy counts unchanged from the control | — | no cross-wake |

Scenarios 1–3 are milestone 1 and the kill gate. Scenario 14 is the performance differentiator
(§1a). Every wall is measured in Chromium against the live-shaped fixture, interleaved, load
recorded, under the bench lease; counts are asserted in CI on happy-dom.

### 5.9 The foot-gun exercise, which is the point

Done by a developer (or agent) who did not build the model layer, on the candidate and on the
control, counting files, lines and places-to-remember and recording what the screen shows:

- A: add a new input that affects row placement (snooze: time-dependent membership).
- B: add a new derived field to the row (the continuation walk: a graph walk).
- C: change the bubbling rule ("an ask on any descendant marks the root asking").
- C2: add a second row kind to the same list (worktree rows).
- D: omit the plausible bookkeeping step in each (control: leave the input out of
  `sourceEqual`; candidate: store the input in a plain variable). Expected: control silent;
  candidate throws under `observableRequiresReaction` / the isolation fence fails.
- E: forget to remove a row from an index on evict. Expected: candidate's parity oracle fails on
  scenario 6.
- F: write an O(N) read inside a row component. Expected: isolation fence fails.

The decision document leads with this table, not with walls.

### 5.10 Milestones

| M | Deliverable | Gate |
|---|---|---|
| 0 | Stage 0 fixes landed and remeasured; cruft removed from `dev/mw`; browser harness with the live-shaped fixture; control fails the isolation fence | harness produces counts and paint times |
| 1 | Each arm: tables, indexes, per-row derivation, its own list and row components; shape review (§6.1); scenarios 1–3 | shape review, then kill gate per arm |
| 2 | Scenarios 4–10 | budgets or a named reason |
| 3 | Lifecycle 11–13, growth 14, coexistence 15, mobile worklist on each arm, write-path sketch (§6.4), bundle and heap | budgets in §1a |
| 4 | Foot-gun exercise, change exercise, complexity report, screen coverage map (§6.3), decision document applying the rule in §6.2 with the two open decisions (§6.4) and the migration order | a decision the operator can read cold |

Rough sizes, one lane per arm per milestone: M0 about a week (mostly Stage 0), M1 three to four
days per arm, M2 a week per arm, M3 three to four days per arm, M4 a week. About seven weeks of
lane time across three arms, running up to three lanes in parallel.

## 6. Closing the gaps between "library choice" and "rewrite decision base"

### 6.1 Shape review gate at milestone 1

Before an arm's scenarios run, a reviewer who did not build it reads the arm against this
checklist and writes pass or fail per line. Any fail sends the arm back before measurement.

| Check | Hand-rolled | MobX | TanStack DB |
|---|---|---|---|
| No import from `viewmodels/`, `slices/`, `mission.ts`, `presentation/`, `replica/issue-view*` | required | required | required |
| Entities keyed by id, values immutable borrowed rows | required | required | required |
| No derivation enumerates a table on an ordinary delta (only at bootstrap / replace) | delta handlers only | no computed reads `map.values()` outside `WorklistModel.visible` | no full-collection query without an index |
| Dependency correctness by construction | every handler is an exhaustive switch over the delta union; rebuild oracle test present | enforcement config on; no `keepAlive`; `eslint-plugin-mobx` clean | derived collections chained from live queries; only the recursive closure is imperative |
| Row isolation | one subscription key per row | `observer` per row | per-row keyed subscription |
| Lifecycle explicit | release on evict; replace clears tables | store per principal; `map.delete` on evict | `gcTime` set; replace via one transaction |
| Own UI, windowed, no whole-array props | required | required | required |

### 6.2 Decision rule, pre-committed

Three gates, in order, then one ranking. All three gates must pass; the order says only which
failure is reported first.

1. **Safety gate.** The arm turns every mistake in §5.9 into a thrown error, a failing test or a
   failing lint. A mistake that stays silent disqualifies the arm unless a check can be added
   inside the arm within the milestone.
2. **Performance gate.** Every budget in §1a at live corpus, in the browser; the growth slope
   at 2× and 4×.
3. **Fidelity gate.** Parity oracle green on all scenarios; lifecycle scenarios 11–13 green.

Ranking among arms that pass all three: the change exercise (places to remember, lines,
whether a newcomer got it right first time) decides; the growth slope breaks a tie; bundle and
heap break the next. The document reports every gate result for every arm, including the ones
that failed, so the losing arms' costs are named as accurately as the winner's.

### 6.3 Coexistence and the screen coverage map

Scenario 15 mounts the arm's screen beside the legacy sidebar on one kernel and asserts neither
wakes the other. That is the mechanism a screen-by-screen migration relies on.

Milestone 4 fills in this map for the winner, from the consumer census. Each row is covered by
the slice, a named exclusion, or a gap probed before the rewrite plan is written.

| Screen or surface | Mechanisms it needs (from §5.6) | Status after the slice |
|---|---|---|
| Worklist sidebar, rail, mobile Work tab | all twelve | covered |
| Command palette | membership, ordering, text filter over titles | text filter is a full scan by nature: named exclusion, bounded by the visible set |
| Workspace and Flight Deck | recursive rollup, key relations, ordering within one mission, per-mission aggregates | covered by rollup + relations; aggregates are groupBy over one subtree: probe |
| Issues board and Tasks | membership by stage, counts per stage, ordering, epic progress | groupBy + rollup: probe at 4× corpus |
| Repo picker, cold-start composer | most-recent-use over sessions × repos | non-key relation: covered by the prefix relation |
| Host indicators, machine facts | high-frequency numeric stream | named exclusion: stays off the graph, own store (as today) |
| Chat transcript, presence, connection | already off the store | named exclusion |
| Issue detail, properties, edges | single entity + edges | covered by composite entity + graph edge |
| Drafts | per-id local ledger | probe: local state with persistence semantics |

### 6.4 The two decisions the prototypes inform but do not make

**Where optimism lives.** The arms keep the kernel as the only writer, for comparability. To
inform the decision, milestone 3 adds a bounded write-path sketch per arm: a one-page design plus
a small spike of one optimistic edit made through the arm's own write API (an action, a
transaction, a pending delta), reconciled against the kernel's echo and rejection from scenario
9. Not measured for speed; judged on how much of the kernel's optimism semantics (rollback,
dead-letter, readmission) the arm's idiom expresses without special cases.

**What the server precomputes.** Each arm's instrumentation reports the share of its per-event
computation spent in rollups versus row assembly. If rollups dominate at 4× corpus, server-side
projections are the next lever and the decision document says so with the number.

## 7. The issue tree (filed 2026-09-20 under POD-4441)

Integration branch `integrate/4441-round-two`, off `dev/mw`; every child branches from it and lands
on it ff-only. Nothing from round two lands on `dev/mw` or `main`.

| Phase | Issues | Blocked by |
|---|---|---|
| G shared ground | G1 POD-4442 slice spec + package skeleton · G2 POD-4443 fixture + oracle · G3 POD-4444 effective row stream + scenarios · G4 POD-4445 measurement harness + legacy control | G2–G4 by G1 |
| H milestone 1 | H1 POD-4446 hand-rolled · H2 POD-4447 MobX · H3 POD-4448 TanStack DB · H4 POD-4449 shape review (gate) | H1–H3 by G1–G4; H4 by H1–H3 |
| I milestone 2 | I1 POD-4450 · I2 POD-4451 · I3 POD-4452 (scenarios 4–10 per arm) | each by H4 and its H |
| J milestone 3 | J1 POD-4453 · J2 POD-4454 · J3 POD-4455 (lifecycle, growth, coexistence, mobile, write-path sketch, rollup share, bundle) | each by its I |
| K decision | K1 POD-4456 · K2 POD-4457 · K3 POD-4458 (exercise per arm, by a non-builder) · K4 POD-4459 decision document | K1–K3 by their J; K4 by K1–K3 |

## 8. What this changes in the epic

- F2–F4 stay blocked; they assumed a pilot that passed F1.
- The shipped pilot (`presentation/*`, effective-changes, E1–E7 consumers, the flag) is not the
  base for round two and is removed from `dev/mw` (§7). Its tests and the lifecycle contracts
  (D6) are reused as specifications.
- The C1 gate outcome 4 stands; its definition of the pilot is replaced by §5.

## 9. Stage 0 and the landing plan

### 7.1 Where the code is

`dev/mw` already contains the integration branch up to the E4 WIP commit (`6c578b31c`): Phase
A and B, the D1/D7 proofs, the effective-changes contract, the presentation model, and the
`mobx` / `@tanstack/db 0.9.2` pins. Only 72 commits remain on `integrate/4286-frontend-perf`:
E1/E5/E6 consumers, the 4394/4399 worklist tails, the F1 harness, the 4410/4411 probes, the
4403 arms and bench, and three real fixes.

### 7.2 Salvage from the integration branch (cherry-pick onto a branch off `dev/mw`)

| Commit | Keep | Why |
|---|---|---|
| `097abcbd5` + `49317693a` (4378) | yes | retires dead file records after prune grace; a runtime fix |
| `905ee439e` + `12f4d5bfd` (4382), `replica/issue-views.ts` half only | yes | live sessions counted as `unknown` phase; the `presentation/` half goes with the pilot |
| `717785d52` (C2 verdict), `df1de1d0f` (F1 report), `9de88e917`/`9c50a3514` (4410/4411 diagnoses), `e158aa6fa` + `35f9376e9` (4403 document and results JSON) | docs only | evidence; no code |
| everything else (E1/E5/E6, 4394, 4399, F1 harness, 4403 arms, probes) | no | prototype cruft |

Then retire the integration branch.

### 7.3 Remove from `dev/mw` (a branch off `dev/mw`, landed with the operator's go-ahead)

- `packages/client-core/src/presentation/*`, `react/presentation.test.tsx`
- `engine/effective-changes.ts`, `engine/effective-view.ts`, their tests, and the hooks into
  `optimism.ts`, `runtime.ts`, `react/provider.tsx` (keep the addressed replica batches through
  the binding, `5ade60a99`/`7d1b97c17`, only if a test other than the pilot's depends on them;
  otherwise remove)
- `packages/client-core/proofs/d1/*`, `apps/web/src/perf/d1-reactivity.test.tsx`, the perf
  config include, `turbo.json` proof tasks, `apps/server/turbo.json` if pilot-related
- `mobx` and `mobx-react-lite` pins (round two re-adds them deliberately, in the model package)
- `@tanstack/db` 0.9.2 / companion 0.2.23 / `react-db` 0.4.1: keep only if the legacy adapter's
  own tests pass on the bump; otherwise revert to the `main` pins. The retirement plan owns the
  eventual deletion.
- `docs/plans/pod-4322/4325/4328` stay as history; `docs/measurements/*.json` from proofs stay.

### 7.4 Stage 0 fixes (each its own sub-issue, each independently releasable, each with before/after counts from the post-B collector)

| # | Fix | Where | Expected effect |
|---|---|---|---|
| S1 | Mission root and member index once per issues array (WeakMap), used by every `missionRootFor` / `missionIssueIds` caller | `viewmodels/mission.ts:388`, callers in `engine/state.ts`, `reactions.ts`, `runtime.ts`, `Workspace.tsx`, `use-unified-work.ts`, mobile screens | removes ~4 s of the 14-click warm profile |
| S2 | Selection out of the worklist derive; latch and group placement as a cheap post-pass over the derived output | `slices/worklist/published.ts:191`, `folds.ts` | 2 derives per click → 0 |
| S3 | Memoized rows with narrow props; row-local lookups moved into the derived row (origin issue, display title); mobile `WorkRow` the same | `SidebarUnified.tsx` `renderWorkRow`, `UnifiedIssueRow.tsx`, `WorkScreen.tsx:670` | 211 row renders per publish → rows whose row object changed |
| S4 | Issue chip signature memoized on the issues array identity | `apps/web/src/lib/issue-chip-liveness.ts`, `IssueChipLiveness.tsx` | ~0.9 s per 14 clicks |
| S5 | One publication per click: fold mark-read optimism, visit baseline and the machines echo into the navigation batch | `use-unified-work.ts:206-231`, `runtime.ts` reactions | ~5 publishes per click → 1 + the network echo |
| S6 | Layout-read hotspot on switch (`getBoundingClientRect`, 1.7 s per 14 clicks): find the reader, batch or remove | unknown until profiled | measured, then fixed or filed |
| S7 | Post-fix live remeasure with the C1 collector; freeze as the round-two control baseline | `docs/measurements/` | the baseline round two is judged against |

## 10. Source anchors

Live evidence: `docs/measurements/POD-4358-post-b-baseline.md`, `POD-4358-post-b-live.json`,
`POD-4286-gate-a.md`. Round one: `docs/decisions/4321-reactive-pilot.md`,
`4364-keyed-store-comparison.md`, `4403-three-way-store-comparison.md`;
`docs/measurements/POD-4332-f1-acceptance.md`, `POD-4410-publish-path.md`,
`POD-4411-principal-switch.md`. Shapes compared: `packages/client-core/src/presentation/model.ts:234-268`
vs `packages/client-core/proofs/mobx-presentation/mobx-model.ts:359-393`; per-row proof at
`packages/client-core/proofs/d1/mobx.tsx`. Current read path: `packages/client-core/src/store.ts:49-63`,
`engine/runtime.ts:872-892`, `viewmodels/slices/worklist/published.ts:164-241`,
`slices/worklist/rows.ts:51-231`, `viewmodels/mission.ts:388`, `replica/issue-view-cache.ts:250-300`,
`apps/web/src/features/worklist/SidebarUnified.tsx:840-940`, `UnifiedIssueRow.tsx:118-230`,
`apps/mobile/src/screens/WorkScreen.tsx:203,398,664-670`. MobX enforcement: `configure` options
and `eslint-plugin-mobx` rules as named in §4.3 (verify against the pinned 7.0.3 docs before use).
