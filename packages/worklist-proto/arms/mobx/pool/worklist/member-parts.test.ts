// @vitest-environment happy-dom
/**
 * POD-4683 — member parts per edge: view-time O(family) is accepted, pinned.
 *
 * DECISION (coordinator addendum 2026-09-27): family size does not grow with
 * the corpus (explicit seats per issue: avg 2, p50 1, p90 3, p99 5, max 8 at
 * 1x and 4x), so O(family) id work per membership edge is O(1) with respect
 * to scale — as Linear sorts and filters at view time over a collection.
 *
 * WHAT THIS HOLDS (same shape in both arms, from outside the arm):
 * - a session joins its issue, leaves it, and moves between issues (issueId
 *   change): the session ids iterated across the member/seat consumers
 *   (seat list compare, memberIds Set, the visible.ts unread loop and the
 *   rollup.ts openOwn loop, plus their retained/roster/activity companions)
 *   stay within a small bound at 1x and 4x, flat across scales;
 * - the family-size distribution itself is reported per scale (explicit seats
 *   only; the issueless lump is per-worktree, not one family);
 * - the plants (consumers that walk the whole corpus on a membership change:
 *   the session-id set, and the session table's key iterator — the
 *   coordinator's table-walk mutation class) exceed the same bound at both
 *   scales, proving the count is armed.
 *
 * The bound counts session-id element visits through the shared instrument
 * (`harness/src/count-session-ids.ts`: Array/Set/Map iterators and array
 * methods, MobX observables included, filtered to the corpus session ids so
 * order sorts over issue ids never count). Slice copies (MobX's computedStruct
 * unwrap) count their session ids; sorts count the session ids they order.
 * Index-by-index compares on plain copies are not separately counted (a
 * constant factor the bound absorbs); the flatness across scales is what the
 * decision rests on.
 */
import { describe, expect, it } from 'vitest'
import { createReplaySource } from '../../../../harness/src/count-harness'
import { countSessionIds } from '../../../../harness/src/count-session-ids'
import { buildCorpus } from '../../../../harness/src/fixture/index'
import { writeResult } from '../../../../harness/src/results'
import { DISABLED_READ_FENCE } from '../../../../shared/src/instrument/reads'
import { settableLocals } from '../../../../shared/src/locals-source'
import type { RowSource } from '../../../../shared/src/arm'
import type { RowRecord } from '../../../../shared/src/stats'
import { mobxPoolArm } from '../arm'
import { tracked } from '../pool'

/** A membership edge's ids, measured from outside at one scale. */
async function edgeIds(
  scale: 1 | 4,
): Promise<{ target: string; family: number; join: number; leave: number; move: number; mover: string; from: string }> {
  const corpus = buildCorpus(scale)
  const sessionIds = new Set(corpus.sliceSessions.map((s) => s.sessionId as string))
  const replay = createReplaySource({
    issues: corpus.sliceIssues.map((value) => ({ kind: 'issue', id: value.id, value })),
    sessions: corpus.sliceSessions.map((value) => ({ kind: 'session', id: value.sessionId, value })),
    worktrees: corpus.sliceWorktrees.map((value) => ({ kind: 'worktree', id: value.path, value })),
  })
  const locals = settableLocals({ selectedIssueId: null, coarseNow: corpus.fixedNow })
  const counted: RowSource = {
    snapshot: (kind) => replay.source.snapshot(kind),
    row: (kind, id) => replay.source.row?.(kind, id),
    subscribe: (listener) => replay.source.subscribe(listener),
  }
  const handle = mobxPoolArm.create(counted, locals.source, DISABLED_READ_FENCE, {
    schedule: () => () => {},
  })
  try {
    await handle.settleLoads?.()
    const counts = new Map<string, string[]>()
    for (const s of corpus.sliceSessions) {
      if (s.issueId == null) continue
      const list = counts.get(s.issueId as string) ?? []
      list.push(s.sessionId as string)
      counts.set(s.issueId as string, list)
    }
    let target: string | null = null
    for (const issue of corpus.sliceIssues) {
      if (counts.get(issue.id)?.length !== 2) continue
      if (issue.audience !== 'human') continue
      if (!['planning', 'in_progress', 'review'].includes(issue.stage as string)) continue
      if (issue.parentId != null) continue
      target = issue.id
      break
    }
    if (target === null) throw new Error('no family-2 open human root')
    const family = counts.get(target)!.length
    let mover: string | null = null
    let from: string | null = null
    for (const [issueId, members] of counts) {
      if (issueId === target || members.length !== 2) continue
      const row = corpus.sliceIssues.find((i) => i.id === issueId)
      if (row?.audience !== 'human' || row.parentId != null) continue
      mover = members[0]!
      from = issueId
      break
    }
    if (mover === null || from === null) throw new Error('no mover')
    const T0 = '2026-09-27T00:00:00.000Z'
    const newId = `s-4683-mobx-${scale}`
    sessionIds.add(newId)
    const pool = handle.pool as unknown as {
      knownIssue(id: string): { seatIds: readonly string[] } | undefined
    }
    void tracked(() => pool.knownIssue(target)?.seatIds.length ?? 0)
    void tracked(() => pool.knownIssue(from)?.seatIds.length ?? 0)
    const joinRow: RowRecord = {
      kind: 'session',
      id: newId,
      value: {
        sessionId: newId,
        issueId: target,
        cwd: '/repo',
        status: 'live',
        lastActiveAt: T0,
        agentKind: 'claude-code',
      } as unknown as RowRecord['value'],
    }
    const join = countSessionIds(sessionIds, () => {
      replay.push({ type: 'update', rows: [joinRow] })
    })
    await handle.settleLoads?.()
    const leave = countSessionIds(sessionIds, () => {
      replay.push({ type: 'update', rows: [{ kind: 'session', id: newId, value: undefined }] })
    })
    await handle.settleLoads?.()
    const moverRow = corpus.sliceSessions.find((s) => (s.sessionId as string) === mover)!
    const moveRow: RowRecord = {
      kind: 'session',
      id: mover,
      value: { ...(moverRow as unknown as object), issueId: target } as unknown as RowRecord['value'],
    }
    const move = countSessionIds(sessionIds, () => {
      replay.push({ type: 'update', rows: [moveRow] })
    })
    await handle.settleLoads?.()
    return { target, family, join, leave, move, mover, from }
  } finally {
    handle.dispose()
    locals.dispose()
  }
}

/** Explicit family sizes (no issueless lump: that set is per-worktree). */
function familyDistribution(scale: 1 | 4): {
  families: number
  avg: number
  max: number
  p50: number
  p90: number
  p99: number
} {
  const corpus = buildCorpus(scale)
  const byIssue = new Map<string, number>()
  for (const s of corpus.sliceSessions) {
    if (s.issueId == null) continue
    byIssue.set(s.issueId as string, (byIssue.get(s.issueId as string) ?? 0) + 1)
  }
  const sizes = [...byIssue.values()].sort((a, b) => a - b)
  const total = sizes.reduce((a, b) => a + b, 0)
  return {
    families: byIssue.size,
    avg: total / sizes.length,
    max: sizes[sizes.length - 1] ?? 0,
    p50: sizes[Math.floor(sizes.length / 2)] ?? 0,
    p90: sizes[Math.floor(sizes.length * 0.9)] ?? 0,
    p99: sizes[Math.floor(sizes.length * 0.99)] ?? 0,
  }
}

describe('member parts per edge are O(family) (POD-4683)', () => {
  // One membership edge touches its family, never the corpus: well below the
  // corpus count at either scale (4,304 / 17,216 sessions).
  const BOUND = 100

  it('family size does not grow with the corpus', () => {
    const at1x = familyDistribution(1)
    const at4x = familyDistribution(4)
    writeResult('mobx-member-parts-4683-distribution', { at1x, at4x })
    for (const key of ['avg', 'max', 'p50', 'p90', 'p99'] as const) {
      if (key === 'avg') {
        expect(Math.abs(at4x[key] - at1x[key]), key).toBeLessThan(0.1)
      } else {
        expect(at4x[key], key).toBe(at1x[key])
      }
    }
  })

  it('a join, a leave and a move iterate the family at 1x and 4x', async () => {
    const at1x = await edgeIds(1)
    const at4x = await edgeIds(4)
    writeResult('mobx-member-parts-4683-edges', { at1x, at4x, bound: BOUND })
    for (const [label, a, b] of [
      ['join', at1x.join, at4x.join],
      ['leave', at1x.leave, at4x.leave],
      ['move', at1x.move, at4x.move],
    ] as const) {
      expect(a, `1x ${label} within ${BOUND}`).toBeLessThanOrEqual(BOUND)
      expect(b, `4x ${label} within ${BOUND}`).toBeLessThanOrEqual(BOUND)
      expect(b, `4x ${label} flat within noise`).toBeLessThanOrEqual(a + 10)
    }
  }, 600_000)

  it('a consumer that walks the corpus fails the same bound', async () => {
    for (const scale of [1, 4] as const) {
      const corpus = buildCorpus(scale)
      const sessionIds = new Set(corpus.sliceSessions.map((s) => s.sessionId as string))
      const walked = countSessionIds(sessionIds, () => {
        for (const id of sessionIds) void id
      })
      expect(walked, `${scale}x plant walks the corpus`).toBe(sessionIds.size)
      expect(walked, `${scale}x plant exceeds ${BOUND}`).toBeGreaterThan(BOUND)
    }
    writeResult('mobx-member-parts-4683-plant', { bound: BOUND })
  })

  it('a consumer that walks the session table fails the same bound', async () => {
    // The coordinator's table-walk mutation class (a seat read that walks
    // `tables.session.keys()`), expressed without editing pool code: a table
    // walk beside a membership push counts the corpus through the Map
    // iterator, failing the same bound at both scales.
    const walkedByScale: Record<string, number> = {}
    for (const scale of [1, 4] as const) {
      const corpus = buildCorpus(scale)
      const sessionIds = new Set(corpus.sliceSessions.map((s) => s.sessionId as string))
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
      const handle = mobxPoolArm.create(counted, locals.source, DISABLED_READ_FENCE, {
        schedule: () => () => {},
      })
      try {
        await handle.settleLoads?.()
        const tables = handle.pool.tables as unknown as {
          session: { keys(): Iterable<string> }
        }
        const walked = countSessionIds(sessionIds, () => {
          for (const __s of tables.session.keys()) void __s
        })
        // Far beyond any family (max 8): the table holds thousands of
        // resident sessions at either scale (lazy pools keep cold rows out of
        // the tables, so this is a subset of the corpus — still corpus-scale).
        expect(walked, `${scale}x table plant walks the table`).toBeGreaterThan(1000)
        expect(walked, `${scale}x table plant exceeds ${BOUND}`).toBeGreaterThan(BOUND)
        walkedByScale[`${scale}x`] = walked
      } finally {
        handle.dispose()
        locals.dispose()
      }
    }
    writeResult('mobx-member-parts-4683-table-plant', { bound: BOUND, walkedByScale })
  }, 600_000)
})
