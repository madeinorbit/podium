// @vitest-environment happy-dom
/**
 * POD-4447 — MobX arm UI tests: the windowed list mounts rows in RowShells,
 * a data change commits exactly the affected chain, a depth-3 change
 * invalidates exactly its ancestors, the heartbeat commits nothing, and a UI
 * selection click commits exactly two rows with zero derivations.
 *
 * Counts are asserted mounted: unobserved computeds suspend, so only an
 * observed graph produces the invalidation counts the budgets constrain.
 */

import { describe, expect, it } from 'vitest'
import { act } from 'react'
import { createReplaySource, mountArmForCounts, runCountScenario } from '../../harness/src/count-harness'
import type { SliceLocals } from '../../shared/src/slice-types'
import { mobxArm } from './arm'
import { issue, LANE, NOW, rec, session, waitingOffer, waitingState, workingState } from './mobx.test'
import type { MobXStore } from './store'
import { fixedLocals } from '../../shared/src/locals-source'

function mountExample() {
  const replay = createReplaySource({
    issues: [
      rec('issue', 'A', issue({ id: 'A', seq: 10, sortKey: 'a0', worktreePath: '/wt' })),
      rec('issue', 'B', issue({ id: 'B', seq: 9, sortKey: 'b0', parentId: 'A', stage: 'review' })),
    ],
    sessions: [
      rec('session', 's1', session({ sessionId: 's1', issueId: 'A', agentState: workingState })),
      rec(
        'session',
        's2',
        session({ sessionId: 's2', issueId: 'B', agentState: waitingState, offer: waitingOffer }),
      ),
    ],
    worktrees: [rec('worktree', '/wt', LANE)],
  })
  const locals: SliceLocals = { selectedIssueId: null, coarseNow: NOW }
  const mounted = mountArmForCounts(mobxArm, replay.source, fixedLocals(locals))
  const store = (mounted.handle as unknown as { store: MobXStore }).store
  return { replay, mounted, store }
}

describe('mobx arm UI', () => {
  it('mounts windowed rows; phase change commits the chain only', async () => {
    const { replay, mounted, store } = mountExample()
    try {
      expect(document.querySelectorAll('[data-issue-row]').length).toBe(2)
      const beforeB = mounted.handle.snapshot().rowsById['B']
      const result = await runCountScenario(mounted, {
        scenario: 'phaseChange',
        methodology: '#2',
        apply: () => {
          replay.push({
            type: 'update',
            rows: [
              rec(
                'session',
                's2',
                session({
                  sessionId: 's2',
                  issueId: 'B',
                  agentState: { phase: 'working', since: new Date(NOW).toISOString() },
                  lastActiveAt: new Date(NOW).toISOString(),
                }),
              ),
            ],
          })
        },
        expected: () => mounted.handle.snapshot(),
      })
      expect(result.parity).toBe(true)
      expect(result.rowsCommitted).toBe(2)
      expect(result.commitsByRow).toEqual({ A: 1, B: 1 })
      // B: flat + summary + aggregate re-ran (own session moved); A: only
      // the aggregate re-ran (B's rollup feeds it). A's flat/summary read
      // A's own sessions only and never invalidated.
      expect(result.stats.rowsDerived).toBe(2)
      expect(result.stats.rollupsDerived).toBe(4)
      expect(result.stats.indexUpdates).toBe(0)
      expect(mounted.handle.snapshot().rowsById['B']).not.toBe(beforeB)
      expect(store.worklist.order.length).toBe(2)
    } finally {
      mounted.unmount()
    }
  })

  it('change at depth 3 invalidates exactly the ancestor chain, no siblings', async () => {
    const replay = createReplaySource({
      issues: [
        rec('issue', 'R', issue({ id: 'R', seq: 4 })),
        rec('issue', 'P', issue({ id: 'P', seq: 3, parentId: 'R' })),
        rec('issue', 'C', issue({ id: 'C', seq: 2, parentId: 'P' })),
        rec('issue', 'L', issue({ id: 'L', seq: 1, parentId: 'C' })),
        rec('issue', 'S', issue({ id: 'S', seq: 5, parentId: 'R' })),
      ],
      sessions: [
        rec('session', 'sl', session({ sessionId: 'sl', issueId: 'L', agentState: workingState })),
        rec('session', 'ss', session({ sessionId: 'ss', issueId: 'S', agentState: workingState })),
      ],
      worktrees: [rec('worktree', '/wt', LANE)],
    })
    const locals: SliceLocals = { selectedIssueId: null, coarseNow: NOW }
    const mounted = mountArmForCounts(mobxArm, replay.source, fixedLocals(locals))
    try {
      expect(Object.keys(mounted.handle.snapshot().rowsById).sort()).toEqual(['C', 'L', 'P', 'R', 'S'])
      const beforeS = mounted.handle.snapshot().rowsById['S']
      const result = await runCountScenario(mounted, {
        scenario: 'depth3',
        methodology: '#2chain',
        apply: () => {
          replay.push({
            type: 'update',
            rows: [
              rec(
                'session',
                'sl',
                session({ sessionId: 'sl', issueId: 'L', agentState: waitingState, offer: waitingOffer, lastActiveAt: new Date(NOW).toISOString() }),
              ),
            ],
          })
        },
        expected: () => mounted.handle.snapshot(),
      })
      expect(result.parity).toBe(true)
      expect(mounted.handle.snapshot().rowsById['R']?.phase).toBe('waiting')
      expect(result.rowsCommitted).toBe(4)
      expect(result.commitsByRow).toEqual({ C: 1, L: 1, P: 1, R: 1 })
      expect(result.stats.rowsDerived).toBe(4)
      // L: flat + summary + aggregate; C/P/R: aggregate only. S: nothing —
      // its row object is identical before and after.
      expect(result.stats.rollupsDerived).toBe(6)
      expect(mounted.handle.snapshot().rowsById['S']).toBe(beforeS)
    } finally {
      mounted.unmount()
    }
  })

  it('heartbeat on an invisible session commits nothing and derives nothing', async () => {
    const replay = createReplaySource({
      issues: [
        rec('issue', 'A', issue({ id: 'A', seq: 10, worktreePath: '/wt' })),
        rec('issue', 'D', issue({ id: 'D', seq: 7, archived: true })),
      ],
      sessions: [
        rec('session', 's1', session({ sessionId: 's1', issueId: 'A', agentState: workingState })),
        rec('session', 'sd', session({ sessionId: 'sd', issueId: 'D', agentState: workingState })),
      ],
      worktrees: [rec('worktree', '/wt', LANE)],
    })
    const locals: SliceLocals = { selectedIssueId: null, coarseNow: NOW }
    const mounted = mountArmForCounts(mobxArm, replay.source, fixedLocals(locals))
    try {
      const result = await runCountScenario(mounted, {
        scenario: 'heartbeat',
        methodology: '#1',
        apply: () => {
          replay.push({
            type: 'update',
            rows: [
              rec(
                'session',
                'sd',
                session({ sessionId: 'sd', issueId: 'D', agentState: workingState, lastActiveAt: new Date(NOW).toISOString() }),
              ),
            ],
          })
        },
        expected: () => mounted.handle.snapshot(),
      })
      expect(result.parity).toBe(true)
      expect(result.rowsCommitted).toBe(0)
      expect(result.stats.rowsDerived).toBe(0)
      expect(result.stats.rollupsDerived).toBe(0)
      expect(result.stats.indexUpdates).toBe(0)
      expect(result.stats.notifications).toBe(1)
    } finally {
      mounted.unmount()
    }
  })

  it('UI selection click commits exactly two rows, zero derivations', async () => {
    const { mounted, store } = mountExample()
    try {
      await act(async () => {
        store.setSelection('A')
      })
      mounted.handle.stats.reset()
      mounted.log.reset()
      const result = await runCountScenario(mounted, {
        scenario: 'selectionClick',
        methodology: '#3',
        apply: () => {
          act(() => {
            store.setSelection('B')
          })
        },
        expected: () => mounted.handle.snapshot(),
      })
      expect(result.rowsCommitted).toBe(2)
      expect(result.commitsByRow).toEqual({ A: 1, B: 1 })
      expect(result.stats.rowsDerived).toBe(0)
      expect(result.stats.rollupsDerived).toBe(0)
    } finally {
      mounted.unmount()
    }
  })
})
