# worklist-proto — package notes

## POD-4550 (L2a) — one corpus everywhere · 2026-09-22

### What changed

- `shared/src/scenarios.ts` seeds from `buildCorpus(scale, FIXTURE_SEED)`. Gone:
  `CorpusSpec`, `SMALL_CORPUS`, `GROWTH_CORPORA`, `seedCorpus`, `scenarioRepos`,
  the hand-seeded keeper pair (`seedKeeperPair`, `KEEPER_*`).
- Scenario functions take a fixture scale (`1 | 2 | 4`, default 1).
- `harness/src/scenario-writes.ts` folded into the library: each write exists
  once, as `write*` (settles; count runs) over `apply*` (synchronous; the web
  pages time this half). Scenario functions are "boot, one write under a row
  source".
- `harness/src/engine-bootstrap.ts` folded into the library as
  `startEngineOnCorpus` (the one boot path for scenarios, count runs, web
  entries).
- `ScenarioCache` is a `Map` keyed `entity:id`: `read`/`put`/`drop` O(1);
  `records` materialised on demand.
- Targets picked by rule (`pickTargets`), exposed on `ScenarioEngine.targets`
  and `ScenarioResult.targets`; each checked against the oracle in
  `scenarios.test.ts`. Rules: `docs/plans/pod-4441-harness.md` "One corpus".
- Clock: new runtime seam `coarseClock` (client-core `runtime.ts`). The scenario
  engine pins it to `FIXED_NOW` and `writeClockTick` advances it through the
  runtime's own tick path. Scenario #8 used to synthesise
  `after.coarseNow = before.coarseNow + 60_000` without touching the engine.
- `arms/tanstack/` deleted with its native test, web entry, tsconfig include,
  vite input, driver arm, and the `@tanstack/db` / `@tanstack/react-db`
  dependencies of this package (other packages' TanStack use is untouched).
- Fixture: `corpus.unscannedWorktree` (handover from POD-4546; see below).

### Decisions

- **Engine clock = corpus clock.** The engine used to seed `coarseNow` from the
  wall clock, so engine-backed counts drifted with the date the test ran (the
  mobx clock test's "+60d is the smallest jump that moves rows, probed
  2026-09-21" was a wall-clock fact). Engine-backed runs and the oracle now
  read the same `FIXED_NOW`. Writes stamp rows from that clock too
  (`ctx.stamp()`, strictly increasing), never `new Date()`.
- **#6d uses the fixture's own rescue pairs.** The fixture has ten; the rule
  picks an open leaf that is the only child of a sessionless backlog parent
  (at seed 4443 that is `i0` under `i321`). The oracle test proves that
  evicting it drops the parent.
- **#1 heartbeat target.** No fixture session is bound to an archived or
  deleted issue, so the rule is "session on a closed, childless agent root".
  The oracle test proves the bound issue is not visible.
- **Browser pages use the library's writes and targets**: heartbeat, rename and
  click aim at the rule-picked targets; stagemove still moves a fresh open row
  per sample, now through `applyStageMove`. FINDING: the page's heartbeat used
  to bump `sessions[0]`, a session on a VISIBLE vWork root, so the browser
  "unrelated heartbeat" was never unrelated. L5c owns the driver and should
  re-read that number.
- **Unscanned worktree case (POD-4546 handover).** The last `vSessless` root
  gets `worktreePath = /w/unscanned-<id>`, in no repo's `worktrees` and in no
  session's cwd; the first live working orphan session moves to
  `<path>/sub`. Nothing else in the fixture changes: the transform draws no
  random numbers. The row reads `working` only through that seat. The oracle
  seats it; moving the orphan away turns it off (both asserted in
  `oracle.test.ts`). Visible count at 1x: still 211.

### Re-pinned counts

(Filled in from the test run: see the table below.)

### Open questions

- None blocking. L2b adds the 2x/4x oracle range; this issue asserts 211 at 1x
  only.
