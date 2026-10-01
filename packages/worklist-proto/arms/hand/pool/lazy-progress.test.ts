/**
 * POD-4707 — hidden parents' progress composes over their formal children.
 *
 * The H3 full-view probe caught the CLEAN hand arm at seed 1, snapshot 1
 * (bootstrap, before any change): hidden parents outside the bootstrap
 * closure read solo (`progressTotal: 1`) while the direct rebuild over the
 * same feed composed over their formal children (`progressTotal: 0`, with
 * done units below):
 * - i1093.progressTotal: live 1, direct 0 (child i1148, cold done)
 * - i1182.progressDone/Total: live 0/0, direct 1/1 (child i1252, cold done)
 * - i1691.progressDone/Total: live 0/0, direct 2/2 (children i1706/i1720)
 * - i2141.progressTotal: live 1, direct 0 (child i2230, hot hidden)
 * - i4615.progressDone/Total: live 0/0, direct 1/1 (child i4632, cold done)
 *
 * The bootstrap closure now roots every known formal parent (bucket probe,
 * residency-independent), so hidden parents file their formal subtrees at
 * `replace` and compose correctly once read — exactly what the probe does
 * before it compares. `view()` stays pure (no read-path filing, H3-F3).
 *
 * POD-5033 (cold rule): i2141 is archived, so the shared rule keeps it cold
 * (hidden, no view). Both arms agree it is cold (direct skips cold
 * non-resident, live has no view). The test still files it (formal filing is
 * residency-independent) and checks progress where views exist, absence
 * where correctly cold.
 */

import { describe, expect, it } from 'vitest'
import { createEngineLocals } from '../../../harness/src/engine-locals'
import { startGenRun } from '../../../shared/src/gen/run'
import { harnessHandPoolArm, poolPendingLoads, residentIssueIdsOf, type HarnessHandPoolHandle } from '../../../harness/src/adapters/hand-pool'
import { rebuildResidentViews } from './rebuild'

const PARENTS = ['i1093', 'i1182', 'i1691', 'i2141', 'i4615'] as const

describe('lazy progress over hidden formal subtrees (H3 seed 1 snapshot 1)', () => {
  it('hidden parents outside the bootstrap closure compose like the rebuild once read', async () => {
    const run = await startGenRun({ feedMode: 'overlaid' })
    const feed = run.feed()
    const locals = createEngineLocals(run.ctx.engine)
    const handle = harnessHandPoolArm.create(feed.source, locals.source) as HarnessHandPoolHandle
    try {
      locals.flush()
      const { pool } = handle
      // The probe's own settle: read every resident view until loads drain.
      for (let round = 0; ; round += 1) {
        for (const id of residentIssueIdsOf(pool)) pool.view(id)
        if (poolPendingLoads(pool) === 0) break
        if (round >= 64) throw new Error('loads did not settle')
        handle.settleLoads()
      }
      const want = rebuildResidentViews(feed.source, locals.source, residentIssueIdsOf(pool))
      for (const id of PARENTS) {
        const live = pool.view(id)
        const direct = want.get(id)
        // Correctly cold (archived i2141): both arms agree it is hidden (no
        // view). Still filed (formal filing is residency-independent), still
        // checked below. Otherwise both views exist and progress composes.
        if (direct === undefined) {
          expect(live, `${id} correctly cold has no live view`).toBeUndefined()
        } else {
          expect(live, `${id} has no live view`).toBeDefined()
          if (live === undefined) throw new Error(`${id} missing view`)
          expect({ done: live.progressDone, total: live.progressTotal }, `${id} progress`).toEqual({
            done: direct.progressDone,
            total: direct.progressTotal,
          })
        }
        // The filing itself: every engine bucket member is filed under it.
        const filed = [...pool.rollup.inputs.formalChildren(id)].sort()
        const bucket = [...pool.engine.members('issue', id, 'children')].sort()
        expect(filed, `${id} filed formal children`).toEqual(bucket)
      }
    } finally {
      handle.dispose()
      locals.dispose()
      run.dispose()
    }
  }, 300_000)
})
