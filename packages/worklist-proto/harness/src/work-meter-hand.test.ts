/**
 * POD-4934 — the outside work counter (`work-meter.ts`) sees the hand-rolled
 * pool's cells.
 *
 * A change to one row re-runs derivations (counted from OUTSIDE the hand arm
 * by patching `CellGraph.run`, as the MobX patch does — nothing in
 * `arms/hand` counts itself), and a hand derivation that walks the whole
 * issue table on every change blows the bound: the change's distinct elements
 * stay below the resident issue count, a full walk reaches it.
 *
 * PLANT (proven red, restored with cp): in `IssueCells.view`'s compute
 * (`arms/hand/pool/pool.ts`), walk the whole issue table
 * (`for (const key of pool.tables.issue.keys()) void key`) — the rename's
 * elements reach the table size and the bound below fails.
 */

import { describe, expect, it } from 'vitest'
import { handPoolArm } from '../../arms/hand/pool/arm'
import type { SliceIssue } from '@podium/client-graph/shared/slice-types'
import type { RowRecord } from '../../shared/src/stats'
import { createReplaySource } from './count-harness'
import { buildCorpus } from './fixture/index'
import { insideArm, measureWork } from './work-meter'
import { settableLocals } from '@podium/client-graph/shared/locals-source'

describe('hand derivations (POD-4934)', () => {
  it('counts a change’s cell re-runs, and a whole-table walk in a cell blows the bound', async () => {
    const corpus = buildCorpus(1)
    const replay = createReplaySource({
      issues: corpus.sliceIssues.map((value) => ({ kind: 'issue', id: value.id, value })),
      sessions: corpus.sliceSessions.map((value) => ({
        kind: 'session',
        id: value.sessionId,
        value,
      })),
      worktrees: corpus.sliceWorktrees.map((value) => ({
        kind: 'worktree',
        id: value.path,
        value,
      })),
    })
    const locals = settableLocals({ selectedIssueId: null, coarseNow: corpus.fixedNow })
    // The load window never closes: what is counted is the change, before loads.
    const handle = handPoolArm.create(replay.source, locals.source, undefined, {
      schedule: () => () => {},
    })
    try {
      // First paint: every visible row's view, so the change re-runs cells.
      for (const id of handle.pool.order()) handle.pool.view(id)
      const target = handle.pool.order()[0]
      if (target === undefined) throw new Error('[hand] the pool lists no row')
      const current = replay.source
        .snapshot('issue')
        .find((row) => row.id === target)?.value as SliceIssue | undefined
      if (current === undefined) throw new Error(`[hand] ${target} is not in the feed`)
      const renamed: RowRecord = {
        kind: 'issue',
        id: target,
        value: { ...current, title: `${current.title} (pod-4934)` },
      }
      const tableSize = handle.pool.tables.issue.size
      expect(tableSize, 'the pool holds a table to walk').toBeGreaterThan(100)
      const { work } = await measureWork(async () => {
        insideArm(() => handle.pool.apply({ type: 'update', rows: [renamed] }))
      })
      // Not vacuous: without the hand patch every change counts 0 derivations.
      expect(work.derivations).toBeGreaterThan(0)
      // A change touches its row's family, never the whole table: a hand
      // derivation walking every issue on every change reaches `tableSize`.
      expect(work.elements).toBeLessThan(tableSize)
    } finally {
      handle.dispose()
    }
  }, 300_000)
})
