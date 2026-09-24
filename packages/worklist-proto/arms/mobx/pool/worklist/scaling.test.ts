// @vitest-environment happy-dom
/**
 * POD-4686 — each change's work follows the change, at 1x and 4x, counted
 * from outside the pool.
 *
 * - STAGE MOVE files one id between two lanes (`counters.groupRuns` 1, and
 *   `counters.groupElements` exactly its group's lanes after the move), with
 *   no order re-sort and no membership flip. The plant runs the old whole-list
 *   layout (`layoutOf` over the visible order) and touches the visible count,
 *   failing the same bound.
 * - CLICK (selection plus the app's mark-read of an unread keep row)
 *   re-validates zero per-node maintenance reactions
 *   (`pool.visible.<id>` / `pool.nested.<id>` / `pool.children.<id>`,
 *   counted by patching `Reaction.runReaction_` from the test): the cursor
 *   moves through the read-state lane, so only the clicked row's `unread`
 *   re-runs — and it is unobserved here, scheduling nothing. The plant
 *   replaces the row's slot the old way and schedules at least the row's own
 *   three reactions, failing the same bound.
 *
 * Direct pool, no React and no engine: the harness's fence steps already hold
 * commits, reads and parity per scenario (`groups.test.tsx`,
 * `counts.test.tsx`); this file holds the SCALING of the pool's own work.
 */

import { Reaction, runInAction } from 'mobx'
import { describe, expect, it } from 'vitest'
import { createReplaySource, type ReplaySource } from '../../../../harness/src/count-harness'
import { buildCorpus } from '../../../../harness/src/fixture/index'
import type { RowSource } from '../../../../shared/src/arm'
import { createReadFence } from '../../../../shared/src/instrument/reads'
import { settableLocals, type SettableLocalsHandle } from '../../../../shared/src/locals-source'
import type { SliceIssue } from '../../../../shared/src/slice-types'
import type { RowRecord } from '../../../../shared/src/stats'
import { type MobxPoolHandle, mobxPoolArm } from '../arm'
import type { MobxPool } from '../pool'
import { tracked } from '../pool'
import { layoutOf } from './groups'

interface Rig {
  replay: ReplaySource
  locals: SettableLocalsHandle
  handle: MobxPoolHandle
  push(event: { type: 'update'; rows: RowRecord[] }): void
  dispose(): void
}

function rig(scale: 1 | 4): Rig {
  const corpus = buildCorpus(scale)
  const replay = createReplaySource({
    issues: corpus.sliceIssues.map((value) => ({ kind: 'issue', id: value.id, value })),
    sessions: corpus.sliceSessions.map((value) => ({
      kind: 'session',
      id: value.sessionId,
      value,
    })),
    worktrees: corpus.sliceWorktrees.map((value) => ({ kind: 'worktree', id: value.path, value })),
  })
  const locals = settableLocals({ selectedIssueId: null, coarseNow: corpus.fixedNow })
  const counted: RowSource = {
    snapshot: (kind) => replay.source.snapshot(kind),
    row: (kind, id) => replay.source.row?.(kind, id),
    subscribe: (listener) => replay.source.subscribe(listener),
  }
  const reads = createReadFence({ enabled: true })
  const handle = mobxPoolArm.create(reads.wrapSource(counted), locals.source, reads, {
    schedule: () => () => {},
  }) as MobxPoolHandle
  return {
    replay,
    locals,
    handle,
    push: (event) => replay.push(event),
    dispose: () => {
      handle.dispose()
      locals.dispose()
    },
  }
}

function corpusIssue(r: Rig, id: string): SliceIssue {
  const row = r.replay.source
    .snapshot('issue')
    .find((record) => record.id === id)?.value as SliceIssue | undefined
  if (row === undefined) throw new Error(`no corpus issue ${id}`)
  return row
}

/** A childless, unpinned open human root in the visible order (the stage-move rule). */
function stageTarget(pool: MobxPool): string {
  const order = tracked(() => [...pool.worklist.order])
  const id = order.find((candidate) => {
    const node = pool.worklist.issue(candidate)
    const standing = node?.standing
    return (
      standing !== undefined &&
      standing.activeHuman &&
      !standing.pinned &&
      standing.parentId === null &&
      node.childIds.length === 0
    )
  })
  if (id === undefined) throw new Error('no childless open root in the visible order')
  return id
}

/** An unread open-human root (a keep row: its `flat` never reads the cursor). */
function clickTarget(pool: MobxPool): string {
  const order = tracked(() => [...pool.worklist.order])
  const id = order.find((candidate) => {
    const node = pool.worklist.issue(candidate)
    return (
      node?.standing?.activeHuman === true &&
      node.standing.parentId === null &&
      node.unread === true
    )
  })
  if (id === undefined) throw new Error('no unread open-human root in the visible order')
  return id
}

/** Maintenance reactions (`pool.visible/nested/children.<id>`) run while `run` runs. */
function countReactions(run: () => void): Map<string, number> {
  const proto = Reaction.prototype as unknown as { runReaction_: () => void }
  const original = proto.runReaction_
  const runs = new Map<string, number>()
  proto.runReaction_ = function (this: { name_: string }) {
    runs.set(this.name_, (runs.get(this.name_) ?? 0) + 1)
    return original.call(this)
  }
  try {
    run()
  } finally {
    proto.runReaction_ = original
  }
  return runs
}

function maintenanceOf(runs: Map<string, number>): [string, number][] {
  return [...runs].filter(
    ([name]) =>
      name.startsWith('pool.visible.') ||
      name.startsWith('pool.nested.') ||
      name.startsWith('pool.children.'),
  )
}

describe('scaling: the work follows the change (POD-4686)', () => {
  for (const scale of [1, 4] as const) {
    it(`stage move files one id at ${scale}x`, () => {
      const r = rig(scale)
      try {
        const { pool } = r.handle
        const visible = tracked(() => pool.worklist.order.length)
        const target = stageTarget(pool)
        const base = corpusIssue(r, target)
        const now = new Date(base.updatedAt).toISOString()
        pool.stats.reset()
        r.push({
          type: 'update',
          rows: [
            {
              kind: 'issue',
              id: target,
              value: {
                ...base,
                stage: 'done',
                closedAt: now,
                closedReason: 'done',
                tuckedAt: now,
              },
            },
          ],
        })
        const { groupRuns, groupElements, orderSorts, membershipFlips } = pool.stats.counters
        // Exactly one filing, no re-sort, no membership change.
        expect(groupRuns, 'filings').toBe(1)
        expect(orderSorts, 'order re-sorts').toBe(0)
        expect(membershipFlips, 'membership flips').toBe(0)
        // The filing re-sorts exactly its own group's lanes.
        const lane = tracked(() => {
          for (const key of pool.groups.keys) {
            const group = pool.groups.group(key)
            if (group.closedIds.includes(target)) {
              return { open: group.rowIds.length, closed: group.closedIds.length }
            }
          }
          return null
        })
        expect(lane, 'the moved row is in a closed fold').not.toBeNull()
        expect(groupElements, 'lane members re-sorted').toBe(lane!.open + lane!.closed)
        // The plant touches the whole visible order, failing the same count.
        const placed = tracked(() => {
          let touched = 0
          layoutOf(tracked(() => [...pool.worklist.order]), (id) => {
            touched += 1
            return pool.worklist.issue(id)?.placement
          })
          return touched
        })
        expect(placed, 'whole-list layout elements').toBe(visible)
        expect(
          visible > lane!.open + lane!.closed,
          'the corpus holds more than one group',
        ).toBe(true)
      } finally {
        r.dispose()
      }
    }, 600_000)

    it(`click re-validates no maintenance reaction at ${scale}x`, () => {
      const r = rig(scale)
      try {
        const { pool } = r.handle
        const target = clickTarget(pool)
        expect(tracked(() => pool.worklist.issue(target)?.unread)).toBe(true)
        pool.stats.reset()
        const runs = countReactions(() => {
          r.locals.set({ selectedIssueId: target })
          r.locals.flush()
          // Past every seat's stamp, so the row reads as read: sessions only
          // ever stamped 2026 and earlier on this corpus.
          const readAt = '2027-06-01T00:00:00.000Z'
          r.push({
            type: 'update',
            rows: [{ kind: 'issue', id: target, value: { ...corpusIssue(r, target), readAt } }],
          })
        })
        const maintenance = maintenanceOf(runs)
        expect(maintenance, 're-validated maintenance reactions').toEqual([])
        // The cursor still works: the row reads as read, stays visible, files nothing.
        expect(tracked(() => pool.worklist.issue(target)?.unread)).toBe(false)
        expect(tracked(() => pool.worklist.issue(target)?.visible)).toBe(true)
        expect(pool.stats.counters.groupRuns, 'filings').toBe(0)
        expect(pool.stats.counters.membershipFlips, 'membership flips').toBe(0)
        // The plant replaces the row's slot the old way: at least the row's
        // own three reactions re-validate, failing the same count.
        const planted = countReactions(() => {
          const row = pool.tables.issue.get(target) as SliceIssue
          const reread = new Date(Date.parse(row.updatedAt) + 1).toISOString()
          runInAction(() => {
            pool.tables.issue.set(target, { ...row, readAt: reread })
            pool.readStates.set(target, reread)
          })
        })
        expect(maintenanceOf(planted).length, 'plant re-validations').toBeGreaterThanOrEqual(3)
      } finally {
        r.dispose()
      }
    }, 600_000)
  }
})
