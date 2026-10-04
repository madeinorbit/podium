// @vitest-environment happy-dom
/**
 * POD-4557 — the reads fence, end to end, in BOTH directions, through the
 * same path every round-three arm takes: a real engine, the real row feed,
 * `mountArmForCounts` (which hands the arm the feed through the fence) and
 * `runCountScenario`.
 *
 * Three probe arms that differ in ONE dimension — how they handle a session
 * row arriving on the feed:
 * - `borrow`  stores the borrowed row, then reads that session and its issue
 *             by id through the fenced tables. 2 rows: the fence says YES.
 * - `scan`    the same, plus a walk over every session to recount "working".
 *             The whole sessions table: the fence says NO.
 * - `copy`    stores a spread copy instead of the borrowed row. The fenced
 *             table refuses it; the feed swallows that throw, so the count
 *             run must still fail — through the sticky violation.
 *
 * Not an arm under test. The probes render nothing and project no slice, so
 * parity is not asserted here; the legacy control carries the parity half.
 */

import { createElement, type ReactElement } from 'react'
import { describe, expect, it } from 'vitest'
import type { Arm, ArmHandle } from '../../shared/src/arm'
import { DISABLED_READ_FENCE } from '../../shared/src/instrument/reads'
import { createRowSource } from '@podium/client-graph/shared/row-source'
import { startScenarioEngine, writeHeartbeat } from '../../shared/src/scenarios'
import type { SliceLocals } from '@podium/client-graph/shared/slice-types'
import type { ArmStats, RowRecord } from '../../shared/src/stats'
import {
  assertReads,
  mountArmForCounts,
  READ_BUDGETS,
  runCountScenario,
  type CountResult,
} from './count-harness'
import { snapshotFromStore } from './oracle/index'
import { fixedLocals } from '@podium/client-graph/shared/locals-source'

type ProbeMode = 'borrow' | 'scan' | 'copy'

function zeroStats(): ArmStats {
  const stats: ArmStats = {
    rowsDerived: 0,
    rollupsDerived: 0,
    indexUpdates: 0,
    notifications: 0,
    reset() {
      stats.rowsDerived = 0
      stats.rollupsDerived = 0
      stats.indexUpdates = 0
      stats.notifications = 0
    },
  }
  return stats
}

function probeArm(mode: ProbeMode): Arm {
  return {
    create(source, _locals, reads = DISABLED_READ_FENCE): ArmHandle {
      const raw = { issue: new Map<string, unknown>(), session: new Map<string, unknown>() }
      const put = (record: RowRecord): void => {
        if (record.kind === 'worktree') return
        const table = raw[record.kind]
        if (record.value === undefined) table.delete(record.id)
        // Storing reads nothing; the copy reads the row once, at the copy.
        else table.set(record.id, mode === 'copy' ? { ...record.value } : record.value)
      }
      for (const record of source.snapshot('issue')) put(record)
      for (const record of source.snapshot('session')) put(record)
      const tables = reads.wrapTables(raw)
      const stats = zeroStats()
      let working = 0
      const off = source.subscribe((event) => {
        stats.notifications += 1
        for (const record of event.rows) put(record)
        for (const record of event.rows) {
          if (record.kind !== 'session' || record.value === undefined) continue
          const session = tables.session.get(record.id) as { issueId?: string | null } | undefined
          if (typeof session?.issueId === 'string') tables.issue.get(session.issueId)
          if (mode === 'scan') {
            working = 0
            for (const row of tables.session.values()) {
              if ((row as { agentState?: { phase?: string } }).agentState?.phase === 'working') working += 1
            }
          }
        }
      })
      return {
        snapshot: () => ({ order: { pinnedIds: [], groups: [] }, rowsById: {} }),
        stats,
        dispose: off,
        mountWeb: () => () => undefined,
        mountNative: (): ReactElement => createElement('div', { 'data-working': working }),
      }
    },
  }
}

async function heartbeat(mode: ProbeMode): Promise<{ run: () => Promise<CountResult>; sessions: number; done: () => void }> {
  const ctx = await startScenarioEngine(1)
  const source = createRowSource(ctx.engine, ctx.replica, { mode: 'overlaid' })
  const locals: SliceLocals = { selectedIssueId: null, coarseNow: ctx.engine.access.coarseNow }
  const mounted = mountArmForCounts(probeArm(mode), source.source, fixedLocals(locals))
  return {
    // The session table the scan walks: the replica's rows, which keep every
    // resume twin the runtime's session list collapses (POD-4551).
    sessions: ctx.replica.rows('sessions').length,
    run: () =>
      runCountScenario(mounted, {
        scenario: 'unrelatedHeartbeat',
        methodology: '#1',
        apply: async () => {
          await writeHeartbeat(ctx)
          source.flush()
        },
        expected: () => snapshotFromStore(ctx.engine.access, locals),
      }),
    done: () => {
      mounted.unmount()
      source.dispose()
      ctx.engine.destroy()
    },
  }
}

describe('reads fence, end to end', () => {
  it('YES: an arm that reads the changed row and its issue passes the heartbeat budget', async () => {
    const probe = await heartbeat('borrow')
    try {
      const result = await probe.run()
      // Non-vacuous: the fence saw the arm's reads (a blind fence reads 0).
      expect(result.readsPerChange).toBe(2)
      expect(result.reads?.byEntity).toEqual({ session: 1, issue: 1 })
      expect(() => assertReads(result, { readsPerChange: READ_BUDGETS.unrelatedHeartbeat })).not.toThrow()
    } finally {
      probe.done()
    }
  }, 30_000)

  it('NO: the same arm plus one table walk reads every session and fails', async () => {
    const probe = await heartbeat('scan')
    try {
      const result = await probe.run()
      expect(result.reads?.byEntity['session']).toBe(probe.sessions)
      expect(() => assertReads(result, { readsPerChange: READ_BUDGETS.unrelatedHeartbeat })).toThrow(
        /read \d+ rows, budget 3/,
      )
    } finally {
      probe.done()
    }
  }, 30_000)

  it('NO: an arm that stores copies fails the count run, although the feed swallowed the throw', async () => {
    const probe = await heartbeat('copy')
    try {
      await expect(probe.run()).rejects.toThrow(/fence violated .* did not hand out/)
    } finally {
      probe.done()
    }
  }, 30_000)
})
