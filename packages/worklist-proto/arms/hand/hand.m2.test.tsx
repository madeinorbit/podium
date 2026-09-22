// @vitest-environment happy-dom
/**
 * POD-4450 — hand-rolled arm milestone 2: structural scenarios #4–#10 through
 * the G4 count harness at live corpus (1x), with oracle parity and the rebuild
 * oracle after every step.
 *
 * One engine, methodology order (#4 rename, #5 stage move, #6a new, #6b
 * archive, #6c evict, #6d keeper evict, #7 reparent, #8
 * clock, #9 optimism in four steps, #10 burst50). Each step records rows
 * committed, arm stats, parity and the rebuild-oracle verdict into a table;
 * budget assertions run when `PROTO_M2_STRICT=1` (the gate), otherwise the
 * table is printed for the before/after record. Corpus: the fixture at 1x,
 * targets picked by rule (`ctx.targets`, POD-4550: one corpus everywhere).
 *
 * Counts only — no walls under box load (methodology §5.7).
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createRowSource } from '../../shared/src/row-source'
import { startScenarioEngine } from '../../shared/src/scenarios'
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
  writeNewIssue,
  writeOptimisticEcho,
  writeOptimisticPress,
  writeParentReassignment,
  writeStageMove,
  writeTitleRename,
} from '../../shared/src/scenarios'
import { handArm } from './arm'
import { rebuildFromScratch } from './rebuild'
import type { HandStore } from './store'
import { fixedLocals } from '../../shared/src/locals-source'

const STRICT = process.env.PROTO_M2_STRICT === '1'

interface StepRecord {
  scenario: string
  methodology: string
  rowsCommitted: number
  commitsByRow: Record<string, number>
  visibleRows: number
  stats: CountResult['stats']
  scans: Record<string, number>
  parity: boolean
  parityDiff: string | null
  oracle: boolean
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

describe('hand-rolled arm milestone 2: structural scenarios', () => {
  // POD-4551 expected failure (coordinator ruling, option 1): the resume-twin tie root (i286 at 1x) collapses in the runtime (runtime.ts:465 and :1172 via dedupeSessions) and this retired round-two arm never collapses, so it shows the stale ask. Delete with the round-two code (Ma1/Ha1); never copy onto a round-three arm.
  it.fails('scenarios #4-#10 with parity, rebuild oracle, and budgets', async () => {
    const started = performance.now()
    const ctx = await startScenarioEngine(1)
    const source = createRowSource(ctx.engine, ctx.replica, { mode: 'overlaid' })
    let locals: SliceLocals = {
      selectedIssueId: null,
      coarseNow: ctx.engine.getSnapshot().coarseNow,
    }
    const mounted = mountArmForCounts(handArm, source.source, fixedLocals(locals))
    const store = (mounted.handle as unknown as { store: HandStore }).store
    const records: StepRecord[] = []

    const checkOracle = (): boolean => {
      const rebuilt = rebuildFromScratch({
        issues: store.issues,
        sessions: store.sessions,
        worktrees: store.worktrees,
        selection: {
          selectedIssueId: store.locals.selectedIssueId,
          selectedIssueWasFolded: store.locals.selectedIssueWasFolded ?? false,
        },
        now: store.locals.coarseNow,
      })
      try {
        expect(mounted.handle.snapshot()).toEqual(rebuilt.snapshot)
        return true
      } catch {
        return false
      }
    }

    const step = async (
      scenario: string,
      methodology: string,
      apply: () => unknown,
      expectedLocals: SliceLocals = locals,
    ): Promise<CountResult> => {
      const before = snapshotFromStore(ctx.engine.getSnapshot(), expectedLocalsFor(scenario))
      const result = await runCountScenario(mounted, {
        scenario,
        methodology,
        apply: async () => {
          await apply()
          source.flush()
        },
        expected: () => snapshotFromStore(ctx.engine.getSnapshot(), expectedLocals),
      })
      const oracle = checkOracle()
      const changed = changedRows(before, snapshotFromStore(ctx.engine.getSnapshot(), expectedLocals))
      const committed = Object.keys(result.commitsByRow).sort()
      const over = committed.filter((id) => !changed.includes(id))
      const scans = store.scanCounts()
      console.info(
        `[hand-m2] ${methodology} ${scenario}: visible=${result.visibleRows} ` +
          `committed=${result.rowsCommitted} [${committed.slice(0, 8).join(',')}${committed.length > 8 ? '…' : ''}] ` +
          `oracleChanged=${changed.length} overCommit=[${over.join(',')}] ` +
          `stats=${JSON.stringify(result.stats)} scans=${JSON.stringify(scans)} ` +
          `parity=${result.parity} oracle=${oracle}`,
      )
      records.push({ ...result, scenario, methodology, scans, oracle })
      expect(result.parity, `${scenario}: parity ${result.parityDiff ?? ''}`).toBe(true)
      expect(oracle, `${scenario}: rebuild oracle`).toBe(true)
      expect(over, `${scenario}: every committed row must be oracle-changed`).toEqual([])
      return result
    }

    // `before` for the clock step is captured with pre-tick locals; every
    // other step shares the current locals.
    const expectedLocalsFor = (_scenario: string): SliceLocals => locals

    try {
      const atMount = mounted.handle.snapshot()
      expect(Object.keys(atMount.rowsById).length).toBeGreaterThan(0)
      expect(atMount).toEqual(snapshotFromStore(ctx.engine.getSnapshot(), locals))
      expect(checkOracle()).toBe(true)

      const rename = await step('visibleTitleRename', '#4', () => writeTitleRename(ctx))
      const stageMove = await step('stageMoveAcrossGroups', '#5', () => writeStageMove(ctx))
      const newIssue = await step('newIssue', '#6a', () => writeNewIssue(ctx))
      const archive = await step('archiveIssue', '#6b', () => writeArchiveIssue(ctx))
      const evict = await step('evictWithoutRevision', '#6c', () => writeEvictIssue(ctx))
      // #6d — the only child of one of the fixture's rescue parents is
      // evicted, and its rescue parent must leave with it (POD-4503). Parity
      // + rebuild oracle fire on a missing keeper-seat cleanup; #6c cannot
      // fail that way.
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
      // rejection. Row identity is captured per step: the rejection must
      // restore the echo step's committed object (compare by identity).
      const target = ctx.targets.markReadId
      const prePress = store.rows.rows.get(target)
      const press1 = await step('optimisticPress', '#9a', () => writeOptimisticPress(ctx, target))
      const afterPress1 = store.rows.rows.get(target)
      const echo = await step('optimisticEcho', '#9b', () => writeOptimisticEcho(ctx, target))
      const echoObj = store.rows.rows.get(target)
      armMarkReadRejection(ctx)
      const press2 = await step('optimisticPressRejected', '#9c', () =>
        writeOptimisticPress(ctx, target),
      )
      const rejected = await step('optimisticRollback', '#9d', () => Promise.resolve())
      const finalObj = store.rows.rows.get(target)
      console.info(
        `[hand-m2] #9 identity: prePress===afterPress1 ${prePress === afterPress1} ` +
          `echoKept=${echoObj !== undefined} final===echo ${finalObj === echoObj}`,
      )

      // #9 supplement (not a G3 scenario): the same optimistic press on a
      // VISIBLE row. readAt moves no derived value, so the committed object
      // must survive press + confirm with identity intact. Both i6 and i0
      // are visible at 1x (POD-4496: the R3 anchor dual-carry makes s6 join
      // i6), so both halves touch all three bodies.
      const visibleTarget = ctx.targets.visibleRootId
      const visibleBefore = store.rows.rows.get(visibleTarget)
      expect(visibleBefore, 'supplement needs a visible row').toBeDefined()
      const pressVisible = await step('optimisticPressVisible', '#9 suppl.', () =>
        writeOptimisticPress(ctx, visibleTarget),
      )
      const visibleAfter = store.rows.rows.get(visibleTarget)
      console.info(
        `[hand-m2] #9 suppl. identity: kept=${visibleAfter === visibleBefore} ` +
          `committed=${pressVisible.rowsCommitted} evals=${pressVisible.stats.rollupsDerived}`,
      )

      const burst = await step('burst50', '#10', () => writeBurst50(ctx))

      if (STRICT) {
        // #4: exactly the renamed row; derivation bodies: own-summary,
        // visibility predicate, subtree aggregate (methodology Q-H3/M3: this
        // counter is arm-relative; the cross-arm metric is rows committed).
        expect(rename.rowsCommitted).toBe(1)
        expect(rename.stats.rowsDerived).toBe(1)
        expect(rename.stats.rollupsDerived).toBe(3)
        expect(rename.stats.notifications).toBe(1)
        // #5: the moved row only (its child's aggregate reads its own
        // subtree, never the parent) + order/group deltas, one pass.
        expect(stageMove.rowsCommitted).toBe(1)
        expect(stageMove.stats.rowsDerived).toBe(1)
        expect(stageMove.stats.notifications).toBe(1)
        // #6a: the arriving row mounts (mount-phase renders are excluded by
        // the RowShell by design, so commits stay 0) — the work is order +
        // one row derivation, one pass.
        expect(newIssue.stats.rowsDerived).toBe(1)
        expect(newIssue.rowsCommitted).toBe(0)
        expect(newIssue.stats.notifications).toBe(1)
        // #6b: the leaving row unmounts (likewise uncounted). POD-4550: the
        // fixture's #6b target is a childless ROOT, so no parent chain
        // re-renders (the retired corpus archived i4, a child, whose parent
        // committed). #6c: the evicted row unmounts with no chain effect.
        expect(archive.stats.rowsDerived).toBe(1)
        expect(archive.rowsCommitted).toBe(0)
        expect(archive.stats.notifications).toBe(1)
        expect(evict.stats.rowsDerived).toBe(1)
        expect(evict.rowsCommitted).toBe(0)
        expect(evict.stats.notifications).toBe(1)
        // #6d: the keeper leaf unmounts and its rescue parent leaves with it
        // (both unmounts uncounted, commits stay 0). Failing parity here is
        // the armed eviction check (POD-4503).
        expect(keeperEvict.rowsCommitted).toBe(0)
        expect(keeperEvict.stats.notifications).toBe(1)
        // #7: both chains (old parent, new parent); the moved row itself is
        // value-stable (its subtree did not change).
        expect(reparent.rowsCommitted).toBe(2)
        expect(reparent.stats.rowsDerived).toBe(2)
        expect(reparent.stats.rollupsDerived).toBe(5)
        expect(reparent.stats.notifications).toBe(1)
        // #8: no band boundary crosses on +60s at 1x, so nothing commits —
        // and the over-commit check above already proves every commit would
        // have to be oracle-changed.
        expect(tick.rowsCommitted).toBe(0)
        expect(tick.stats.notifications).toBe(1)
        // #9: every step bounded like a phase change; the rollback restores
        // the echo step's object identity; never a full rebuild. The #9
        // target is a visible row, so its steps touch all three bodies like
        // the visible supplement (3 evals per press); press2 carries two
        // presses (6).
        for (const [name, r] of [
          ['press1', press1],
          ['echo', echo],
        ] as const) {
          expect(r.rowsCommitted, name).toBe(0)
          expect(r.stats.rollupsDerived, name).toBe(3)
          expect(r.visibleRows, `${name} never a full rebuild`).toBeGreaterThan(10)
        }
        expect(press2.rowsCommitted, 'press2').toBe(0)
        expect(press2.stats.rollupsDerived, 'press2').toBe(6)
        expect(press2.stats.notifications, 'press2 optimistic + rollback').toBe(2)
        expect(rejected.rowsCommitted, 'rollback').toBe(0)
        expect(rejected.stats.notifications, 'rollback quiet').toBe(0)
        expect(finalObj, 'rollback restores the echo row object').toBe(echoObj)
        expect(pressVisible.rowsCommitted, 'visible press').toBe(0)
        expect(pressVisible.stats.rollupsDerived, 'visible press').toBe(3)
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
        join(resultsDir, 'hand-m2-counts-1x.json'),
        JSON.stringify(
          {
            arm: 'hand',
            milestone: 2,
            corpus: { scale: 1, seed: ctx.corpus.seed, targets: ctx.targets },
            strict: STRICT,
            runtimeSha: execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
              encoding: 'utf-8',
            }).trim(),
            capturedAt: new Date().toISOString(),
            elapsedMs: Math.round(elapsedMs),
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
