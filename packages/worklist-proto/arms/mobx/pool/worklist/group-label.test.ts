/**
 * POD-4757 (H1) — a group's label is read from its head member, tracked.
 *
 * The label is the first member's path tail (`folds.ts:200-203`). A change
 * that moves the head's label but not its place (its `repoPath`, with the
 * group keyed by `repoId`) files the row into the same lanes at the same
 * places, so no lane moves: only a tracked read of the member's placement
 * can carry the new label to the header. A label read from something the
 * filing keeps aside (untracked, and not toggled by a move) stays stale, and
 * this test fails.
 */

import { reaction } from 'mobx'
import { describe, expect, it } from 'vitest'
import { createReplaySource } from '../../../../harness/src/count-harness'
import { buildCorpus } from '../../../../harness/src/fixture/index'
import { DISABLED_READ_FENCE } from '../../../../shared/src/instrument/reads'
import { settableLocals } from '../../../../shared/src/locals-source'
import type { SliceIssue } from '../../../../shared/src/slice-types'
import type { RowRecord } from '../../../../shared/src/stats'
import { harnessMobxPoolArm, tracked, visibleOrderOf } from '../../../../harness/src/adapters/mobx-pool'
import { installMobxWarnTrap } from '../../../../harness/src/mobx-trap'

installMobxWarnTrap()

describe('group label (POD-4757 H1)', () => {
  it("follows the head member's label when no row moves", () => {
    const corpus = buildCorpus(1)
    const replay = createReplaySource({
      issues: corpus.sliceIssues.map((value): RowRecord => ({ kind: 'issue', id: value.id, value })),
      sessions: corpus.sliceSessions.map(
        (value): RowRecord => ({ kind: 'session', id: value.sessionId, value }),
      ),
      worktrees: corpus.sliceWorktrees.map(
        (value): RowRecord => ({ kind: 'worktree', id: value.path, value }),
      ),
    })
    const locals = settableLocals({ selectedIssueId: null, coarseNow: corpus.fixedNow })
    const handle = harnessMobxPoolArm.create(replay.source, locals.source, DISABLED_READ_FENCE, {
      schedule: () => () => {},
    })
    const { pool } = handle
    try {
      // A group keyed by its repo id, and its head (the rank-first member).
      const found = tracked(() => {
        for (const key of pool.groups.keys) {
          const group = pool.groups.group(key)
          const head = [...group.rowIds, ...group.closedIds].find(
            (id) => pool.knownIssue(id)?.rank === group.headRank,
          )
          const row = corpus.sliceIssues.find((issue) => issue.id === head)
          if (row?.repoId != null && row.repoId === key) return { key, head: row }
        }
        return null
      })
      expect(found, 'a group keyed by repo id').not.toBeNull()
      const { key, head } = found!
      const group = pool.groups.group(key)
      const labels: string[] = []
      const stop = reaction(
        () => group.label,
        (label) => labels.push(label),
        { fireImmediately: true },
      )
      const orderBefore = visibleOrderOf(pool)
      const lanesBefore = tracked(() => [[...group.rowIds], [...group.closedIds]])
      try {
        const moved: SliceIssue = { ...head, repoPath: '/elsewhere/renamed-checkout' }
        replay.push({ type: 'update', rows: [{ kind: 'issue', id: head.id, value: moved }] })
        // Nothing moved: same key, same order, same lanes, no lane touched.
        expect(tracked(() => pool.groups.keys.includes(key))).toBe(true)
        expect(visibleOrderOf(pool)).toEqual(orderBefore)
        expect(tracked(() => [[...group.rowIds], [...group.closedIds]])).toEqual(lanesBefore)
        // The header follows its head.
        expect(labels.at(-1)).toBe('renamed-checkout')
        expect(tracked(() => group.label)).toBe('renamed-checkout')
        expect(tracked(() => pool.groups.layout.groups.find((g) => g.key === key)?.label)).toBe(
          'renamed-checkout',
        )
      } finally {
        stop()
      }
    } finally {
      handle.dispose()
      locals.dispose()
    }
  })
})
