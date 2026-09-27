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
relation; Ma3 (POD-4567) keeps cold rows out until something reads them;
Mb1 (POD-4569) builds the visible collection and its order; Mb2 (POD-4570)
groups it with closed folds and windows the lists; roll-ups (Mb3) come next.

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
   (`installFields`); `FEED_SPELLING` (in `shared/src/repo-from-lane.ts`,
   POD-4695) names the one field the feed spells
  differently (a repo's `path` is its lanes' `repoPath`).
- **Every derived value a computed, split by input** (`pool/views.ts`
  `IssueParts`, computed on `IssueModel`): `own` (row-only fields and the
  clock), `repoTarget` → `prefix` → `displayRef`, `displayTitle`,
  `originRef` → `originId` → `originTick`, `activityAt`, then `view`
  assembles them and reads no row. A relation's TARGET comes from the
  engine (`inputs.relations.one('issue', id, 'repo' | 'discoveredFrom')`),
  which reads the link's forward slot and the target's presence, never the
  own row; the target's FIELDS are a separate part. So a rename re-runs
  neither, and an origin's rename re-runs only its spin-offs'
  `originTick`. No view resolves a relation itself (M3 F2; the lint refuses
  `views.ts` importing `relations.ts`). `one()` answers a KNOWN cold origin,
  so `originRef` may be cold: `loading` reads it, `originId` keeps only a
  resident one. The rebuild runs the same parts over the scan's `one()`, so
  the gate holds the engine's forward slots to a from-scratch resolution.
  Objects compare structurally (`computedStruct`), so an unchanged part or
  view keeps its identity.
- **Roll-ups re-compose from cached child values** (POD-4568). A part over
  a collection reads the bucket once (`sessionIds`, its own computed) and
  each member's CACHED value, a computed on the member's model
  (`SessionModel.activityMs`), never the member's row: one session's
  `lastActiveAt` re-runs that session's computed (one row read) and the
  issue's `activityAt` over cached siblings. A value that needs a member
  only sometimes asks for it only then (a draft's title reads its first
  member; a non-draft's never does). A member model built earlier is taken
  from the identity memo without a presence read; it reads its own slot, so
  a removed member answers null (the bucket that listed it has moved).
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
  observable `buckets` (target key → an observable SET of member ids: its
  inverse collection, UNORDERED). Ingest tells the engine of every table
  write; it re-resolves only links whose declared inputs moved (key/path/edge
  field and every `where` field), detaches then attaches, and the action's
  one `flush` applies each touched bucket's NET moves once: one element added
  or deleted per edge moved, whatever the bucket's size (M3 F1; the round-
  three a-phase copied and sorted the whole bucket, 4,575 elements for one
  new issue on the live export). An order a reader needs is applied at view
  time (`sessionIds` sorts its members). The `prefix` link keeps an ancestor
  index (`under`) so a new root takes its sessions without a scan, and a
  removed root hands them to the next-longest root. The session resume-twin
  collapse is declared in the schema (`session.collapse`,
  `collapseLosers`); a collapsed row contributes no edge. Derivations read
  buckets only through the shared `RelationReader` (`one`: one read; `many`:
  one per member, unordered; `size`: free). Adding a relation to the schema needs no
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

- **Visible collection and order** (`pool/worklist/visible.ts`, Mb1): R-VIS
  (slice spec §3, executable in the oracle) as parts on one node per KNOWN
  issue, hot or cold (`IssueNode`), and one per member session
  (`SessionNode`): own-row standing, R2+R3 members, retention against the
  clock's deadlines, the flat pass, the rescue read down `children`
  (`keeps`/`keptBelow`), and nesting (nearest present ancestor, the started-by
  fallback). A cold row is read by id through the feed (`MobxPool.coldRow`,
  counted, tracked by residency's per-id atom); it is loaded only when drawn.
  The set of visible ids is MAINTAINED by one reaction per node (nodes follow
  each event's issue records, `MobxPool.syncWorklist`); the order is a
  computed `compareRank` sort of the visible nodes' cached ranks, reading no
  row. A cold visible row is drawn as a placeholder outside `RowShell` until
  its load lands.

- **Groups and closed folds** (`pool/worklist/groups.ts`, Mb2): R-GROUP over
  the order. Each node carries a `placement` (`computedStruct`: pinned, group
  key and label, fold verdict, fold stamp) read from the own row, hot or cold;
  one `layout` computed over the order and the visible placements (the
  snapshot's `SliceOrder`, no selection) re-runs only when either moves; one
  `GroupNode` per key holds its lanes as shallow-compared computeds with the
  R-GROUP 5 latch applied. The rebuild groups its own views with L1b's
  `groupKeyOf` / `compareClosedFold` instead.
- **Lists** (`pool/react/list.tsx`, `pool/native/list.tsx`, Mb2): the web list
  windows with `@tanstack/react-virtual` (56 px rows, 40 px headers; every item
  when the container has no height, i.e. the happy-dom count lane); the native
  list is a `SectionList`. The list observes the grouped ids, a header its own
  group's lanes, a slot its row's presence, the row its `view`.

### The enumeration module

`pool/enumerate.ts` is the ONE module that walks a whole table
(`fence.json` `enumeration`; the lint's `no-table-walk` refuses a walk
anywhere else in `pool/`): `issueIdsOf` (every resident issue id),
`knownIssueIds` (every known issue id, hot or cold, which the visible
collection syncs its nodes to at a `replace`) and `reseed` (a `replace`).
It also holds the from-scratch relation resolution the live pool never
runs: `scanRelations` (the rebuild's relations: the declared resolvers over
whole tables) and `diffRelations` (the live engine against that scan, for
the relation tests and the gate), plus the gate's residency walks:
`knownTables` (every row the pool knows, cold ones from the feed) and
`diffResidency` (the hot/cold partition against the feed).

### Write path (phase c: optimism on the model, Mc1/Mc2)

`pool/write/` holds the pending display beside the pool; the kernel stays the
transport, the durable queue and the authority on outcomes, and the pool's
tables go on holding BORROWED server rows, never a copy.

- **Where pending lives.** An observable map of per-row overlays
  (`write.overlays`: the newest pending value per editable field —
  title/stage/readAt only, never a full row), mirrored from the reference
  pending log (`shared/src/write-contract.ts` `createPendingLog`, re-exported
  by `pool/write/pending.ts`; the arm owns no log of its own). It is overlaid
  at the row-reader boundary (`pool.inputs.issue`,
  `pool.visibleInputs.issueRow` / `progressFacts` / `loadedIssue`) plus the
  read cursor (`pool.visibleInputs.issueRead`, so a pending mark-read flips
  the unread/decay verdicts at once, exactly as the overlaid row flips the
  rebuild's): no pending edit returns the server object unchanged
  (identity-preserving, idle layer invisible); with one a transient
  `{...server, ...pending}` is returned (never stored, so the copy sweep
  never sees it).
- **What the kernel still owns.** The command (`commandFor`: title/stage ride
  `issues.update`, `readAt` rides `issues.markRead`), the queue and its
  persistence, the receipt (`accepted` = outbox `applied`, L3b), the echo
  (the server row, recognised by value: exact for title/stage, the server's
  own stamp for `readAt`), the refusal (parked or discarded) and the collapse
  (mark-read supersede). The arm never reads the kernel's fold (W12): its
  feed runs in `truth` mode, server rows only.
- **The loop.** `edit` paints in one action and sends without awaiting;
  `handleAccepted` records the receipt (the entry stays until its echo
  confirms every field — dropping on receipt alone would flicker); the echo
  arrives as an ordinary feed row and settles with zero extra commits when
  its values equal the pending ones (no equal rewrite, PITFALL); a remote on
  a pending row keeps the local value and takes the rest; `reject` rewinds
  from the log and surfaces the error; `handleSuperseded` drops a collapsed
  mark-read without repainting; `expire` drops receipted edits past the TTL;
  a duplicate receipt is a no-op. `bootstrap` re-applies the outbox's pending
  entries on creation under their own mutation ids without re-sending, over
  the feed's server rows (the reference oracle's reload rebuild reads the
  same rows, so the two resolutions agree exactly), so pending edits survive
  a principal-preserving rebuild.
- **The rebuild is optimism-aware.** `rebuildFromScratch` overlays the pending
  display onto the feed's server rows before deriving, so a gate with pending
  edits outstanding compares pending with pending — never with server truth.
- **The gate adapter** (`shared/src/gen/arm-edits.ts`, shared with the hand
  arm's Hc2): generated edits call the live arm's `write.edit` while its
  transport invokes the same runtime action, so the kernel mints the mutation
  id and the runner learns it from the outbox as before; outcomes and
  `pending()` entries are translated between kernel and arm ids for receipts,
  rejections and bootstrap across reloads.

Tests: `pool/write/edit.test.tsx` (paint, rewind, order, mark-read,
stacking), `pool/write/settle.test.tsx` (echo zero-commit, remote-on-pending
one commit, duplicate no-op, rebuild and bootstrap re-apply),
`pool/write/gate-truth.test.ts` (L4b on the truth feed with arm edits: the
whole-snapshot shared write oracle, complete-or-fail per-seed rows, plus the
(a)/(c) write-path plants on fixed sequences, the visibility plants (i)/(ii)
and the late-remote plant (iii)), `pool/write/gate-with-
edits.test.ts` (the phase-a/b gate still passes with the layer attached but
idle).

### Stats (what each counter counts)

- `rowsDerived` — runs of an issue model's `view` computed body (one per
  row view re-derived; a body whose result is structurally equal still
  counts, and keeps the old object).
- `notifications` — actions that changed pool state: one per feed event
  that wrote a table slot, one per locals notification naming a key the
  pool uses (selection, clock).
- `indexUpdates` — relation slots written: one per `forward` entry set or
  deleted, one per bucket touched (`PoolRelations.lastWrites` names them
  for the last action). A slot says nothing about the work inside it; that
  is `bucketElements`.
- `counters.bucketElements` (M3 F1) — relation bucket ELEMENTS touched: one
  per member added to or deleted from a bucket, plus a cold bucket's members
  once when its target turns resident (`promote`). One edge moved = 1,
  whatever the bucket's size (`relations.test.ts` "bucket upkeep is
  proportional to the change": 4,000-member buckets, 1 per insert and per
  delete). `PoolRelations.lastElements` is the last action's.
- `rollupsDerived` — 0 until the roll-ups (Mb3).
- `stats.counters` (the pool's own): `modelsCreated` (first accesses:
  every drawn issue, and each resident member session a drawn row's
  activity reads),
  `tableWrites` (slots set to a different object or deleted), `rowsRemoved`,
  `bucketElements` (above).
- `residency.counters` (Ma3): `coldWrites` (a cold row registered, relinked
  or forgotten: no slot), `requests` (distinct rows queued), `batches` (load
  windows closed), `hydrated` (rows loaded on access), `warmed` (rows
  installed because the row they inherit from stopped being cold).
  `notifications` also counts an action that only touched cold rows.
- Reads are never counted by the arm: every table read goes through
  `reads.wrapTables`, every relation read through `reads.wrapRelations`, and
  the enumeration records each id it walks with `reads.touch`.

### Gates (a phase, POD-4568)

- **Correctness (L4b)**, `pool/gate.test.ts`: rebuild-only (`oracleEvery:
  0`; the oracle compares order and roll-ups, Mb4's). Defaults are 3 seeds x
  200 steps; the gate of record is 20 x 300, run from the repo root:
  `POD_POOL_GATE_SEEDS=20 POD_POOL_GATE_STEPS=300 bun scripts/test-heavy.ts
  -- bash -c "bun --bun ./node_modules/vitest/vitest.mjs run --config
  vitest.unit.config.ts --project node
  packages/worklist-proto/arms/mobx/pool/gate.test.ts"` (heavy lease only;
  `test:file` inside `test-heavy` would also hold a focused slot for hours).
  Each seed also runs four planted arms, and each must fail on every seed:
  removal-deaf (caught by the rebuild), cold-deaf and relink-skipped (by
  the per-step checks), and promote-skipped for sessions (by the
  full-residency checkpoint alone).
- **Bucket work (M3 F1)**, `pool/relations.test.ts` "bucket upkeep is
  proportional to the change": 1 element per edge in 4,000-member buckets,
  COUNTED OUTSIDE THE POOL (M3 G1): the test patches MobX's `ObservableSet`
  prototype (`add`, `delete`, `values`, which every iteration goes through)
  and `Array.prototype.sort`/`toSorted` around the push, and asserts that
  count; `bucketElements` must then equal it. The pool's own counter alone is
  not evidence: a copy-and-sort that does not report itself leaves it at 1.
  PLAIN SETS AND MAPS TOO (M3 G3): the prefix index is a map of plain `Set`s,
  so the test also patches `Set` and `Map` (writes, deletes, every iterator,
  `forEach`) and `Array.from`, skipping calls MobX makes on its own sets.
  That count must stay under the change's own bookkeeping (16) plus two per
  ancestor path of the row, plus one: an unsorted copy of one prefix set
  (8,003 elements per new session) fails it.
  AND NO SET IS SWAPPED (M3 G4): a copy no patched method makes
  (`set.union(new Set())`, `structuredClone(set)`) is caught by identity: no
  set the engine holds (`under`, `buckets`, `coldBuckets`, collapse
  `groups`) may be a different object after one edge.
  M3's probe (`harness/review/m3-shape-probes.test.tsx`, with
  `M3_LIVE_EXPORT`) prints the same count on the live export.
- **Fence steps #1-#4**, `pool/counts.test.tsx`: the shared
  `assertCommits` (#1-#3), `assertReads` and `assertNoCopies`, no parity.
- **Every fence step #1-#10 with parity**, `harness/src/fences.test.tsx`:
  the pool is on the roster (`harness/src/roster.ts`, POD-4572) with its
  named allowances (`worklist/known-gaps.ts` `MOBX_POOL_ALLOWANCES`: POD-4671
  parity, POD-4674 `activityAt`, POD-4678 #10 reads), each failing the suite
  once no step needs it.
- **The console trap** (M3 N3): `installMobxWarnTrap({ errors: true })` also
  fails a test on any `console.error` (MobX reports a throw inside a reaction
  there); the native lane runs under it. The browser driver fails a candidate
  arm's run on any console warning or error (`run.ts`; proof plants
  `--console-plant warn|reaction`). The production pages compile MobX's
  enforcement warnings out, so enforcement proper is asserted in the count
  lanes.
  A STEP COUNTS ITS OWN LOADS (M3 G2): the handle's `settleLoads()` flushes
  the arm's redraws and lands what they queued until nothing is queued, and
  the shared fence (`runFenceStep`) awaits it inside each step before the
  reads are sampled; `pendingLoads()` lets it refuse a step that leaves one.
  It finds the feeds by `feeds.flush`'s identity and refuses any other
  flush (N9), so a wrapper cannot switch the lazy-arm refusal off.
  M3's cold-issue plant fails #2 there (2,839 reads, budget 3).
- Numbers: `docs/measurements/POD-4568-a.md`.

### How to add a field

1. Declare it in `shared/src/schema.ts` (coordinator: the schema is shared).
   The model gets its getter from the schema; `pool/models.test.ts` reads it
   off a model with no edit. If the feed spells it differently, add it to
   `FEED_SPELLING` in `shared/src/repo-from-lane.ts`.
2. If a row view shows it: `shared/src/row-view.ts` (coordinator), then
   compute it in the part whose inputs it reads (`pool/views.ts`: own-row
   fields in `ownPartOf`; a new relation hop as a target part that reads
   `inputs.relations.one(...)`, never the own row, plus a part that reads
   the target's fields) and assemble it in `buildRowView`. A new part is a new
   computed on `IssueModel` and a new getter in `directParts`, which the
   rebuild uses, so the correctness gate (`pool/gate.test.ts`) holds the two
   together.
3. Never read a row in `view` itself, and never read a target in a part
   that also reads the own row: that is how a rename starts charging reads
   to its neighbours (`pool/counts.test.tsx` fails the budget).
4. A field over a collection (a roll-up): put each member's contribution in
   a computed on the MEMBER's model, add it to `ViewInputs` (the rebuild
   computes the same function directly), and walk the cached member list
   (`sessionIds`), never the relation or the member rows, in the parent's
   part. Reading member rows re-reads the whole family on every member's
   change (POD-4568: #2 read 4 rows against a budget of 3).

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
