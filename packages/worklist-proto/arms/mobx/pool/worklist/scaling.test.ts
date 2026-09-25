// @vitest-environment happy-dom
/**
 * POD-4686 — each change's work follows the change, at 1x and 4x, counted
 * from outside the pool.
 *
 * - STAGE MOVE files one id between two lanes (`counters.groupRuns` 1, and
 *   `counters.groupElements` exactly its group's lanes after the move), with
 *   no order re-sort and no membership change. Its group-set writes (element
 *   `add`/`delete` on the named `pool.groups.*` sets, counted from outside)
 *   are at most four — out of one lane, into the other. The head-rank key
 *   order reads no per-id index (key-index reads 0) and re-evaluates at most
 *   once; pinned ids and the latch never re-evaluate; every other group's
 *   lanes never re-evaluate. The plants run the old whole-list layout
 *   (`layoutOf` over the visible order, touching the visible count) and
 *   re-file every visible id (touching a whole list of sets), each failing
 *   its bound.
 * - CLICK (selection plus the app's mark-read of an unread keep row)
 *   re-validates zero per-node maintenance reactions
 *   (`pool.visible.<id>` / `pool.nested.<id>` / `pool.children.<id>`,
 *   counted by patching `Reaction.runReaction_` from the test): the cursor
 *   moves through the read-state lane, so only the clicked row's `unread`
 *   re-runs — and it is unobserved here, scheduling nothing. The selection
 *   marks every lane stale once (each does O(1) latch-check work off cached
 *   lanes; nothing re-sorts, no order walks); the latch itself re-evaluates
 *   once. The plant replaces the row's slot the old way and schedules at
 *   least the row's own three reactions, failing the same bound.
 *
 * Page observers are attached throughout (keys, pinned ids, every group's
 * lanes, like `PoolList` and the headers), and every reaction execution
 * counts through the `runReaction_` patch — a scheduled re-evaluation counts
 * even when it keeps its value. Reported per scale to `mobx-scaling-4686`.
 *
 * Direct pool, no React and no engine: the harness's fence steps already hold
 * commits, reads and parity per scenario (`groups.test.tsx`,
 * `counts.test.tsx`); this file holds the SCALING of the pool's own work.
 */

import { ObservableMap, ObservableSet, Reaction, reaction, runInAction } from 'mobx'
import { describe, expect, it } from 'vitest'
import { createReplaySource, type ReplaySource } from '../../../../harness/src/count-harness'
import { buildCorpus } from '../../../../harness/src/fixture/index'
import type { RowSource } from '../../../../shared/src/arm'
import { createReadFence } from '../../../../shared/src/instrument/reads'
import { type SettableLocalsHandle, settableLocals } from '../../../../shared/src/locals-source'
import { compareRank } from '../../../../shared/src/row-view'
import type { SliceIssue } from '../../../../shared/src/slice-types'
import type { RowRecord } from '../../../../shared/src/stats'
import { writeResult } from '../../../../harness/src/results'
import { type MobxPoolHandle, mobxPoolArm } from '../arm'
import type { MobxPool } from '../pool'
import { tracked } from '../pool'
import { GroupNode, layoutOf } from './groups'

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
  const row = r.replay.source.snapshot('issue').find((record) => record.id === id)?.value as
    | SliceIssue
    | undefined
  if (row === undefined) throw new Error(`no corpus issue ${id}`)
  return row
}

/** A childless, unpinned open human root in the visible order (the stage-move rule). */
function stageTarget(pool: MobxPool): { id: string; wasHead: boolean } {
  return tracked(() => {
    const order = [...pool.worklist.order]
    const groupOf = (candidate: string): string | null => {
      for (const key of pool.groups.keys) {
        const group = pool.groups.group(key)
        if (group.rowIds.includes(candidate) || group.closedIds.includes(candidate)) return key
      }
      return null
    }
    const candidates = order.filter((candidate) => {
      const node = pool.worklist.issue(candidate)
      if (node === undefined) return false
      const standing = node.standing
      return (
        standing !== undefined &&
        standing.activeHuman &&
        !standing.pinned &&
        standing.parentId === null &&
        node.childIds.length === 0
      )
    })
    if (candidates.length === 0) throw new Error('no childless open root in the visible order')
    // Prefer a row that is not its group's head, so the move cannot change
    // the group order and `keys` legitimately re-evaluates nothing.
    for (const id of candidates) {
      const key = groupOf(id)
      const rank = pool.worklist.issue(id)?.rank
      const head = key === null ? undefined : pool.groups.group(key).headRank
      if (key !== null && rank !== undefined && head !== undefined && compareRank(rank, head) > 0) {
        return { id, wasHead: false }
      }
    }
    return { id: candidates[0]!, wasHead: true }
  })
}

/** An unread open-human root (a keep row: its `flat` never reads the cursor). */
function clickTarget(pool: MobxPool): string {
  return tracked(() => {
    const id = [...pool.worklist.order].find((candidate) => {
      const node = pool.worklist.issue(candidate)
      if (node?.standing === undefined) return false
      return (
        node.standing.activeHuman === true &&
        node.standing.parentId === null &&
        node.unread === true
      )
    })
    if (id === undefined) throw new Error('no unread open-human root in the visible order')
    return id
  })
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

/**
 * `ObservableMap.get` calls on one named map while `run` runs: the key-index
 * walk counter. The old group order walked every visible id through the
 * `pool.groups.keys` index per stage move; the head-rank order reads no
 * per-id index at all.
 */
function countMapReads(name: string, run: () => void): number {
  const proto = ObservableMap.prototype as unknown as Record<
    'get',
    (this: { name_?: string }, id: string) => unknown
  >
  const original = proto.get
  let reads = 0
  proto.get = function (this: { name_?: string }, id: string) {
    if ((this.name_ ?? '') === name) reads += 1
    return original.call(this, id)
  }
  try {
    run()
  } finally {
    proto.get = original
  }
  return reads
}

/**
 * Always-fire observers over the groups computeds the page reads
 * (`PoolList` reads `keys` and `pinnedIds`, each header its lanes): every
 * re-evaluation counts, even one that keeps its value. Returned with a stop
 * function; creation settles baselines synchronously.
 *
 * NOTE: executions are counted through the `runReaction_` patch
 * (`countReactions`), not through these reactions' effects: an effect fires
 * only when its computed's value changes, but a scheduled re-evaluation that
 * keeps its value is still work. Filter the execution map by the `audit.`
 * prefix.
 */

/**
 * Group lanes the page reads, present on the running code: newer than the
 * keys-walk plant (to-do 3), which has no head rank or unlatched base lanes.
 */
type GroupLane = 'label' | 'headRank' | 'rowIds' | 'closedIds' | 'baseRowIds' | 'baseClosedIds'
const ALL_LANES: readonly GroupLane[] = [
  'label',
  'headRank',
  'rowIds',
  'closedIds',
  'baseRowIds',
  'baseClosedIds',
]
const availableLanes: readonly GroupLane[] = ALL_LANES.filter(
  (lane) => lane in GroupNode.prototype,
)

function observeGroups(pool: MobxPool): { stop(): void } {
  const stops: (() => void)[] = []
  const watch = (name: string, fn: () => unknown): void => {
    stops.push(reaction(fn, () => {}, { name: `audit.${name}` }))
  }
  watch('keys', () => pool.groups.keys)
  watch('pinnedIds', () => pool.groups.pinnedIds)
  watch('latchedOpenId', () => pool.groups.latchedOpenId)
  for (const key of tracked(() => pool.groups.keys)) {
    const group = pool.groups.group(key)
    for (const lane of availableLanes) {
      watch(`${lane}:${key}`, () => group[lane])
    }
  }
  return {
    stop: () => {
      for (const stop of stops) stop()
    },
  }
}

/** executions of the `audit.*` observers, with the prefix stripped. */
function auditOf(runs: Map<string, number>): Map<string, number> {
  const out = new Map<string, number>()
  for (const [name, count] of runs) {
    if (name.startsWith('audit.')) out.set(name.slice('audit.'.length), count)
  }
  return out
}

/**
 * Element writes (`add`/`delete`) on the groups' named maintenance sets
 * (`pool.groups.*`) while `run` runs, counted from outside the pool
 * (POD-4686, answering the F1 exemption: this upkeep has its own bound).
 */
function countGroupSets(run: () => void): number {
  const proto = ObservableSet.prototype as unknown as Record<
    'add' | 'delete',
    (this: { name_?: string }, id: string) => unknown
  >
  const original = { add: proto.add, delete: proto.delete }
  let touched = 0
  const isGroups = (self: { name_?: string }): boolean =>
    (self.name_ ?? '').startsWith('pool.groups.')
  proto.add = function (this: { name_?: string }, id: string) {
    if (isGroups(this)) touched += 1
    return original.add.call(this, id)
  }
  proto.delete = function (this: { name_?: string }, id: string) {
    if (isGroups(this)) touched += 1
    return original.delete.call(this, id)
  }
  try {
    run()
  } finally {
    proto.add = original.add
    proto.delete = original.delete
  }
  return touched
}

describe('scaling: the work follows the change (POD-4686)', () => {
  for (const scale of [1, 4] as const) {
    it(`stage move files one id at ${scale}x`, () => {
      const r = rig(scale)
      let audit: { stop(): void } | undefined
      try {
        const { pool } = r.handle
        const visible = tracked(() => pool.worklist.order.length)
        const { id: target, wasHead } = stageTarget(pool)
        const base = corpusIssue(r, target)
        const now = new Date(base.updatedAt).toISOString()
        // The page's observers: keys, pinned ids, and every group's lanes.
        // Executions are counted through the runReaction_ patch below, so a
        // scheduled re-evaluation counts even when it keeps its value.
        audit = observeGroups(pool)
        pool.stats.reset()
        let mapReads = 0
        let sets = 0
        const runs = countReactions(() => {
          sets = countGroupSets(() => {
            mapReads = countMapReads('pool.groups.keys', () => {
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
        const { groupRuns, groupElements, orderSorts, membershipFlips } = pool.stats.counters
        // Exactly one filing, no re-sort, no membership change.
        expect(groupRuns, 'filings').toBe(1)
        expect(orderSorts, 'order re-sorts').toBe(0)
        expect(membershipFlips, 'membership flips').toBe(0)
        // The filing touches one lane's sets: out of one lane, into the
        // other (a cross-bucket move touches both buckets' lanes: four).
        expect(sets, 'group set writes').toBeLessThanOrEqual(4)
        // No key-index walk: the head-rank order reads no per-id index.
        expect(mapReads, 'key-index reads').toBe(0)
        // Executions per groups observer: the moved row's own layout
        // reaction runs once; the moved group's lanes run once each; the key
        // order runs at most once (only when the move changes a head rank or
        // a bucket membership); everything else never runs here.
        const evals = auditOf(runs)
        const layoutRuns = [...runs].filter(([name]) => name.startsWith('pool.layout.'))
        expect(layoutRuns.length, 'layout reactions executed').toBe(1)
        expect(evals.get('keys') ?? 0, 'keys executions').toBeLessThanOrEqual(1)
        expect(evals.get('pinnedIds') ?? 0, 'pinnedIds executions').toBe(0)
        expect(evals.get('latchedOpenId') ?? 0, 'latch executions').toBe(0)
        const moved = tracked(() => {
          for (const key of pool.groups.keys) {
            const group = pool.groups.group(key)
            if (group.rowIds.includes(target) || group.closedIds.includes(target)) return key
          }
          return null
        })
        expect(moved, 'the moved row is still grouped').not.toBeNull()
        for (const [name, count] of evals) {
          if (name === 'keys' || name === 'pinnedIds' || name === 'latchedOpenId') continue
          if (name.endsWith(`:${moved}`)) {
            expect(count, `${name} executions (moved group)`).toBe(1)
          } else {
            expect(count, `${name} executions (other group)`).toBe(0)
          }
        }
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
        const order = tracked(() => [...pool.worklist.order])
        const placed = tracked(() => {
          let touched = 0
          layoutOf(order, (id) => {
            touched += 1
            return pool.worklist.issue(id)?.placement
          })
          return touched
        })
        expect(placed, 'whole-list layout elements').toBe(visible)
        expect(visible > lane!.open + lane!.closed, 'the corpus holds more than one group').toBe(
          true,
        )
        // The plant re-files every visible id (out and back in), touching a
        // whole list of sets and failing the same bound.
        const refiled = countGroupSets(() => {
          runInAction(() => {
            for (const id of order) {
              const node = pool.worklist.issue(id)
              const placement = node?.visible === true ? node.placement : undefined
              pool.groups.file(id, undefined)
              pool.groups.file(id, placement)
            }
          })
        })
        expect(refiled, 'whole-group rebuild set writes').toBeGreaterThan(4)
        writeResult(`mobx-scaling-4686-${scale}x-stage`, {
          scale,
          at: 'stageMove',
          visible,
          target,
          wasHead,
          filings: groupRuns,
          laneMembers: groupElements,
          setWrites: sets,
          keyIndexReads: mapReads,
          evals: Object.fromEntries(evals),
        })
      } finally {
        audit?.stop?.()
        r.dispose()
      }
    }, 600_000)

    it(`click re-validates no maintenance reaction at ${scale}x`, () => {
      const r = rig(scale)
      let audit: { stop(): void } | undefined
      try {
        const { pool } = r.handle
        audit = observeGroups(pool)
        try {
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
          // Executions per groups observer: at most one scheduling round per
          // observer across both actions (selection, then the cursor write).
          // The latch may execute once (it must look at the new selection);
          // lanes may execute once (scheduled, O(1) latch-check bodies off
          // cached lanes); nothing re-sorts and nothing walks an index.
          const evals = auditOf(runs)
          for (const [name, count] of evals) {
            expect(count, `${name} executions`).toBeLessThanOrEqual(1)
          }
          expect(evals.get('keys') ?? 0, 'keys executions').toBe(0)
          expect(evals.get('pinnedIds') ?? 0, 'pinnedIds executions').toBe(0)
        // The cursor still works: the row reads as read, stays visible, files nothing.
        expect(tracked(() => pool.worklist.issue(target)?.unread)).toBe(false)
        expect(tracked(() => pool.worklist.issue(target)?.visible)).toBe(true)
        expect(pool.stats.counters.groupRuns, 'filings').toBe(0)
        expect(pool.stats.counters.membershipFlips, 'membership flips').toBe(0)
        // The plant replaces the row's slot the old way — the volatile lane
        // lifted, so the cursor update writes the slot like every other
        // field, through the real feed (borrowed rows, fence-clean): at least
        // the row's own three reactions re-validate, failing the same count.
        const hook = pool as unknown as {
          target: { volatile?: unknown }
        }
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
        expect(maintenanceOf(planted).length, 'plant re-validations').toBeGreaterThanOrEqual(3)
        writeResult(`mobx-scaling-4686-${scale}x-click`, {
          scale,
          at: 'click',
          target,
          reactions: 0,
          groupsExecutions: Object.fromEntries(auditOf(runs)),
        })
        } finally {
          audit?.stop?.()
        }
      } finally {
        r.dispose()
      }
    }, 600_000)
  }
})
