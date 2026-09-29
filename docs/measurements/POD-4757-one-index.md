# POD-4757: one index for visibility and groups (MobX pool)

Each issue the worklist held had four reactions filing it into indexes kept by
hand: the visible set, its nest parent's children, its formal parent's
children, and its group lane. Which issues were held was predicted per change
by a second, untracked evaluator (`plainScope` / `expandRoots` /
`syncWorklist`, about 400 lines). The group lanes and the visible order were
re-sorted at view time, and `groups.keys` subscribed to the whole-list sort to
keep a counter alive.

Now:

- **One filing reaction per issue in memory** (`VisibleCollection.track`),
  taken when the row enters the issue table and released when it leaves (the
  pool observes the table). It tracks what the row files: its placement and
  rank while visible, nothing while hidden. A cold row is hidden by the cold
  rule, so it holds no reaction; its object is still built on first read when
  a walk reaches it. Rows kept out of memory beside the rule (the
  `outOfMemory` test option) are tracked as well.
- **Sorted lanes, one row moved at a time** (`worklist/sorted-lanes.ts`): the
  visible order, the pinned section, and per group its members by rank (the
  head gives the label and the group's place), its open lane and its closed
  fold. Filing moves the row alone (binary search out, binary search in); a
  row whose place is unchanged moves nothing. No lane is re-sorted.
  mobx-utils' `ObservableGroupMap` does not fit: it groups one observable
  array (the pool has none), its groups are unordered with swap-remove, it
  writes a symbol onto each item, and it declares MobX 6.
- **Formal children** are the relation engine's `issue.children` bucket (the
  `childrenBy` index and its reaction are gone). The progress group is split
  into `unitOwn` and `unitsBelow`, so a change to an issue's own row (a
  rename) walks no child.
- **Nest children are derived** (`nestBelowPartOf`, `nestedPartOf`): down the
  raw parent edge (`issue.treeChildren`, archived and deleted issues included,
  as the legacy walk goes up through any issue) a present child is one and a
  hidden one passes on its own; the started-by fallback adds the issues its
  sessions started (`session.startedIssues`). Each candidate is kept only when
  its own `nestParent` names the row, so the one rule decides. The two
  relations landed first, in their own commit (`89ec1cb35`).
- **The per-change node prediction is removed**, with `hasMembers` and
  `knownIssueIds` it alone used.
- **H1**: a group's label is read from its head member's placement, tracked.
  `clock.ts` lists every untracked read a derivation makes (now also the object
  memo, the cached-group memo and the groups' node memo); the lanes' filed
  sort values are read only by the filing, never by a derivation.
- **No order subscription**: `groups.keys` sorts the group heads (O(groups))
  and reads no order. The visible order is a maintained list the snapshot and
  the tests read; no product reader does.

## Tracking census (`tracking-counts.test.ts`, first paint of a 20-row window)

At landing, on POD-4756's base (`d54efa35d`: row fields are cached values on
the issue): reactions live 8,509 → 2,797 at 1x and 33,789 → 11,038 at 4x (3.8
per visible row at both scales); first-paint built computeds 1,521 → 1,345 at
1x and 3,883 → 1,673 at 4x. The table below is the same comparison measured
before that rebase, on `89ec1cb35`.

Base = the committed baseline at `89ec1cb35` (POD-4755's model plus the two
nest relations). After = this issue's baseline.

| Count | 1x base | 1x after | 4x base | 4x after |
|---|---|---|---|---|
| reactions live | 8,489 | **2,777** | 33,769 | **11,018** |
| reactions per visible row (732 / 2,928) | 11.6 | **3.8** | 11.5 | **3.8** |
| issues with a filing reaction (was: held) | 2,112 (4 each) | 2,736 (1 each) | 8,432 | 10,977 |
| closed issues' reactions | 5,644 | 574 | 22,649 | 2,314 |
| cold issues' reactions | 3,424 | 0 | 13,644 | 0 |
| computeds total | 12,290 | 15,322 | 47,619 | 58,555 |
| observable sets | 4,276 | 3,756 | 17,231 | 15,243 |
| startup row reads: plain pass | 230,806 | 0 | 927,121 | 0 |
| startup row reads: first reactive run | 118,266 | 149,178 | 465,505 | 594,221 |
| first-paint computed runs | 1,097 | 920 | 3,459 | 1,248 |

**First paint** (`phases.firstPaint.built.computed`): 1,101 → 3,463 from 1x to
4x before, 925 → 1,253 now. The part that grew with the visible set, one rank
computed per visible row first read by the view-time lane sorts, is gone
(ranks are built at startup by the filing reactions). What still differs is
the 20 drawn rows' own subtrees, which are larger in the 4x corpus: by group,
`unitOwn` and `unitsBelow` are the drawn rows' formal descendants plus the 20
rows (76 + 20 = 96 at 1x, 113 + 20 = 133 at 4x), and `nestBelow` follows their
raw-tree descendants (97 at 1x, 165 at 4x); `attention`, `nested`, `loaded`
and `verdict` follow the same families and their seats (41 → 54). First paint
is bounded by the window's families, never by the visible count.

The closure used to hold fewer resident issues (it skipped rows no reader
could reach) but 858 cold ones at 1x; every resident issue now files itself,
so more issues evaluate their visibility (computeds up), while the plain pass
over every known issue (its 231k reads at 1x) is gone.

The two nest relations (census of `89ec1cb35` against `784c8f9ac`): observable
maps 26 → 30, sets 3,124 → 4,276 at 1x (12,518 → 17,231 at 4x), map entries
+4,340 at 1x (+17,526 at 4x). They cover every known issue, so they join the
all-known-rows index the deferred cutoff reworks.

## Work per change (`work-per-change.test.tsx`, POD-4746)

Every MobX step's count is within its neighbourhood except the web list's
(`observerPoolList`, POD-4792's allowance on #5, #6a-d, #8b). The order
re-sort (`VisibleCollection.order`, 734 → 2,930 elements on #6a) no longer
appears; a moved row's group lane copy (`GroupNode.baseRowIds`, 409 → 1,630
on #6a) is inside the neighbourhood. This issue's allowance is removed.

## Bench (flatblock, POD-4755's method)

`bench-4757.ts` (not landed; attached to the issue): fresh lazy pool per
round, one warm-up discarded, `NODE_ENV=production`, enforcement off, reads
fence off, `bench:flatblock` held, Bun 1.4.2 (`.toolchain`). Arms interleaved
(base then after, then after then base), 7 rounds at 1x and 5 at 4x, load
average 5.2-8.1 on 8 cores. Base = `89ec1cb35`, after = `7769af2aa` (product
code as landed, before the typed-links rebase). Medians, ms; ranges span the
two passes.

| Phase | 1x base | 1x after | 4x base | 4x after |
|---|---|---|---|---|
| ingest | 86.6-87.4 | 79.1-91.8 | 349.6-374.6 | 358.5-374.8 |
| relation flush | 18.3-21.3 | 16.5-24.4 | 105.1-112.2 | 112.3-122.0 |
| plain pass and closure | 51.4-56.7 | 0.1 | 233.7-235.5 | 0.4-0.5 |
| node construction | 20.8-22.4 | 3.6-3.9 | 29.0-33.1 | 13.6-14.0 |
| reactions' first run | 82.9-90.3 | 97.5-126.6 | 368.5-379.1 | 415.6-476.5 |
| `apply` total | 268.9-273.5 | 195.0-246.9 | 1,100.4-1,118.8 | 939.6-993.4 |
| first paint | 9.4-10.0 | 6.9-8.5 | 42.4-45.6 | 10.8-12.8 |
| retained heap (MB, JSC) | 74.6 | 67.6-67.9 | 295.1 | 264.9 |
| stage move (a root to the fold) | 0.72-0.81 | **0.21** | 5.45-6.17 | **0.25-0.27** |
| new issue | 0.80-0.91 | **0.08-0.09** | 8.12-10.89 | **0.11-0.12** |

A change now costs the same at 1x and 4x. Bootstrap trades the plain pass for
more reactive work (every resident issue evaluates its visibility once).

## Plants (proven red, restored)

- The group label reads a plain map the filing keeps (untracked, not toggled
  by a label-only change): `group-label.test.ts` fails, "expected 'repo-001'
  to be 'renamed-checkout'".
- No one-row move: every group lane re-sorted whole after each filing.
  `scaling.test.ts` fails at both scales ("sorted elements ... expected 521 to
  be less than 24" at 1x, 2,006 at 4x). POD-4746's check stays green under this
  plant: the re-sort happens only on steps where a row moves, where the moved
  row's whole group is inside the neighbourhood the check allows by design,
  and those steps also carry POD-4792's allowance. The plant shows in its
  printout (#6a `pool.file.i-new 474→1827`, #8b `pool.file.i# 559→3056`).
- The schema validator's duplicate-edge signature without the where fields: 3
  schema tests fail, the declared schema among them.
