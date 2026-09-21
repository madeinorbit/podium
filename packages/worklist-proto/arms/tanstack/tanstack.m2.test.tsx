// @vitest-environment happy-dom
/**
 * POD-4452 — TanStack DB arm milestone 2: structural scenarios #4–#10 through
 * the G4 count harness at live corpus (1x), with oracle parity after every step.
 *
 * One engine, methodology order (#4 rename, #5 stage move, #6a new, #6b
 * archive, #6c evict, #6d keeper setup + keeper evict, #7 reparent, #8
 * clock, #9 optimism in four steps, #10 burst50). Each step records rows
 * committed, arm stats, scans, query-graph
 * runs deltas, and parity into a table; budget assertions run when
 * `PROTO_M2_STRICT=1` (the gate), otherwise the table is printed for the
 * before/after record. Corpus scale via `PROTO_M2_SPEC=small` (iteration) or
 * the default 1x (the record).
 *
 * TanStack has no rebuild oracle (H4: one query-graph path instead of
 * incremental + from-scratch); parity against `snapshotFromStore` plus the
 * over-commit check (every committed row ⊆ oracle-changed rows) is the
 * per-step proof. Row identity for #9 is the committed `SliceRow` object in
 * `store.rows`: the commit layer only replaces it when the value moved
 * (JSON compare), so the rejection must restore the echo step's object
 * (compare by identity).
 *
 * Counts only — no walls under box load (methodology §5.7).
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createRowSource } from '../../shared/src/row-source'
import { GROWTH_CORPORA, SMALL_CORPUS, startScenarioEngine } from '../../shared/src/scenarios'
import type { SliceLocals, SliceSnapshot } from '../../shared/src/slice-types'
import {
  mountArmForCounts,
  runCountScenario,
  type CountResult,
} from '../../harness/src/count-harness'
import { snapshotFromStore } from '../../harness/src/oracle/index'
import {
  armMarkReadRejection,
  writeArchiveIssue,
  writeBurst50,
  writeEvictIssue,
  writeEvictKeeperIssue,
  writeKeeperPair,
  writeNewIssue,
  writeOptimisticEcho,
  writeOptimisticPress,
  writeParentReassignment,
  writeStageMove,
  writeTitleRename,
} from '../../harness/src/scenario-writes'
import { tanstackArm } from './arm'
import type { GraphRuns } from './queries'
import type { TanStackStore } from './store'

const SPEC = process.env.PROTO_M2_SPEC === 'small' ? SMALL_CORPUS : GROWTH_CORPORA.x1
const STRICT = process.env.PROTO_M2_STRICT === '1'

interface StepRecord {
  scenario: string
  methodology: string
  rowsCommitted: number
  commitsByRow: Record<string, number>
  visibleRows: number
  stats: CountResult['stats']
  scans: Record<string, number>
  runs: Record<string, number>
  parity: boolean
  parityDiff: string | null
}

function changedRows(before: SliceSnapshot, after: SliceSnapshot): string[] {
  const out = new Set<string>()
  for (const id of new Set([...Object.keys(before.rowsById), ...Object.keys(after.rowsById)])) {
    if (JSON.stringify(before.rowsById[id] ?? null) !== JSON.stringify(after.rowsById[id] ?? null)) {
      out.add(id)
    }
  }
  return [...out].sort()
}

const RUN_KEYS = [
  'narrow',
  'resolve',
  'verdict',
  'issuesNarrow',
  'child',
  'summary',
  'lane',
  'rows',
] as const

function snapshotRuns(runs: GraphRuns): { counters: Record<string, number>; changes: Record<string, number> } {
  const counters: Record<string, number> = {}
  for (const key of RUN_KEYS) counters[key] = runs[key]
  return { counters, changes: { ...runs.changes } }
}

function diffRuns(
  before: { counters: Record<string, number>; changes: Record<string, number> },
  after: GraphRuns,
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const key of RUN_KEYS) {
    const delta = after[key] - (before.counters[key] ?? 0)
    if (delta !== 0) out[key] = delta
  }
  for (const key of new Set([...Object.keys(before.changes), ...Object.keys(after.changes)])) {
    const delta = (after.changes[key] ?? 0) - (before.changes[key] ?? 0)
    if (delta !== 0) out[`changes:${key}`] = delta
  }
  return out
}

describe('tanstack arm milestone 2: structural scenarios', () => {
  it('scenarios #4-#10 with parity and budgets', async () => {
    const started = performance.now()
    const ctx = await startScenarioEngine(SPEC)
    const source = createRowSource(ctx.engine, ctx.replica)
    let locals: SliceLocals = {
      selectedIssueId: null,
      coarseNow: ctx.engine.getSnapshot().coarseNow,
    }
    const mounted = mountArmForCounts(tanstackArm, source.source, locals)
    const store = (mounted.handle as unknown as { store: TanStackStore }).store
    const records: StepRecord[] = []

    const step = async (
      scenario: string,
      methodology: string,
      apply: () => unknown,
      expectedLocals: SliceLocals = locals,
      allowOver: string[] = [],
    ): Promise<CountResult> => {
      const before = snapshotFromStore(ctx.engine.getSnapshot(), expectedLocalsFor(scenario))
      const runsBefore = snapshotRuns(store.runs)
      const result = await runCountScenario(mounted, {
        scenario,
        methodology,
        apply: async () => {
          await apply()
          source.flush()
        },
        expected: () => snapshotFromStore(ctx.engine.getSnapshot(), expectedLocals),
      })
      const runsDelta = diffRuns(runsBefore, store.runs)
      const changed = changedRows(before, snapshotFromStore(ctx.engine.getSnapshot(), expectedLocals))
      const committed = Object.keys(result.commitsByRow).sort()
      const over = committed.filter((id) => !changed.includes(id))
      const scans = store.scanCounts()
      console.info(
        `[tanstack-m2] ${methodology} ${scenario}: visible=${result.visibleRows} ` +
          `committed=${result.rowsCommitted} [${committed.slice(0, 8).join(',')}${committed.length > 8 ? '…' : ''}] ` +
          `oracleChanged=${changed.length} overCommit=[${over.join(',')}] ` +
          `stats=${JSON.stringify(result.stats)} scans=${JSON.stringify(scans)} ` +
          `runs=${JSON.stringify(runsDelta)} ` +
          `parity=${result.parity}${result.parityDiff ? ` DIFF ${result.parityDiff.slice(0, 300)}` : ''}`,
      )
      records.push({ ...result, scenario, methodology, scans, runs: runsDelta })
      expect(result.parity, `${scenario}: parity ${result.parityDiff ?? ''}`).toBe(true)
      // POD-4491/POD-4496: #6a newIssue commits i1 (R3 fan-out on the newly
      // live worktree index; the SliceSnapshot oracle reports no change for
      // i1). Allowed, not a leak — parity holds.
      expect(over, `${scenario}: every committed row must be oracle-changed`).toEqual(allowOver)
      return result
    }

    // `before` for the clock step is captured with pre-tick locals; every
    // other step shares the current locals.
    const expectedLocalsFor = (_scenario: string): SliceLocals => locals

    try {
      const atMount = mounted.handle.snapshot()
      expect(Object.keys(atMount.rowsById).length).toBeGreaterThan(0)
      expect(atMount).toEqual(snapshotFromStore(ctx.engine.getSnapshot(), locals))
      // Mount record for the Q-T5 fan-out check: verdictR rows and the max
      // issues sharing one worktree path (the fan-out bound).
      const verdictRows = store.base.verdictQ.toArray as Array<{ owner: string }>
      const verdictRRows = store.base.verdictR.toArray as Array<{ owner: string }>
      const sharing = new Map<string, number>()
      for (const row of verdictRRows) {
        sharing.set(row.owner, (sharing.get(row.owner) ?? 0) + 1)
      }
      const mountRecord = {
        visibleRows: Object.keys(atMount.rowsById).length,
        verdictQ: verdictRows.length,
        verdictR: verdictRRows.length,
        maxIssuesPerWorktree: Math.max(0, ...sharing.values()),
      }
      console.info(`[tanstack-m2] mount: ${JSON.stringify(mountRecord)}`)

      const rename = await step('visibleTitleRename', '#4', () => writeTitleRename(ctx))
      const stageMove = await step('stageMoveAcrossGroups', '#5', () => writeStageMove(ctx))
      const newIssue = await step('newIssue', '#6a', () => writeNewIssue(ctx, SPEC), locals, ['i1'])
      const archive = await step('archiveIssue', '#6b', () => writeArchiveIssue(ctx))
      const evict = await step('evictWithoutRevision', '#6c', () => writeEvictIssue(ctx))
      // #6d — keeper setup seeds the rescue pair (POD-4503: the seed corpus
      // carries no rescue rows), then the keeper leaf is evicted and its
      // rescue parent must leave with it.
      const keeperSetup = await step('keeperPairSetup', '#6d setup', () => writeKeeperPair(ctx, SPEC))
      const keeperEvict = await step('evictKeeperWithoutRevision', '#6d', () =>
        writeEvictKeeperIssue(ctx),
      )
      const reparent = await step('parentReassignment', '#7', () => writeParentReassignment(ctx))

      // #8 — the coarse clock ticks with no row change: time is a local.
      // Expected locals advance with the arm; the engine's own clock is
      // untouched (mirrors G3 `clockTick`).
      const tickTo = store.locals.coarseNow + 60_000
      const tickLocals: SliceLocals = { ...locals, coarseNow: tickTo }
      const tick = await step(
        'clockTick',
        '#8',
        () => {
          store.setCoarseNow(tickTo)
        },
        tickLocals,
      )
      locals = tickLocals

      // #9 — optimistic press, server echo, second press, definitive
      // rejection. The committed SliceRow is the identity unit: the commit
      // layer only replaces it when the value moved, so the rollback must
      // restore the echo step's object (compare by identity).
      const target = 'i6'
      const press1 = await step('optimisticPress', '#9a', () => writeOptimisticPress(ctx, target))
      const echo = await step('optimisticEcho', '#9b', () => writeOptimisticEcho(ctx, target))
      const echoObj = store.rows.get(target)
      armMarkReadRejection(ctx)
      const press2 = await step('optimisticPressRejected', '#9c', () =>
        writeOptimisticPress(ctx, target),
      )
      const rejected = await step('optimisticRollback', '#9d', () => Promise.resolve())
      const finalObj = store.rows.get(target)
      console.info(
        `[tanstack-m2] #9 identity: echoKept=${echoObj !== undefined} final===echo ${finalObj === echoObj}`,
      )

      // #9 supplement (not a G3 scenario): the same optimistic press on a
      // VISIBLE row. readAt moves no derived value, so the committed object
      // must survive press + confirm with identity intact — the non-vacuous
      // half of the #9 identity gate (i6 above is invisible in the seed
      // corpus, so its identity holds trivially).
      const visibleTarget = 'i0'
      const visibleBefore = store.rows.get(visibleTarget)
      expect(visibleBefore, 'supplement needs a visible row').toBeDefined()
      const pressVisible = await step('optimisticPressVisible', '#9 suppl.', () =>
        writeOptimisticPress(ctx, visibleTarget),
      )
      const visibleAfter = store.rows.get(visibleTarget)
      console.info(
        `[tanstack-m2] #9 suppl. identity: kept=${visibleAfter === visibleBefore} ` +
          `committed=${pressVisible.rowsCommitted} evals=${pressVisible.stats.rollupsDerived}`,
      )

      const burst = await step('burst50', '#10', () => writeBurst50(ctx, SPEC))

      if (STRICT) {
        // #4: exactly the renamed row, one event, one notification.
        // Derivation bodies are arm-relative (methodology Q-H3/M3: the
        // cross-arm metric is rows committed): the touched row evaluates
        // twice per query stage (retraction + assertion), so own-summary +
        // rows folds read 2+2 with 1 rollup recompute. Scale-invariant.
        expect(rename.rowsCommitted).toBe(1)
        expect(rename.commitsByRow).toEqual({ i0: 1 })
        expect(rename.stats.rowsDerived).toBe(1)
        expect(rename.stats.rollupsDerived).toBe(5)
        expect(rename.stats.notifications).toBe(1)
        // #5: the moved row only (its child's aggregate reads its own
        // subtree, never the parent) + order/group deltas, one pass.
        expect(stageMove.rowsCommitted).toBe(1)
        expect(stageMove.stats.rowsDerived).toBe(1)
        expect(stageMove.stats.rollupsDerived).toBe(5)
        expect(stageMove.stats.notifications).toBe(1)
        // #6a: the arriving row mounts (mount-phase renders are excluded by
        // the RowShell by design) plus one R3 fan-out commit on i1
        // (POD-4491/POD-4496: the newly live worktree index re-resolves on
        // keyspace change; the oracle reports no change for i1, hence the
        // allowed over-commit above). The engine re-runs the graph's fns
        // broadly on the keyspace change (recorded, not pinned — the pin
        // is commits + rows folds, which are scale-invariant).
        expect(newIssue.rowsCommitted).toBe(1)
        expect(newIssue.commitsByRow).toEqual({ i1: 1 })
        expect(newIssue.stats.rowsDerived).toBe(2)
        expect(newIssue.stats.notifications).toBe(1)
        // #6b: the leaving row unmounts (likewise uncounted); its parent's
        // chain commits: the archived row's own fold settling plus the
        // chain row. #6c: the evicted row unmounts with no chain effect
        // (its derived state is disposed, order/groups drop it).
        // POD-4496: archiving i4 removes its R3 anchor (/repo-4/wt-0), so the
        // worktree index re-resolves broadly (resolve/verdict/summary fan-out
        // ~9k). Arm-relative cost, pinned as the new live value; the cross-arm
        // metric (rows committed) stays 1.
        expect(archive.rowsCommitted).toBe(1)
        expect(archive.stats.rowsDerived).toBe(2)
        expect(archive.stats.rollupsDerived).toBe(9255)
        expect(archive.stats.notifications).toBe(1)
        expect(evict.rowsCommitted).toBe(0)
        expect(evict.stats.rowsDerived).toBe(1)
        expect(evict.stats.notifications).toBe(1)
        // #6d setup: arrivals mount (commits stay 0); #6d evict: the keeper
        // leaf unmounts and its rescue parent leaves with it (POD-4503).
        expect(keeperSetup.rowsCommitted).toBe(0)
        expect(keeperSetup.stats.notifications).toBe(1)
        expect(keeperEvict.rowsCommitted).toBe(0)
        expect(keeperEvict.stats.notifications).toBe(1)
        // #7: both chains (old parent, new parent); the moved row itself is
        // value-stable (its subtree did not change).
        expect(reparent.rowsCommitted).toBe(2)
        expect(reparent.stats.rowsDerived).toBe(2)
        expect(reparent.stats.rollupsDerived).toBe(11)
        expect(reparent.stats.notifications).toBe(1)
        // #8: no band boundary crosses on +60s at 1x, so nothing commits —
        // and the over-commit check above already proves every commit would
        // have to be oracle-changed. The locals write re-runs the joined
        // fns (recorded, not pinned); settled rows re-run and settle by
        // equality, same shape as the MobX arm's F-clock.
        expect(tick.rowsCommitted).toBe(0)
        expect(tick.stats.rowsDerived).toBe(0)
        expect(tick.stats.notifications).toBe(1)
        // #9: every step bounded like a phase change; the rollback restores
        // the echo step's object identity; never a full rebuild. POD-4496:
        // i6 is VISIBLE at 1x (R3 anchor s6 joins i6 after the projection
        // dual-carry), so its steps touch the rows fold as well (5 evals,
        // like the visible supplement); press2 carries two presses (10).
        for (const [name, r, evals] of [
          ['press1', press1, 5],
          ['echo', echo, 5],
        ] as const) {
          expect(r.rowsCommitted, name).toBe(0)
          expect(r.stats.rowsDerived, name).toBe(0)
          expect(r.stats.rollupsDerived, name).toBe(evals)
          expect(r.visibleRows, `${name} never a full rebuild`).toBeGreaterThan(10)
        }
        expect(press2.rowsCommitted, 'press2').toBe(0)
        expect(press2.stats.rollupsDerived, 'press2').toBe(10)
        expect(press2.stats.notifications, 'press2 optimistic + rollback').toBe(2)
        expect(rejected.rowsCommitted, 'rollback').toBe(0)
        expect(rejected.stats.rollupsDerived, 'rollback').toBe(0)
        expect(rejected.stats.notifications, 'rollback quiet').toBe(0)
        expect(finalObj, 'rollback restores the echo row object').toBe(echoObj)
        expect(pressVisible.rowsCommitted, 'visible press').toBe(0)
        expect(pressVisible.stats.rowsDerived, 'visible press').toBe(0)
        expect(pressVisible.stats.rollupsDerived, 'visible press').toBe(5)
        expect(visibleAfter, 'visible press keeps row identity').toBe(visibleBefore)
        // #10: one event, work bounded by the burst size plus chains.
        expect(burst.stats.notifications).toBe(1)
        expect(burst.rowsCommitted).toBeLessThanOrEqual(64)
        expect(burst.stats.rowsDerived).toBeLessThanOrEqual(64)
      }

      const elapsedMs = performance.now() - started
      const cwd = process.cwd()
      const resultsDir = cwd.endsWith(join('packages', 'worklist-proto'))
        ? join(cwd, 'harness', 'browser', 'results')
        : join(cwd, 'packages', 'worklist-proto', 'harness', 'browser', 'results')
      mkdirSync(resultsDir, { recursive: true })
      writeFileSync(
        join(resultsDir, `tanstack-m2-counts-${process.env.PROTO_M2_SPEC === 'small' ? 'small' : '1x'}.json`),
        JSON.stringify(
          {
            arm: 'tanstack',
            milestone: 2,
            spec: process.env.PROTO_M2_SPEC === 'small' ? 'small' : '1x',
            strict: STRICT,
            runtimeSha: execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
              encoding: 'utf-8',
            }).trim(),
            capturedAt: new Date().toISOString(),
            elapsedMs: Math.round(elapsedMs),
            mount: mountRecord,
            steps: records,
          },
          null,
          2,
        ),
      )
    } finally {
      mounted.unmount()
      source.dispose()
      ctx.engine.destroy()
    }
  }, 600_000)
})
