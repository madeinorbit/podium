/** Assemble the real layout read path over a seeded model pool. No shadow layout. */

import { here } from '@podium/client-graph/lookup'
import { MobxPool } from '@podium/client-graph/pool'
import { layoutRowId, type UserId } from '@podium/model'
import { createRecordsApi } from '../src/records'
import { LayoutAccess } from '../src/ui/layout-access'

export function layoutFixture(
  userId: UserId,
  write: Parameters<typeof createRecordsApi>[0] = async () => {},
  initial: Readonly<Record<string, unknown>> | null = {},
) {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  const layout = new LayoutAccess(userId, createRecordsApi(write))
  const read = (key: string) => here(pool.model('userLayout', layoutRowId(userId, key)))?.value
  const detach = layout.attach(read)
  pool.bindLayout({
    read,
    ready: (key) => typeof pool.model('userLayout', layoutRowId(userId, key)) !== 'symbol',
    write: (key, value) => layout.set(key, value),
  })
  const seed = (snapshot: Readonly<Record<string, unknown>>) =>
    pool.apply({
      type: 'replace',
      rows: Object.entries(snapshot).map(([key, value]) => ({
        kind: 'userLayout',
        id: layoutRowId(userId, key),
        value: { userId, key, value },
      })),
    })
  if (initial !== null) seed(initial)
  return {
    pool,
    layout,
    seed,
    dispose: () => {
      detach()
      pool.dispose()
    },
  }
}
