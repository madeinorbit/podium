import { createRequire } from 'node:module'
import { expect, it } from 'vitest'
import { here } from './lookup'
import { MobxPool } from './pool'
import './message-models'

it('reports retained heap per message identity separately from stored rows', async () => {
  const count = 8192
  const pool = new MobxPool({ coarseNow: 0, selectedIssueId: null })
  const ids = Array.from({ length: count }, (_, i) => `memory-${i}`)
  pool.apply({ type: 'update', rows: ids.map(id => ({ kind: 'message', id, value: {
    id, sessionId: 'seat', senderUserId: 'user', body: 'Synthetic words', status: 'stored', createdAt: '2026-10-10T12:00:00Z',
  } })) })
  const { heapStats } = createRequire(import.meta.url)('bun:jsc') as { heapStats(): { heapSize: number } }
  const heap = () => { (globalThis as unknown as { Bun: { gc(force: boolean): void } }).Bun.gc(true); return heapStats().heapSize }
  try {
    // Warm shared constructors/map allocation before measuring marginal identities.
    expect(here(pool.model('message', ids[0]!))?.id).toBe(ids[0])
    const before = heap()
    for (const id of ids) expect(here(pool.model('message', id))?.id).toBe(id)
    const allocated = heap() - before
    console.log(JSON.stringify({ metric: 'message-model-retained-heap', identities: count - 1,
      bytes: allocated, bytesPerModel: Math.round(allocated / (count - 1)),
      scope: 'shared model identities and pool model-map entries; excludes already-stored rows and lazy notice/ledger fields' }))
  } finally { pool.dispose() }
})
