/**
 * POD-4705 — the lazy-visibility plant: IssueNodes are built only for issues
 * a derivation can read (visible rows, their visibility dependencies, and
 * anything touched since), never for every known issue. Boots the lazy pool
 * at 1x over the replay feed and counts from outside (the pool's own
 * counters and held ids, as the first-paint test does — nothing asks the
 * pool what it *should* have built).
 *
 * - bootstrap builds fewer nodes than known issues (eager construction,
 *   today's code before this issue, holds one node per known issue and fails
 *   the strict bound), while every visible row holds one;
 * - cold rows outside the closure hold no node (at least one exists);
 * - a cold session's heartbeat builds no node and moves no row.
 */

import { describe, expect, it } from 'vitest'
import { createReplaySource } from '../../../../harness/src/count-harness'
import { buildCorpus } from '../../../../harness/src/fixture/index'
import { DISABLED_READ_FENCE } from '../../../../shared/src/instrument/reads'
import { settableLocals } from '../../../../shared/src/locals-source'
import type { RowRecord } from '../../../../shared/src/stats'
import { mobxPoolArm } from '../arm'
import { installMobxWarnTrap } from '../mobx-trap'
import { tracked } from '../pool'

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
  const handle = mobxPoolArm.create(replay.source, locals.source, DISABLED_READ_FENCE, {
    schedule: () => () => {},
  })
  return { corpus, replay, handle, pool: handle.pool }
}

describe('lazy visibility nodes (POD-4705)', () => {
  it('builds nodes for the visible closure, not the corpus', () => {
    const { pool } = boot()
    try {
      const held = new Set(pool.worklist.heldIds())
      const known =
        tracked(() => pool.tables.issue.size) + (pool.residency?.size('issue') ?? 0)
      const order = tracked(() => [...pool.worklist.order])
      // Eager construction fails this: one node per known issue.
      expect(pool.stats.counters.issueNodes).toBeLessThan(known)
      expect(held.size).toBeLessThan(known)
      // Every visible row holds its node.
      expect(order.length).toBeGreaterThan(0)
      for (const id of order) expect(held.has(id), `visible ${id} has no node`).toBe(true)
      // Some cold row holds no node.
      const cold = pool.residency?.ids('issue') ?? []
      expect(cold.length).toBeGreaterThan(0)
      expect(cold.filter((id) => !held.has(id)).length).toBeGreaterThan(0)
    } finally {
      pool.dispose()
    }
  })

  it('a cold heartbeat builds no node and moves no row', () => {
    const { replay, pool } = boot()
    try {
      const before = pool.stats.counters.issueNodes
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
      expect(pool.stats.counters.issueNodes).toBe(before)
      expect(tracked(() => [...pool.worklist.order])).toEqual(orderBefore)
    } finally {
      pool.dispose()
    }
  })
})
