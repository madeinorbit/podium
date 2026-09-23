# arms/hand/ — the hand-rolled arm

Two generations share this folder. **`pool/`** is the round-three hand-rolled
pool (POD-4578 onward, epic POD-4545): the section "Round three: the pool"
below. Everything else is the frozen round-two arm (POD-4446), documented
after it; the pool never imports it (the lint's import fence), and it goes
when the pool's worklist replaces it.

## Round three: the pool (`pool/`)

Built on the declared schema (`shared/src/schema.ts`, L1a), fed row by row
by the kernel feed (`shared/src/row-source.ts`, `overlaid` mode), handing
each row its L1b `RowView` (`shared/src/row-view.ts`). Phase a1 (POD-4578)
holds the tables and the row views; Ha2 (POD-4579) maintains every declared
relation; Ha3 (POD-4580) keeps cold rows out until something reads them; the
visible collection, order, groups and roll-ups (Hb1-Hb3) come next.

### Idiom

- **Tables from the schema** (`pool/tables.ts`): one plain `Map` per schema
  entity — issue, session, worktree, repo — mapping the key to the BORROWED
  row object the feed handed out (never a copy, never edited). A repo's row
  is a lane that carries its facts (the feed has no repo kind).
- **Cells that record what they read** (`pool/cells.ts`): every derived
  value is a `Cell`, a memo whose body reads its inputs through tracked
  doors — a table slot (`HandPool.tracked`), a table's membership, the
  selection, a clock deadline (`pool/clock.ts`), another cell. Each door
  records the running cell under its key in a `DepIndex`; a change to a key
  dirties exactly the cells that read it on their last run. There is no
  sensitivity set, input list or hand-written "who depends on what": a cell
  declares its inputs by reading them, and a branch not taken is not an
  input.
- **A row view is a cell per part** (`pool/views.ts` `PART_RULES`,
  `pool/pool.ts` `IssueCells`): `own` (row-only fields and the clock),
  `repoId` → `prefix` → `displayRef`, `displayTitle`, `originRef` →
  `originId` → `originTick`, `activityAt`, `loading`, then `view` assembles
  them and reads no row.
  A single-valued relation is its own part, read through the relation
  accessor (`relations.one`: the engine's forward slot plus the target's
  presence), never resolved off the own row, so a rename moves no relation
  slot and re-runs neither; the target's fields are the next part's. An
  origin's rename re-runs only its spin-offs' `originTick`. A cell whose new
  value is structurally equal (`sameData`) keeps its old object, so the row
  does not redraw and the propagation stops there.
- **Records from the schema** (`pool/records.ts`): `HandPool.record(entity,
  id)` is a typed record per row, built on first access, with one getter per
  declared field installed from the schema (`installFields`); it reads the
  row through the tracked table on every access. `FEED_SPELLING` names the
  one field the feed spells differently (a repo's `path` is its lane's
  `repoPath`).
- **Per-key listeners**: `HandPool.subscribe(id, listener)` per row view,
  `subscribeIds` for the id list; the lists bind each with
  `useSyncExternalStore` (`pool/react/list.tsx`, `pool/native/list.tsx`).
  A row component gets its `RowView` and nothing else.
- **Relations from the schema** (`pool/relations.ts`, Ha2): the engine
  reads `schema[entity].relations` at construction and names no relation.
  Each single-valued relation (`belongsTo`, `prefix`, outgoing `edge`) is a
  LINK: a forward `Map` (source → target key, members only) paired with the
  inverse collection it maintains, a `Map` of `Set`s (target key → members).
  Ingest hands every table write to `changed(entity, id, prev, next)`, which
  re-decides the resume-twin collapse (`session.collapse`) when its inputs
  moved, relinks each link whose declared inputs (key, path or edge field,
  plus every `where` field) moved — detach, then attach, one member at a
  time — and, for a new or removed worktree, re-homes the sessions under it
  (a path index finds them without a scan). Buckets are keyed by the
  reference, so an evicted and re-added target finds its members where they
  were. Every slot written becomes a `relation` delta that dirties only the
  cells that read that slot; `one()`'s presence check is tracked on the
  target's presence, not its row. A bucket has no order: a reader that needs
  one imposes it (a draft's first member is the lowest session id).
- **Residency** (`pool/residency.ts`, Ha3): the schema's cold rule
  (`coldByRule` in `shared/src/schema.ts`: an issue with `closedAt`, a
  session of such an issue) keeps a row OUT of the tables at ingest: a plain
  registry holds its id (and a session's issue), and the relation engine
  links it all the same, so buckets hold hot and cold ids alike. A cell that
  reaches a cold row asks `ViewInputs.loading(entity, id)`: that records the
  cell under the row's `coldness` key and queues the row; the first request
  arms a 50 ms window, and every row queued in it is read by id through the
  feed (`RowSource.row`) and installed in ONE commit (`HandPool.hydrate`). A
  registry entry that appears or leaves is a `residency` delta (a member of
  the closed union) that dirties exactly the cells that asked. The row view
  sets `loading` while its origin or a member session is cold, so the
  provisional values are never drawn as data. A cold row's update that keeps
  it cold relinks it and is not stored; an update that makes it hot (a
  reopen) installs it and its cold sessions at once; a removal warms its
  cold sessions; only a `replace` makes rows cold again (it re-partitions).
  `HandPool.lazyMany` answers a lazy collection as `{ ready, pending }`: what
  a roll-up (Hb3) derives from, and its pending marker. `HandPool.resident`
  is the tracked "resident / loading / absent" of one row.

### The enumeration module

`pool/enumerate.ts` is the ONE module that walks a whole table
(`fence.json` `enumeration`; the lint's `no-table-walk` refuses a walk
anywhere else in `pool/`): `issueIdsOf` (every issue id, for the a1 list and
`snapshot()`, until Hb1's visible collection; the id-list cell records the
issue table's MEMBERSHIP as its input, so a rename never re-runs it),
`reseed` (a `replace`; with residency it walks the cold registry for the ids
the slice dropped), and `scanRelations` / `diffRelations`: every
declared relation resolved from scratch by walking the tables, the oracle
the gate and `pool/relations.test.ts` hold the engine to (the pool never
calls it); `knownTables` (every row the pool knows, from the feed, cold ones
included) and `diffResidency` (the hot/cold partition against the feed), the
gate's. When a repo's lane leaves, another lane is found in the
maintained `repo.worktrees` collection, not by a walk.

### Write path

`RowSourceEvent` → `HandPool.apply`: the whole event is ingested
(`ingestRecord` per record — the same object is no write; `value:
undefined` removes the row; a `replace` runs `reseed`: the new slice through
the same ingest into fresh maps, then kept rows untouched, changed rows
written, the rest removed), each slot write reported as a row delta. Then
ONE `commit` runs the handlers in order over the closed `Delta` union (each
a `switch` with a never-check): `invalidate` (dirty the readers of each
delta's key, and move the local it names), `release` (a row that left
disposes its cells and record), `CellGraph.flush` (dirty cells run lowest
level first; a changed cell dirties its readers), `publish` (each changed
key's listeners once, the id list's once). A locals notification →
`HandPool.applyLocals` → the same commit with `selection` / `clock` deltas
for only the keys it names. `rebuildFromScratch` (`pool/rebuild.ts`)
replays the feed's `snapshot(kind)` through the same ingest into fresh maps
and runs the same `PART_RULES` directly (`directParts`), no cells.

### Stats (what each counter counts)

- `rowsDerived` — runs of an issue's `view` cell body (one per row view
  derived or re-derived; a run whose result is structurally equal still
  counts, and keeps the old object).
- `notifications` — commits that changed pool state: one per feed event
  that wrote a table slot, one per locals notification naming a key the
  pool uses (selection, clock). A commit with no delta is not one.
- `indexUpdates` — relation ELEMENTS the engine touched: a bucket member
  added or removed, a forward entry set or deleted, a path-index entry, a
  collapse entry. Never slots, so a bucket-sized copy could not hide behind
  one count (M3 F1); `pool/relations.test.ts` asserts one new issue costs
  the same in a repo of 1,000 as in a repo of 1. The cells' dependency
  indexes are bookkeeping, not relation indexes, and are not counted.
- `rollupsDerived` — 0 until the roll-ups (Hb3).
- `residency.counters` (Ha3, zeroed by `stats.reset()`): `coldWrites`
  (registry writes: a cold row registered, relinked or forgotten),
  `requests` (distinct rows queued), `batches` (windows closed, one commit
  each), `hydrated` (rows loaded on access), `warmed` (rows installed because
  the row they inherit from stopped being cold).
- `stats.counters` (the pool's own): `cellsCreated` (cells made on first
  read), `cellRuns` (cell bodies run, first runs included), `cellsChanged`
  (re-runs whose value differed), `tableWrites` (slots set to a different
  object or deleted), `rowsRemoved` (rows that left, each with its cells and
  record disposed), `recordsCreated`, `listenerCalls` (listener calls made by
  `publish`).
- Reads are never counted by the arm: every table read goes through
  `reads.wrapTables` (behind the tracked doors), every relation read through
  `reads.wrapRelations`, and the id walk through the fenced table's `keys()`.

### Gates (a-phase)

- **Correctness (L4b)**, `pool/gate.test.ts`: rebuild-only (`oracleEvery:
  0`, coordinator ruling for the a-phase; the oracle compares order and
  roll-ups), plus, at every compared step, every relation of every KNOWN row
  (cold ones included) against the from-scratch scan of the feed (Ha2) and
  the hot/cold partition against the feed (Ha3); at the last step, the
  full-residency checkpoint (load everything, then compare with no input
  from the pool). Five planted NOs, each of which must fail every seed:
  deaf to removals (the rebuild), relation upkeep skipped on a held row's
  update (the scan), deaf to cold rows' updates (partition or scan), cold
  relinks skipped (the per-step scan, checkpoint off: the error heals on
  load), a cold session forgotten (the checkpoint, per-step checks off).
  Defaults 3 seeds x 200 steps; the gate of record is 20 x 300
  (`POD_POOL_GATE_SEEDS`, `POD_POOL_GATE_FIRST_SEED` for chunks,
  `POD_POOL_GATE_STEPS`). The same file compares the own-row and one-hop
  fields with the oracle's row views, after loading the visible rows.
- **Residency**, `pool/residency.test.tsx` (bootstrap split by count, cells
  on first read with the list mounted, the loader, lazy relations with the
  pending marker, every transition) and `pool/bootstrap.test.ts` (counts at
  1x and 4x; walls with `POD_POOL_BOOT_WALLS=1`).
- **Fence steps** #1, #3, #4, #8, #8b, `pool/counts.test.tsx`: the shared
  `assertCommits` (where the a1 list can meet it), `assertReads` and
  `assertNoCopies`, no parity; the roster entry with parity is Ha4's
  (`harness/src/fences.test.tsx` names it pending). The mount's queued loads
  are settled before counting (the window never closes on its own there).
- Relations: `pool/relations.test.ts` — per relation, the §4.5 worked
  example, the write record per change kind, the fixture schema with an
  extra relation, the resume twins against the legacy dedupe, and seeded
  random sequences against the scan.
- Lifecycle, ingest and locals: `pool/pool.test.tsx`; the cell and the clock
  in isolation: `pool/cells.test.ts`, `pool/clock.test.ts`; every schema
  field on a record: `pool/records.test.ts`.

### How to add a field

1. Declare it in `shared/src/schema.ts` (coordinator: the schema is
   shared). The record gets its getter from the schema;
   `pool/records.test.ts` reads it off a record with no edit. If the feed
   spells it differently, add it to `FEED_SPELLING`.
2. If a row view shows it: `shared/src/row-view.ts` (coordinator), then
   compute it in the part whose inputs it reads (`pool/views.ts`
   `PART_RULES`: own-row fields in `own`; a new relation hop as a part that
   calls `input.relations.one`/`many` plus a part that reads the target) and
   assemble it in `buildRowView`. A new RELATION is a schema declaration and
   nothing else: the engine maintains it. A new
   entry in `PART_RULES` is a new cell in the live pool AND a new getter in
   the rebuild, with nothing else to edit, so the correctness gate holds the
   two together.
3. Read inputs only through `ViewInputs` (the tracked doors). A plain field,
   closure or module value read inside a part is an input no cell recorded:
   the value goes stale and the gate's rebuild comparison fails.
4. A part that reads a lazy relation's target (an issue or session that may
   be cold) reads only resident rows (`input.present`, `input.issue`, ...)
   and the target joins the `loading` part, so the row shows loading, never
   a half-built value as data.
5. Never read a row in `view`, and never read a target in a part that also
   reads the own row: that is how a rename starts charging reads to its
   neighbours (`pool/counts.test.tsx` fails the budget).

## Round two (frozen, POD-4446)

Incremental view maintenance with typed deltas (methodology §5.2). No imports
from legacy view-model / slice / mission / presentation / replica-view code
(H4 shape review gate, methodology §6.1) — every rule is re-expressed from
the frozen spec (`docs/plans/pod-4441-round-two-slice.md`, cited inline).

## Idiom

Normalised entity tables keyed by id (`tables.ts`) hold borrowed row objects
by reference — never spread on the hot path. Every derived structure is a
small module with one `apply(batch)` that updates its output in place and
emits typed deltas downstream: a dataflow of deltas, not a cache of
snapshots. One `RowSourceEvent` becomes one delta batch, run through the
levels in topology order (`store.ts`: tables → indexes → summary → visible
→ rollup → order/groups → rows), then a single notification pass with
de-duplicated per-key subscriptions (row id, `group:<key>`, `order`,
`selected:<id>`; React binds with `useSyncExternalStore` per key).

Correctness comes from two mechanisms, not from input lists (there are none):

1. **Exhaustiveness.** Delta kinds form a closed union (`deltas.ts`); every
   handler switches over all of them with `assertNever` in the default
   branch, so ignoring a kind is a compile error.
2. **Rebuild oracle.** `rebuild.ts` re-derives everything from scratch
   through the same pure `compute` functions but with zero incremental
   state; `hand.test.ts` / `hand.engine.test.tsx` / `hand.1x.test.tsx` /
   `hand.m2.test.tsx` assert incremental deep-equals rebuild after every
   scenario.

## M2 (POD-4450): what the structural scenarios changed

- **Clock sensitivity is a bootstrap invariant.** `timeSensitive`
  (summary), `decaySensitive` (visible) and `graceSensitive` (groups) decide
  which rows a tick re-derives; all three are populated by `rebuildAll`, not
  just by incremental refresh — a bootstrap that leaves one empty blinds
  every later tick (M2 gap, fixed with a regression test per set in
  `hand.test.ts` "clock sensitivity sets").
- **Order keeps a membership set and rank keys.** Placement checks read the
  set (the old `ordered.includes` was an O(visible) scan per dirty row);
  re-ranks whose key did not move skip the position walk (burst50 paid
  ~1,100 no-move probes before this). Issue seats in `indexes.ts` diff
  against a prev-seat map for the same reason (the old `moveSeat` walked
  every bucket).
- **Order has no clock arm on purpose.** Summary runs before order and every
  band flip arrives as `SummaryChanged`; the old `timeSensitive` sweep
  re-ranked ~540 carriers per tick at 1x, each paying a position walk.
- **Multi-row walks are counted.** `scan(name, visits)` in `deltas.ts`
  prices the remaining O(visible)-or-worse walks (group rebuilds, batch
  builds, subtree walks, removal lookups, snapshot builds); the store
  surfaces cumulative totals beside `ArmStats`, and the M2 run reports them
  per scenario. The oracle does not cover counts — the M2 run's exact
  derivation assertions do.

## M3 (POD-4453): what the lifecycle phase changed

- **Rollup seats are incremental; the batch build is gone.** `openExplicit`
  (issues with ≥1 open explicit session), `lastActive` (per-issue max over
  non-archived explicit sessions) and `staffed` (ancestor closure of open
  issues) are maintained, not rebuilt: session diffs against a per-session
  snapshot refresh the touched issue's bucket only (O(bucket), typically one
  session), open flips walk the ancestor chain (O(depth)), parent moves
  re-hang the moved subtree's open issues (O(open-in-subtree × depth)).
  Semantics mirror the old build exactly (same predicates, same walks), so the
  rebuild oracle covers the maintenance. The `rollup-batch` scan (~11.2k
  visits per computing dispatch at 1x) is zero on every scenario; the M2
  strict gate passes with identical rows/derivations.
- **Computation share is timed.** `HandStore` accumulates `indexMs`
  (index maintenance), `rollupMs` (summary + visible + rollup) and `rowMs`
  (order + groups + rows) per dispatch, exposed via `store.phaseMs()`.
  Arm-local optional fields on the arm's own stats object — the shared
  `ArmStats` interface and the harness's four-field readers are untouched.
- **Write idiom (sketch only).** A pending delta is a synthetic `update`
  through `dispatch` plus a side mark; echo clears the mark, rejection
  re-applies the saved prior row. See `docs/plans/POD-4453-write-path.md`;
  the spike lives in `spike/` and is never imported by the production path.

`RowSourceEvent` → `HandStore.dispatch` → table deltas → `IndexSet.apply`
→ `SummaryModule` → `VisibleModule` → `RollupModule` → `OrderModule` +
`GroupsModule` → `RowsModule` → notify. Selection and the coarse clock are
locals: `store.setSelection` / `store.setCoarseNow` drive synthetic
single-delta batches (`SelectionChanged` notifies only `selected:<old/new>`;
`ClockChanged` re-derives only time-sensitive rows). A `replace` event
clears and reseeds atomically with one notification pass.

## How to add a field

Example: a `dueSoon` flag on the row, derived from `issue.deferUntil`.

1. `shared/src/slice-types.ts` — add it to `SliceRow` (needs coordinator:
   shared/ is frozen; the oracle compares exactly these fields).
2. `rules.ts` — add the pure predicate (cite the spec section).
3. `summary.ts` or `rollup.ts` — compute it where its inputs live (own row
   vs subtree), include it in the compared value so changes emit.
4. `rows.ts` — assemble it into the `SliceRow`.
5. `rebuild.ts` needs no change (it reuses the same computes).
6. Tests: extend the worked-example assertion in `hand.test.ts`. If the
   oracle (parity) disagrees, the rule transcription is wrong — fix the
   rule, never the test expectation, unless the expectation misread the spec.

## Every place a developer must remember

1. `deltas.ts` — the kind union (add a kind here and every handler below
   fails to compile until it handles it — that is the point).
2. `tables.ts` — table ingest (new entity kinds arrive here).
3. `indexes.ts` — buckets + seats (new relations; every bucket write counts
   `stats.index()`).
4. `summary.ts` — own-row derivation + `timeSensitive` set.
5. `rollup.ts` — subtree aggregation + ancestor-chain walks.
6. `visible.ts` — flat predicate + rescue chains + `decaySensitive` set.
7. `order.ts` — rank keys (band-affecting fields only).
8. `groups.ts` — lane placement + `closedOf` inputs + `graceSensitive` set.
9. `rows.ts` — `SliceRow` assembly (every snapshot field is read here).
10. `store.ts` — level order in `runLevels`, key mapping in `notifyBatch`.
11. `rebuild.ts` — module construction order (mirrors `runLevels`).
12. `react/list.tsx` + `native.tsx` — components (narrow props only; rows
    read their own key, never arrays).
13. `rules.ts` — the pure predicates everything above shares.

The oracle and the never-checks cover 1–11; 12 is covered by the isolation
fence (rows committed ≤ rows affected). Miss 4–8's sensitivity sets and a
clock tick goes stale — `hand.test.ts` ("clock sensitivity sets", one case
per set plus a finished-review non-decay pin) proves each set repopulates
from bootstrap and flips its rows. Miss 9 and parity fails loudly. Scan
miscounts (the `scan` vocabulary in `deltas.ts`) are covered by the M2 run's
exact derivation-count assertions, not by the oracle.
