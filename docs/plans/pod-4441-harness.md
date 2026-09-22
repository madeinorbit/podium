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
| `harness/src/oracle/` | G2 oracle, plus `projectSnapshot` and `snapshotFromStore` (parity over live engine state) |
| `harness/web/` | Vite pages per arm/control (`entries/`), shared page wiring (`entrylib.ts`, `window.__proto`) |
| `harness/browser/run.ts` | Chromium timing driver (one invocation per arm/scale) |
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

## Timings (Chromium) — walls, second

```bash
# production build (heavy):
bun scripts/test-heavy.ts -- bunx vite build --config packages/worklist-proto/harness/web/vite.config.ts
# one invocation per (arm, scale) — never loop pairs in-process (F1 lesson):
bun scripts/test-heavy.ts -- bun packages/worklist-proto/harness/browser/run.ts \
  --arm control --scale 1 --samples 5 --out harness/browser/results/control-1x.json
```

The driver serves `harness/web/dist`, loads `<arm>.html?scale=N&sha=<HEAD>`,
waits for `window.__proto.ready`, then rotates scenarios round-robin per
sample: `runScenario` (heartbeat/rename: task wall, long tasks, commits) and
`clickRow` (pointerdown dispatched in-page, paint after two rAFs =
input-to-paint). Heap comes from CDP (`HeapProfiler.collectGarbage` +
`Runtime.getHeapUsage`) before and after; every record carries `loadavg`,
`uptime` and `runtimeSha`. Timing runs under the `bench:ludovico` lease —
without it the driver refuses (walls would be contaminated). Pending arm stubs
expose `ready:false`; the driver writes a skip record and exits 0.

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
| Any single hot-path event | ≤ 8 ms main-thread p95 at live corpus | `taskMs` p95 in driver JSON |
| Row click, input to paint, inside the slice | ≤ 16 ms p95 at 1x, ≤ 32 ms at 4x | `inputToPaintMs` p95 in driver JSON |
| Cost follows the change, not the corpus | per-event slope across 1x/2x/4x ≤ 1.2 | driver runs at three scales; counts must match at all three |
| Bootstrap / principal switch | ≤ 1.1x / ≤ 2x control | driver `coldBootstrap`/`principalSwitch` vs control JSON |
| Memory | retained heap ≤ 1.1x control, no growth after rescope | `heapAfter` vs control; rescope disposal check |
| Bundle | ≤ +60 KB gzip on web, no native-incompatible dep | entry chunk sizes in build output; native lane mount |

Per-scenario row budgets are methodology §5.8 (#1: 0 rows; #2: 1 + ancestors;
#3: 2; #4: 1; #5–#7: affected + order; #10: bounded; #11–#13: full once).
Counts are asserted in CI; walls in Chromium. The growth slope (§1a, scenario
#14) is the performance differentiator among arms that pass.

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
| #3 selection click | 0 | Selection is a local. No table read. |
| #4 visible title rename | ≤ 3 | The renamed issue, and at most two rows to place or label it. |
| #5 stage move across groups | ≤ 24 (`stageMoveNeighbourhood`) | The **visible neighbourhood**: the moved row, two neighbours at the old position and two at the new (5), plus the probes of a binary-search placement at 4x (211 visible rows at 1x, so ~850 at 4x: log2 ≈ 10), is 15; rounded up to 24 for a group-header lookup and the closed-fold boundary. A constant: it does not grow with the corpus. A re-sort of the visible collection reads every visible row and fails. |

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
| #3 selection click | 9,920 | the same (the eager mark-read row republishes) | 0 |
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

```bash
bun run test:file -- packages/worklist-proto/shared/src/instrument/reads.test.ts \
  packages/worklist-proto/harness/src/count-harness.test.ts \
  packages/worklist-proto/harness/src/reads-probe.test.tsx \
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
steps, one engine, methodology order; row-view locals come from the engine's
selection and clock). `harness/src/fences.test.tsx` runs it:

- the REFERENCE arm (`harness/src/reference-arm/`: the oracle drawn through
  memoised `RowShell` rows) passes `assertCommits` on every step — the fence
  can say YES through a real React tree; `#2 #3 #4 #5 #7 #10` must change at
  least one visible row, so the pass is not 0 == 0. At 1x (seed 4443),
  changed = drawn: #2 1, #3 1, #4 1, #5 1, #7 2, #10 54, every other step 0.
- every arm in `harness/src/roster.ts` must pass, on every step, the exact
  commit fence, parity, the L5a reads budget where one is fixed, and the copy
  sweep. The roster must name exactly the `arms/*` folders with a
  `fence.json`.
- the NO: the legacy control fails `assertCommits` on the heartbeat
  (`control.test.tsx`: changed 0, drawn every visible row). Mutants of the
  reference arm, each red with parity green: an unmemoised slot (#1: over, all
  211 rows), a stale view (#2: under=[i17]), a remount per render (#1: over via
  remounts, `rowsCommitted` 0 — the round-two isolation fence passes it).

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
  packages/worklist-proto/harness/lint/fence-lint.test.ts \
  packages/worklist-proto/harness/src/count-harness.test.ts \
  packages/worklist-proto/harness/src/legacy-control/control.test.tsx \
  packages/worklist-proto/shared/src/instrument/reads.test.ts \
  packages/worklist-proto/harness/src/oracle/row-views.test.ts
```

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
