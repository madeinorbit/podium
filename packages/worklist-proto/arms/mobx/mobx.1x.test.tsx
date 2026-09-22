// @vitest-environment happy-dom
/**
 * POD-4447 — MobX arm at live corpus (1x): scenarios #1–#3 through the count
 * harness with oracle parity and the 1x count JSON (attached to the issue,
 * not committed — same shape as the control's `control-1x-counts.json`).
 *
 * Counts only — no walls under box load (methodology §5.7).
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createRowSource } from '../../shared/src/row-source'
import { startScenarioEngine } from '../../shared/src/scenarios'
import type { SliceLocals } from '../../shared/src/slice-types'
import {
  assertIsolation,
  mountArmForCounts,
  runCountScenario,
} from '../../harness/src/count-harness'
import { snapshotFromStore } from '../../harness/src/oracle/index'
import {
  writeHeartbeat,
  writePhaseChange,
  writeSelectionClick,
} from '../../shared/src/scenarios'
import { mobxArm } from './arm'

describe('mobx arm at 1x', () => {
  it('scenarios #1-#3 with parity and budgets', async () => {
    const started = performance.now()
    const ctx = await startScenarioEngine(1)
    const source = createRowSource(ctx.engine, ctx.replica)
    const locals: SliceLocals = {
      selectedIssueId: null,
      coarseNow: ctx.engine.getSnapshot().coarseNow,
    }
    const mounted = mountArmForCounts(mobxArm, source.source, locals)
    try {
      const atMount = mounted.handle.snapshot()
      expect(Object.keys(atMount.rowsById).length).toBeGreaterThan(0)
      expect(atMount).toEqual(snapshotFromStore(ctx.engine.getSnapshot(), locals))

      const heartbeat = await runCountScenario(mounted, {
        scenario: 'unrelatedHeartbeat',
        methodology: '#1',
        apply: async () => {
          await writeHeartbeat(ctx)
          source.flush()
        },
        expected: () => snapshotFromStore(ctx.engine.getSnapshot(), locals),
      })
      console.info(
        `[mobx-1x] heartbeat visible=${heartbeat.visibleRows} committed=${heartbeat.rowsCommitted} ` +
          `stats=${JSON.stringify(heartbeat.stats)} parity=${heartbeat.parity}`,
      )
      expect(heartbeat.parity).toBe(true)
      expect(heartbeat.parityDiff).toBeNull()
      expect(() => assertIsolation(heartbeat, { rowsCommitted: 0 })).not.toThrow()
      expect(heartbeat.stats.rowsDerived).toBe(0)
      // POD-4550: on the fixture the #1 target is a session of a closed agent
      // issue, which the arm holds (unlike the retired corpus's archived
      // issue, which it skipped outright). The arm re-derives that one
      // issue's summary: a member's activity can decide whether a closed row
      // is retained. One body, flat across 1x/2x/4x (m3 growth); zero rows
      // commit, which is the methodology budget.
      expect(heartbeat.stats.rollupsDerived).toBe(1)
      expect(heartbeat.stats.indexUpdates).toBe(0)

      const phase = await runCountScenario(mounted, {
        scenario: 'visibleSessionPhaseChange',
        methodology: '#2',
        apply: async () => {
          await writePhaseChange(ctx)
          source.flush()
        },
        expected: () => snapshotFromStore(ctx.engine.getSnapshot(), locals),
      })
      console.info(
        `[mobx-1x] phase visible=${phase.visibleRows} committed=${phase.rowsCommitted} ` +
          `stats=${JSON.stringify(phase.stats)} parity=${phase.parity} ` +
          `rows=${JSON.stringify(phase.commitsByRow)}`,
      )
      expect(phase.parity).toBe(true)
      expect(phase.parityDiff).toBeNull()
      expect(phase.rowsCommitted).toBe(1)
      expect(phase.commitsByRow).toEqual({ i0: 1 })
      expect(phase.stats.rowsDerived).toBe(1)
      expect(phase.stats.rollupsDerived).toBe(3)
      expect(phase.stats.indexUpdates).toBe(0)

      const click = await runCountScenario(mounted, {
        scenario: 'selectionClick',
        methodology: '#3',
        apply: async () => {
          await writeSelectionClick(ctx)
          source.flush()
        },
        expected: () => snapshotFromStore(ctx.engine.getSnapshot(), locals),
      })
      console.info(
        `[mobx-1x] click visible=${click.visibleRows} committed=${click.rowsCommitted} ` +
          `stats=${JSON.stringify(click.stats)} parity=${click.parity}`,
      )
      expect(click.parity).toBe(true)
      expect(click.parityDiff).toBeNull()
      expect(click.rowsCommitted).toBe(0)
      expect(click.stats.rowsDerived).toBe(0)
      expect(click.stats.rollupsDerived).toBe(3)

      const elapsedMs = performance.now() - started
      expect(elapsedMs).toBeLessThan(60_000)
      const cwd = process.cwd()
      const resultsDir = cwd.endsWith(join('packages', 'worklist-proto'))
        ? join(cwd, 'harness', 'browser', 'results')
        : join(cwd, 'packages', 'worklist-proto', 'harness', 'browser', 'results')
      mkdirSync(resultsDir, { recursive: true })
      writeFileSync(
        join(resultsDir, 'mobx-1x-counts.json'),
        JSON.stringify(
          {
            arm: 'mobx',
            scale: 1,
            runtimeSha: execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
              encoding: 'utf-8',
            }).trim(),
            capturedAt: new Date().toISOString(),
            elapsedMs: Math.round(elapsedMs),
            heartbeat: {
              visibleRows: heartbeat.visibleRows,
              rowsCommitted: heartbeat.rowsCommitted,
              stats: heartbeat.stats,
              parity: heartbeat.parity,
            },
            phaseChange: {
              visibleRows: phase.visibleRows,
              rowsCommitted: phase.rowsCommitted,
              commitsByRow: phase.commitsByRow,
              stats: phase.stats,
              parity: phase.parity,
            },
            selectionClick: {
              visibleRows: click.visibleRows,
              rowsCommitted: click.rowsCommitted,
              stats: click.stats,
              parity: click.parity,
            },
            walls: null,
            wallsSkipped: 'counts carry the verdict; walls via the browser driver under the bench lease',
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
  }, 120_000)
})
