# arms/mobx/ — the MobX arm

Two generations share this folder. **`pool/`** is the round-three MobX pool
(POD-4565 onward, epic POD-4545): the section "Round three: the pool" below.
Everything else is the frozen round-two arm (POD-4447), documented after it;
the round-three pool never imports it (the lint's import fence), and it goes
when the pool's worklist replaces it.

## Round three: the pool (`pool/`)

Built on the declared schema (`shared/src/schema.ts`, L1a), fed row by row
by the kernel feed (`shared/src/row-source.ts`, `overlaid` mode), handing
each row its L1b `RowView` (`shared/src/row-view.ts`). Phase a1 (POD-4565)
holds the tables and the row views; Ma2 (POD-4566) maintains every declared
relation; Ma3 (POD-4567) keeps cold rows out until something reads them; the
visible collection, order, groups and roll-ups (Mb1-Mb3) come next.

### Idiom

- **Tables from the schema** (`pool/tables.ts`): one shallow `ObservableMap`
  per schema entity — issue, session, worktree, repo — mapping the key to the
  BORROWED row object the feed handed out (never a copy; `deep: false` is
  `observable.ref` per slot). A derivation reading `table.get(id)` subscribes
  to that one slot.
- **Models on first access** (`pool/models.ts`, `MobxPool.model`): ingest
  builds no model; the first read of a row builds its model (Linear's
  "observable on first access"), cached per id, dropped when the row leaves.
  A model holds no row: it reads its slot on every access, so it cannot go
  stale. Every declared field is a getter installed from the schema
  (`installFields`); `FEED_SPELLING` names the one field the feed spells
  differently (a repo's `path` is its lanes' `repoPath`).
- **Every derived value a computed, split by input** (`pool/views.ts`
  `IssueParts`, computed on `IssueModel`): `own` (row-only fields and the
  clock), `repoRef` → `prefix` → `displayRef`, `displayTitle`, `originRef` →
  `originId` → `originTick`, `activityAt`, then `view` assembles them and
  reads no row. A relation is split into its REFERENCE (the foreign key off
  the own row, a string, `relations.ts` `relationRef`) and its RESOLUTION
  (the target's presence and fields), so a rename re-runs the reference,
  which returns the same string, and no target is read; an origin's rename
  re-runs only its spin-offs' `originTick`. Objects compare structurally
  (`computedStruct`), so an unchanged part or view keeps its identity.
- **Locals as tracked state**: the selection is a one-entry observable map
  (`selection.has(id)`), so a click re-derives exactly two views; the clock
  is a set of deadlines (`pool/clock.ts`): a rule asks "has `t` passed", and
  a tick wakes only the rows whose deadline it crosses.
- **Enforcement configured AND asserted** (`pool/enforce.ts`): all four MobX
  flags on; every pool test installs `pool/mobx-trap.ts`, which throws on
  any `console.warn` and fails the test on any recorded warning. No
  `keepAlive`. Out-of-reaction reads (`snapshot()`) go through `tracked`, a
  transient reaction.
- **Relations from the schema** (`pool/relations.ts`, Ma2): the engine reads
  `schema[entity].relations` at construction and names no relation. Each
  single-valued relation (`belongsTo`, `prefix`, outgoing `edge`) is a link
  with an observable `forward` map (source → target key, members only) and
  observable `buckets` (target key → sorted frozen member array: its inverse
  collection). Ingest tells the engine of every table write; it re-resolves
  only links whose declared inputs moved (key/path/edge field and every
  `where` field), detaches then attaches, and the action's one `flush`
  replaces each touched bucket once. The `prefix` link keeps an ancestor
  index (`under`) so a new root takes its sessions without a scan, and a
  removed root hands them to the next-longest root. The session resume-twin
  collapse is declared in the schema (`session.collapse`,
  `collapseLosers`); a collapsed row contributes no edge. Derivations read
  buckets only through the shared `RelationReader` (`one`: one read; `many`:
  one per member; `size`: free). Adding a relation to the schema needs no
  code here (`relations.test.ts`, the fixture-schema test).

- **Residency from the schema** (`pool/residency.ts`, Ma3): a row the
  schema's `cold` spec lets stay out (a closed issue; a session of one) is
  never put in a table. A plain registry holds its id, the relation engine
  links it, and its relation slots live in plain twins until it is resident.
  A derivation that reaches it through a lazy relation gets `loading`
  (`ViewInputs.loading`, `RowView.loading`, `MobxPool.resident`,
  `MobxPool.lazyMany`) and queues it; one 50 ms window loads every queued
  row by id through the feed (`RowSource.row`) in ONE action
  (`MobxPool.hydrate`). An update that makes a row itself not cold (a reopen)
  installs it and the sessions that inherited coldness from it at once. A
  resident row never goes cold except on `replace`, which re-partitions.

### The enumeration module

`pool/enumerate.ts` is the ONE module that walks a whole table
(`fence.json` `enumeration`; the lint's `no-table-walk` refuses a walk
anywhere else in `pool/`): `issueIdsOf` (every issue id, for the a1 list and
`snapshot()`, until Mb1's visible collection) and `reseed` (a `replace`).
It also holds the from-scratch relation resolution the live pool never
runs: `scanRelations` (the rebuild's relations: the declared resolvers over
whole tables) and `diffRelations` (the live engine against that scan, for
the relation tests and the gate), plus the gate's residency walks:
`knownTables` (every row the pool knows, cold ones from the feed) and
`diffResidency` (the hot/cold partition against the feed).

### Write path

`RowSourceEvent` → `MobxPool.apply` → one `runInAction`: an `update` runs
`ingestRecord` per record (the same object is a no-op; `value: undefined`
removes the row and drops its model; a row that can be cold is routed
through `Residency.ingest`); a `replace` runs `reseed` (the new slice
through the same ingest into plain maps, then kept rows untouched, named rows
written or registered cold, the rest removed) — observers see one
transition. A closed load window → `MobxPool.hydrate` → one `runInAction`
installing every queued cold row. A
locals notification → `MobxPool.applyLocals` → one `runInAction` over only
the keys it names. `rebuildFromScratch` (`pool/rebuild.ts`) replays the
feed's `snapshot(kind)` through the same ingest and the same part functions
over plain maps, with relations resolved from scratch (`scanRelations`), not
by the engine.

### Stats (what each counter counts)

- `rowsDerived` — runs of an issue model's `view` computed body (one per
  row view re-derived; a body whose result is structurally equal still
  counts, and keeps the old object).
- `notifications` — actions that changed pool state: one per feed event
  that wrote a table slot, one per locals notification naming a key the
  pool uses (selection, clock).
- `indexUpdates` — relation slots written: one per `forward` entry set or
  deleted, one per bucket array replaced (`PoolRelations.lastWrites` names
  them for the last action).
- `rollupsDerived` — 0 until the roll-ups (Mb3).
- `stats.counters` (the pool's own): `modelsCreated` (first accesses),
  `tableWrites` (slots set to a different object or deleted), `rowsRemoved`.
- `residency.counters` (Ma3): `coldWrites` (a cold row registered, relinked
  or forgotten: no slot), `requests` (distinct rows queued), `batches` (load
  windows closed), `hydrated` (rows loaded on access), `warmed` (rows
  installed because the row they inherit from stopped being cold).
  `notifications` also counts an action that only touched cold rows.
- Reads are never counted by the arm: every table read goes through
  `reads.wrapTables`, every relation read through `reads.wrapRelations`, and
  the enumeration records each id it walks with `reads.touch`.

### How to add a field

1. Declare it in `shared/src/schema.ts` (coordinator: the schema is shared).
   The model gets its getter from the schema; `pool/models.test.ts` reads it
   off a model with no edit. If the feed spells it differently, add it to
   `FEED_SPELLING`.
2. If a row view shows it: `shared/src/row-view.ts` (coordinator), then
   compute it in the part whose inputs it reads (`pool/views.ts`: own-row
   fields in `ownPartOf`; a new relation hop as a reference part plus a
   resolution part) and assemble it in `buildRowView`. A new part is a new
   computed on `IssueModel` and a new getter in `directParts`, which the
   rebuild uses, so the correctness gate (`pool/gate.test.ts`) holds the two
   together.
3. Never read a row in `view` itself, and never read a target in a part
   that also reads the own row: that is how a rename starts charging reads
   to its neighbours (`pool/counts.test.tsx` fails the budget).

## Round two (frozen, POD-4447)


Tracked object graph with enforcement on (methodology §5.3). No imports from
legacy view-model / slice / mission / presentation / replica-view code (H4
shape review gate, methodology §6.1) — every rule is re-expressed from the
frozen spec (`docs/plans/pod-4441-round-two-slice.md`, cited inline).

## Idiom

Domain models as classes with observable fields and computed getters
(`models/issue.ts`, `models/session.ts`, `models/worktree.ts`): each issue
holds its borrowed row behind `observable.ref` and derives everything —
`flat`, `visible`, `summary`, `aggregate`, `tick`, `rankKey`, `closed`,
`isSelected`, `row` — as a computed. Relations run through the graph
(`issue.parent/children/sessions/origin` read the store's buckets, so reads
flow to the calling computed and no intermediary identity propagates).
`WorklistModel` (`worklist.ts`) holds the three list-level computeds —
`visibleIds` (the ONE allowed table enumeration), `order`, `groups` — with
shallow/structural equality so the list re-renders only when order changes.

Correctness comes from two mechanisms, not from input lists (there are none):

1. **Read as late as possible.** Every computed checks cheap structural gates
   first (`structurallyExcluded`? `visible`? settled?) and reads volatile
   fields and the coarse clock only on paths that need them. MobX subscribes
   a computed only to what its body actually read, so an unrelated heartbeat
   invalidates nothing and a deep change re-runs exactly the ancestors until
   values settle (structural equality stops the propagation).
2. **The parity oracle.** `mobx.fixture.test.ts` / `mobx.engine.test.tsx` /
   `mobx.1x.test.tsx` assert the snapshot deep-equals the legacy oracle after
   every scenario; `mobx.test.ts` pins the worked example field by field.

## Write path

`RowSourceEvent` → `MobXStore.apply` (one `runInAction`): table ingest
(same reference is a no-op, `undefined` evicts) plus bucket maintenance
(`ingestIssue` / `ingestSession` / `ingestWorktree` + `resolveAllUnbound`),
then one notification. A `replace` event clears and reseeds atomically.
Derivation itself is lazy: nothing recomputes until an observer (a mounted
`observer` component) or `snapshot()` reads it. Selection and the coarse
clock are locals: `store.setSelection` flips two `isSelected` computeds (two
commits, zero derivations); `store.setCoarseNow` re-derives only rows that
read the clock (defer carriers, decay-gated rows, grace-window rows).

Enforcement (`config.ts`, imported by `arm.ts`): `enforceActions: 'always'`
plus `computedRequiresReaction`, `observableRequiresReaction` and
`reactionRequiresObservable`. No `keepAlive` anywhere: computeds suspend when
unobserved and that is correct. `snapshot()` reads outside reactions by Arm
contract; those warnings are expected, never a failure.

## How to add a field

Example: a `dueSoon` flag on the row, derived from `issue.deferUntil`.

1. `shared/src/slice-types.ts` — add it to `SliceRow` (needs coordinator:
   shared/ is frozen; the oracle compares exactly these fields).
2. `rules.ts` — add the pure predicate (cite the spec section).
3. `models/issue.ts` — read it in the computed that owns its inputs
   (`summary` for own-row inputs, `aggregate` for subtree inputs), keeping
   the read as late as possible so unrelated changes do not subscribe.
4. `models/issue.ts` `row` — assemble it into the `SliceRow` (the JSON
   comparison there is what commits rows, and what counts `rowsDerived`).
5. Tests: extend the worked-example assertion in `mobx.test.ts`. If the
   oracle (parity) disagrees, the rule transcription is wrong — fix the
   rule, never the test expectation, unless the expectation misread the spec.

## Every place a developer must remember

1. `rules.ts` — the pure predicates everything below shares (cite the spec).
2. `models/session.ts` / `models/worktree.ts` — leaf boxes (new entity
   fields arrive here as reads, never as copies).
3. `models/issue.ts` — per-issue computeds + relation getters + the
   `lastRowJson` / `lastTickJson` commit counters. New derivations live here.
4. `store.ts` — tables, buckets, ingest (every bucket write counts
   `stats.index()`), `apply`/`replace`, locals, `snapshot`, `mountWeb`,
   `dispose`. New relations add a bucket plus ingest on both write paths.
5. `worklist.ts` — `visibleIds` / `order` / `groups` (equality annotations
   are load-bearing: a fresh object without equality re-renders the list).
6. `react/list.tsx` + `native/list.tsx` — `observer` components (narrow
   reads only; rows read their own model, never arrays). Any component
   reading a MobX value must be `observer` (`eslint-plugin-mobx`
   `missing-observer`); every model member must be annotated in
   `makeObservable` (`exhaustive-make-observable`).
7. `config.ts` — the enforcement flags (new flags need coordinator review:
   they change what every test may do).
8. `arm.ts` — the `Arm` entry (test hook: the live `store`).

The oracle and the isolation fence cover 1–6; miss 3's late reads and a
heartbeat starts invalidating rows (scenario #1 goes red); miss 5's equality
and every recompute re-renders the list (scenario #2 commits the world).
Derivation counters (`rollupsDerived` = `flat` + `summary` + `aggregate`
bodies; `rowsDerived` = committed rows + tick rides; `indexUpdates` = bucket
writes) are observation-driven: unobserved computeds suspend, so count
assertions belong in mounted tests (`mobx.ui.test.tsx`, the engine lanes),
never in bare-store tests.

## M2: structural scenarios (POD-4451)

`mobx.m2.test.tsx` replays scenarios #4–#10 through the G4 count harness
at 1x with parity and the over-commit check (every committed row ⊆
oracle-changed rows) after every step, plus `PROTO_M2_STRICT=1` budget
assertions. The scan vocabulary (`MobxScanName` in `store.ts`, beside
`ArmStats`, cleared by `stats.reset()`, read via `scanCounts()`) counts the
H4 slope material per step: `move-seat-scan` (buckets visited by
`moveSeat`), `roots-spread` (keys spread by `roots()`), `resolve-unbound`
(homes visited by `resolveAllUnbound`), `visible-enumeration` (issues per
`visibleIds` run — the ONE enumeration), `order-sort`, `groups-bucket`.
Judgments per walk (inherent vs removable) live in
`docs/measurements/POD-4451-m2.md`.

Two idiom translations worth knowing. First, the identity unit is the
`IssueModel`, not the row object: models are created once and mutated
(`prev.value = …`), never replaced, so the optimism test asserts the model
survives all four #9 steps while its borrowed value settles back to the
echo value (snapshot rows are fresh objects per read by construction —
identity there is meaningless). Second, locals dispatch no row-source
event: `setCoarseNow` moves no notification counter (reactions commit, the
dispatch counter does not), so the clock step asserts `notifications == 0`
where the hand arm asserts 1 — same verdict, honest counter.

Clock subscriptions are by-construction complete: any flat/summary whose
row holds a finished member reads the clock through its retention check and
stays subscribed, so a tick re-runs all of them (3,589 settled bodies on
the fixture corpus, 0 commits) and a band-moving jump commits exactly the
movers (`mobx.clock.test.tsx`; finding F-clock in
`docs/measurements/POD-4451-m2.md` §4). There is no sensitivity list to
remember — that is the point, and the per-tick price of it.
