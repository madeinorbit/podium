/**
 * POD-4598 (H3) — M3's identity check (`m3-index-identity.test.ts`, §7 G4),
 * ported to the hand pool's relation engine (`arms/hand/pool/relations.ts`).
 *
 * The hand F1 guard (`arms/hand/pool/relations.test.ts`, "bucket upkeep is
 * O(1) in the bucket") counts element work by patching `Set`/`Map` methods,
 * their iterators and `Array.prototype.sort`. Two copy idioms call none of
 * those on the copied set: `set.union(other)` copies the receiver's data
 * natively, and `structuredClone(set)` calls no prototype method. M3 found
 * both escaping the MobX guard (G4). This file asks the question that closes
 * the class: during one change, was any container the engine already held
 * REPLACED by another object? An in-place update keeps the object; a
 * copy-on-write swaps it, whatever idiom made the copy.
 *
 * The rig differs from the hand guard's on purpose: the guard's rig holds
 * issues only, so it never places a session and a plant in the prefix index
 * (`place()`) or a session bucket cannot fire there. Here 4,000 issues sit in
 * repo R and 4,000 sessions sit under `/repo` and in issue E, so every edge
 * kind touches a 4,000-member container.
 *
 * Each plant is applied to the engine instance (as the hand guard's own
 * plants are), and the same edges are also measured with a verbatim copy of
 * the hand guard's counter (`elementOps`), so the output shows which plants
 * the counter sees and which only the identity check sees. The authoritative
 * run of the real guard against source plants is in the review document.
 */

import { describe, expect, it } from 'vitest'
import { HandPool } from '../../arms/hand/pool/pool'
import { DISABLED_READ_FENCE } from '../../shared/src/instrument/reads'
import { settableLocals } from '../../shared/src/locals-source'
import { prefixAncestors } from '../../shared/src/schema'
import type { RowRecord } from '../../shared/src/stats'
import { createReplaySource } from '../src/count-harness'
import { type EngineInside, elementOps, held, replaced, report } from './h3-witness'

const T0 = '2026-09-23T00:00:00.000Z'
const B = 4000

const issue = (id: string): RowRecord => ({
  kind: 'issue',
  id,
  value: {
    id,
    seq: Number(id.replace(/\D/g, '')) || 1,
    title: `Issue ${id}`,
    stage: 'in_progress',
    createdAt: T0,
    updatedAt: T0,
    repoId: 'R',
    repoPath: '/repo',
    parentId: null,
    worktreePath: null,
    deps: [],
    audience: 'human',
  } as RowRecord['value'],
})
const session = (sessionId: string, cwd: string): RowRecord => ({
  kind: 'session',
  id: sessionId,
  value: {
    sessionId,
    issueId: 'E',
    cwd,
    status: 'live',
    lastActiveAt: T0,
    agentKind: 'claude-code',
  } as RowRecord['value'],
})
const lane = (path: string): RowRecord => ({
  kind: 'worktree',
  id: path,
  value: { path, repoId: 'R', repoPath: '/repo', prefix: 'POD' } as RowRecord['value'],
})
const gone = (kind: RowRecord['kind'], id: string): RowRecord => ({ kind, id, value: undefined })

type Copy = (set: Set<string>) => Set<string>
const union: Copy = (set) =>
  (set as unknown as { union(o: Set<string>): Set<string> }).union(new Set<string>())
const clone: Copy = (set) => structuredClone(set)
const spread: Copy = (set) => new Set(set)

/** A copy-on-write of the prefix index: every ancestor set of the placed path is replaced by `copy`. */
function underCopy(copy: Copy) {
  return (pool: HandPool): void => {
    const engine = pool.engine as unknown as EngineInside
    const place = engine.place.bind(engine)
    engine.place = (link, id, normalized) => {
      place(link, id, normalized)
      const under = (link as { under: Map<string, Set<string>> }).under
      if (normalized === null) return
      for (const path of prefixAncestors(normalized)) {
        const set = under.get(path)
        if (set !== undefined) under.set(path, copy(set))
      }
    }
  }
}

/** A copy-on-write of the target bucket after every attach. */
function bucketCopy(copy: Copy) {
  return (pool: HandPool): void => {
    const engine = pool.engine as unknown as EngineInside
    const point = engine.point.bind(engine)
    engine.point = (link, id, target) => {
      point(link, id, target)
      const buckets = (link as { buckets: Map<string, Set<string>> }).buckets
      const bucket = target === null ? undefined : buckets.get(target)
      if (target !== null && bucket !== undefined) buckets.set(target, copy(bucket))
    }
  }
}

const PLANTS: readonly [string, ((pool: HandPool) => void) | null][] = [
  ['clean', null],
  ['P4 under: new Set(set)', underCopy(spread)],
  ['P7 under: set.union(empty)', underCopy(union)],
  ['P8 under: structuredClone(set)', underCopy(clone)],
  ['PB7 bucket: set.union(empty)', bucketCopy(union)],
  ['PB8 bucket: structuredClone(set)', bucketCopy(clone)],
]

type EdgeResult = { replaced: ReturnType<typeof replaced>; counterOps: number }

function runEdges(plant: ((pool: HandPool) => void) | null): Record<string, EdgeResult> {
  const rows: RowRecord[] = [lane('/repo'), issue('E')]
  for (let i = 0; i < B; i += 1) rows.push(issue(`B${i}`), session(`BS${i}`, `/repo/x${i}`))
  const replay = createReplaySource({
    issues: rows.filter((row) => row.kind === 'issue'),
    sessions: rows.filter((row) => row.kind === 'session'),
    worktrees: rows.filter((row) => row.kind === 'worktree'),
  })
  const locals = settableLocals({ selectedIssueId: null, coarseNow: Date.parse(T0) })
  const pool = new HandPool(DISABLED_READ_FENCE, locals.source.get())
  const source = replay.source
  pool.apply({
    type: 'replace',
    rows: [
      ...source.snapshot('session'),
      ...source.snapshot('issue'),
      ...source.snapshot('worktree'),
    ],
  })
  const off = source.subscribe((event) => pool.apply(event))
  try {
    expect(pool.engine.members('repo', 'R', 'issues').size).toBe(B + 1)
    expect(pool.engine.members('worktree', '/repo', 'sessions').size).toBe(B)
    expect(pool.engine.members('issue', 'E', 'sessions').size).toBe(B)
    plant?.(pool)
    const edges: [string, RowRecord][] = [
      ['new issue', issue('N1')],
      ['removed issue', gone('issue', 'B7')],
      ['new session', session('NS1', '/repo/y')],
      ['removed session', gone('session', 'BS7')],
    ]
    const seen: Record<string, EdgeResult> = {}
    for (const [label, change] of edges) {
      const before = held(pool)
      const counterOps = elementOps(() => replay.push({ type: 'update', rows: [change] }))
      seen[label] = { replaced: replaced(before, held(pool)), counterOps }
    }
    return seen
  } finally {
    off()
    pool.dispose()
    locals.dispose()
  }
}

describe('the hand relation engine updates its containers in place (H3, M3 G4 ported)', () => {
  for (const [name, plant] of PLANTS) {
    it(`${name}: ${plant === null ? 'no container replaced' : 'the identity check names the copy'}`, () => {
      const seen = runEdges(plant)
      report(`[h3-index-identity] ${name} ${JSON.stringify(seen)}`)
      if (plant === null) {
        for (const [label, result] of Object.entries(seen)) {
          expect(result.replaced, `${label}: containers replaced by a copy`).toEqual({
            keys: 0,
            elements: 0,
            where: [],
          })
        }
        return
      }
      // The plant fires on at least one edge, and there it re-copies a 4,000-member set.
      const worst = Math.max(...Object.values(seen).map((r) => r.replaced.elements))
      expect(worst, `${name}: elements in replaced containers`).toBeGreaterThanOrEqual(B)
    }, 120_000)
  }
})
