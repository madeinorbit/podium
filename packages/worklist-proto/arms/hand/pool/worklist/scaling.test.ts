// @vitest-environment happy-dom
/**
 * POD-4694 — each change's layout work follows the change, at 1x and 4x,
 * counted from outside the pool (the MobX arm's POD-4686 harness, ported to
 * the hand idiom; the MobX-specific parts — the `Reaction` patch and the
 * observable-set spies — have no counterpart here).
 *
 * - STAGE MOVE of the head row files one id between two lanes
 *   (`counters.groupRuns` 1, `counters.groupElements` exactly its group's
 *   lanes after the move), with no order re-sort and no membership change.
 *   No order element and no order length is read here at any scale (counted
 *   through a proxy on the groups host's `order()`, so a walk through any
 *   map shows up). Only the moved group's header is notified, once; every
 *   other header never runs. The target is its group's head on purpose: only
 *   a head move re-sorts the key order at all, so only it can expose a walk
 *   hidden there. The plants run the old whole-list layout (`layoutOf` over
 *   the visible order, touching the visible count) and re-file every visible
 *   id, each failing its bound.
 * - ARCHIVE leaves without walking the order: one membership flip, no
 *   re-sort, one un-filing of exactly its lane, 0 order walks. Only the
 *   emptied group's header is notified.
 * - CLICK (selection plus the app's mark-read of an unread keep row) files
 *   nothing, flips no membership, walks no order element, and notifies no
 *   header and not the list: the cursor moves outside the placement, so only
 *   the clicked row's own cells re-run.
 * - ENTER (a new visible issue) files one id into its group's lanes: one
 *   membership flip, no re-sort, 0 order walks; only its group's header is
 *   notified.
 * - EVICT (a visible row deleted from the pool) un-files one id in the
 *   settle: one membership flip, no re-sort, 0 order walks; only the emptied
 *   group's header is notified.
 * - PIN (an open row pinned) files one id from its bucket into the pinned
 *   section: no membership flip, no re-sort, 0 order walks; its old group's
 *   header is notified once, and the list (the pinned section moved).
 * - RANK (a sort-key change inside one lane) files nothing: no membership
 *   flip, 0 order walks; only its group's header is notified, once, for the
 *   lane reorder.
 * - REPARENT (a nested row moved between two present parents) files nothing:
 *   the placement never reads the parent edge, so no membership flip, no
 *   order walk, no header and no list notice.
 *
 * Page listeners are attached throughout (the grouped view, like `PoolList`,
 * and each group's lanes, like its header). Reported per scale to
 * `hand-scaling-4694-*`. Direct pool, no React and no engine: the harness's
 * fence steps already hold commits, reads and parity per scenario
 * (`groups.test.tsx`); this file holds the SCALING of the pool's own work.
 */

import { describe, expect, it } from 'vitest'
import { createReplaySource, type ReplaySource } from '../../../../harness/src/count-harness'
import { buildCorpus } from '../../../../harness/src/fixture/index'
import { writeResult } from '../../../../harness/src/results'
import type { RowSource } from '../../../../shared/src/arm'
import { createReadFence } from '../../../../shared/src/instrument/reads'
import { type SettableLocalsHandle, settableLocals } from '@podium/client-graph/shared/locals-source'
import { diffSnapshots } from '../../../../shared/src/gen/check'
import { compareRank } from '@podium/client-graph/shared/row-view'
import type { SliceIssue } from '@podium/client-graph/shared/slice-types'
import type { RowRecord } from '../../../../shared/src/stats'
import { harnessHandPoolArm, type HarnessHandPoolHandle } from '../../../../harness/src/adapters/hand-pool'
import type { HandPool } from '../pool'
import { layoutOf, sliceOrderOf } from './groups'

interface Rig {
  replay: ReplaySource
  locals: SettableLocalsHandle
  handle: HarnessHandPoolHandle
  push(event: { type: 'update' | 'replace'; rows: RowRecord[] }): void
  dispose(): void
}

function rig(scale: 1 | 2 | 4): Rig {
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
  const handle = harnessHandPoolArm.create(reads.wrapSource(counted), locals.source, reads, {
    schedule: () => () => {},
  }) as HarnessHandPoolHandle
  // Land the visibility parts' cold reads before any counted step.
  handle.settleLoads()
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

/** The visible ids in rank order, without tracking (tests). */
function visibleOrder(pool: HandPool): string[] {
  return [...pool.order()]
}

/** Which group a visible id is filed in (snapshot, no selection). */
function groupOf(pool: HandPool, candidate: string): string | null {
  for (const group of pool.groups.snapshot().groups) {
    if (group.rowIds.includes(candidate) || group.closedIds.includes(candidate)) return group.key
  }
  return null
}

/** A childless, unpinned open human root heading its group (the stage-move rule). */
function stageTarget(pool: HandPool): { id: string; key: string } {
  const order = visibleOrder(pool)
  const byId = new Map(order.map((id) => [id, pool.worklist.placedRankOf(id)]))
  const candidates = order.filter((candidate) => {
    const parts = pool.worklist.issue(candidate)
    const placement = pool.groups.placement(candidate)
    if (parts === undefined || placement === undefined) return false
    if (placement.pinned || placement.closed) return false
    if (parts.childIds.length !== 0) return false
    const row = pool.visibleInputs.issueRow(candidate) as SliceIssue | undefined
    if (row === undefined) return false
    const human =
      row.audience === 'human' &&
      (row.stage === 'planning' || row.stage === 'in_progress' || row.stage === 'review')
    return human && (row.parentId === null || row.parentId === undefined)
  })
  if (candidates.length === 0) throw new Error('no childless open root in the visible order')
  // The head of its group: moving it changes the head rank, so the key order
  // genuinely re-sorts instead of staying silent. A whole-order walk hidden in
  // the key order can only execute here — a non-head move never re-runs it.
  for (const id of candidates) {
    const key = groupOf(pool, id)
    if (key === null) continue
    const group = pool.groups.snapshot().groups.find((candidate) => candidate.key === key)
    if (group === undefined) continue
    const members = [...group.rowIds, ...group.closedIds]
    let head = members[0] as string
    for (const member of members) {
      const a = byId.get(member)
      const b = byId.get(head)
      if (a !== undefined && b !== undefined && compareRank(a, b) < 0) head = member
    }
    if (head === id) return { id, key }
  }
  throw new Error('no head childless open root in the visible order')
}

/** An unread open root (a keep row: its placement never reads the cursor). */
function clickTarget(pool: HandPool): string {
  for (const id of visibleOrder(pool)) {
    const parts = pool.worklist.issue(id)
    const placement = pool.groups.placement(id)
    if (parts === undefined || placement === undefined) continue
    if (parts.unread === true && !placement.closed && !placement.pinned) return id
  }
  throw new Error('no unread open root in the visible order')
}

/**
 * Order elements iterated out of the groups host's `order()` while `run`
 * runs. The host object is plain, so its `order` entry is swapped for one
 * that wraps the returned array in a counting proxy: every visited element
 * and every `length` read counts, through indexed access, iteration, spread
 * and array methods. A walk that iterates `host.order()` and reads any map
 * per id shows up here at the visible count. Bound per hot-path change: 0
 * elements, 0 lengths.
 */
function countOrderReads(pool: HandPool, run: () => void): { elements: number; lengths: number } {
  const groups = pool.groups as unknown as { host: { order(): readonly string[] } }
  const original = groups.host.order
  let elements = 0
  let lengths = 0
  const wrap = (array: readonly string[]): readonly string[] =>
    new Proxy(array, {
      get(target, property, receiver): unknown {
        if (property === 'length') {
          lengths += 1
          return Reflect.get(target, property, receiver)
        }
        if (property === Symbol.iterator) {
          const inner = Reflect.get(target, property, array) as () => Iterator<string>
          const iterator = Reflect.apply(inner, array, []) as Iterator<string>
          const counting: Iterator<string> & { [Symbol.iterator](): Iterator<string> } = {
            next: () => {
              const step = iterator.next()
              if (step.done !== true) elements += 1
              return step
            },
            [Symbol.iterator]() {
              return counting
            },
          }
          return () => counting
        }
        if (typeof property === 'string' && Number.isInteger(Number(property))) {
          elements += 1
        }
        return Reflect.get(target, property, receiver)
      },
    })
  groups.host.order = () => wrap(original())
  try {
    run()
  } finally {
    groups.host.order = original
  }
  return { elements, lengths }
}

/** Header + list notices while `run` runs (outside the pool, as the list observes it). */
function countNotices(
  pool: HandPool,
  run: () => void,
): { headers: Map<string, number>; list: number } {
  const headers = new Map<string, number>()
  const offs = pool.groupsView().keys.map((key) =>
    pool.subscribeGroup(key, () => headers.set(key, (headers.get(key) ?? 0) + 1)),
  )
  let list = 0
  const offView = pool.subscribeGroups(() => list += 1)
  try {
    run()
  } finally {
    for (const off of offs) off()
    offView()
  }
  return { headers, list }
}

describe('scaling: the work follows the change (POD-4694)', () => {
  for (const scale of [1, 4] as const) {
    it(`stage move files one id at ${scale}x`, () => {
      const r = rig(scale)
      try {
        const { pool } = r.handle
        const visible = pool.order().length
        const { id: target, key: before } = stageTarget(pool)
        const base = corpusIssue(r, target)
        const now = new Date(base.updatedAt).toISOString()
        pool.stats.reset()
        let orderReads = { elements: 0, lengths: 0 }
        let notices: { headers: Map<string, number>; list: number } = {
          headers: new Map(),
          list: 0,
        }
        // Listeners first (as the mounted list holds them), then the change
        // with the order seam counted.
        const offs = pool.groupsView().keys.map((key) =>
          pool.subscribeGroup(key, () => notices.headers.set(key, (notices.headers.get(key) ?? 0) + 1)),
        )
        const offView = pool.subscribeGroups(() => notices.list += 1)
        try {
          orderReads = countOrderReads(pool, () => {
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
        } finally {
          for (const off of offs) off()
          offView()
        }
        const { groupRuns, groupElements, orderSorts, membershipFlips } = pool.stats.counters
        // Exactly one filing, no re-sort, no membership change.
        expect(groupRuns, 'filings').toBe(1)
        expect(orderSorts, 'order re-sorts').toBe(0)
        expect(membershipFlips, 'membership flips').toBe(0)
        // No order walk at all: nothing iterates the visible order or reads
        // its length here.
        expect(orderReads.elements, 'order elements iterated').toBe(0)
        expect(orderReads.lengths, 'order length reads').toBe(0)
        // The filing re-sorts exactly its own group's lanes.
        const moved = groupOf(pool, target)
        expect(moved, 'the moved row is still grouped').not.toBeNull()
        const lane = pool.groups.snapshot().groups.find((group) => group.key === moved)
        expect(lane, 'the moved group').toBeDefined()
        expect(groupElements, 'lane members re-sorted').toBe(
          lane!.rowIds.length + lane!.closedIds.length,
        )
        // Only the moved group's header is notified, once (a cross-group move
        // notifies the emptied group instead; here the row stays in its group,
        // crossing the fold).
        expect(moved, 'the row stays in its group').toBe(before)
        expect(notices.headers.get(moved!), 'moved header notices').toBe(1)
        for (const [key, count] of notices.headers) {
          if (key === moved) continue
          expect(count, `${key} header notices (other group)`).toBe(0)
        }
        // The plant touches the whole visible order, failing the same count.
        const order = visibleOrder(pool)
        let touched = 0
        const plantReads = countOrderReads(pool, () => {
          const host = pool.groups as unknown as { host: { order(): readonly string[] } }
          for (const id of host.host.order()) {
            touched += 1
            void pool.groups.placement(id)
          }
        })
        expect(touched, 'whole-visible-order walk elements').toBe(visible)
        expect(plantReads.elements, 'plant order elements iterated').toBe(visible)
        expect(visible > lane!.rowIds.length + lane!.closedIds.length, 'the corpus holds more than one group').toBe(
          true,
        )
        // The plant re-files every visible id (out and back in), touching a
        // whole list of lanes and failing the same bound.
        pool.stats.reset()
        {
          const groups = pool.groups as unknown as {
            filed: Map<string, { pinned: boolean; repoKey: string; closed: boolean }>
            unfile(id: string, placement: unknown): number
            enfile(id: string, placement: unknown): number
            count(elements: number): void
          }
          for (const id of order) {
            const filed = groups.filed.get(id)
            if (filed === undefined) continue
            const behind = groups.unfile(id, filed)
            const around = groups.enfile(id, filed)
            groups.count(behind + around)
          }
        }
        const { groupElements: refiled } = pool.stats.counters
        expect(refiled, 'whole-group rebuild lane touches').toBeGreaterThan(
          lane!.rowIds.length + lane!.closedIds.length,
        )
        // The pure whole-list layout touches the visible count per run.
        const placed = layoutOf(order, (id) => pool.groups.placement(id))
        void placed
        expect(order.length, 'whole-list layout elements').toBe(visible)
        writeResult(`hand-scaling-4694-${scale}x-stage`, {
          scale,
          at: 'stageMove',
          visible,
          target,
          filings: groupRuns,
          laneMembers: groupElements,
          orderElements: orderReads.elements,
          orderLengths: orderReads.lengths,
          headers: Object.fromEntries(notices.headers),
          list: notices.list,
          plantOrderElements: plantReads.elements,
          plantVisible: touched,
          refiledLaneTouches: refiled,
        })
      } finally {
        r.dispose()
      }
    }, 600_000)

    it(`archive leaves without walking the order at ${scale}x`, () => {
      const r = rig(scale)
      try {
        const { pool } = r.handle
        // A childless unpinned open human root in a multi-member group (the
        // #6b rule), so its bucket survives the removal.
        let found: { id: string; key: string; size: number } | null = null
        for (const id of visibleOrder(pool)) {
          const parts = pool.worklist.issue(id)
          const placement = pool.groups.placement(id)
          if (parts === undefined || placement === undefined) continue
          if (parts.childIds.length !== 0 || placement.pinned || placement.closed) continue
          const row = pool.visibleInputs.issueRow(id) as SliceIssue | undefined
          if (row === undefined) continue
          const human =
            row.audience === 'human' &&
            (row.stage === 'planning' || row.stage === 'in_progress' || row.stage === 'review')
          if (!human || (row.parentId !== null && row.parentId !== undefined)) continue
          const key = groupOf(pool, id)
          if (key === null) continue
          const group = pool.groups.snapshot().groups.find((candidate) => candidate.key === key)
          if (group === undefined) continue
          const size = group.rowIds.length + group.closedIds.length
          if (size >= 2) {
            found = { id, key, size }
            break
          }
        }
        expect(found, 'a removable row in a multi-member group').not.toBeNull()
        const { id: target, key, size: before } = found!
        const base = corpusIssue(r, target)
        pool.stats.reset()
        let orderReads = { elements: 0, lengths: 0 }
        const notices = countNotices(pool, () => {
          orderReads = countOrderReads(pool, () => {
            r.push({
              type: 'update',
              rows: [{ kind: 'issue', id: target, value: { ...base, archived: true } }],
            })
          })
        })
        const { groupRuns, groupElements, orderSorts, membershipFlips } = pool.stats.counters
        // One row leaves the visible set: one membership flip, no re-sort,
        // one un-filing of exactly its lane.
        expect(membershipFlips, 'membership flips').toBe(1)
        expect(orderSorts, 'order re-sorts').toBe(0)
        expect(groupRuns, 'filings').toBe(1)
        expect(groupElements, 'lane members left behind').toBe(before - 1)
        // No order walk at any scale.
        expect(orderReads.elements, 'order elements iterated').toBe(0)
        expect(orderReads.lengths, 'order length reads').toBe(0)
        // Only the emptied group's header is notified, once.
        expect(notices.headers.get(key), 'emptied header notices').toBe(1)
        for (const [name, count] of notices.headers) {
          if (name === key) continue
          expect(count, `${name} header notices (other group)`).toBe(0)
        }
        expect(pool.worklist.has(target), 'archived row leaves').toBe(false)
        writeResult(`hand-scaling-4694-${scale}x-archive`, {
          scale,
          at: 'archive',
          target,
          membershipFlips,
          orderSorts,
          filings: groupRuns,
          laneMembers: groupElements,
          orderElements: orderReads.elements,
          orderLengths: orderReads.lengths,
          headers: Object.fromEntries(notices.headers),
          list: notices.list,
        })
      } finally {
        r.dispose()
      }
    }, 600_000)

    it(`click files nothing at ${scale}x`, () => {
      const r = rig(scale)
      try {
        const { pool } = r.handle
        const target = clickTarget(pool)
        pool.stats.reset()
        let orderReads = { elements: 0, lengths: 0 }
        const notices = countNotices(pool, () => {
          orderReads = countOrderReads(pool, () => {
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
        // No filing, no membership change, no order walk.
        expect(pool.stats.counters.groupRuns, 'filings').toBe(0)
        expect(pool.stats.counters.membershipFlips, 'membership flips').toBe(0)
        expect(orderReads.elements, 'order elements iterated').toBe(0)
        expect(orderReads.lengths, 'order length reads').toBe(0)
        // No header and not the list: the selection holds no folded row open.
        expect([...notices.headers.values()].reduce((a, b) => a + b, 0), 'header notices').toBe(0)
        expect(notices.list, 'list notices').toBe(0)
        writeResult(`hand-scaling-4694-${scale}x-click`, {
          scale,
          at: 'click',
          target,
          filings: 0,
          orderElements: orderReads.elements,
          orderLengths: orderReads.lengths,
          headers: Object.fromEntries(notices.headers),
          list: notices.list,
        })
      } finally {
        r.dispose()
      }
    }, 600_000)

    it(`enter files one id at ${scale}x`, () => {
      const r = rig(scale)
      try {
        const { pool } = r.handle
        // A new open human root filed into an existing multi-member group (its
        // repoKey copied from a visible open row), so no group is born.
        const baseId = (() => {
          for (const id of visibleOrder(pool)) {
            const placement = pool.groups.placement(id)
            if (placement === undefined || placement.pinned || placement.closed) continue
            const row = pool.visibleInputs.issueRow(id) as SliceIssue | undefined
            if (row === undefined) continue
            const human =
              row.audience === 'human' &&
              (row.stage === 'planning' || row.stage === 'in_progress' || row.stage === 'review')
            if (!human || (row.parentId !== null && row.parentId !== undefined)) continue
            const key = groupOf(pool, id)
            if (key === null) continue
            const group = pool.groups.snapshot().groups.find((candidate) => candidate.key === key)
            if (group === undefined || group.rowIds.length < 2) continue
            return { id, key, size: group.rowIds.length + group.closedIds.length, row }
          }
          throw new Error('no multi-member open group in the visible order')
        })()
        const id = `zxenter${scale}`
        expect(pool.worklist.has(id), 'fresh enter id is unknown').toBe(false)
        const value: SliceIssue = {
          ...baseId.row,
          id,
          stage: 'in_progress',
          closedReason: null,
          closedAt: null,
          tuckedAt: null,
          archived: false,
          pinned: false,
          parentId: null,
        }
        pool.stats.reset()
        let orderReads = { elements: 0, lengths: 0 }
        const notices = countNotices(pool, () => {
          orderReads = countOrderReads(pool, () => {
            r.push({ type: 'update', rows: [{ kind: 'issue', id, value }] })
          })
        })
        const { groupRuns, groupElements, orderSorts, membershipFlips } = pool.stats.counters
        expect(membershipFlips, 'membership flips').toBe(1)
        expect(orderSorts, 'order re-sorts').toBe(0)
        expect(groupRuns, 'filings').toBe(1)
        expect(groupElements, 'lane members around the filed row').toBe(baseId.size + 1)
        expect(orderReads.elements, 'order elements iterated').toBe(0)
        expect(orderReads.lengths, 'order length reads').toBe(0)
        const moved = groupOf(pool, id)
        expect(moved, 'the entered row is grouped').toBe(baseId.key)
        expect(notices.headers.get(moved!), 'entered header notices').toBe(1)
        for (const [name, count] of notices.headers) {
          if (name === moved) continue
          expect(count, `${name} header notices (other group)`).toBe(0)
        }
        writeResult(`hand-scaling-4694-${scale}x-enter`, {
          scale,
          at: 'enter',
          target: id,
          membershipFlips,
          filings: groupRuns,
          laneMembers: groupElements,
          orderElements: orderReads.elements,
          orderLengths: orderReads.lengths,
          headers: Object.fromEntries(notices.headers),
          list: notices.list,
        })
      } finally {
        r.dispose()
      }
    }, 600_000)

    it(`evict un-files one id at ${scale}x`, () => {
      const r = rig(scale)
      try {
        const { pool } = r.handle
        // A sessionless childless open root in a multi-member group, so its
        // deletion moves no other row's visibility and its bucket survives.
        let found: { id: string; key: string; size: number } | null = null
        for (const id of visibleOrder(pool)) {
          const parts = pool.worklist.issue(id)
          const placement = pool.groups.placement(id)
          if (parts === undefined || placement === undefined) continue
          if (parts.childIds.length !== 0 || placement.pinned || placement.closed) continue
          if (parts.seatIds.length !== 0 || parts.memberIds.length !== 0) continue
          const row = pool.visibleInputs.issueRow(id) as SliceIssue | undefined
          if (row === undefined) continue
          const human =
            row.audience === 'human' &&
            (row.stage === 'planning' || row.stage === 'in_progress' || row.stage === 'review')
          if (!human || (row.parentId !== null && row.parentId !== undefined)) continue
          const key = groupOf(pool, id)
          if (key === null) continue
          const group = pool.groups.snapshot().groups.find((candidate) => candidate.key === key)
          if (group === undefined) continue
          const size = group.rowIds.length + group.closedIds.length
          if (size >= 2) {
            found = { id, key, size }
            break
          }
        }
        expect(found, 'a sessionless removable row in a multi-member group').not.toBeNull()
        const { id: target, key, size: before } = found!
        pool.stats.reset()
        let orderReads = { elements: 0, lengths: 0 }
        const notices = countNotices(pool, () => {
          orderReads = countOrderReads(pool, () => {
            r.push({ type: 'update', rows: [{ kind: 'issue', id: target, value: undefined }] })
          })
        })
        const { groupRuns, groupElements, orderSorts, membershipFlips } = pool.stats.counters
        expect(membershipFlips, 'membership flips').toBe(1)
        expect(orderSorts, 'order re-sorts').toBe(0)
        expect(groupRuns, 'filings').toBe(1)
        expect(groupElements, 'lane members left behind').toBe(before - 1)
        expect(orderReads.elements, 'order elements iterated').toBe(0)
        expect(orderReads.lengths, 'order length reads').toBe(0)
        expect(notices.headers.get(key), 'emptied header notices').toBe(1)
        for (const [name, count] of notices.headers) {
          if (name === key) continue
          expect(count, `${name} header notices (other group)`).toBe(0)
        }
        expect(pool.worklist.has(target), 'evicted row leaves').toBe(false)
        writeResult(`hand-scaling-4694-${scale}x-evict`, {
          scale,
          at: 'evict',
          target,
          membershipFlips,
          filings: groupRuns,
          laneMembers: groupElements,
          orderElements: orderReads.elements,
          orderLengths: orderReads.lengths,
          headers: Object.fromEntries(notices.headers),
          list: notices.list,
        })
      } finally {
        r.dispose()
      }
    }, 600_000)

    it(`pin files one id out of its bucket at ${scale}x`, () => {
      const r = rig(scale)
      try {
        const { pool } = r.handle
        let found: { id: string; key: string; size: number } | null = null
        for (const id of visibleOrder(pool)) {
          const parts = pool.worklist.issue(id)
          const placement = pool.groups.placement(id)
          if (parts === undefined || placement === undefined) continue
          if (parts.childIds.length !== 0 || placement.pinned || placement.closed) continue
          const row = pool.visibleInputs.issueRow(id) as SliceIssue | undefined
          if (row === undefined || row.pinned === true) continue
          const key = groupOf(pool, id)
          if (key === null) continue
          const group = pool.groups.snapshot().groups.find((candidate) => candidate.key === key)
          if (group === undefined) continue
          const size = group.rowIds.length + group.closedIds.length
          if (size >= 2) {
            found = { id, key, size }
            break
          }
        }
        expect(found, 'a pinnable row in a multi-member group').not.toBeNull()
        const { id: target, key, size: before } = found!
        const pinnedBefore = pool.groups.snapshot().pinnedIds.length
        pool.stats.reset()
        let orderReads = { elements: 0, lengths: 0 }
        const notices = countNotices(pool, () => {
          orderReads = countOrderReads(pool, () => {
            r.push({
              type: 'update',
              rows: [{ kind: 'issue', id: target, value: { ...corpusIssue(r, target), pinned: true } }],
            })
          })
        })
        const { groupRuns, groupElements, orderSorts, membershipFlips } = pool.stats.counters
        // Bucket to pinned: one filing across two lanes, no membership change.
        expect(membershipFlips, 'membership flips').toBe(0)
        expect(orderSorts, 'order re-sorts').toBe(0)
        expect(groupRuns, 'filings').toBe(1)
        expect(groupElements, 'lanes around the filed row').toBe(
          before - 1 + (pinnedBefore + 1),
        )
        expect(orderReads.elements, 'order elements iterated').toBe(0)
        expect(orderReads.lengths, 'order length reads').toBe(0)
        expect(pool.groups.snapshot().pinnedIds.includes(target), 'the row is pinned').toBe(true)
        expect(notices.headers.get(key), 'emptied header notices').toBe(1)
        for (const [name, count] of notices.headers) {
          if (name === key) continue
          expect(count, `${name} header notices (other group)`).toBe(0)
        }
        // The pinned section moved, so the list is notified.
        expect(notices.list, 'list notices').toBe(1)
        writeResult(`hand-scaling-4694-${scale}x-pin`, {
          scale,
          at: 'pin',
          target,
          filings: groupRuns,
          laneMembers: groupElements,
          orderElements: orderReads.elements,
          orderLengths: orderReads.lengths,
          headers: Object.fromEntries(notices.headers),
          list: notices.list,
        })
      } finally {
        r.dispose()
      }
    }, 600_000)

    it(`rank move re-sorts only its lane at ${scale}x`, () => {
      const r = rig(scale)
      try {
        const { pool } = r.handle
        // The first open row of a group with at least three open members,
        // sunk to the lane's end by a sort-key change: the placement is
        // untouched, so nothing files.
        let found: { id: string; key: string } | null = null
        for (const group of pool.groups.snapshot().groups) {
          if (group.rowIds.length < 3) continue
          const id = group.rowIds[0] as string
          const placement = pool.groups.placement(id)
          if (placement === undefined || placement.pinned || placement.closed) continue
          found = { id, key: group.key }
          break
        }
        expect(found, 'a group with a non-trivial open lane').not.toBeNull()
        const { id: target, key } = found!
        pool.stats.reset()
        let orderReads = { elements: 0, lengths: 0 }
        const notices = countNotices(pool, () => {
          orderReads = countOrderReads(pool, () => {
            r.push({
              type: 'update',
              rows: [{ kind: 'issue', id: target, value: { ...corpusIssue(r, target), sortKey: '~~~' } }],
            })
          })
        })
        const { groupRuns, groupElements, membershipFlips } = pool.stats.counters
        expect(groupRuns, 'filings').toBe(0)
        expect(membershipFlips, 'membership flips').toBe(0)
        expect(groupElements, 'lane members re-sorted').toBe(0)
        expect(orderReads.elements, 'order elements iterated').toBe(0)
        expect(orderReads.lengths, 'order length reads').toBe(0)
        // The lane reordered, so exactly its header is notified.
        expect(notices.headers.get(key), 'reordered header notices').toBe(1)
        for (const [name, count] of notices.headers) {
          if (name === key) continue
          expect(count, `${name} header notices (other group)`).toBe(0)
        }
        writeResult(`hand-scaling-4694-${scale}x-rank`, {
          scale,
          at: 'rankMove',
          target,
          filings: groupRuns,
          orderElements: orderReads.elements,
          orderLengths: orderReads.lengths,
          headers: Object.fromEntries(notices.headers),
          list: notices.list,
        })
      } finally {
        r.dispose()
      }
    }, 600_000)

    it(`reparent files nothing at ${scale}x`, () => {      const r = rig(scale)
      try {
        const { pool } = r.handle
        // A visible nested row moved between two present top-level roots: the
        // placement never reads the parent edge.
        const order = visibleOrder(pool)
        const presentTop = order.filter((id) => {
          const row = pool.visibleInputs.issueRow(id) as SliceIssue | undefined
          return (
            row !== undefined &&
            (row.parentId === null || row.parentId === undefined) &&
            pool.groups.placement(id) !== undefined
          )
        })
        let found: { id: string; from: string; to: string } | null = null
        for (const id of order) {
          const row = pool.visibleInputs.issueRow(id) as SliceIssue | undefined
          if (row?.parentId === null || row?.parentId === undefined) continue
          if (pool.groups.placement(id) === undefined) continue
          const from = row.parentId as string
          const to = presentTop.find((candidate) => candidate !== from && candidate !== id)
          if (to === undefined) continue
          if (!pool.worklist.has(from) || !pool.worklist.has(to)) continue
          found = { id, from, to }
          break
        }
        expect(found, 'a visible nested row and two present roots').not.toBeNull()
        const { id: target, to } = found!
        pool.stats.reset()
        let orderReads = { elements: 0, lengths: 0 }
        const notices = countNotices(pool, () => {
          orderReads = countOrderReads(pool, () => {
            r.push({
              type: 'update',
              rows: [{ kind: 'issue', id: target, value: { ...corpusIssue(r, target), parentId: to } }],
            })
          })
        })
        expect(pool.worklist.has(target), 'reparented row stays visible').toBe(true)
        expect(pool.stats.counters.groupRuns, 'filings').toBe(0)
        expect(pool.stats.counters.membershipFlips, 'membership flips').toBe(0)
        expect(orderReads.elements, 'order elements iterated').toBe(0)
        expect(orderReads.lengths, 'order length reads').toBe(0)
        expect([...notices.headers.values()].reduce((a, b) => a + b, 0), 'header notices').toBe(0)
        expect(notices.list, 'list notices').toBe(0)
        writeResult(`hand-scaling-4694-${scale}x-reparent`, {
          scale,
          at: 'reparent',
          target,
          filings: 0,
          orderElements: orderReads.elements,
          orderLengths: orderReads.lengths,
          headers: Object.fromEntries(notices.headers),
          list: notices.list,
        })
      } finally {
        r.dispose()
      }
    }, 600_000)
  }

  /**
   * A bulk replace files the same lanes as a fresh bootstrap of the grown
   * rows. A row filed before its rank arrived lands at the lane end; its
   * rank arrival comes back on the worklist's entered path (its rank cell
   * runs for the first time), and the settle re-places it by its current
   * rank instead of dropping the arrival on the placement-equal skip —
   * without this, bulk grows (rescope onto 2x) leave rows stranded out of
   * rank order while the flat order stays exact.
   */
  it('bulk replace matches a fresh bootstrap at 2x', () => {
    const grown = buildCorpus(2)
    const grownRows: RowRecord[] = [
      ...grown.sliceSessions.map(
        (value): RowRecord => ({ kind: 'session', id: value.sessionId, value }),
      ),
      ...grown.sliceIssues.map((value): RowRecord => ({ kind: 'issue', id: value.id, value })),
      ...grown.sliceWorktrees.map((value): RowRecord => ({ kind: 'worktree', id: value.path, value })),
    ]
    const a = rig(1)
    try {
      a.push({ type: 'replace', rows: grownRows })
      a.handle.settleLoads()
      const b = rig(2)
      try {
        expect([...a.handle.pool.order()], 'flat order after replace').toEqual([
          ...b.handle.pool.order(),
        ])
        const after = sliceOrderOf(a.handle.pool.groups.snapshot())
        const fresh = sliceOrderOf(b.handle.pool.groups.snapshot())
        expect(
          diffSnapshots({ order: after, rowsById: {} }, { order: fresh, rowsById: {} }),
          'grouped order after replace',
        ).toBeNull()
        writeResult('hand-scaling-4694-2x-replace', {
          scale: 2,
          at: 'bulkReplace',
          visible: b.handle.pool.order().length,
        })
      } finally {
        b.dispose()
      }
    } finally {
      a.dispose()
    }
  }, 600_000)
})
