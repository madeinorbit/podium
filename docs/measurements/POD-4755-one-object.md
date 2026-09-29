# POD-4755: one object per issue in the MobX pool (counts and bootstrap bench)

Each issue had two objects computing overlapping facts from the same row:
`IssueModel` (12 computeds, `models.ts`) and `IssueNode` (32 computeds and 4
reactions, `worklist/visible.ts`), and each session had `SessionModel` (1) and
`SessionNode` (5). Now there is one `IssueModel` and one `SessionModel`. Their
derived values are cached in groups, 10 per issue and 4 per session. The
four per-issue maintenance reactions are unchanged (POD-4757 owns them).

The brief asked for one memo design to be chosen between two: mobx-utils
`computedFn` (a cached value per object, created on first reactive read and
dropped when unobserved) and one computed per group declared on every object
by `makeObservable`. The choice was made on the POD-4748 tracking census and
the review's bootstrap bench (review §5 method). Both measurements are below.

## The groups

| Group | Holds | Read by |
|---|---|---|
| `facts` | standing, the row view's own part, the settled placement (own row, hot or cold, and the clock) | everything below |
| `rank` | L1b rank | the order and the group lanes (every visible row: kept apart from `facts`) |
| `members` | seats, lane members, retained seats, roster, `retained`, `liveRoster`, `openOwn` | presence, nesting, attention, progress, the view's activity |
| `presence` | `flat`, `keeps`, `present` (unread and the children only when needed) | the parent's rescue, nesting, attention |
| `nesting` | `nestParent`, `placed`, `visible` | the maintenance reactions, a nested child's `placed` |
| `tip` | the live spin-off tip | the review decision (attention) |
| `attention` | own attention, subtree aggregate, subtree seat activity | the parent's aggregate, the view, `waiting` |
| `progress` | own unit, units below | the parent's progress, the view |
| `loaded` | the in-memory row's decision facts, label and origin (one load-mode read) | the view, a spin-off's origin tick, attention |
| `view` | the L1b row view | the row slot |

Groups read other issues one way only (children up, ancestors down,
spin-offs across). The parent-cycle `Cycle detected` logs in
`relations.test.ts`'s random sequences predate this change: the base commit
logs 718 of them on `IssueNode.placed`.

## Tracking census (`tracking-counts.test.ts`, 1x first paint of a 20-row window)

Base = `ee74e7ad7` (the committed baseline before this issue). "makeObservable"
= one computed per group declared on each object (measured at `80820b6b2`, whose
plain pass still computed whole groups: its `visibilityPass` count is not a
memo effect and was fixed before the final design). Final = the cached groups
(`cached.ts`), the committed baseline.

| Count | Base | makeObservable | Final |
|---|---|---|---|
| `1x.firstPaint.computeds.total` | 79,768 | 30,679 | **12,290** |
| per visible row (732) | 109.0 | 41.9 | **16.8** |
| `1x.startup.computeds.total` | 79,424 | 30,593 | 11,189 |
| `1x.firstPaint.reactions.live` | 8,489 | 8,489 | 8,489 |
| `1x.firstPaint.observables.object` | 4,536 | 4,493 | 11 |
| `1x.phases.nodeConstruction.built.computed` | 67,584 | 21,120 | 0 |
| `1x.phases.firstReactiveRun.computedRuns` | 28,521 | 11,190 | 11,190 |
| `1x.phases.firstReactiveRun.distinctRows` | 4,725 | 4,756 | 4,756 |
| `1x.phases.visibilityPass.rowReads` | 236,658 | 388,678 | 230,806 |
| `1x.firstPaint.closedIssues.computeds` | 45,168 | 14,120 | 6,262 |
| `1x.firstPaint.coldIssues.computeds` | 27,392 | 8,580 | 3,380 |
| `4x.firstPaint.computeds.total` | 317,073 | 121,917 | **47,619** (16.3 per row) |

The review's "about 122 per visible row" counted a full draw of every row
(happy-dom); the census counts a 20-row window, where the base is 109.

mobx-utils' own `computedFn`, run verbatim against MobX 7 in a scratch
checkout, gave 19,037 at 1x. None of its computeds had an owner, so the
census could not attribute them to issues. The final `cachedGroup` passes the
object as the computed's context: its computeds are declared and owned
(`IssueModel` 9,508 at 1x, over 2,115 objects).

## Bootstrap bench (flatblock, review §5 method)

`review-bench.ts` (POD-4286 artifact). The after-runs use an adapted copy
that constructs `IssueModel` in the construction micro-benchmark; the phase
split is unchanged. Bun 1.4.2 (`.toolchain`), `NODE_ENV=production`,
enforcement off, reads fence disabled, `bench:flatblock` held. Arms were
interleaved: 7 rounds at 1x and 5 at 4x in the order base, makeObservable,
computedFn, then 3 + 3 rounds in reverse order. Load average was 4.7-7.2 on 8
cores (other sessions' test runs); the ranges span the two runs. Medians, ms:

| Phase | Base | makeObservable | computedFn (mobx-utils) |
|---|---|---|---|
| 1x node construction | 48.7-51.5 | 35.0-39.4 | 7.2-14.2 |
| 1x reactions' first run | 122.8-125.7 | 91.0-95.7 | 116.0-121.0 |
| 1x construction + first run | 171.5-177.2 | 126.0-135.1 | 128.2-130.2 |
| 1x `apply` total | 325.7-326.3 | 276.5-287.0 | 266.1-275.4 |
| 1x first paint | 17.0-17.9 | 12.0-12.2 | 13.7-14.8 |
| 4x node construction | 163.1-208.7 | 103.0-128.7 | 23.0-26.3 |
| 4x reactions' first run | 449.4-455.1 | 375.2-401.7 | 434.7-462.6 |
| 4x construction + first run | 612.5-663.8 | 478.2-530.4 | 457.7-488.9 |
| 4x `apply` total | 1,226.9-1,255.0 | 1,091.7-1,180.2 | 1,040.1-1,105.5 |
| Retained heap 1x / 4x (MB, JSC) | 114.8 / 454.1 | 75.7 / 300.5 | 75.2 / 297.9 |
| Construct N objects (micro) 1x / 4x | 19.7-23.3 / 71.5-78.8 | 7.4-8.6 / 24.5-25.2 | 0.05-0.11 / 0.15 |

An earlier run of the same script at load 14-20 is not used (walls spread by
up to 2x). Heap is the same across the two load levels.

## The choice

`computedFn` design: 60% fewer computeds than `makeObservable` in the census
(12,290 vs 30,679 at 1x), and equal or better in the bench (construction plus
first run is a tie at 1x and 4-8% faster at 4x; `apply` total 3-5% faster; heap
equal). An object costs nothing until a reaction reads one of its groups, and
a group no one reads (a hidden issue's view, a closed issue's roll-ups) is
never built. That is Linear's "observable when accessed", applied per group.

It is not imported: mobx-utils 6.1.1 declares a MobX 6 peer (the pool runs
7.0.3), its computeds have no owner (the census goes blind), and it warns on a
read that is untracked inside a reaction, where MobX's own computed stays
silent (the gate's chain plant does exactly that read). `cached.ts` is the
same mechanism for one object argument: a map per group, the object passed as
the computed's context, MobX's warning semantics (warn only outside every
batch).
