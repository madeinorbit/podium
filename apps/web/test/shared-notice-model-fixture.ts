/** Import-only adapter for the existing row-reader fixture. Records enter the
 * real pool once; all assertions and snapshots still exercise production views. */
import { MobxPool } from '@podium/client-graph/pool'
import '@podium/client-graph/message-models'
import { NOT_VISIBLE } from '@podium/client-graph/lookup'
import { afterEach, vi } from 'vitest'

const pools = new Set<MobxPool>()
const fixtures = new WeakMap<object, MobxPool>()
function sharedPool(fixture: MobxPool): MobxPool {
  if (typeof fixture.model === 'function') return fixture
  let pool = fixtures.get(fixture)
  if (pool) return pool
  pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  const owning = pool
  const read = owning.row.bind(owning)
  owning.row = ((entity: string, id: string, absent?: 'load' | 'mark' | 'summary-fields') => {
    if (entity === 'messageRecord' || entity === 'pendingInteraction' || entity === 'session') {
      if (!owning.tables[entity].has(id)) {
        const row = fixture.row(entity as 'messageRecord', id)
        if (row) owning.apply({ type: 'update', rows: [{ kind: entity, id, value: row as never }] })
      }
      return read(entity as 'messageRecord', id, absent)
    }
    return fixture.row(entity as 'noticeSession', id) ?? NOT_VISIBLE
  }) as MobxPool['row']
  fixtures.set(fixture, owning)
  pools.add(owning)
  return owning
}
afterEach(() => { for (const pool of pools) pool.dispose(); pools.clear() })
vi.mock('@podium/client-graph/notice-views', async importOriginal => {
  const real = await importOriginal<typeof import('@podium/client-graph/notice-views')>()
  return {
    ...real,
    noticeMessageCount: (pool: MobxPool) => real.noticeMessageCount(sharedPool(pool)),
    noticeNewestMessage: (pool: MobxPool) => real.noticeNewestMessage(sharedPool(pool)),
    noticeMessages: (pool: MobxPool, limit?: number) => real.noticeMessages(sharedPool(pool), limit),
    noticeInteractions: (pool: MobxPool, id: string) => real.noticeInteractions(sharedPool(pool), id),
    noticeRecovery: (pool: MobxPool) => real.noticeRecovery(sharedPool(pool)),
    noticeContinuity: (pool: MobxPool) => real.noticeContinuity(sharedPool(pool)),
  }
})
