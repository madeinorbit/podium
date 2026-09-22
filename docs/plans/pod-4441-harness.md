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
| `harness/src/count-harness.tsx` | CI counting: `mountArmForCounts`, `mountElementForCounts`, `mountNativeForCounts`, `createReplaySource`, `runCountScenario`, `assertIsolation` |
| `shared/src/scenarios.ts` | THE scenario library (POD-4550): boot (`startScenarioEngine`, `startEngineOnCorpus`), rule-picked targets (`pickTargets`), every write (`write*` settled / `apply*` synchronous), the thirteen scenarios. Count runs, web entries and native lanes all use it |
| `harness/src/fixture/` | The ONE corpus: `buildCorpus(scale, seed)` |
| `harness/src/legacy-control/` | The control: `arm.ts` (`legacyControlArmFor`), `list.tsx`, `native.tsx`, `control.test.tsx` (armed), `control-1x.test.tsx` (CI budget + JSON) |
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
| `visibleRootId` (#2 #3 #4, #7 destination) | lowest-id open human root in an active stage with children, exactly one live working bound session and no working orphan seated under its worktree (so #2 flips `working` at every scale; oracle-checked at 1x/2x/4x) |
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
| Unrelated heartbeat | 0 rows committed, 0 derivations, publish ≤ 2 ms | counts in CI (`assertIsolation` + `rollupsDerived`); publish wall in Chromium |
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
