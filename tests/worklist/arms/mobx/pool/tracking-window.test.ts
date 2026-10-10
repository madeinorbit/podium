import { autorun } from 'mobx'
import { expect, it } from 'vitest'
import { worklistGroups } from '@podium/client-graph/worklist/groups'
import { sidebarView } from '@podium/client-graph/worklist/sidebar'
import { openFenceFeeds } from '../../../harness/src/fence-scenarios'
import { harnessMobxPoolArm } from '../../../harness/src/adapters/mobx-pool'
import { startCensus } from '../../../harness/src/mobx-census'
import { installMobxWarnTrap } from '../../../harness/src/mobx-trap'
import { createReadFence } from '../../../shared/src/instrument/reads'
import { startScenarioEngine } from '../../../shared/src/scenarios'

installMobxWarnTrap()

it.each([false, true])('fills the same first-paint window with census=%s', async (measured) => {
  const ctx = await startScenarioEngine(1)
  const feeds = openFenceFeeds(ctx, 'pooled')
  const reads = createReadFence({ enabled: true })
  const census = measured ? startCensus() : null
  const handle = harnessMobxPoolArm.create(reads.wrapSource(feeds.rows.source), feeds.locals.source, reads, {
    schedule: () => () => {},
  })
  let stop: (() => void) | undefined
  try {
    census?.snapshot()
    let ids: string[] = []
    stop = autorun(() => {
      void sidebarView(handle.pool).sections()
      const groups = worklistGroups(handle.pool)
      ids = [...groups.pinnedIds]
      for (const key of groups.keys) {
        const group = groups.group(key)
        ids.push(...group.rowIds, ...group.closedIds)
      }
    })
    expect(ids.length, 'product window has rows before any load').toBeGreaterThanOrEqual(20)
  } finally {
    stop?.()
    census?.stop()
    handle.dispose()
    feeds.dispose()
    ctx.dispose()
  }
})
