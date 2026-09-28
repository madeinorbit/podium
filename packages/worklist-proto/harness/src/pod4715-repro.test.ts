// @vitest-environment happy-dom
// POD-4715 scratch repro: stage the grown scope exactly as the browser page
// does (rescope.ts + entrylib stageScope/fireRescope order) on separate
// engines per arm, and report what each page's grown state holds.
import { describe, expect, it } from 'vitest'
import { handPoolArm } from '../../arms/hand/pool/arm'
import { mobxPoolArm } from '../../arms/mobx/pool/arm'
import { startScenarioEngine, type ScenarioEngine } from '../../shared/src/scenarios'
import { openFenceFeeds } from './fence-scenarios'
import { legacyControlArmFor } from './legacy-control/arm'
import { noopArmFor } from '../web/noop-arm'
import { oracleSnapshot } from './oracle/index'
import { currentScope, fireRescope, scopeOfCorpus, stageRows, stageScans } from './rescope'

async function stageGrown(ctx: ScenarioEngine): Promise<void> {
  const grown = scopeOfCorpus(2)
  await stageScans(ctx, grown.repos)
  await new Promise((r) => setTimeout(r, ctx.settleMs))
  stageRows(ctx, grown.rows)
  fireRescope(ctx, 2)
  await new Promise((r) => setTimeout(r, ctx.settleMs))
}

describe('POD-4715 repro', () => {
  it('reports grown-state rows per arm on separate engines', async () => {
    for (const arm of ['control', 'mobx', 'hand', 'noop'] as const) {
      const ctx = await startScenarioEngine(1)
      const feeds = openFenceFeeds(ctx, 'overlaid')
      const handle =
        arm === 'control'
          ? legacyControlArmFor(ctx.engine).create(feeds.rows.source, feeds.locals.source)
          : arm === 'noop'
            ? noopArmFor(ctx).create(feeds.rows.source, feeds.locals.source)
            : arm === 'mobx'
              ? mobxPoolArm.create(feeds.rows.source, feeds.locals.source)
              : handPoolArm.create(feeds.rows.source, feeds.locals.source)
      try {
        const baseRows = Object.keys(handle.snapshot().rowsById).length
        const baseOracle = Object.keys(oracleSnapshot(ctx.engine.getSnapshot()).rowsById).length
        await stageGrown(ctx)
        feeds.flush()
        ;(handle as { settleLoads?: () => void }).settleLoads?.()
        await new Promise((r) => setTimeout(r, ctx.settleMs))
        feeds.flush()
        ;(handle as { settleLoads?: () => void }).settleLoads?.()
        const grownRows = Object.keys(handle.snapshot().rowsById).length
        const oracleRows = Object.keys(oracleSnapshot(ctx.engine.getSnapshot()).rowsById).length
        const store = ctx.engine.getSnapshot()
        console.info(
          `[4715] arm=${arm} base armRows=${baseRows} base oracleRows=${baseOracle} ` +
            `grown armRows=${grownRows} oracleRows=${oracleRows} ` +
            `store issues=${store.issues.length} proj=${store.issueProjections.length} ` +
            `sessions=${store.sessions.length} repos=${store.repos.length} ` +
            `cache=${ctx.cache.records.length}`,
        )
      } finally {
        handle.dispose()
        feeds.dispose()
        ctx.engine.destroy()
      }
    }
    expect(true).toBe(true)
  }, 300_000)
})
