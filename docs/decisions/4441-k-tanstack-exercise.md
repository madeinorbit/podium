# K3 TanStack DB arm exercise (`POD-4458`)

I did not build this arm. I read only `packages/worklist-proto/arms/tanstack/README.md`
before opening any code in the arm, formed written expectations of where each
change would go (recorded in `docs/decisions/4441-k3-scratch.md`, committed as
`48387c1ce` before any arm-code read, deleted before landing with its content
folded into §5 below), then read the code. All changes and omissions below were
implemented on throwaway branches (`k3a-snooze`, `k3b-continuation`, `k3c-bubble`,
`k3c2-lanes`, `k3d-nosync`, `k3e-evict`, `k3f-rowscan`), verified, saved as diffs
under `docs/decisions/4441-k-tanstack-diffs/`, and reverted. The arm is byte-identical
to before (`git status`/`git diff` empty on `packages/worklist-proto/arms/tanstack/`);
its tests are green after the revert (§8). Load was above 8 for nearly the whole
exercise (5.8 at the final gate), so every verdict below rests on counts, not walls
(methodology §5.7).

## Table 1 — changes (A/B/C/C2)

| Change | Files touched | Lines +/− | Places you must remember (branch-tip file:line) | First-attempt parity | First-attempt fence | What told you when it failed | Time |
|---|---|---|---|---|---|---|---|
| A snooze: `snoozedUntil` hides the row while `coarseNow` is before it; reappears on the passing tick | `rules.ts`, `queries.ts`, `rollup.ts`, `store.ts` | +55/−1 | `rules.ts:289` (predicate); `queries.ts:220` (IssuesNRow field), `:553` (select carry), `:689` (summaryQ gate); `rollup.ts:150` (`finalFlips` set), `:678` (`takeFinalFlips`), `:699,:709` (reconcile records), `:1010` (removal record), `:1201` (rebuildAll clear); `store.ts:419` (finishCycle drain) | PASS by construction (fixture green — no corpus row carries the field) | FAIL then fixed: boot hid fine, incremental hide went silent | the probe assertion + `runs.changes` (no `rows` key on the snooze path vs `rows:2` on the archive path) → silent rowsQ retraction on a flat-only flip; fixed with `takeFinalFlips` commit-layer driving | ~15 min |
| B continuation walk: legacy `issueContinuation` (mission.ts:2207) as a derived line beside the row | `rules.ts`, `rollup.ts`, `queries.ts`, `store.ts`, `react/list.tsx` | +82/−2 | `rules.ts` (line grammar); `rollup.ts:104` (RollupRow field), `:135` (`continuations` map), `:363` (`continuationLineOf` beside `continuationOf`), `:564` (assemble), `:597,:611,:621` (map upkeep), `:974` + `:1282,:1301` (rebuildAll two-pass + seat seeding); `queries.ts:267` (RowsRow field), `:853` (rowsQ carry); `store.ts` (`lastContinuation` compare); `list.tsx:52,:63` (render) | PASS by construction (fixture green — SliceRow untouched, line rides beside it) | PARTIAL then fixed: superseded/duplicate/unknown green first try; hopscotch-at-boot null | the probe assertion → rebuildAll seats+derives interleaved (origin assembled before its tip is ingested); fixed with seat-all-then-derive two-pass + origin chain-seeding on spin-off seat moves | ~10 min |
| C bubbling: an ask on any descendant marks the root asking | `rollup.ts` (attempt, REVERTED — see §6.2) | +40/−1 (saved, not landed) | `rollup.ts:498` (`compute`, formal-members walk beside `visibleSubtree`) | FAIL: m2 mount parity breaks (i1013/i1043 `asking` true vs oracle false) | PASS on the walk (invisible-offer landing commits exactly the root, `rowsDerived` 1) | m2 parity diff + seat provenance (`decision-fire`, `final=false`) + legacy code reading (`attach` drops invisible children; `pendingDecisionStats` walks visible rows only) → the walk contradicts the oracle; reverted | ~15 min |
| C2 worktree rows: a lane with sessions but no issue rows in the same list and groups | `queries.ts`, `rollup.ts`, `rules.ts`, `store.ts` (4 files) | +513/−8 | `queries.ts:215` (`LaneSeatRow`), `:667` (`laneSeatQ`), `:978` (`laneRowsQ`), `:78` (`GraphRuns` counters); `rules.ts:321` (`laneOwnerForPath`/`isLaneOwner`); `rollup.ts:105` (RollupRow disp fields), `:126` (inputs), `:159` (denorm maps), `:162` (`finalFlips`), `:246` (laneSeatQ sub), `:940`+ (ingestLane/refresh/dropLane), `:1090` (claim-kill), `:1160` (dropSession flat), `:470` (`computeLane`), `:560` (assemble branches), `:1400`+ (rebuildAll lanes); `store.ts` (subs, `refreshRow` fallback, `finishCycle` marks+drain, worktree-removal driving, teardown order) | FAIL by design: fixture exactly 37 extra lane rows (`lane:/w/*`), 0 missing, 0 changed issue rows (§4); m2 #6c exactly 1 extra (`lane:/repo-5/wt-0`, uncovered by the evict) | PASS (evict-close: commits 0, `rowsDerived` 1; claim: `rowsDerived` 2; rescope: `rowsDerived` 0) | the classify probe (extra=37/missing=0/changed=0 — the MobX C2 number exactly) | ~25 min |

## Table 2 — foot-guns (D/E/F)

| Gun | What the screen showed | What fired (named) or SILENT | How long until a developer notices |
|---|---|---|---|
| D omitted bookkeeping in the arm's idiom: `snoozedUntil` declared on `IssuesNRow` + gated in the summaryQ fold, but the issuesN select never carries it (the input the sync routing never writes into any collection) | snoozed row stays visible after the update and after the passing tick (stale, self-consistent) | FIRED: only the intended-behavior probe (`k3d-probe.test.ts`, kept in the diff — fails with the row present). SILENT: `typecheck` (optional field, green), fixture parity (green — no carriers in corpus), `tanstack.test.ts` (11 green), `tanstack.ui.test.tsx` (green) | indefinite without a behavior test on a snooze-shaped corpus; the next unrelated invalidation changes nothing (the gate reads `undefined` forever), so no self-healing — worse than MobX D |
| E index not cleaned on eviction: session `takeRemoved` drained but `dropSession` never driven | evicted session's seats linger; the row keeps its waiting phase and ask with no session behind it (ghost ask, permanent — no later event clears that sid) | FIRED: only the kept probe (`k3e-probe.test.ts`). SILENT: `typecheck`, unit tests, fixture parity, ui, and the m2 gate (green — the SPEC evict removes no sole asker, the same corpus-shape qualifier as K1 §6.4) | immediate with a sole-asker evict test; in the wild, when a user evicts a row's only asking session and the amber never clears |
| F O(N) read inside the row component (`for (const [, committed] of store.rows)` in `TanStackRow`) | identical screen, identical output | SILENT everywhere automated: `typecheck` green, unit + ui green with the exact-commit assertion unchanged (`keyed commits=1`), fixture parity green, m2 gate green (every count identical), no component lint exists for this arm, scan vocabulary has no render-path entry. Cost is real: ~176 ms per full list render at 1x (3,332² reads, Node micro-calc, loaded box), ~679 ms at 2x, ~3.2 s at 4x — textbook quadratic, 11× the hand arm's 15.6 ms (11× the reads) | only a wall-clock profile or the 2x/4x growth walls; counts and commits can never show it (the fence counts commits, not work per commit) |

## Table 3 — complexity

| Item | Value |
|---|---|
| Implementation lines, tests excluded | 4,127 (8 files: `rollup.ts` 1,278, `queries.ts` 858, `store.ts` 763, `rules.ts` 512, `collections.ts` 404, `react/list.tsx` 194, `native.tsx` 69, `arm.ts` 49; tests 2,148 incl. spike 203). Matches NOTES.md M3 exactly; the largest arm (hand 3,962, MobX 2,516) with no compression achieved |
| Concepts a reader must hold (all named from the code) | borrowed (never spread) entity rows; `EntitySync` ingest + `takeRemoved` explicit removal driving + last-writer-wins dedup; `PrefixIndex` seats/roots/`wtVersion` + `prefix-probe`/`move-seat-scan`; the 1-row `locals` collection (marker join; time/version as data); the chained live-query graph (`narrowQ` → `resolveQ` → `verdictQ`/`verdictR` → `aggQ`/`aggR` → `issuesN` → `childQ` → `summaryQ` → `visibleQ`, then `orderQ`/`laneQ`/`groupsQ`/`rowsQ` over the rollup) with per-query `gcTime`/`getKey`/`GraphRuns` (+`ms` walls); pure-DSL vs `fn` queries and their notification asymmetry (verified semantics #13/#14: updates surface as insert, pure-`where` retractions are silent); explicit `createIndex` calls; the ONE custom collection (`RollupSync`: member/child/origin/dependent seats, `keptBy`/`chains` rescue, agent `dropped` hosting, `droppedSeats` netting, `continuationOf`/`spinOffTip`/`vacatedOrigin`, denormalized rank/lane inputs, `written` value-compare, `batchDuring`/`flushBatch`, `dirtyChains`/`fullChains`, `rebuildAll` bootstrap); flat-via-`summaryQ` (never `visibleQ` events); `orderDirty`-gated order surface; commit layer (`rows`/`lastTick` identity-stable compares, `rowsDirty`, `graceSensitive`, selection latch, per-key `emit`); keyed `useSyncExternalStore` subscriptions (rows read own key + `selected:<id>`, list reads `order`, headers read `group:<key>`); `RowShell` mount-excluded fence; `ArmStats` classification (`rowsDerived`/`rollupsDerived`/`indexUpdates`) beside `GraphRuns`; `scan()` slope vocabulary; M3 `teardownGraph`/`buildGraph` rescope + `phaseMs` split |
| Reading path I took | README → `arm.ts` → `rules.ts` → `collections.ts` → `queries.ts` → `rollup.ts` → `store.ts` → `react/list.tsx` + `native.tsx` → `tanstack.test.ts` → `tanstack.1x.test.tsx` → legacy `issueContinuation` (mission.ts:2207), `rowWaitingCount` (row-attention.ts:100-122), `pendingDecisionStats` (:159-187), `attach`/`buildUnifiedRows` (rows.ts:40-180, :317-344), oracle projection (oracle.ts:100-125) → sibling K1/K2 diffs |
| README accuracy | High: the 6-step "How to add a field" recipe predicted the A/B touch-points (rules + narrowing-query carry + rollup compare + `refreshRow`); the 7-place list covered every file all four changes touched; the M2 notes (flat-via-summaryQ, silent sync deletes, `takeRemoved` draining) documented the exact traps A/C2 hit. Three deductions: (1) the union-list problem, same as both siblings — a newcomer cannot tell which subset a change needs (I wrongly expected order/groups/UI edits for A and C2 UI edits; none were needed); (2) the rowsQ/top-query commit-layer silence on value-equal retractions is documented for `visibleQ`/`childQ` but not for the top of the graph — A hit exactly that; (3) the `continuationOf` boolean already exists but is not mentioned — B was surfacing, not inventing (same as the hand arm). Filed here, not fixed |

## §4 C2 parity classification (fail by design, measured not asserted)

The fixture corpus at 1x carries 51 lane seats across ownerless paths (`lane:/w/276`,
`/w/281`, … — the same paths as the MobX C2's 37), every one of them a long-dead
session (`live=0`, `retaining=0`). The classify probe (boot fixture corpus, arm snapshot
vs `snapshotFromStore`, deleted before the diff was saved) reports `extra=37 missing=0
changed=0`, `allLane=true`, `visible=248` (211 + 37) — the MobX C2 number exactly.
Every issue row is byte-identical; the 37 lane rows are pure additions in the `lane:`
namespace, so no id can collide with an issue row. The m2 SPEC corpus starts lane-free
(mount + #4/#5/#6a/#6b parity green, counts identical to the clean tree) and uncovers
exactly one lane at #6c (`lane:/repo-5/wt-0`: the evicted issue's sessions orphan at its
worktree — `missing=[]`, the step's only diff). Inventions with no spec behind them,
recorded not defended (same three as the siblings, plus three): lane id namespace
(`lane:<path>`), lane displayRef (`prefix ?? path tail`), lane title (`repoName`), lane
rank (`createdAt ''`, `seq 0` — sorts last in-band), band fixed 1, progress 0/0 (lanes
hold sessions, not milestones), group labels coincide by construction (lane `repoPath`
is the worktree's, so `max(label)` agrees). Caveat: the seat-presence flat gate means
lanes never decay — a lane of only long-dead sessions rows until evict/claim/removal,
where the legacy worktree-fallback rows would decay through retain windows (the
ownerless retain/live windows ARE implemented on the seats and drive phase, but flat
follows presence per the brief's letter and the MobX precedent).

## §5 Expectations (README-only) vs where things act
...[truncated 9119 chars]