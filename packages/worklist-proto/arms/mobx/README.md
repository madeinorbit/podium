# arms/mobx/ — owned by the MobX arm (POD-4447)

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
