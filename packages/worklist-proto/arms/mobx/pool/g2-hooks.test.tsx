// @vitest-environment happy-dom
/**
 * POD-4759 — the G2 load-hook refusal, kept outside product code.
 *
 * Restored from the retired `counts.test.tsx` (deleted: it asserted the
 * retired reads budgets): a lazy arm without `settleLoads()`/`pendingLoads()`,
 * one with a no-op settle, and a wrapped flush are all refused by the shared
 * fence. Uses only the outside seam (the harness adapter, `mountArmForCounts`,
 * `runFenceStep`); no product counter is read.
 */

import { describe, expect, it } from 'vitest'
import { mountArmForCounts } from '../../../harness/src/count-harness'
import { FENCE_SCENARIOS, openFenceFeeds, runFenceStep } from '../../../harness/src/fence-scenarios'
import type { CheckableArm } from '../../../shared/src/arm'
import { startScenarioEngine } from '../../../shared/src/scenarios'
import {
  type HarnessMobxPoolHandle,
  harnessMobxPoolArm,
} from '../../../harness/src/adapters/mobx-pool'
import { installMobxWarnTrap } from '../../../harness/src/mobx-trap'

installMobxWarnTrap()

/**
 * The pool with a load window that never closes on its own: every load lands
 * through the shared fence's `settleLoads` (G2), none by a timer in a later step.
 */
const arm: CheckableArm = {
  create: (source, locals, reads) =>
    harnessMobxPoolArm.create(source, locals, reads, { schedule: () => () => {} }),
}

describe('G2 load hooks (outside)', () => {
  it('a lazy arm without the load hooks, or with a no-op settle, is refused (G2); so is a wrapped flush (N9)', async () => {
    const noHooks = (handle: HarnessMobxPoolHandle): HarnessMobxPoolHandle => {
      const bare: Partial<HarnessMobxPoolHandle> = { ...handle }
      delete bare.settleLoads
      delete bare.pendingLoads
      return bare as HarnessMobxPoolHandle
    }
    for (const [name, strip, wrapFlush, message] of [
      ['no hooks', noHooks, false, 'but has no settleLoads() and pendingLoads()'],
      [
        'a no-op settle',
        (handle: HarnessMobxPoolHandle) => ({ ...handle, settleLoads: () => {} }),
        false,
        'did not settle',
      ],
      // N9: the fence finds the feeds by the flush's identity. A wrapper
      // found none, and a lazy arm without hooks passed unrefused.
      ['no hooks, wrapped flush', noHooks, true, 'the flush is not an openFenceFeeds flush'],
    ] as const) {
      const stripped: CheckableArm = {
        create: (source, locals, reads) =>
          strip(arm.create(source, locals, reads) as HarnessMobxPoolHandle),
      }
      const ctx = await startScenarioEngine(1)
      const feeds = openFenceFeeds(ctx, 'pooled')
      const mounted = mountArmForCounts(stripped, feeds.rows.source, feeds.locals)
      try {
        const entry = FENCE_SCENARIOS.find((candidate) => candidate.methodology === '#1')!
        const flush = wrapFlush ? () => feeds.flush() : feeds.flush
        await expect(runFenceStep(mounted, ctx, flush, entry), name).rejects.toThrow(message)
      } finally {
        mounted.unmount()
        feeds.dispose()
        ctx.engine.destroy()
      }
    }
  }, 120_000)
})
