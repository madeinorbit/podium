# arms/hand/ — owned by the hand-rolled arm (POD-4446)

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

## Write path

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
