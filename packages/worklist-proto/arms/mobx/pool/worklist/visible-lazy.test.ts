/**
 * POD-4705, POD-4757 — the filing reactions cover the issues in memory, not
 * every issue the pool knows. Boots the lazy pool at 1x over the replay feed
 * and counts from outside (the pool's own counters and tracked ids, as the
 * first-paint test does — nothing asks the pool what it *should* have built).
 *
 * - every issue in memory holds one filing reaction and no cold issue holds
 *   one (a cold row is hidden by the cold rule), so bootstrap builds fewer
 *   than the known issues (at least one is cold), and every visible row is
 *   among them;
 * - a cold session's heartbeat builds no reaction and moves no row.
 */

import { describe, expect, it } from 'vitest'
import { createReplaySource } from '../../../../harness/src/count-harness'
import { buildCorpus } from '../../../../harness/src/fixture/index'
import { DISABLED_READ_FENCE } from '../../../../shared/src/instrument/reads'
import { settableLocals } from '../../../../shared/src/locals-source'
import type { RowRecord } from '../../../../shared/src/stats'
import { harnessMobxPoolArm, tracked } from '../../../../harness/src/adapters/mobx-pool'
import { installMobxWarnTrap } from '../mobx-trap'

installMobxWarnTrap()

function boot() {
  const corpus = buildCorpus(1)
  const rows: { issues: RowRecord[]; sessions: RowRecord[]; worktrees: RowRecord[] } = {
    issues: corpus.sliceIssues.map((value) => ({ kind: 'issue', id: value.id, value })),
    sessions: corpus.sliceSessions.map((value) => ({
      kind: 'session',
      id: value.sessionId,
      value,
    })),
    worktrees: corpus.sliceWorktrees.map((value) => ({ kind: 'worktree', id: value.path, value })),
  }
  const replay = createReplaySource(rows)
  const locals = settableLocals({ selectedIssueId: null, coarseNow: corpus.fixedNow })
  const handle = harnessMobxPoolArm.create(replay.source, locals.source, DISABLED_READ_FENCE, {
    schedule: () => () => {},
  })
  return { corpus, replay, handle, pool: handle.pool }
}

describe('filing reactions over the issues in memory (POD-4705, POD-4757)', () => {
  it('tracks every issue in memory and no cold one', () => {
    const { pool } = boot()
    try {
      const tracked_ = new Set(pool.worklist.trackedIds())
      const resident = tracked(() => [...pool.tables.issue.keys()])
      const known = resident.length + (pool.residency?.size('issue') ?? 0)
      const order = tracked(() => [...pool.worklist.order])
      // Every known issue tracked (the old eager construction) fails this.
      expect(new Set(resident)).toEqual(tracked_)
      // Every visible row is tracked.
      expect(order.length).toBeGreaterThan(0)
      for (const id of order) expect(tracked_.has(id), `visible ${id} is not tracked`).toBe(true)
      // No cold row is.
      const cold = pool.residency?.ids('issue') ?? []
      expect(cold.length).toBeGreaterThan(0)
      expect(cold.filter((id) => tracked_.has(id))).toEqual([])
    } finally {
      pool.dispose()
    }
  })

  it('a cold heartbeat builds no reaction and moves no row', () => {
    const { replay, pool } = boot()
    try {
      const orderBefore = tracked(() => [...pool.worklist.order])
      const coldSessions = pool.residency?.ids('session') ?? []
      expect(coldSessions.length).toBeGreaterThan(0)
      const target = replay.source
        .snapshot('session')
        .find((record) => coldSessions.includes(record.id) && record.value !== undefined)
      expect(target, 'a cold session with a value').toBeDefined()
      const value = target!.value as unknown as Record<string, unknown>
      const agentState = (value['agentState'] ?? {}) as Record<string, unknown>
      const phase = agentState['phase']
      // working <-> compacting: the same attention verdict either way, so no
      // visibility input moves; the row still routes through ingest.
      const next = phase === 'working' ? 'compacting' : 'working'
      pool.apply({
        type: 'update',
        rows: [
          {
            kind: 'session',
            id: target!.id,
            value: { ...value, agentState: { ...agentState, phase: next } } as never,
          },
        ],
      })
      expect(tracked(() => [...pool.worklist.order])).toEqual(orderBefore)
    } finally {
      pool.dispose()
    }
  })
})
