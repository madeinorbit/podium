import { rowWaitingCount } from '@podium/client-core/viewmodels'
import { describe, expect, it } from 'vitest'
import { harnessMobxPoolArm, snapshotPool, tracked } from '../../../harness/src/adapters/mobx-pool'
import { engineLocals, openFenceFeeds } from '../../../harness/src/fence-scenarios'
import { legacyDerivationFromStore, visibleIssueRows } from '../../../harness/src/oracle/oracle'
import { startScenarioEngine } from '../../../shared/src/scenarios'

describe('composed sidebar rail counts', () => {
  for (const scale of [1, 4] as const)
    it(`matches every legacy badge count at ${scale}x without walking the subtree`, async () => {
      const ctx = await startScenarioEngine(scale)
      const feeds = openFenceFeeds(ctx, 'overlaid')
      const handle = harnessMobxPoolArm.create(feeds.rows.source, feeds.locals.source)
      try {
        for (let batch = 0; batch < 64; batch += 1) {
          snapshotPool(handle.pool)
          if (handle.pool.hydrate() === 0) break
        }
        const locals = engineLocals(ctx)
        const legacy = legacyDerivationFromStore(ctx.engine.getSnapshot(), locals.coarseNow)
        for (const row of visibleIssueRows(legacy, locals)) {
          const count = tracked(() => {
            const model = handle.pool.issue(row.issue.id)!
            const values = model.aggregate.railWaiting
            return (
              ((model.ownFacts.state === 'ready' && model.ownFacts.finished
                ? values?.finished
                : values?.open) ?? 0) + (values?.decisions ?? 0)
            )
          })
          expect(count, row.issue.id).toBe(rowWaitingCount(row))
        }
      } finally {
        handle.dispose()
        feeds.dispose()
        ctx.engine.destroy()
      }
    }, 600_000)
})
