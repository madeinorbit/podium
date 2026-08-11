/**
 * POD-1651 EVIDENCE — is per-frame delta apply O(replica size)?
 *
 * `IndexedDbCacheStore.slice()` copies this principal's ENTIRE entity Map on the
 * first touch of a draft, and `applyAtomic` without a caller-supplied span takes
 * `autocommitEager`, which mints a FRESH span (and therefore a fresh draft) per
 * call. So a delta frame carrying one row should still cost O(rows already in the
 * replica). This measures that directly: N frames of one upsert each, at growing
 * N, reporting per-frame cost. Linear per-frame cost ⇒ quadratic total.
 *
 * Not a gate — it prints a measurement. Run it with `bun run test:perf:sync`.
 * See docs/evidence/pod-perf-coldload/.
 */
import { asUserId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { Cursor } from '../../replica/types'
import { REPLICA_DB_NAME } from './schema'
import { IndexedDbSyncStore } from './store'
import { freshFactory } from './test-support'

const PRINCIPAL = asUserId('ada')

// A payload roughly the shape of a real issue row rather than a bare scalar, so
// the Map copy and the structured-clone cost are not measured against a toy.
const value = (i: number): unknown => ({
  id: `POD-${i}`,
  title: `issue number ${i} with a title of a realistic length`,
  body: 'x'.repeat(400),
  stage: 'backlog',
  labels: ['perf', 'cold-load'],
  updatedAt: 1_700_000_000_000 + i,
})

const runN = async (n: number): Promise<number> => {
  const store = await IndexedDbSyncStore.open({
    factory: freshFactory(),
    databaseName: REPLICA_DB_NAME,
    onDegraded: () => {},
  })
  const cache = store.viewFor(PRINCIPAL).cache
  const t0 = performance.now()
  for (let i = 0; i < n; i++) {
    const cursor: Cursor = { feedId: 'feed', epoch: 'e1', seq: i + 1 }
    // One frame, one row — the shape a live delta stream has.
    cache.applyAtomic({
      operations: [
        {
          kind: 'upsert',
          entity: 'issue',
          entityId: `POD-${i}`,
          value: value(i),
          revision: i,
          // CacheOperation's upsert arm requires provenance; the sibling adapter
          // benches spell it `{ seq: cursor.seq }` (mobile-sqlite/quota.test.ts).
          provenance: { seq: cursor.seq },
        },
      ],
      cursor,
    })
  }
  return performance.now() - t0
}

describe('POD-1651: cost of applying N single-row delta frames', () => {
  it('reports per-frame cost as the replica grows', async () => {
    const results: { n: number; totalMs: number; perFrameUs: number }[] = []
    for (const n of [250, 500, 1000, 2000, 4000, 8000, 16000]) {
      const totalMs = await runN(n)
      results.push({ n, totalMs: Math.round(totalMs), perFrameUs: (totalMs * 1000) / n })
    }
    for (const r of results)
      console.log(
        `n=${String(r.n).padStart(5)}  total=${String(r.totalMs).padStart(6)}ms  per-frame=${r.perFrameUs.toFixed(1)}us`,
      )
    const first = results[0]
    const last = results[results.length - 1]
    if (first === undefined || last === undefined) throw new Error('no results')
    const sizeGrowth = last.n / first.n
    console.log(
      `PER_FRAME_GROWTH n=${first.n}->${last.n} (${sizeGrowth}x): ${(last.perFrameUs / first.perFrameUs).toFixed(2)}x`,
    )
    expect(results.length).toBeGreaterThan(3)
  }, 600_000)
})
