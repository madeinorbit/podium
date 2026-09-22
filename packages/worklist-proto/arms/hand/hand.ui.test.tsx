// @vitest-environment happy-dom
/**
 * POD-4446 — hand-rolled arm UI tests: the windowed list mounts rows in
 * RowShells, a data change commits exactly the affected rows, and a UI
 * selection click commits exactly two rows with zero derivations.
 */

import { describe, expect, it } from 'vitest'
import { act } from 'react'
import { createReplaySource, mountArmForCounts, runCountScenario } from '../../harness/src/count-harness'
import type { SliceLocals } from '../../shared/src/slice-types'
import { handArm } from './arm'
import { issue, LANE, NOW, rec, session, waitingOffer, waitingState, workingState } from './hand.test'
import { rebuildFromScratch } from './rebuild'
import type { HandStore } from './store'
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
  const mounted = mountArmForCounts(handArm, replay.source, fixedLocals(locals))
  const store = (mounted.handle as unknown as { store: HandStore }).store
  return { replay, mounted, store }
}

describe('hand-rolled arm UI', () => {
  it('mounts windowed rows; phase change commits the chain only', async () => {
    const { replay, mounted, store } = mountExample()
    try {
      expect(document.querySelectorAll('[data-issue-row]').length).toBe(2)
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
        expected: () => {
          const rebuilt = rebuildFromScratch({
            issues: store.issues,
            sessions: store.sessions,
            worktrees: store.worktrees,
            selection: { selectedIssueId: null, selectedIssueWasFolded: false },
            now: NOW,
          })
          return rebuilt.snapshot
        },
      })
      expect(result.parity).toBe(true)
      expect(result.rowsCommitted).toBe(2)
      expect(result.commitsByRow).toEqual({ A: 1, B: 1 })
      expect(result.stats.rowsDerived).toBe(2)
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
