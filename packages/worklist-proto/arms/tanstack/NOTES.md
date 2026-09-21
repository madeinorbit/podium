# POD-4448 NOTES — TanStack DB arm, milestone 1

## Decisions

- **Idiomatic TanStack, not a port of the store.** Entity collections with
  sync adapters, chained live queries for every relational derivation,
  one custom collection for the recursion. The round-one traps stayed
  out by construction: no envelope rows (borrowed objects stored by
  reference; only `fn` outputs are fresh objects, which is what derived
  values are), one wake mechanism (the query graph + the rollup sync —
  §"Two mechanisms" below says exactly what each owns), no `keepAlive`,
  no whole-worklist computed, no input lists.
- **R3 is a maintained index + a fanned-out join.** Longest-prefix
  containment is not expressible in the query predicate language (joins
  are cross-source `eq` only), so `PrefixIndex` owns the match and the
  `wtVersion` join makes every seat move re-resolve. One session can sit
  at a worktree shared by N issues, and `fn.select` is 1:1, so the fan-out
  happens in `verdictR`'s join (resolveQ × issuesN on path equality);
  explicit members resolve through `verdictQ`. The fixture caught the
  first single-owner design dropping R3 members (s562); the unit test now
  pins s3's seat.
- **Time and prefix version ride a 1-row locals collection.** Queries join
  it on a constant marker (self-equality joins are rejected; the marker
  must be materialized by an upstream query — joins see pre-`fn` rows,
  verified). Selection does NOT enter the queries: a click must not
  re-run 3,200 lane fns (R-SEL); the latch lives in the commit layer.
- **The rollup sync owns seats + fixpoints + denorm.** Member/child/
  origin/dependent seats, rescue keeper chains, agent nesting drops, the
  origin tick, and rank/lane inputs denormalized onto `RollupRow` so
  order/lane stay single-source pure queries. Invalidation: member
  changes walk the owner chain stopping at the first unchanged value;
  edge moves walk both ends fully; flat flips reconcile keepers;
  summary changes rewrite denorm only; prefix bumps re-tick.
- **Sync deletes are silent — removals are driven explicitly.** Verified:
  sync `delete` writes apply without subscriber events, on entity AND
  live-query collections; updates/inserts notify synchronously, and
  updates propagate as retraction+assertion pairs. `EntitySync`
  records removed keys (`takeRemoved`); the store drives
  `rollup.ingestIssue(id, undefined)` / `dropSession` / dirty rows from
  them. R1 edges reconcile from issue rows because childQ drops archived
  rows silently.
- **Stats match the hand arm's classification.** `rowsDerived` = committed
  rows; `rollupsDerived` = post-gate per-issue bodies (summary folds,
  rollup recomputes, rows folds — counted after the structural-exclusion
  gate, same placement as the hand arm); `indexUpdates` = net membership
  moves per flush (a retraction+assertion pair nets zero); per-query `fn`
  runs live in `GraphRuns` for these tables, not in `ArmStats`.
- **Rows subscribe by key, not by findOne.** Measured both at small scale
  (`tanstack.ui.test.tsx`): identical commits (1 row), keyed 3.5ms vs
  findOne 6.2ms for 3 rows under load, and findOne costs a live query
  instance per mounted row against zero for keyed subscriptions. Keyed
  stays the default. Windowing is hand-rolled (fixed heights + overscan),
  the same call the MobX arm made — no new virtualization dependency.
- **Native renders full in a ScrollView for M1**, same as both prior arms
  and the control lane, so counts compare directly.

## Verified library semantics (all by spike, kept out of the tree)

1. IVM is per-row incremental: one update re-runs ~2 `fn` evaluations
   (retraction + assertion) with identity-stable output rows otherwise.
2. Value-equal outputs do not emit change events downstream.
3. Propagation is synchronous through chains (subscribe → read current).
4. Joins require cross-source `eq`; self-equality is rejected.
5. A join after `fn.select` matches on the FROM shape (projection applies
   after the join) — narrowing/marker hops must be their own collections.
6. `fn.select` after a LEFT join sees partial rows at init — tolerate
   missing right sides; INNER for guaranteed matches.
7. `fn.select` cannot combine with `groupBy`; non-aggregates in `select`
   must be group keys; no `first` aggregate (first-member naming rides a
   `min()` composite instead).
8. `orderBy` sorts nulls first (sortKey encoded with `\uffff` fallback).
9. `max()` over all-null yields `0`, not null (compatible with the
   hand arm's `?? 0` style).
10. Sync params capture synchronously at `createCollection` WITH
    `startSync: true` (missing it was a silent empty store); cleanup must
    run reverse-topology (dependents first).
11. Collection rows are reactive proxies: scalar reads behave, array
    methods do not (`plainDeps` boundary).
12. Queries compile synchronously at creation (declaration order matters).

## Count tables

### 1x engine-backed (GROWTH_CORPORA.x1; 4,867 issues / 4,304 sessions / 500 repos; 3,230 visible rows)

| Scenario | Rows committed | rowsDerived | rollupsDerived | indexUpdates | notifications | Parity |
|---|---|---|---|---|---|---|
| #1 unrelatedHeartbeat | 0 / 3230 | 0 | 0 | 0 | 1 | green |
| #2 visibleSessionPhaseChange | 1 (i0) | 1 | 7 | 0 | 1 | green |
| #3 selectionClick (engine path) | 0 | 0 | 5 | 0 | 1 | green |

Query-graph runs per scenario (cumulative `GraphRuns` deltas; del+ins =
retraction+assertion pair per touched row):

- Heartbeat: narrow 2, resolve 2, verdict 2, rest 0. The touched session's
  verdicts re-run and settle equal; the archived owner's summary short-
  circuits at the structural gate (0 summary runs); nothing downstream.
- Phase change: +summary 2 (i0 del+ins), +lane 2, +rows 4 (summary-driven
  del+ins, then rollup-driven del+ins), rollup chain 1 (i0; no ancestor
  rollup moved). Total rollupsDerived 7 = 2 + 4 + 1.
- Click (mark-read row): +issuesNarrow 2, +child 2, +summary 2 (derived
  unread flips true→false — a real derivation), +verdict 2 (join side
  moved), +rows 2, rollup chain 1 (value-equal). Total 5.

Why this differs from MobX's 3/3: the stream replaces whole row objects,
so every touched row evaluates twice (retraction + assertion), and this
arm counts rows-folds where MobX counts flat+summary+aggregate. Same
0/1/0 rows committed as both finished arms; the derivation delta is
TanStack's nature (eager per-row IVM), not a design choice.

### UI click path (happy-dom, `tanstack.ui.test.tsx`)

| Action | Rows committed | rowsDerived | rollupsDerived |
|---|---|---|---|
| setSelection A→B (after A latched) | 2 (A, B flags) | 0 | 0 |
| Title rename on A | 1 (A) | 1 | chain |

### Bindings (happy-dom, 3 rows, loaded box — illustrative, not a verdict)

| Binding | Commits | Dispatch ms | Live queries per mounted row |
|---|---|---|---|
| keyed subscribeChanges | 1 | 3.5 | 0 |
| useLiveQuery(findOne) | 1 | 6.2 | 1 |

### SMALL engine-backed + native lane

Same shape at 37 visible rows (native lane asserts heartbeat 0 commits
and parity ×3; see `harness/native/tanstack.native.test.tsx`).

### G2 fixture at 1x (engine-booted, `tanstack.fixture.test.ts`)

211 visible rows — full-snapshot deep-equal with `snapshotFromStore`.

## Line count (arm folder, `wc -l`; tests excluded)

| Module | Total | Code-only |
|---|---|---|
| rules.ts | 512 | 373 |
| collections.ts | 391 | 318 |
| queries.ts | 818 | 698 |
| rollup.ts | 1218 | 1080 |
| store.ts | 623 | 551 |
| arm.ts | 49 | 31 |
| react/list.tsx | 194 | 165 |
| native.tsx | 69 | 54 |
| **Total** | **3,874** | **3,270** |

OVER the 800–1,500 budget, openly (MobX reported 1,954 code-only the
same way). Where the weight is: the same ~370-line faithful rule
transcription every arm carries; ~700 lines of query-graph surface the
approach demands (15 collections × id/gcTime/getKey/query, plus the
static-field repetition the issue brief prices in); ~1,080 lines of
rollup seats, fixpoints and denorm the queries cannot hold. Compression
below ~2,700 means dropping parity-exact rules or merging queries the
criteria require to be separate — deferred to H4 review (open question
1). No forbidden imports (legacy view-model/slice/mission/presentation
— grep clean).

## Open questions for H4

1. Line budget vs fidelity (shared with both arms): is ~3,300 acceptable
   for a parity-exact TanStack slice, or should M2 compress (and what may
   be dropped — queries, denorm, or rule fidelity)?
2. `resolveKey`/`sidOwner`/`droppedSeats` bookkeeping inside the rollup
   sync re-implements seat tracking the queries already do — is that one
   mechanism with two reads, or two mechanisms? The decider is single
   (query events in, value-compare out), but review should confirm.
3. `rollupsDerived` classification (summary + rollup + rows folds;
   membership/lane/grouping in `GraphRuns` only) matches the hand arm's
   placement — keep, or split classification from derivation?
4. Draft-title `firstPick` composite: `name` containing `\x00` reads back
   truncated (pathological; fixture + 1x verify exact).
5. R3 sessions at a worktree shared by N issues fan out in `verdictR`'s
   join — confirmed exact on the fixture; growth-corpus spot-checks are
   M2.
6. Native windowing + FlatList recycling: M3 like both prior arms.
