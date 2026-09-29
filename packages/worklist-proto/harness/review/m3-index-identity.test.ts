/**
 * POD-4591 (M3), final review §7 — a check that sees a copy-on-write of the
 * relation engine's sets whatever idiom makes the copy.
 *
 * The F1 guard (`arms/mobx/pool/relations.test.ts`, "bucket upkeep is
 * proportional to the change") counts element work by patching `Set`, `Map`,
 * `ObservableSet`, `Array.from` and the sorts. A copy that none of those
 * methods sees gets past it: `set.union(new Set())` copies the receiver's
 * data natively, `structuredClone(set)` never calls a prototype method, and
 * MobX's `toJS(set)` does its iteration and adds inside MobX, which the guard
 * skips on purpose (§7, G4). Each one, as a copy-on-write in `place()`,
 * copies 8,003 elements per new session and the guard stays green.
 *
 * This check does not count work. It asks whether a set the engine already
 * held was REPLACED by another object during one change: an in-place update
 * keeps the object, a copy-on-write swaps it, by any idiom. It reads the
 * engine's containers (`under`, `buckets`, `coldBuckets` per link, and each
 * collapse's `groups`) before and after each edge of the F1 rig.
 */

import { describe, expect, it } from 'vitest'
import { installMobxWarnTrap } from '../../arms/mobx/pool/mobx-trap'
import { MobxPool } from '../../arms/mobx/pool/pool'
import { tracked } from '../src/adapters/mobx-pool'
import { createReadFence } from '../../shared/src/instrument/reads'
import { settableLocals } from '../../shared/src/locals-source'
import type { RowRecord } from '../../shared/src/stats'
import { createReplaySource } from '../src/count-harness'

installMobxWarnTrap()

const T0 = '2026-09-23T00:00:00.000Z'

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
    issueId: null,
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

type SetLike = { readonly size: number }
type MapLike = { forEach(fn: (value: unknown, key: unknown) => void): void }
/** Every set the engine holds, by container and key: the object and its size. */
type Held = Map<string, { set: SetLike; size: number }>

function held(pool: MobxPool): Held {
  const out: Held = new Map()
  const engine = pool.graph as unknown as {
    links: Map<string, Record<string, unknown>>
    collapses: Map<string, { groups: MapLike }>
  }
  const take = (label: string, container: unknown): void => {
    if (container === null || container === undefined) return
    ;(container as MapLike).forEach((value, key) => {
      const set = value as SetLike
      out.set(`${label}:${String(key)}`, { set, size: set.size })
    })
  }
  tracked(() => {
    for (const [name, link] of engine.links) {
      for (const field of ['under', 'buckets', 'coldBuckets']) take(`${name}.${field}`, link[field])
    }
    for (const [entity, collapse] of engine.collapses) take(`${entity}.groups`, collapse.groups)
  })
  return out
}

/** Sets held both before and after that are different objects: elements re-copied. */
function replaced(before: Held, after: Held): { keys: number; elements: number } {
  let keys = 0
  let elements = 0
  for (const [key, was] of before) {
    const now = after.get(key)
    if (now === undefined || now.set === was.set) continue
    keys += 1
    elements += now.size
  }
  return { keys, elements }
}

describe('the relation engine updates its sets in place (M3 §7, G4)', () => {
  const B = 4000
  const rows: RowRecord[] = [lane('/repo')]
  for (let i = 0; i < B; i += 1) rows.push(issue(`B${i}`), session(`BS${i}`, `/repo/x${i}`))

  it(`no set is replaced by a copy on one insert or delete, in buckets of ${B}`, () => {
    const replay = createReplaySource({
      issues: rows.filter((row) => row.kind === 'issue'),
      sessions: rows.filter((row) => row.kind === 'session'),
      worktrees: rows.filter((row) => row.kind === 'worktree'),
    })
    const locals = settableLocals({ selectedIssueId: null, coarseNow: Date.parse(T0) })
    const reads = createReadFence({ enabled: true })
    const pool = new MobxPool(reads, locals.source.get())
    const source = reads.wrapSource(replay.source)
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
      const edges: [string, RowRecord][] = [
        ['new issue', issue('N1')],
        ['removed issue', gone('issue', 'B7')],
        ['new session', session('NS1', '/repo/y')],
        ['removed session', gone('session', 'BS7')],
      ]
      const seen: Record<string, { keys: number; elements: number }> = {}
      for (const [label, change] of edges) {
        const before = held(pool)
        replay.push({ type: 'update', rows: [change] })
        seen[label] = replaced(before, held(pool))
      }
      console.info(`[m3-index-identity] ${JSON.stringify(seen)}`)
      for (const [label, result] of Object.entries(seen)) {
        expect(result, `${label}: sets replaced by a copy`).toEqual({ keys: 0, elements: 0 })
      }
    } finally {
      off()
      pool.dispose()
      locals.dispose()
    }
  }, 120_000)
})
