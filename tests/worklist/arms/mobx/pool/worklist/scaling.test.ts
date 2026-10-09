import { worklistGroups } from '@podium/client-graph/worklist/groups'
// @vitest-environment happy-dom
/**
 * POD-4686, POD-4757 — each change's work follows the change, at 1x and 4x,
 * counted from outside the pool.
 *
 * The lists the worklist shows (the visible order, the pinned section, each
 * group's members, open lane and closed fold) are kept in order by moving
 * the changed row alone (`sorted-lanes.ts`). What is counted:
 *
 * - LANE SPLICES: calls into the splice of the pool's observable arrays
 *   (`pool.visible.*`, `pool.groups.*`), patched on MobX's array
 *   administration from here. A moved row is two splices per list it moves
 *   in (out, in), one per list it enters or leaves, so a change's splices
 *   are a small constant at every scale. A re-sort or a rebuild of a lane
 *   writes the lane whole instead (a `replace`, or one splice per member).
 * - SORTED ELEMENTS: the lengths of every array `Array.prototype.sort` is
 *   called on while the change runs. The only sort a change may run is the
 *   group keys' (one head per group, and the groups are the same at every
 *   scale), plus the changed row's own family lists.
 * - REACTION RUNS (`Reaction.runReaction_`, patched): the filing reactions
 *   (`pool.file.<id>`) and page-like observers over the groups (the keys,
 *   the pinned ids, the latch, and every group's lanes, read whole as the
 *   list reads them).
 *
 * - STAGE MOVE of a seatless open root in the largest group: one filing, no
 *   membership change, at most six splices (out of the open lane, into the
 *   fold, and a move in its group's members and in the visible order); only
 *   its own group's observers run. A re-sort of its group instead of the
 *   one-row move sorts the group whole and fails the sort bound (521 at 1x,
 *   2,006 at 4x, POD-4757).
 * - ARCHIVE: one filing, one membership flip, exactly three splices (out of
 *   the order, the members and the open lane); only the emptied row's group
 *   runs.
 * - CLICK (selection plus the app's mark-read of an unread keep row):
 *   re-validates no filing reaction; the latch runs once and the lanes that
 *   read it are scheduled once each, sorting nothing. The plant replaces the
 *   row's slot the old way (the read-state lane lifted) and re-validates the
 *   row's filing reaction.
 *
 * Direct pool, no React and no engine: the harness's work-per-change check
 * (`work-per-change.test.tsx`) holds every scenario's work to its
 * neighbourhood; this file names the pool's own steps.
 */

import { $mobx, observable, Reaction, reaction } from 'mobx'
import { describe, expect, it } from 'vitest'
import { createReplaySource, type ReplaySource } from '../../../../harness/src/count-harness'
import { buildCorpus } from '../../../../harness/src/fixture/index'
import { writeResult } from '../../../../harness/src/results'
import type { RowSource } from '../../../../shared/src/arm'
import { createReadFence } from '../../../../shared/src/instrument/reads'
import { type SettableLocalsHandle, settableLocals } from '@podium/client-graph/shared/locals-source'
import type { SliceIssue } from '@podium/client-graph/shared/slice-types'
import type { RowRecord } from '../../../../shared/src/stats'
import { harnessMobxPoolArm, tracked, visibleOrderOf, type HarnessMobxPoolHandle } from '../../../../harness/src/adapters/mobx-pool'
import type { MobxPool } from '@podium/client-graph/pool'

interface Rig {
  replay: ReplaySource
  locals: SettableLocalsHandle
  handle: HarnessMobxPoolHandle
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
  const handle = harnessMobxPoolArm.create(reads.wrapSource(counted), locals.source, reads, {
    schedule: () => () => {},
  }) as HarnessMobxPoolHandle
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
  const row = r.replay.source.snapshot('issue').find((record) => record.id === id)?.value as
    | SliceIssue
    | undefined
  if (row === undefined) throw new Error(`no corpus issue ${id}`)
  return row
}

/** The group key whose lanes hold `id`, or null (tracked reads: call inside `tracked`). */
function groupOf(pool: MobxPool, id: string): string | null {
  for (const key of worklistGroups(pool).keys) {
    const group = worklistGroups(pool).group(key)
    if (group.rowIds.includes(id) || group.closedIds.includes(id)) return key
  }
  return null
}

/**
 * A childless, seatless, unpinned open human root (the stage-move rule: done
 * takes it to the fold), in the LARGEST group that has one: a walk of the
 * moved row's group (a re-sort instead of the one-row move) then shows at
 * every scale.
 */
function stageTarget(pool: MobxPool): string {
  return tracked(() => {
    let best: { id: string; size: number } | null = null
    for (const id of visibleOrderOf(pool)) {
      const node = pool.knownIssue(id)
      const standing = node?.standing
      if (
        standing === undefined ||
        !standing.activeHuman ||
        standing.pinned ||
        standing.parentId !== null ||
        node?.childIds.length !== 0 ||
        node.memberIds.length !== 0
      ) {
        continue
      }
      const key = groupOf(pool, id)
      if (key === null) continue
      const group = worklistGroups(pool).group(key)
      const size = group.rowIds.length + group.closedIds.length
      if (best === null || size > best.size) best = { id, size }
    }
    if (best === null) throw new Error('no childless seatless open root in the visible order')
    return best.id
  })
}

/** An unread open-human root (a keep row: its `flat` never reads the cursor). */
function clickTarget(pool: MobxPool): string {
  return tracked(() => {
    const id = [...visibleOrderOf(pool)].find((candidate) => {
      const node = pool.knownIssue(candidate)
      if (node?.standing === undefined) return false
      return (
        node.standing.activeHuman === true &&
        node.standing.parentId === null &&
        pool.issueObject(candidate).unread === true
      )
    })
    if (id === undefined) throw new Error('no unread open-human root in the visible order')
    return id
  })
}

/** Reaction executions by name while `run` runs (a scheduled re-validation counts). */
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

/** The filing reactions (`pool.file.<id>`) among `runs`. */
function filingsOf(runs: Map<string, number>): [string, number][] {
  return [...runs].filter(([name]) => name.startsWith('pool.file.'))
}

/** Splices into the pool's observable lists (`pool.*` arrays) while `run` runs. */
function countLaneSplices(run: () => void): number {
  const probe = observable.array<string>([])
  const proto = Object.getPrototypeOf(
    (probe as unknown as Record<symbol, object>)[$mobx],
  ) as { spliceWithArray_: (this: { atom_: { name_: string } }, ...args: unknown[]) => unknown }
  const original = proto.spliceWithArray_
  let splices = 0
  proto.spliceWithArray_ = function (this: { atom_: { name_: string } }, ...args: unknown[]) {
    if (this.atom_.name_.startsWith('pool.')) splices += 1
    return original.apply(this, args)
  }
  try {
    run()
  } finally {
    proto.spliceWithArray_ = original
  }
  return splices
}

/** Elements of every array sorted while `run` runs. */
function countSorted(run: () => void): number {
  const original = Array.prototype.sort
  let sorted = 0
  Array.prototype.sort = function <T>(this: T[], compare?: (a: T, b: T) => number): T[] {
    sorted += this.length
    return original.call(this, compare) as T[]
  }
  try {
    run()
  } finally {
    Array.prototype.sort = original
  }
  return sorted
}

/** Group lanes the page reads, each read whole (as the list reads it). */
const LANES = ['label', 'headRank', 'rowIds', 'closedIds', 'baseRowIds', 'baseClosedIds'] as const

/**
 * Page-like observers over the groups (`PoolList` reads `keys` and
 * `pinnedIds`, each header and lane its own). A lane is read whole, so its
 * observer re-runs when the list's content moves.
 */
function observeGroups(pool: MobxPool): { stop(): void } {
  const stops: (() => void)[] = []
  const whole = (value: unknown): unknown => (Array.isArray(value) ? [...value] : value)
  const watch = (name: string, fn: () => unknown): void => {
    stops.push(reaction(() => whole(fn()), () => {}, { name: `audit.${name}` }))
  }
  watch('keys', () => worklistGroups(pool).keys)
  watch('pinnedIds', () => worklistGroups(pool).pinnedIds)
  watch('latchedOpenId', () => worklistGroups(pool).latchedOpenId)
  for (const key of tracked(() => worklistGroups(pool).keys)) {
    const group = worklistGroups(pool).group(key)
    for (const lane of LANES) watch(`${lane}:${key}`, () => group[lane])
  }
  return {
    stop: () => {
      for (const stop of stops) stop()
    },
  }
}

/** Executions of the `audit.*` observers, with the prefix stripped. */
function auditOf(runs: Map<string, number>): Map<string, number> {
  const out = new Map<string, number>()
  for (const [name, count] of runs) {
    if (name.startsWith('audit.')) out.set(name.slice('audit.'.length), count)
  }
  return out
}

/** Every group observer ran at most once for `key`'s group, and never for another group. */
function expectOnlyGroup(evals: Map<string, number>, key: string): void {
  for (const [name, count] of evals) {
    if (name === 'keys' || name === 'pinnedIds' || name === 'latchedOpenId') continue
    if (name.endsWith(`:${key}`)) expect(count, `${name} executions (moved group)`).toBeLessThanOrEqual(1)
    else expect(count, `${name} executions (other group)`).toBe(0)
  }
}

describe('scaling: the work follows the change (POD-4686, POD-4757)', () => {
  for (const scale of [1, 4] as const) {
    it(`stage move moves one row at ${scale}x`, () => {
      const r = rig(scale)
      let audit: { stop(): void } | undefined
      try {
        const { pool } = r.handle
        const visible = tracked(() => visibleOrderOf(pool).length)
        const target = stageTarget(pool)
        const key = tracked(() => groupOf(pool, target)) as string
        const base = corpusIssue(r, target)
        const now = new Date(base.updatedAt).toISOString()
        audit = observeGroups(pool)
        let splices = 0
        let sorted = 0
        const runs = countReactions(() => {
          sorted = countSorted(() => {
            splices = countLaneSplices(() => {
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
            })
          })
        })
        // Out of the open lane, into the fold, and at most a move in the
        // group's members and in the visible order: one row, whatever the scale.
        expect(splices, 'lane splices').toBeLessThanOrEqual(6)
        const groupCount = tracked(() => worklistGroups(pool).keys.length)
        expect(sorted, 'sorted elements (the group keys, the row family)').toBeLessThan(
          groupCount + 16,
        )
        expect(filingsOf(runs), 'filing reactions run').toEqual([[`pool.file.${target}`, 1]])
        const evals = auditOf(runs)
        expect(evals.get('keys') ?? 0, 'keys executions').toBeLessThanOrEqual(1)
        expect(evals.get('pinnedIds') ?? 0, 'pinnedIds executions').toBe(0)
        expect(evals.get('latchedOpenId') ?? 0, 'latch executions').toBe(0)
        expectOnlyGroup(evals, key)
        expect(tracked(() => worklistGroups(pool).group(key).closedIds.includes(target))).toBe(true)
        writeResult(`mobx-scaling-4686-${scale}x-stage`, {
          scale,
          at: 'stageMove',
          visible,
          target,
          splices,
          sorted,
          evals: Object.fromEntries(evals),
        })
      } finally {
        audit?.stop()
        r.dispose()
      }
    }, 600_000)

    it(`archive leaves by one row at ${scale}x`, () => {
      const r = rig(scale)
      let audit: { stop(): void } | undefined
      try {
        const { pool } = r.handle
        // A childless unpinned open human root in a multi-member group (the
        // #6b rule), so its group survives the removal.
        const found = tracked(() => {
          for (const id of visibleOrderOf(pool)) {
            const node = pool.knownIssue(id)
            const standing = node?.standing
            if (
              standing === undefined ||
              !standing.activeHuman ||
              standing.pinned ||
              standing.parentId !== null ||
              node?.childIds.length !== 0
            ) {
              continue
            }
            const key = groupOf(pool, id)
            if (key === null) continue
            const group = worklistGroups(pool).group(key)
            if (group.rowIds.length + group.closedIds.length >= 2) return { id, key }
          }
          return null
        })
        expect(found, 'a removable row in a multi-member group').not.toBeNull()
        const { id: target, key } = found!
        const base = corpusIssue(r, target)
        audit = observeGroups(pool)
        let splices = 0
        let sorted = 0
        const runs = countReactions(() => {
          sorted = countSorted(() => {
            splices = countLaneSplices(() => {
              r.push({
                type: 'update',
                rows: [{ kind: 'issue', id: target, value: { ...base, archived: true } }],
              })
            })
          })
        })
        // Out of the visible order, its group's members and its open lane.
        expect(splices, 'lane splices').toBe(3)
        const groupCount = tracked(() => worklistGroups(pool).keys.length)
        expect(sorted, 'sorted elements').toBeLessThan(groupCount + 16)
        const evals = auditOf(runs)
        expect(evals.get('pinnedIds') ?? 0, 'pinnedIds executions').toBe(0)
        expect(evals.get('latchedOpenId') ?? 0, 'latch executions').toBe(0)
        expectOnlyGroup(evals, key)
        expect(tracked(() => pool.knownIssue(target)?.visible), 'archived row leaves').toBe(false)
        expect(tracked(() => visibleOrderOf(pool).includes(target))).toBe(false)
        writeResult(`mobx-scaling-4686-${scale}x-archive`, {
          scale,
          at: 'archive',
          target,
          splices,
          sorted,
          evals: Object.fromEntries(evals),
        })
      } finally {
        audit?.stop()
        r.dispose()
      }
    }, 600_000)

    it(`click re-validates no filing reaction at ${scale}x`, () => {
      const r = rig(scale)
      let audit: { stop(): void } | undefined
      try {
        const { pool } = r.handle
        audit = observeGroups(pool)
        const target = clickTarget(pool)
        expect(tracked(() => pool.issueObject(target).unread)).toBe(true)
        let splices = 0
        let sorted = 0
        const runs = countReactions(() => {
          sorted = countSorted(() => {
            splices = countLaneSplices(() => {
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
          })
        })
        expect(filingsOf(runs), 're-validated filing reactions').toEqual([])
        expect(splices, 'lane splices').toBe(0)
        expect(sorted, 'sorted elements').toBe(0)
        // The latch runs once (it must look at the new selection); every lane
        // that reads it is scheduled once and keeps its value; nothing else runs.
        const evals = auditOf(runs)
        expect(evals.get('keys') ?? 0, 'keys executions').toBe(0)
        expect(evals.get('pinnedIds') ?? 0, 'pinnedIds executions').toBe(0)
        expect(evals.get('latchedOpenId') ?? 0, 'latch executions').toBe(1)
        for (const [name, count] of evals) {
          if (name === 'latchedOpenId' || name === 'keys' || name === 'pinnedIds') continue
          const readsLatch = name.startsWith('rowIds:') || name.startsWith('closedIds:')
          expect(count, `${name} executions`).toBe(readsLatch ? 1 : 0)
        }
        // The cursor still works: the row reads as read, stays visible, files nothing.
        expect(tracked(() => pool.issueObject(target).unread)).toBe(false)
        expect(tracked(() => pool.knownIssue(target)?.visible)).toBe(true)
        // The plant replaces the row's slot the old way — the read-state lane
        // lifted, so the cursor update writes the slot like every other
        // field: the row's filing reaction re-validates, failing the count.
        const hook = pool as unknown as { target: { volatile?: unknown } }
        const lane = hook.target.volatile
        const planted = countReactions(() => {
          hook.target.volatile = undefined
          try {
            r.push({
              type: 'update',
              rows: [
                {
                  kind: 'issue',
                  id: target,
                  value: { ...corpusIssue(r, target), readAt: '2027-06-02T00:00:00.000Z' },
                },
              ],
            })
          } finally {
            hook.target.volatile = lane
          }
        })
        expect(filingsOf(planted).length, 'plant re-validations').toBeGreaterThanOrEqual(1)
        writeResult(`mobx-scaling-4686-${scale}x-click`, {
          scale,
          at: 'click',
          target,
          reactions: 0,
          groupsExecutions: Object.fromEntries(evals),
        })
      } finally {
        audit?.stop()
        r.dispose()
      }
    }, 600_000)
  }
})
