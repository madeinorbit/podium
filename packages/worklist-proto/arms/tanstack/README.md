# arms/tanstack/ — owned by the TanStack DB arm (POD-4448)

Collections and live queries for everything relational, one custom
collection for the recursive part (methodology §5.4). No imports from
legacy view-model / slice / mission / presentation / replica-view code
(H4 shape review gate, methodology §6.1) — every rule is re-expressed
from the frozen spec (`docs/plans/pod-4441-round-two-slice.md`, cited
inline in `rules.ts`).

## Idiom

One collection per entity type (`collections.ts`: issues, sessions,
worktrees, locals), keyed by id with explicit indexes (parentId,
issueId, worktree path, discovered-from edge), fed through the sync
interface (`begin`/`write`/`commit`, truncate + writes for replace).
Borrowed row objects are stored by reference, never spread — except the
query `fn` outputs, which are derived values by construction.

Every relational derivation is a live query whose output later queries
read (`queries.ts`): narrow → resolve → verdictE/verdictR → agg/aggR →
issuesN → child → summary → visible, then order/lane/groups/rows over
the rollup. Each carries an explicit `gcTime`; each `fn` body bumps
`GraphRuns`. The ONLY imperative derivation is the rollup collection's
sync (`rollup.ts`): subtree aggregates, rescue keeper chains, agent
nesting drops, the origin tick, and denormalized rank/lane inputs.

Rows subscribe by key: `collection.subscribeChanges` filtered by key,
bound with `useSyncExternalStore` per key (`react/list.tsx`,
`native.tsx`); the list subscribes to `order` only, headers to
`group:<key>`. Selection and the coarse clock are locals
(`store.setSelection` / `store.setCoarseNow`); time reaches queries
through the 1-row locals collection (marker join), never `Date.now()`.

## Write path

`RowSourceEvent` → `TanStackStore.dispatch` → prefix seats →
entity sync writes (+locals version bump) → live-query propagation →
rollup sync (batched) → commit layer (identity-stable rows, order
surface, one notification pass). A `replace` reseeds entities + prefix
and rebuilds the rollup from current collections, then reconciles the
committed rows. Selection notifies two keys + the latch rows; the clock
writes the locals row and lets the joined queries re-run.

## How to add a field

Example: a `dueSoon` flag on the row, derived from `issue.deferUntil`.

1. `shared/src/slice-types.ts` — add it to `SliceRow` (needs coordinator:
   shared/ is frozen; the oracle compares exactly these fields).
2. `rules.ts` — add the pure predicate (cite the spec section).
3. `queries.ts` — carry the input through the narrowing query that owns
   it (`issuesN` for issue fields, verdict queries for session fields)
   and compute it where its inputs live: own-row in `summaryQ`'s fold,
   subtree in the rollup's `compute`.
4. `rollup.ts` — if subtree: include it in the compared value so changes
   emit; if it feeds order/lane, denormalize it onto `RollupRow`.
5. `queries.ts` rowsQ fold + `store.ts` `refreshRow` — assemble it into
   the committed `SliceRow`.
6. Tests: extend the worked-example assertion in `tanstack.test.ts`. If
   the oracle (parity) disagrees, the rule transcription is wrong — fix
   the rule, never the expectation, unless the expectation misread the
   spec.

## Every place a developer must remember

1. `rules.ts` — the pure predicates everything above shares.
2. `collections.ts` — `EntitySync` ingest (new entity kinds arrive here),
   `PrefixIndex` seats (new prefix relations), the `locals` row shape
   (new query-global inputs), explicit `createIndex` calls.
3. `queries.ts` — one definition per live query: `narrowQ`, `resolveQ`,
   `verdictQ`/`verdictR`, `aggQ`/`aggR`, `issuesN`, `childQ`,
   `summaryQ`, `visibleQ`, `orderQ`, `laneQ`, `groupsQ`, `rowsQ`. A new
   relation means a new query in the chain with an explicit `gcTime`,
   a `getKey`, and a `GraphRuns` counter on every `fn` body.
4. `rollup.ts` — seats (member/child/origin/dependent), rescue/hosted
   bookkeeping, aggregates, ticks, rank/lane denorm, the invalidation
   rule in the file header, explicit removal driving (`dropSession`,
   removal branch of `ingestIssue`).
5. `store.ts` — dispatch order, `takeRemoved` draining, commit-layer
   compare, order surface bucketing, `graceSensitive`, selection latch,
   disposal order (reverse topology).
6. `react/list.tsx` + `native.tsx` — components (narrow props only; rows
   read their own key, never arrays).
7. `tanstack.test.ts` — the worked example (every rule change re-asserts
   here); `tanstack.1x.test.tsx` — the count budgets; `tanstack.ui.test.tsx`
   — the bindings comparison.

Miss 3's counter and H4 fails you for undercounting; miss 4's removal
branch and an evict goes stale (sync deletes are silent — see NOTES.md);
miss 5's drain and the same; miss 7 and the next arm can't tell what
broke.
