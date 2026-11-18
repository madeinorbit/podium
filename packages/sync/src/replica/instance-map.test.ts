/**
 * POD-7115 — the markers' layered map behaves as a `Map` copied per mutation
 * did: the same entries, in the same order, and the map a mutation started
 * from unchanged.
 */
import { describe, expect, it } from 'vitest'
import { EMPTY_CACHE_META, nextCacheMeta } from './cache-state'
import type { InstanceOperation } from './ports'
import type { InstanceRecord } from './types'

const CURSOR = { feedId: 'feed', epoch: 'epoch', seq: 1 }
const marker = (key: string, at: number): InstanceRecord => ({
  key,
  collection: 'issueProjection.one',
  args: { id: key },
  part: 'main',
  completeAt: { ...CURSOR, seq: at },
})

function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

/** The old way: a fresh `Map` per mutation. */
function apply(map: Map<string, InstanceRecord>, ops: readonly InstanceOperation[]) {
  const next = new Map(map)
  for (const op of ops) {
    if (op.kind === 'mark') next.set(op.instance.key, op.instance)
    else if (op.kind === 'drop') next.delete(op.key)
    else if (op.kind === 'dropAll') next.clear()
    else {
      const held = next.get(op.key)
      if (held !== undefined) next.set(op.key, { ...held, releasedAt: op.at })
    }
  }
  return next
}

describe('the markers of a cache (POD-7115)', () => {
  it('equal a Map copied per mutation, in order, over random mutations', () => {
    for (let seed = 1; seed <= 12; seed += 1) {
      const next = random(seed)
      const keys = Array.from({ length: 5 + Math.floor(next() * 150) }, (_, i) => `k${i}`)
      let meta = EMPTY_CACHE_META
      let oracle = new Map<string, InstanceRecord>()
      const history: [ReadonlyMap<string, InstanceRecord>, [string, InstanceRecord][]][] = []
      for (let step = 0; step < 200; step += 1) {
        const ops: InstanceOperation[] = []
        for (let i = 0; i < 1 + Math.floor(next() * 6); i += 1) {
          const key = keys[Math.floor(next() * keys.length)] as string
          const roll = next()
          if (roll < 0.55) ops.push({ kind: 'mark', instance: marker(key, step) })
          else if (roll < 0.8) ops.push({ kind: 'drop', key })
          else if (roll < 0.995) ops.push({ kind: 'release', key, at: step })
          else ops.push({ kind: 'dropAll' })
        }
        const before = meta.instances
        meta = nextCacheMeta(meta, { operations: [], instances: ops }).meta
        oracle = apply(oracle, ops)
        const label = `seed ${seed} step ${step}`
        expect([...meta.instances], label).toEqual([...oracle])
        expect(meta.instances.size, label).toBe(oracle.size)
        for (let i = 0; i < 12; i += 1) {
          const key = keys[Math.floor(next() * keys.length)] as string
          expect(meta.instances.get(key), label).toEqual(oracle.get(key))
          expect(meta.instances.has(key), label).toBe(oracle.has(key))
        }
        if (step % 10 === 0) history.push([before, [...before]])
      }
      // No mutation changed the map it started from.
      for (const [map, entries] of history) expect([...map]).toEqual(entries)
    }
  })

  it('keeps the same map when a mutation changes no marker', () => {
    const meta = nextCacheMeta(EMPTY_CACHE_META, {
      operations: [],
      instances: [{ kind: 'mark', instance: marker('a', 1) }],
    }).meta
    const same = nextCacheMeta(meta, { operations: [], instances: [{ kind: 'drop', key: 'zz' }] })
    expect(same.meta.instances).toBe(meta.instances)
  })
})
