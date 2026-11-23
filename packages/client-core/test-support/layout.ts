/** Assemble LayoutAccess over seeded userLayout models. A null seed leaves
 * the layout detached until the first snapshot, like runtime pool attachment. */

import { layoutRowId, type UserId } from '@podium/model'
import { runInAction } from 'mobx'
import { here } from '../../client-graph/src/lookup'
import { MobxPool } from '../../client-graph/src/pool'
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
  let detach = () => {}
  const seed = (snapshot: Readonly<Record<string, unknown>>) =>
    runInAction(() => {
      pool.apply({
        type: 'replace',
        rows: Object.entries(snapshot).map(([key, value]) => ({
          kind: 'userLayout',
          id: layoutRowId(userId, key),
          value: { userId, key, value },
        })),
      })
      if (!pool.hasLayout) {
        detach = layout.attach(read)
        pool.bindLayout({
          read,
          ready: (key) => typeof pool.model('userLayout', layoutRowId(userId, key)) !== 'symbol',
          write: (key, value) => layout.set(key, value),
        })
      }
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
