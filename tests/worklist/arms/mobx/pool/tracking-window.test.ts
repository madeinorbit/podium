import { autorun } from 'mobx'
import { expect, it } from 'vitest'
import { MobxPool } from '@podium/client-graph/pool'
import { PoolRelations } from '@podium/client-graph/relations'
import { VisibleCollection } from '@podium/client-graph/worklist/visible'
import { worklistGroups } from '@podium/client-graph/worklist/groups'
import { sidebarView } from '@podium/client-graph/worklist/sidebar'
import { openFenceFeeds } from '../../../harness/src/fence-scenarios'
import { harnessMobxPoolArm } from '../../../harness/src/adapters/mobx-pool'
import { phaseMethod, startCensus } from '../../../harness/src/mobx-census'
import { installMobxWarnTrap } from '../../../harness/src/mobx-trap'
import { createReadFence } from '../../../shared/src/instrument/reads'
import { startScenarioEngine } from '../../../shared/src/scenarios'

installMobxWarnTrap()

it.each([false, true])('fills the same first-paint window with census=%s', async (measured) => {
  const ctx = await startScenarioEngine(1)
  const feeds = openFenceFeeds(ctx, 'pooled')
  const reads = createReadFence({ enabled: true })
  const census = measured ? startCensus({ sample: () => {
    const stats = reads.stats()
    reads.reset()
    return { rowReads: Object.values(stats.accesses).reduce((a, b) => a + b, 0) }
  } }) : null
  const restores = census === null ? [] : [
    phaseMethod(census, MobxPool.prototype, 'apply', 'ingest'),
    phaseMethod(census, PoolRelations.prototype, 'publish', 'relationUpkeep', () => {
      if (census.phase === 'ingest') census.relabel('firstReactiveRun')
    }),
    phaseMethod(census, PoolRelations.prototype, 'reset', 'relationUpkeep', () => {
      if (census.phase === 'ingest') census.relabel('firstReactiveRun')
    }),
    phaseMethod(census, VisibleCollection.prototype, 'track', 'nodeConstruction'),
  ]
  census?.enter('create')
  const handle = harnessMobxPoolArm.create(reads.wrapSource(feeds.rows.source), feeds.locals.source, reads, {
    schedule: () => () => {},
  })
  let stop: (() => void) | undefined
  try {
    census?.exit()
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
    for (const restore of restores.reverse()) restore()
    census?.stop()
    handle.dispose()
    feeds.dispose()
    ctx.dispose()
  }
})
