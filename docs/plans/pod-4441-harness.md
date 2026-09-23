# POD-4445 — Round-two measurement harness and legacy control

Status: landed on `integrate/4441-round-two` · 2026-09-20 · G4 of POD-4441.
Plan of record: `docs/plans/pod-4286-prototype-methodology.md` rev 4 (§1a budgets,
§5.7 evidence rules, §5.8 scenarios). Slice: `docs/plans/pod-4441-round-two-slice.md`.

One way to count every arm (CI, happy-dom) and one way to time every arm
(Chromium), plus the current-store control that must FAIL the isolation test —
so the detector is proven before any arm is trusted.

## Layout (`packages/worklist-proto/`)

| Path | What |
|---|---|
| `shared/src/row-shell.tsx` | Required per-row wrapper: `RowShell`, `CommitLogContext`, `createCommitLog`, ambient `withCommitLog` / `withCommitLogAsync`, `currentCommitLog` |
| `shared/src/instrument/reads.ts` | Reads-per-change fence (POD-4557): `createReadFence`, `wrapTables`, `RelationReader`, `DISABLED_READ_FENCE` |
| `harness/src/count-harness.tsx` | CI counting: `mountArmForCounts`, `mountElementForCounts`, `mountNativeForCounts`, `createReplaySource`, `runCountScenario`, `assertIsolation`, `assertReads`, `READ_BUDGETS` |
| `harness/src/reads-probe.test.tsx` | The reads fence end to end, both directions (probe arms, real engine) |
| `shared/src/scenarios.ts` | THE scenario library (POD-4550): boot (`startScenarioEngine`, `startEngineOnCorpus`), rule-picked targets (`pickTargets`), every write (`write*` settled / `apply*` synchronous), the thirteen scenarios. Count runs, web entries and native lanes all use it |
| `harness/src/fixture/` | The ONE corpus: `buildCorpus(scale, seed)` |
| `harness/src/legacy-control/` | The control: `arm.ts` (`legacyControlArmFor`), `list.tsx`, `native.tsx`, `fenced-store.ts` (its store read through the reads fence), `control.test.tsx` (armed), `control-1x.test.tsx` (CI budget + JSON) |
| `harness/src/oracle/` | G2 oracle, plus `projectSnapshot` and `snapshotFromStore` (parity over live engine state), `oracleSnapshot` (the engine's own clock) and `rebuiltSnapshotFromStore` (every legacy memo bypassed) |
| `shared/src/gen/check.ts` | The correctness gate (POD-4556): `checkArm`, `diffSnapshots`; tests `check.test.ts` (armed), `check-ci.test.ts` (the CI-sized run, opt-in) |
| `harness/web/` | Vite pages per arm/control (`entries/`), shared page wiring (`entrylib.ts`, `window.__proto`) |
| `harness/web/noop-arm.tsx` | The no-op arm: the instrument floor page, and the timer's planted mistakes (POD-4558) |
| `harness/browser/run.ts` | Chromium timing driver (one invocation per arm/scale) |
| `harness/browser/matrix.ts` | Interleaved arms × scales × rounds, load-gated, lease per invocation |
| `harness/browser/summarize.ts` | Tables: actionMs per cell, floor, budget as floor + allowance, slope; refuses failed runs |
| `harness/native/` | React Native count lane (`control.native.test.tsx`) |

## One corpus (POD-4550)

Every count, parity check and timing runs on the live-shaped fixture,
`buildCorpus(scale, seed)` in `harness/src/fixture/` (shape and provenance:
`docs/measurements/POD-4441-fixture-shape.md`). There is no second corpus: the
scenario generator's synthetic seed (`SMALL_CORPUS`, 60 issues; and
`GROWTH_CORPORA`, which showed 3,230 visible rows at "1x" against ~211 live)
was deleted in POD-4550, and with it the TanStack arm (eliminated in round
two).

| Knob | Values | Where |
|---|---|---|
| Scale | `1` (live installation: 4,867 issues, 4,304 sessions, 500 repos, 468 worktrees, **211 visible rows**), `2`, `4` (every collection multiplied; the growth slope) | `startScenarioEngine(scale)`, `?scale=` on the web pages |
| Seed | `FIXTURE_SEED = 4443` everywhere; vary it only to prove determinism | `shared/src/scenarios.ts` |
| Clock | the runtime's coarse clock is pinned to `FIXED_NOW` (2026-09-20T12:00Z, inside every band threshold) via the runtime's `coarseClock` seam; `writeClockTick` advances it through the engine; every write stamps rows from the same clock | `startEngineOnCorpus` |

Targets are picked BY RULE from the corpus (`pickTargets`), carried on every
`ScenarioResult` and on `ScenarioEngine.targets`, and checked against the
oracle in `shared/src/scenarios.test.ts`:

| Target | Rule |
|---|---|
| `heartbeatSessionId` (#1) | lowest-id session bound to a closed, childless agent root — a row the worklist never shows |
| `visibleRootId` (#2 #3 #4, #7 destination) | lowest-id open human root in an active stage with children, exactly one live working bound session and no other working session in its subtree, bound or prefix-seated (so #2 flips `working` at every scale; oracle-checked at 1x/2x/4x) |
| `phaseSessionId` (#2) | that root's first live working session |
| `stageMoveId`, `archiveId`, `evictId`, `markReadId` (#5 #6b #6c #9) | the next distinct childless, unpinned open human roots |
| `keeperLeafId` / `keeperParentId` (#6d) | an open leaf that is the ONLY child of a sessionless `backlog` rescue parent (the fixture carries ten such pairs) |
| `reparentId` (#7) | an open child with a live working session whose parent is another open root |
| `burstIssueIds` (#10) | the 50 lowest-id open human issues |

The fixture also carries one live issue whose `worktreePath` no discovery scan
reported (`corpus.unscannedWorktree`, handover from POD-4546): a sessionless
visible root seated ONLY by one orphan session under that path. The oracle
seats it (the row reads working); moving the orphan away turns the row off
(`oracle.test.ts`, "unscanned worktree seat"). A feed that only materialises
scanned worktrees loses that seat and fails parity.

## Counts (CI, happy-dom) — the verdict-carrying half

```bash
# the armed control (must fail isolation, must pass parity):
bun run test:file -- packages/worklist-proto/harness/src/legacy-control/control.test.tsx
# the control at live corpus (same, plus the 60 s CI budget and the 1x JSON):
bun run test:file -- packages/worklist-proto/harness/src/legacy-control/control-1x.test.tsx
# the native lane (package lane — excluded from the node lane, see below):
bun run --filter @podium/worklist-proto test -- harness/native/control.native.test.tsx
```

`runCountScenario` resets stats and the commit log, runs the scenario input in
`act`, and returns `{rowsCommitted, commitsByRow, visibleRows, stats, parity,
parityDiff}`. `assertIsolation(result, {rowsCommitted})` throws with the counts
on failure. happy-dom has no paint: never report a number from here as timing.

Every arm's row component must render inside `<RowShell id={rowId}>`, and every
arm's `mountWeb` must capture `currentCommitLog()` at mount and re-provide it
(`<CommitLogContext.Provider value={log}>`) — a separate root cannot inherit
the harness provider's context. Outside the harness the shell is a pass-through.
Every arm test needs the can-say-NO guard: a visible change must commit rows,
or the detector is blind.

## Timings (Chromium) — walls, second (POD-4558: work time only)

```bash
# production build (heavy):
bun scripts/test-heavy.ts -- bunx vite build --config packages/worklist-proto/harness/web/vite.config.ts
# the interleaved matrix: one run.ts invocation per (arm, scale) per round, pair
# order rotated each round, load-gated, bench and heavy-test leases per invocation:
bun packages/worklist-proto/harness/browser/matrix.ts \
  --arms noop,control --scales 1,2,4 --rounds 4 --samples 5 --tag floor
bun packages/worklist-proto/harness/browser/summarize.ts packages/worklist-proto/harness/browser/results/floor
```

The driver serves `harness/web/dist`, loads `<arm>.html?scale=N&sha=<HEAD>`,
waits for `window.__proto.ready`, settles the page (boot commits never land in
a record), then runs one warm-up round and `--samples` rounds of the five
scenarios, the order rotated per round. Every scenario, the click included,
goes through ONE timer in the page (`entrylib.ts`, `measure`):

    start → dispatch the change → drain → last commit signal → next frame

| Field | What it is | Budgeted |
|---|---|---|
| `actionMs` | Dispatch to the arm's last commit signal, or to the drain when the change commits nothing. Commit signals: the page's `RowShell`/`CommitBoundary` commit log (every row commit and mount, timestamped when React calls the shell's profiler) and DOM mutations under the arm's root | yes |
| `drainMs` | Dispatch to the first task after it (a `MessageChannel` message: runs once the dispatch's microtasks — feed flush, arm dispatch, React sync-lane commit — have drained; no timer clamp, no poll) | no |
| `frameMs` | Dispatch to the first animation frame after `actionMs` ends; for the click, pointer event to the first frame after the arm's commit | no (its vsync phase is not the arm's) |
| `endedBy` | `drain`, `commit` or `dom`: which signal ended `actionMs` | — |
| `commits`, `mounts`, `domMutations` | In the change's window | counts |
| `strayCommits` | Commit signals that arrived after the previous settle and before this change | any > 0 FAILS the run |
| `longTasks`, `longTaskMs` | Long tasks overlapping the change's window (`takeRecords` after the settle) | reported |

**Targets are drawn rows** (coordinator ruling on POD-4558 finding #4). A
change aimed at a row the arm has not drawn commits nothing on a windowed arm
and the whole list on the control, so it would time the control's redraw
against an arm doing nothing. Every row target is therefore picked by rule,
identically for every arm, from the **first window**: the oracle's first 36
rows of the list as it stands before the change (`FIRST_WINDOW_ROWS`,
`entrylib.ts`), root rows only (the control nests formal children inside
their parent's row). The rules are the scenario library's (`pickTargets`):

| Scenario | Target |
|---|---|
| #4 rename | the first open human root with children in the window; fixed for the page |
| #5 stage move | the first childless open root (`childlessRoot`) no click selected; the next `prepare` reopens it untimed (its server rows restored), so every sample is the same move of the same row |
| #3 click | the first fresh row (never selected, never moved, not the rename target) that neither rule above wants, else any fresh row; a pointer event plus `click()` on its pressable |
| #1 heartbeat | the library's heartbeat session (a row the worklist never shows) |

The click is each arm's own pressable: on hand and MobX it is an arm-local
selection (`store.setSelection`, no engine write); on the control it sets the
engine selection, whose eager mark-read redraws the whole list later (see the
4x proof run below). The click cell therefore does not carry the same engine
work on every arm; read it with that in mind.

Before every write the page asserts the target is mounted in THAT arm and
throws if not, so the run FAILS instead of recording a zero. `prepare` picks
(untimed, before the driver's forced GC); `runScenario` times; `summarize.ts`
refuses to compare runs whose arms aimed a (scale, scenario, sample) at
different targets.

**Viewport 1600×2400, for every arm and scale.** The pinned section grows
with the corpus (6 rows at 1x, 12 at 2x, 24 at 4x) and at 4x the first
childless open root is row 33 of the list. Round two's 1600×1000 (17 rows on
hand/MobX) held only pinned rows at 4x: #5 had no drawn target there. At
2400 px hand and MobX draw about 40 rows.

**Check mode** (`run.ts --check`, page `?check=1`): after each change the page
compares, over the rows mounted before and after, the rows whose oracle row
view changed with the rows the arm redrew (committed or remounted) — the
count harness's exact-commit rule (`changedViews`) applied to what the page
drew. A mismatch on hand or MobX fails the run; the control and the no-op
page are reported (they exist to fail it). `--offwindow` plants the library's
`visibleRootId` as the rename target (off the windowed arms' first window).

Removed (round two's taskMs): the 50 ms `waitForNotifications` poll and the
two nested animation frames it wrapped, and `inputToPaintMs` (two frames
after a synthetic click, null on every non-click record, zero stats on the
click). No budgeted number contains a frame wait or a poll.

**The settle is untimed.** After the change the page waits until 250 ms
(`?quiet=`) and at least two frames pass with no new commit signal, so an
arm's work deferred to a later task inside that window is charged to
`actionMs`; work deferred past it lands between changes, shows as
`strayCommits` on the next record and FAILS the run. A settle that never
quiets fails after 5 s.

**What fails a run** (status `failed`, exit 2; `summarize.ts` lists it and
never prints its numbers): 1-minute load above `--max-load` (8) before or
during the run; any cell that errors (a missing cell is never a gap); any
stray commit; a page error.

Field names overlap `docs/measurements/POD-4286-stage0-live.json` where they
measure the same thing: `runtimeSha`, `browser`, `capturedAt`, heap
`{before,after}` (`usedSize` et al), `longTasks`/`longTaskMs`, `commits`.
`windows[]`/`buckets`/`traceDistributions` are stage0-collector concepts with
no per-scenario equivalent here; `records[]` (one per scenario sample) is new.

## Budgets (methodology §1a) as assertions

| Goal | Budget | Asserted where |
|---|---|---|
| Idle client | zero derivation work except on the clock tick | count harness (`notifications` on settle-only runs) |
| Unrelated heartbeat | 0 rows committed, 0 derivations, ≤ 3 rows read, publish ≤ 2 ms | counts in CI (`assertIsolation` + `rollupsDerived` + `assertReads`); publish wall in Chromium |
| Any single hot-path event | `actionMs` p95 ≤ floor p95 + 8 ms at live corpus (1x) | `summarize.ts` over the matrix; floor = the no-op page, same scenario, same scale (POD-4558) |
| Row click, pointer event to the arm's commit | `actionMs` p95 ≤ floor p95 + 16 ms at 1x, + 32 ms at 4x | same; `frameMs` (to the next frame) reported, not budgeted |
| Cost follows the change, not the corpus | `actionMs` p50 at 4x / p50 at 1x ≤ 1.2, per scenario | `summarize.ts` slope table; counts must match at all three scales. A low read count is not proof of constant work (see "Instrument floor") |
| Bootstrap / principal switch | ≤ 1.1x / ≤ 2x control | driver `coldBootstrap`/`principalSwitch` vs control JSON |
| Memory | retained heap ≤ 1.1x control, no growth after rescope | `heapAfter` vs control; rescope disposal check |
| Bundle | ≤ +60 KB gzip on web, no native-incompatible dep | entry chunk sizes in build output; native lane mount |

Per-scenario row budgets are methodology §5.8 (#1: 0 rows; #2: 1 + ancestors;
#3: 2; #4: 1; #5–#7: affected + order; #10: bounded; #11–#13: full once).
Counts are asserted in CI; walls in Chromium. The growth slope (§1a, scenario
#14) is the performance differentiator among arms that pass.

## Instrument floor (POD-4558)

The no-op page (`harness/web/entries/noop.html`, `noop-arm.tsx`) mounts an
arm that takes every change and does nothing with it: it subscribes to the
feed and the locals (so the kernel write and the feed drain run as under any
arm), ignores every notification, and draws one window of rows once, from the
oracle, through `RowShell` — so its commit signal comes from its own shell
and it is timed on exactly the arms' path. Its `actionMs` is the cost of the
write, the feed and the timer's own settle hop: the floor. Every wall budget
is stated as **floor p95 + allowance**, per scenario and scale (table above);
the allowances are methodology §1a's numbers, fixed here before any
round-three arm is timed and not re-read on another dimension afterwards.

**Floor numbers: not yet measured** (2026-09-23). Every matrix attempt so
far failed on load: the box's background load sits at 7.7–11, and a browser
run adds about one, so runs cross 8 and are recorded failed, never
published. The floor table lands here from a clean `matrix.ts` run
(`--arms noop,control --scales 1,2,4 --rounds 4 --samples 5`, n = 20 per
cell), with its SHA; until then no wall budget can be evaluated.

**The timer can say NO** (planted mistakes on the no-op page, `--plant`,
summarised under their own label, never a floor run; 1x, functional runs):

| Plant | What it does | Timer result |
|---|---|---|
| `sync:20` | busy-waits 20 ms inside every feed/locals notification, commits nothing | charged: actionMs 20.6–28.9, `endedBy` drain |
| `late:30` | re-renders every drawn row from a 30 ms timer after every notification | charged: actionMs 32.5–38.6, `endedBy` commit, 51 commits. The first cut (settle after one quiet frame) missed it entirely — actionMs 0.3–5.0 with 0 commits, the 51 commits surfacing as strays on the next record — which is why the settle waits a quiet window and strays fail the run |
| `late:400` | the same, 400 ms late (past the quiet window) | run FAILED: 51 stray commits on the next record |

And the legacy control fails the budget it must fail: at 1x it commits 345–346
rows on every hot-path change (0 on the no-op page) — see the floor run.

**A low read count is not proof of constant work.** The reads fence counts
ENTITY rows; an arm that walks its own per-row caches on every change reads
few entity rows while its wall time grows with the corpus. The `actionMs`
slope across 1x/2x/4x, per scenario (`summarize.ts`), is the empirical catch
for that case; read the two together.

**Scenario targets are drawn rows** ("Timings"). The proof, both ways
(`results/proof/`, SHA and table below):

Check-mode runs at `4a870d0dc` (warm-up + 5 samples per scenario, one page
per arm and scale; counts, not walls, so load was not gated — 7.5 to 11):

| Arm | 1x | 2x | 4x | Records where the redraw ≠ the oracle |
|---|---|---|---|---|
| hand | ok | ok | ok | 0 of 90 |
| MobX | ok | ok | ok | 0 of 90 |
| no-op | ok | ok | ok | every rename, stage move and click (draws nothing: under) |
| control | ok | ok | FAILED (1384 stray commits after a click: its whole-list redraw landed past the 250 ms settle) | every record (whole-list redraw: over, 146 / 292 / 584 drawn rows for 1 changed) |

Targets, identical on all four arms at each scale: rename i23 / i133 / i260;
stage move i74 / i581 / i145 (the same row every sample); clicks i300, i301,
i292, i274, i57, i50 at 1x, the pinned roots and i96, i55 at 2x, the pinned
roots i1200–i1207 at 4x. On hand and MobX each rename and stage move redraws
1 row (oracle 1), each click 2 (oracle 2; 1 on the page's first click), the
heartbeat and the clock 0 (oracle 0).

The other direction: `--offwindow` (rename aimed at the library's
`visibleRootId`, i17 at 1x, outside the first window) FAILS the run on hand
and on MobX at the first write: `target i17 is not drawn by hand (first window
i300,i301,i23,…); refusing to time an undrawn row`. Nothing is recorded.

## Reads per change (POD-4557)

Rows committed says how much the screen redrew; it cannot see an arm that
walks the whole corpus to decide which one row to redraw. The reads fence
counts that walk. It is shared code (`shared/src/instrument/reads.ts`), owned
by the harness, and the arm cannot turn it off.

**What is counted.** `readsPerChange` is the number of DISTINCT `entity:id`
rows read between the scenario's reset and the end of its `act` — before the
harness calls `snapshot()` for parity, so the projection is never charged to
the arm. Three doors:

1. **Feed.** `mountArmForCounts` passes the arm's `RowSource` through
   `reads.wrapSource`. Every row value arrives as a borrowed, read-only
   counting proxy; any property read on it, at any later time, counts that
   row.
2. **Tables.** The arm wraps its entity tables with `reads.wrapTables(tables)`
   (a `ReadonlyMap` per entity). `get`/`has` count the id. Every iteration
   (`keys`, `values`, `entries`, `forEach`, `for…of`; array index reads)
   counts every element it yields. Any other member throws. A value that the
   feed did not hand out (a copy) throws.
3. **Relations.** Relation buckets are read only through the shared
   `RelationReader` (`one`, `many`, `size`), wrapped with
   `reads.wrapRelations`. The relation name must be declared in
   `shared/src/schema.ts`. `one` counts its target; `many` counts every id it
   yields; `size` is free.

A refusal throws AND is recorded. The feed swallows a throwing listener
(`row-source.ts` `emit`), so `stats()` re-throws the first recorded violation
for the rest of the fence's life, and a count run on a violating arm fails.

**What a round-three arm must do** (Ma1/Ha1 and later): take the third
`create` argument `reads`; store the borrowed row objects from the feed, never
a copy of their fields; read every entity table through
`reads.wrapTables(...)` and every relation bucket through
`reads.wrapRelations(...)`. Timing entries pass `DISABLED_READ_FENCE`, whose
wrappers are the identity (no proxy cost in the browser) and whose `stats()`
throws, so a count run with the fence off fails instead of reporting zero.

**What the runtime does not close.** An arm that copies each borrowed row
into an object of its own, keeps it in a second container the fence never
wraps, and reads only that is counted once at the copy. L6a (POD-4563) closes
the reachable form with the copy sweep (next section); closure-held copies stay
a review item.
The fence also counts ENTITY rows, not the arm's own derived values: a sort
over cached per-row rank keys reads no entity row, and neither does a walk
over any other per-row cache the arm keeps. That is legitimate for a sort
whose keys are cached (only the moved row's key is recomputed from its row),
and it is also how whole-collection work could hide from this count. The
growth slope across 1x/2x/4x (walls, L5b) and review catch the second case;
this fence does not.

**Budgets.** Fixed here before any round-three arm is measured, in
`READ_BUDGETS` (`count-harness.tsx`). None is re-read on another dimension
after measuring.

| Scenario | Budget (distinct rows read) | Why |
|---|---|---|
| #1 unrelated heartbeat | ≤ 3 | The changed session, and at most its issue and one relation hop. |
| #2 visible phase change | ≤ 3 × (ancestors + 1) (`phaseChangeReadBudget`) | 3 rows per level of the changed session's issue chain: the issue itself plus each ancestor. A roll-up that re-reads a level's siblings grows with the family, not the chain, and fails. |
| #3 selection click | ≤ 3 (corrected from 0, see below) | The selection local plus the engine's own reaction to it: an eager mark-read of the clicked issue, the #9a shape — the clicked issue and at most two rows to place or label it. |
| #4 visible title rename | ≤ 3 | The renamed issue, and at most two rows to place or label it. |
| #5 stage move across groups | ≤ 24 (`stageMoveNeighbourhood`) | The **visible neighbourhood**: the moved row, two neighbours at the old position and two at the new (5), plus the probes of a binary-search placement at 4x (211 visible rows at 1x, so ~850 at 4x: log2 ≈ 10), is 15; rounded up to 24 for a group-header lookup and the closed-fold boundary. A constant: it does not grow with the corpus. A re-sort of the visible collection reads every visible row and fails. |

**#6–#10 (POD-4609).** Fixed before any Phase M arm ran these scenarios,
the way L5a derived its five: from the rows the change necessarily touches,
never from a measured arm. Three terms, each already used above:

- **A level** (`phaseChangeReadBudget`, 3 per level): a roll-up input moved
  at one issue, so that issue and every ancestor re-compose from cached
  child results. Per level: the level's issue and at most two rows to label
  it (a session, the repo). Grows with the chain, never with a family.
- **One placement** (`READ_BUDGETS.placeOne`, 12): one row entering or
  leaving one position: two neighbours, plus the probes of a binary search
  at 4x (844 visible rows or 691 groups at 4x: log2 ≈ 10; a group re-places
  on its first member). #5 counts the same terms for its entering position.
  A constant: flat across 1x/2x/4x.
- **The rows the feed names**: always read; they are the change.

| Scenario | Budget | 1x / 2x / 4x | Derivation |
|---|---|---|---|
| #6a new issue | `newIssueReadBudget()` = level(0) + 1 + `placeOne` | 16 / 16 / 16 | The new issue's own level (the issue, its session, its repo: 3), the new session's lane (`session.worktree` is a prefix relation every session keeps, lazy: false: 1), and the new row entering one position (12). The scenario writes a root, so one level at every scale. |
| #6b archive | `removeOneReadBudget(ancestors)` = level(ancestors) + `placeOne` | 15 / 15 / 15 | The archived row's chain loses its contribution (an archived issue contributes no parent edge, schema `issue.parent` `where`), and the row leaves one position. The target is a childless root by rule (`pickTargets`), so level(0) = 3. A child would surface as a root; the rule rules that out. |
| #6c evict | `removeOneReadBudget(ancestors)` | 15 / 15 / 15 | The same shape through a delete: the stored row (read before it is dropped), its chain, one position. Evict carries no tombstone; dropping the row from its buckets reads nothing. |
| #6d evict keeper | `evictKeeperReadBudget(ancestors)` = level(ancestors) + 2 × `placeOne` | 30 / 30 / 30 | The evicted leaf's chain (the leaf, its rescue parent, their ancestors: 2 levels at every scale), and TWO rows leaving: the leaf and the parent that was visible only through it. Whether the parent still has a member is a `size` (free), not a read. |
| #7 parent reassignment | `parentReassignmentReadBudget(moved, newParent)` = level(moved) + level(newParent) + `placeOne` | 21 / 21 / 21 | The moved row's OLD chain loses its cached subtree roll-up (the row and its old ancestors: 2 levels), the NEW parent's chain gains it (1 level), and one placement (a row that becomes or stops being top-level changes fold eligibility). The subtree moves as one cached value: no descendant is read. |
| #8 clock tick (60 s) | `clockTickReadBudget(crossings)` = crossings × 24 | 0 / 0 / 0 | A local, like #3: the row feed emits nothing; the tick reaches the arm on the locals channel (POD-4608). The only rows a tick re-derives are those whose time-derived fields cross at this tick (a lapsing defer, the finished grace, retention windows); deadlines are derived keys, not entity reads. Each crossing row moves between lanes (or enters or leaves) with no row event: #5's shape, 24 per row. `crossings` is projected BEFORE the write, by the row-view oracle at the advanced clock over the same store (`tickCrossings`). This tick crosses none at any scale. |
| #8b grace crossing (24 h) | `clockTickReadBudget(crossings)` | 96 / 192 / 384 | The same rule. This tick crosses the grace rows (finished 1–20 h before the corpus clock, 4 per scale unit: 4, 8, 16), which fold. Flat per crossing; the crossings are the corpus's, not N's. An O(visible) walk still fails at every scale (211 / 422 / 844 visible). |
| #9a press, #9b echo, #9c rejection | `READ_BUDGETS.markRead` = 3 | 3 / 3 / 3 | An own-field change (`readAt`) of one issue that no row-view field reads — the #4 shape: the issue and at most two rows to place or label it. The rejection's two events name the same row; distinct counting makes it one. |
| #10 burst of 50 | `burstReadBudget(ancestors per issue)` = Σ level(ancestorsᵢ) | 171 / 195 / 243 | Fifty #2-shaped changes in one event: each new working session flips `working`/`phase` up its issue's chain. The sum of the #2 budget over the fifty chains; distinct counting only lowers it where chains share ancestors. No placement term: `rankOf` reads no activity. Bounded by fifty chains, not by N: at 4x, 243 against 844 visible rows. |

The per-scale values are what `FENCE_SCENARIOS` computes from the targets
before each write (#10 after #6–#7 reshaped the tree). #10 moves with the
depth of the fifty burst issues' chains (57, 65 and 81 levels at the step), not with the
corpus.

`assertReads(result, { readsPerChange })` throws with the per-entity
breakdown when the budget is exceeded, and also when the result has no reads
cell (fence disabled): a missing cell fails, never passes.

**The legacy control fails it.** `legacyControlArmFor` reads its store
through the fence (`legacy-control/fenced-store.ts`). The one corpus at 1x
(`startScenarioEngine(1)`): 4,867 issues, 4,304 sessions, 500 lanes. Measured
2026-09-22 at `da7e6c1b3` on this branch (`control.test.tsx`; happy-dom
counts, which box load does not move).

| Scenario | Legacy reads | Of which | Budget |
|---|---|---|---|
| #1 unrelated heartbeat | 9,671 | 4,867 issues, 4,304 sessions, 500 lanes | 3 |
| #2 visible phase change | 9,920 | the same plus 249 dep edges | 3 × (ancestors + 1) |
| #3 selection click | 9,920 | the same (the eager mark-read row republishes) | 3 (was 0) |
| #4 visible title rename | 9,671 | 4,867 issues, 4,304 sessions, 500 lanes | 3 |
| #5 stage move | 9,920 | 4,867 issues, 4,304 sessions, 500 lanes, 249 dep edges | 24 |

Every scenario reads the whole corpus: the derive is whole-world.
`control.test.tsx` asserts the heartbeat reads exactly every session and every
issue and that `assertReads` throws; a second case asserts all five scenarios
exceed their budgets; a third asserts that the fence changes nothing the
control does (rows committed, commits by row and `ArmStats` equal with the
fence on and off; parity true in both).

The adapter adds one thing in count runs only. The derive walks issues as
view models that the replica view cache owns privately, so no outside wrapper
can reach them. `fenced-store.ts` wraps `issues` and `issueProjections` fresh
per store snapshot. The cache then runs its per-snapshot identity pass over
every issue row (counted), reuses every unchanged model, and returns the same
array. That is one extra O(N) identity pass per derive, with the same output.

**Both directions** (`harness/src/reads-probe.test.tsx`, real engine, the
same mount path an arm takes). Three probe arms differ in one dimension:
- reads the changed session and its issue by id: 2 rows, `assertReads`
  passes;
- the same plus one walk over the sessions table: every session (4,304 at
  1x), throws;
- stores copies instead of borrowed rows: the count run throws on the sticky
  violation, although the feed swallowed the original throw.

`count-harness.test.ts` guards `assertReads` both ways on synthetic results,
plus the missing-cell rule. `shared/src/instrument/reads.test.ts` covers each
door and each refusal.

**#6–#10 in both directions (POD-4609).**

*NO — the legacy control exceeds every one.* `control.test.tsx` runs every
fence scenario in order with the budget each computes, and asserts that each
#6–#10 step reads at least the whole corpus and that `assertReads` throws.
Measured at 1x on this branch (happy-dom counts, 2026-09-22):

| Scenario | Legacy reads | Budget |
|---|---|---|
| #6a new issue | 9,922 | 16 |
| #6b archive | 9,922 | 15 |
| #6c evict | 9,921 | 15 |
| #6d evict keeper | 9,920 | 30 |
| #7 parent reassignment | 9,920 | 21 |
| #8 clock tick | 9,920 (the store publishes; the row feed emits nothing) | 0 |
| #8b grace crossing | 9,669 | 96 |
| #9a / #9b / #9c | 9,669 / 9,669 / 9,920 | 3 |
| #10 burst | 9,719 | 171 |

At 2x and 4x the control reads 19,338–19,880 and 38,676–39,752 on the same
steps (a one-off measurement, not a test).

*YES — the reference arm cannot carry it; a shape arm does.* The L6a
reference arm reads the engine store, never the feed or a fenced table: its
reads cell is 0 on every step (pinned in `fences.test.tsx`). It would meet
any budget blind, so it is the wrong arm for this fence (by design: it is
exempt and not a candidate), not evidence that the budgets are right.
`harness/src/reads-budgets.test.tsx` carries the YES instead: a probe arm
that stores the borrowed rows, reads them only through `wrapTables` and
`wrapRelations`, and on each event does exactly the reads the derivations
name — the named rows, the chains it climbs through `issue.parent`, the
neighbours it reads to leave a position, and a binary search that READS
every probed row to enter one. At 1x, 2x and 4x it meets every #6–#10 budget,
and each cell is at least the rows the change names (not a blind 0):

| Scale | #6a | #6b | #6c | #6d | #7 | #8 | #8b | #9a/b/c | #10 |
|---|---|---|---|---|---|---|---|---|---|
| 1x | 3/16 | 1/15 | 2/15 | 3/30 | 3/21 | 0/0 | 6/96 | 1/3 | 108/171 |
| 2x | 4/16 | 1/15 | 2/15 | 2/30 | 3/21 | 0/0 | 11/192 | 1/3 | 116/195 |
| 4x | 5/16 | 1/15 | 2/15 | 3/30 | 3/21 | 0/0 | 24/384 | 1/3 | 132/243 |

For the ticks the arm keeps each open-lane closure's fold deadline
(`issueFinishedAt` + 24 h) as a derived key and, on a clock notification,
reads and moves only the rows whose deadline passed. The test also holds each
tick's projected crossings to what the tick did (0 for #8; 4, 8, 16 for #8b).
The same arm plus ONE walk over the issue table per notification (a row event
or a locals change) fails every #6–#10 budget, the ticks included (1x: 4,866
to 4,919 rows read).

**Step isolation: every step settles its own writes** (POD-4618, replacing
POD-4609's frozen `Date`). The #3 click's eager mark-read used to be
acknowledged by the scenario server and never echoed as truth, so the runtime
kept it awaiting truth until its 60 s WALL-CLOCK sweep
(`AWAITING_TRUTH_TTL_MS`, `client-core/src/engine/overlay.ts`), which retired
it in whichever step was running then: at 4x it landed in #6b, #7 or #8, and
in #8 it read 1 against a budget of 0. That row is #3's, not the step's.
POD-4609 froze `Date` to hide it; a frozen clock hides exactly the clock
behaviour the fences exist to check, so the freeze is gone. Now:

- every scenario write's settle has the server acknowledge AND echo, within
  the step, each mark-read the write provoked (`scenarios.ts`, `settled`):
  `readAt` at the server's clock. Only the #9a press is left for #9b to echo;
- `runFenceStep` refuses a step that leaves the runtime's optimism ledger
  (`pendingOverlaysByRow`: queued, in flight or awaiting truth) holding a write
  the step does not declare (`leavesPending`, #9a only). With the echo removed
  it fails at #3 (`left writes pending: [issues:i17]`); it also caught #10 at
  1x, where the burst gives the still-selected row new activity and the
  runtime marks it read again;
- the shape-arm runs keep the real clock and assert that no step writing no
  read cursor (#1, #2, #4–#8b) moves one, and report how long the run went on
  after #3.

**Feeds changed:** #3 is 2 events (the painted read, then the server's echo)
where it was 1. At 1x and 2x #10 is 2 events too: the burst gives the
still-selected row new activity, the runtime marks it read again, and the
server echoes that within #10 (at 4x the clicked row is not a burst target, so
#10 stays 1). No reads cell moved (the table above holds at every scale): each
pair of events names the same row.

Evidence, 4x, real clock, three interleaved rounds against a control (the old
code with only the freeze removed), 2026-09-23: fixed green 3/3, #3's row
moving only in #3, #8 reading 0, 114–141 s of run after the click; control red
3/3, #3's row moving in #8 (twice, reading 1 against 0) and in #7. Every other
cell was identical in both arms.

**#3 corrected: 0 → 3** (POD-4609, coordinator ruling on POD-4619,
2026-09-22). L5a derived 0 from "selection is a local; no table read". That
derivation was wrong: the engine reacts to a selection by marking the
clicked issue read, so the click's feed event names the clicked row
(`issue:<visibleRootId>`, at every scale; since POD-4618 a second event, the
server's echo, names it again), and no arm that reads the
rows its events name could meet 0. A click is a local change plus a
mark-read of the clicked row: the #9a shape, 3. This is a correction of a
derivation made BEFORE any candidate arm was measured on #3 (the roster was
empty), so it does not re-read a budget after measurement. Both directions:
the shape arm reads 1 on #3 at 1x, 2x and 4x (`reads-budgets.test.tsx`, now
in its budgeted set, with 1 as the named-row floor); the legacy control
reads 9,920 and fails it (`control.test.tsx`); the shape arm plus one table
walk fails it.

```bash
bun run test:file -- packages/worklist-proto/shared/src/instrument/reads.test.ts \
  packages/worklist-proto/harness/src/count-harness.test.ts \
  packages/worklist-proto/harness/src/reads-probe.test.tsx \
  packages/worklist-proto/harness/src/reads-budgets.test.tsx \
  packages/worklist-proto/harness/src/legacy-control/control.test.tsx
```

## Exact commits, the copy sweep and the lint fence (POD-4563)

Three fences every round-three arm meets identically, each proven to fail.

**Exact commits** (`assertCommits`, `harness/src/count-harness.tsx`). The rows
an arm redraws must EQUAL the rows whose row view changed: set equality, no
allowance list. The oracle is the row-view oracle
(`harness/src/oracle/row-views.ts`): every `RowView` field, projected from the
same legacy derivation as parity (the `SliceRow` half IS the parity row;
`selected`, the origin tick, `activityAt`, `workingSince` and the placement
inputs cite their legacy source). A `CountInput` supplies it as `views()`; the
harness calls it before and after the change and compares rows visible in
both. "Redrew" is a non-mount commit, or a REmount of a row visible before and
after (the commit log now records mounts). Over-commit is the work round two
hid behind "≤ budget"; under-commit is a stale screen parity cannot see,
because parity reads `snapshot()`, not what was drawn. No `views` = no commit
cell = the assertion throws. Round two's `allowOver` list (the #4 origin tick)
is gone: the tick is a view field.

`harness/src/fence-scenarios.ts` is the one scenario list (#1–#10 with the #9
steps and #8b, one engine, methodology order; row-view locals come from the
engine's selection and clock). Every fenced arm gets its feeds from
`openFenceFeeds`: the row source and the engine-backed LOCALS CHANNEL
(POD-4608, `LocalsSource` in `shared/src/arm.ts`), which notifies with the
keys that moved — `{selectedIssueId}` on the #3 click, `{coarseNow}` on a
tick, nothing on a row write. #8b ticks 24 h across the finished-grace
boundary, because the methodology #8 tick moves no view and so cannot fail an
arm deaf to the clock. `harness/src/fences.test.tsx` runs it:

- the REFERENCE arm (`harness/src/reference-arm/`: the oracle drawn through
  memoised `RowShell` rows) passes `assertCommits` on every step — the fence
  can say YES through a real React tree; `#2 #3 #4 #5 #7 #10` must change at
  least one visible row, so the pass is not 0 == 0. At 1x (seed 4443),
  changed = drawn: #2 1, #3 1, #4 1, #5 1, #7 2, #8b 4, #10 54, every other
  step 0. The locals channel notified on #3, #8 and #8b only, with only their
  own keys (asserted).
- every arm in `harness/src/roster.ts` must pass, on every step, the exact
  commit fence, parity, the reads budget (every step has one), and the copy
  sweep. The roster must name exactly the `arms/*` folders with a
  `fence.json`.
- the NO: the legacy control fails `assertCommits` on the heartbeat
  (`control.test.tsx`: changed 0, drawn every visible row).
- PLANTED ARMS (`harness/src/fences.planted.test.tsx`, `ReferencePlant` in the
  reference arm), each red with parity green: an unmemoised slot (#1: over,
  all 211 rows), a stale view (#2: under=[i17]), a remount per render (#1:
  over via 211 remounts, `rowsCommitted` 0 — and on the same run round two's
  `assertIsolation` passes, asserted), and an arm deaf to the locals channel
  (#3: under=[i17] with the notification delivered; #8b: under=the 4 grace
  rows) — each beside the same step passing when the arm follows the
  channel. Armed: removing the remount-to-redraw
  line reddens the remount test; forcing `over` empty reddens the unmemoised
  and remount tests; forcing `under` empty reddens the stale test.

**Which stamps are compared** (coordinator, from L4a: mark-read overlays
stamp `Date.now()`, so a PAINTED `readAt` differs between runs).

| stamp | compared? | where it comes from |
|---|---|---|
| `activityAt` (row view) | yes | sessions' `lastActiveAt`, else the issue's `updatedAt`: scenario writes stamp both from the corpus clock (`ctx.stamp()`), server truth |
| `workingSince` (row view) | yes | `agentState.since` / `lastActiveAt`, corpus clock |
| `foldAt` (row view) | yes | `tuckedAt ?? closedAt ?? updatedAt`, corpus clock |
| `createdAt` (row view) | yes | immutable |
| `readAt`, `unread` | NO | no row-view or `SliceRow` field carries them. A painted `readAt` reaches a comparison only through legacy visibility of FINISHED child issues (the read-grace anchor); the #9 target is an open root |

Proved, not argued: `fences.test.tsx` "wall-clock independence of the #9
steps" runs #9a–#9c under system clocks of 2026-09-21 and 2031-03-01, asserts
the painted `readAt` really differs (it carries each clock), and requires
identical row views, cells and parity in both.

**The copy sweep** (`fence.assertNoCopies(handle)`, `shared/src/instrument/
reads.ts`). Walks everything reachable from the arm handle by reflection (own
data properties, symbol keys, Map/Set entries; never a getter, never a
borrowed row or a fenced table) and fails on an object carrying a fed row's key
plus two or more of that row's own values outside the row-view vocabulary —
a copy the reads fence would count once and never again. It also fails when it
reaches no wrapped table: then it is blind, and silence is not a pass. It
cannot see closures, `#private` fields or weak collections; the lint forbids
module-scope state and `#private` fields, and closures stay a review item, as
do walks over an arm's own per-row caches.

**The lint fence** (`harness/lint/`, README there). One ESLint plugin over
every folder under `arms/` (frozen round-two `hand`/`mobx` get only the
wall-clock rule): a manifest per arm (`fence.json`: exactly one enumeration
module, named in the arm README), no table walk outside it, no store reached
from a component or row module by value import (transitively, chain named),
the `RowShell` component a module-scope identifier, no `Date.now` in `arms/`,
no module-scope state or `#private` fields. `bun run lint` in the package runs
it; `fence-lint.test.ts` runs in the test lane, plants each mistake next to its
clean twin, and lints the real `arms/` through the package config.

```bash
bun run test:file -- packages/worklist-proto/harness/src/fences.test.tsx \
  packages/worklist-proto/harness/src/fences.planted.test.tsx \
  packages/worklist-proto/harness/lint/fence-lint.test.ts \
  packages/worklist-proto/harness/src/count-harness.test.ts \
  packages/worklist-proto/harness/src/legacy-control/control.test.tsx \
  packages/worklist-proto/shared/src/instrument/reads.test.ts \
  packages/worklist-proto/harness/src/oracle/row-views.test.ts
```

## The correctness gate (POD-4556)

After every generated change, an arm's incremental state must equal a rebuild
of the same arm from scratch and the legacy oracle.

`checkArm(arm, sequence, opts)` (`shared/src/gen/check.ts`) boots the
generator's engine (`shared/src/gen/run.ts`, POD-4555), creates the arm over
the per-row feed and applies the sequence one change at a time. After the
bootstrap (`step: -1`) and after every settled step it compares:

| Comparison | Against | When (default) |
|---|---|---|
| `snapshot()` vs `rebuildFromScratch()` | the arm recomputed from the feed's CURRENT `snapshot(kind)` tables, so a change the feed never announces (discovery-only worktrees, POD-4606) still shows | every step (`rebuildEvery: 1`) |
| `snapshot()` vs `oracleSnapshot(store)` | the legacy derivation over the engine store (the app's paint), derived AND projected with the engine's own clock | every 10 steps and after the last (`oracleEvery: 10`) |

It compares the whole `SliceSnapshot`: every row's fields, the pinned ids,
and each group's key, label, row ids and closed ids, all order-sensitive.
`SliceSnapshot` carries no `readAt`, so the painted wall-clock stamp of a
pending mark-read (POD-4555 finding 5) is never compared. The first
divergence stops the run. The failing prefix is shrunk (`shrink.ts`, with
"the checker fails" as the predicate), and the result carries
`{ step, change, against, diff, shrunk, shrunkDivergence }`. Quote the shrunk
sequence in a report, not the raw run.

**Contract.** A checked arm is a `CheckableArm` (`shared/src/arm.ts`). Its
handle adds `rebuildFromScratch()`, which reads the feed's current tables and
`locals.get()`, and must read no incremental state and write none. The roster
(`harness/src/roster.ts`) requires a `CheckableArm`, so a round-three arm
without it is a type error. The checker hands the arm the engine-backed locals
channel (`createEngineLocals`, POD-4608), so a tick reaches the arm only there.
A `refresh` is a new page: the checker disposes the arm and creates a new one
over the new engine's feed and locals. An arm that closes over the engine is
therefore passed as a factory (`(ctx) => arm`). `mode` names the feed (default `overlaid`). A `truth` arm
owns its optimism and must still match the overlaid oracle.

**Sampling.** `rebuildEvery`/`oracleEvery` above 1 compare at checkpoints
only. A failure is then re-run densely over its prefix, so the step it names
is exact. A divergence that heals itself between two checkpoints goes unseen.
Sample only an arm whose snapshot or rebuild is expensive. The legacy control
is one: both are a whole legacy derivation.

**The control.** `legacyControlArmFor` is checkable. Its
`rebuildFromScratch()` is `rebuiltSnapshotFromStore`: the same derivation and
projection over copied collections and a fresh stub replica, so the
per-replica view-model cache starts empty. What it checks is the legacy cache
plumbing, not the rules. Until POD-4608 the control projected with its
create-time `locals.coarseNow` while the derivation read the engine's clock:
after a 25 h tick, rows the oracle closes kept `closed: false`. That
behaviour (reading `locals.get()` once, at creation) is the planted defect
below. `snapshotFromStore` still projects with the caller's clock, so a
caller whose clock differs from the engine's gets two clocks. The oracle here
is `oracleSnapshot`, which takes both from the store.

### Proof that it can fail (`shared/src/gen/check.test.ts`)

Measured at `407389b1a`, which became `a7450c223` when rebased onto `9279c2974` (that commit touched only native test files; the later biome pass is formatting). Corpus 1x (seed 4443).

| Subject | Run | Result |
|---|---|---|
| Tiny reference arm (a pool over the feed with one index, sessions by issue; output is not the worklist, so `oracleEvery: 0`) | `gen(7, 200)`, default weights | correct: pass, 201 rebuild checks, 1 reload |
| same, PLANTED: a removed session stays in its issue's bucket | same run | red at step 121 `remove session s875`, against the rebuild (`progressTotal` one too high on its issue's row). Shrunk in 18 runs to **1 step**: `[remove session s875]`. The correct arm passes the shrunk sequence |
| Legacy control, checkpoints every 10 | `gen(3, 120)` | correct: pass, 13 rebuild + 13 oracle checks, 1 reload. It crosses a 25 h tick, so the pass also shows the checker delivers the clock |
| same, PLANTED: reads `locals.get()` once, at creation | same run | noticed at the step-39 checkpoint, named at step 33 `clockTick 25 h` (the dense re-run), against the rebuild: 5 rows `closed: false (expected true)`, and group row and closed ids moved. Shrunk in 15 runs to **1 step**: `[clockTick 90000000]`. The correct control passes it |
| same, PLANTED stale in BOTH snapshot and rebuild (self-consistent) | same run | passes its own rebuild; red against the **oracle** at step 33, shrunk to the same single tick |

Mutations of `check.ts`, each planted alone and restored with `cp`. Each
turned the named test red:

| Mutation | Went red |
|---|---|
| the arm gets frozen locals (`fixedLocals`) instead of the engine's | the correct control: "rows differing (5)" |
| no dense re-run after a sampled failure | the planted control reports the checkpoint's step (`offline`), not `clockTick` |
| rebuild comparison always equal | "the planted bucket leak passed the checker" |

### The CI-sized run

20 seeds × 300 steps at 1x on the legacy control, rebuild and oracle
compared every 10 steps. It is split over four shard files, five seeds each
(`shared/src/gen/check-ci-{1..4}.test.ts`, one runner in `check-ci.ts`).
Opt-in: it runs for minutes. `test:file` runs one worker unless told
otherwise, so the shards need `PODIUM_TEST_WORKERS=4` to run in parallel:

```sh
POD_CHECK_CI=1 PODIUM_TEST_WORKERS=4 bun scripts/test-heavy.ts -- -- bun run test:file -- \
  packages/worklist-proto/shared/src/gen/check-ci-1.test.ts \
  packages/worklist-proto/shared/src/gen/check-ci-2.test.ts \
  packages/worklist-proto/shared/src/gen/check-ci-3.test.ts \
  packages/worklist-proto/shared/src/gen/check-ci-4.test.ts
```

(`test-heavy.ts` eats the first `--`; with one, it tries to execute the test
path.) Each shard asserts it finished in under 5 minutes. Per-seed counts and
times land in `harness/browser/results/check-ci-<n>.json`.

As of `407389b1a` (now `a7450c223`): **all 20 seeds pass**. Totals: 6,000 steps, 10 skipped
by the runner (target gone), 128 arms created (20 at boot, 108 on reloads),
620 rebuild and 620 oracle checks. **Wall 125 s** (the command's Duration;
the shards took 111, 113, 111 and 114 s). Load was 10.5 at the start and
13.9 at the end, so the wall is an upper bound, not a timing result. On one
worker the same run took 348 s (at `6d68b602c`, before the rebase). Summed
over the shards, the time went: apply 114 s, snapshot 124 s, rebuild 126 s,
oracle 81 s. That is ~0.2 s per control snapshot and per rebuild at this
load. Comparing every step would cost ~0.4 s a step, over 30 minutes, which
is why the control samples.

A round-three arm's snapshot is incremental and its rebuild is a pool
rebuild. The tiny arm's cost 14 ms and 25 ms a step at 1x, so run it with the
defaults:
`checkArm(entry.armFor, gen(seed, 300), { mode: entry.mode })`.

## The control and what its failure looks like

`legacyControlArmFor(engine)` reads the published `worklistSlice` through the
published-slice mechanism and renders groups and rows in the pre-Stage-0 shape:
unmemoized rows, whole `issues`/`sessions` arrays as props, fresh closures,
own O(N) scans, unwindowed, legacy nesting (formal children commit with their
parent — the slice is flat, the rendering is not). `snapshot()` projects the
live slice with the oracle's own projection, so parity passes exactly.
`ArmStats` are honest whole-world numbers: `rowsDerived` = visible rows per
derive, `rollupsDerived` = derives, `indexUpdates` = 0 (no incremental index —
zero is the finding), `notifications` = publications observed.

The armed failure (numbers below are from the retired SMALL corpus; the
fixture's are in the POD-4550 section of `packages/worklist-proto/NOTES.md`
and in `control-1x.test.tsx`, which pins 211 visible rows at 1x):

```
[control] heartbeat committed 39/37 visible rows;
  stats={"rowsDerived":41,"rollupsDerived":1,"indexUpdates":0,"notifications":1} parity=true
[isolation] unrelatedHeartbeat (#1): committed 39 rows, budget 0. ...
```

One publish, one whole-world derive, every row commits — including rows the
heartbeat cannot affect (the session belongs to an archived issue). That throw
is the detector proving it can say NO. Never weaken the test; a green run
without a control change means the detector is blind.

## Measurement hygiene (methodology §5.7, mandatory)

- `uptime` first. 1-minute load above 8: counts only, say so, publish no walls.
- Counts do not move with machine load and are the stronger evidence; wall
  times are the contaminated ones. Do not sum overlapping CPU buckets.
- Bench lease around timing phases only; release between scenarios; record
  uptime with every record; interleave (rotate) arms and scales.
- Record corpus counts and the commit SHA in every JSON.
- If Playwright cannot launch Chromium on the box, stop; never substitute
  happy-dom for browser numbers.

## Native lane

`harness/native/control.native.test.tsx` mounts `mountNative()` (RN
`View`/`Text`/`ScrollView`) under the package config, where `react-native`
resolves to `react-native-web`. Excluded from the root node/unit lanes
(`nodeTestExclude` — the POD-1220 Flow hazard); runs via
`bun run --filter @podium/worklist-proto test`. Same scenarios, same
assertion, same heartbeat failure shape as web (39/37 at SMALL).
