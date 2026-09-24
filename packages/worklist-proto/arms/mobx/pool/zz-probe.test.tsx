// @vitest-environment happy-dom
// SCRATCH (POD-4572, not committed): the 4x draft title.
import { describe, it } from 'vitest'
import { openFenceFeeds } from '../../../harness/src/fence-scenarios'
import { oracleSnapshot } from '../../../harness/src/oracle/index'
import { startScenarioEngine } from '../../../shared/src/scenarios'
import { mobxPoolArm } from './arm'
import { tracked } from './pool'

describe('probe', () => {
  it('4x draft title', async () => {
    const ctx = await startScenarioEngine(4)
    const feeds = openFenceFeeds(ctx, 'overlaid')
    const handle = mobxPoolArm.create(feeds.rows.source, feeds.locals.source)
    const got = handle.snapshot()
    const want = oracleSnapshot(ctx.engine.getSnapshot())
    const bad = Object.keys(want.rowsById).filter((id) => JSON.stringify((got.rowsById as any)[id]?.title) !== JSON.stringify((want.rowsById as any)[id].title))
    console.info(`[probe] title diffs=${bad.length} ${bad.slice(0, 10).join(',')}`)
    const pool: any = handle.pool
    for (const id of bad.slice(0, 3)) {
      const seats = tracked(() => pool.worklist.issue(id)?.seatIds)
      const members = tracked(() => pool.worklist.issue(id)?.memberIds)
      console.info(`[probe] ${id} got=${(got.rowsById as any)[id]?.title} want=${(want.rowsById as any)[id].title} seats=${JSON.stringify(seats)} members=${JSON.stringify(members)}`)
      for (const sid of members ?? []) console.info(`[probe]   ${sid} cold=${pool.residency?.isCold('session', sid)} kind=${tracked(() => pool.visibleInputs.sessionRow(sid)?.agentKind)}`)
    }
    handle.dispose(); feeds.dispose(); ctx.engine.destroy()
  }, 600_000)
})
