// @vitest-environment happy-dom
/**
 * POD-4578 (Ha1) — the round-three hand-rolled pool on the native renderer:
 * `mountNative()` through `mountNativeForCounts`, one RowShell per pool
 * issue, a heartbeat redraws no VISIBLE row and a rename redraws the
 * renamed row. Parity and the counted scenarios are the web lane's
 * (`arms/hand/pool/counts.test.tsx`) until the pool has an order (Hb1).
 *
 * Ha2 (POD-4579): `activityAt` reads `issue.sessions`, so the heartbeat
 * moves its session's issue and the a1 list, which draws every issue,
 * redraws that row. The oracle hides it (the web lane's #1 finding); the
 * commit fence for #1 moves to Hb1.
 */

import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { handPoolArm } from '../../arms/hand/pool/arm'
import { startScenarioEngine, writeHeartbeat, writeTitleRename } from '../../shared/src/scenarios'
import { mountNativeForCounts } from '../src/count-harness'
import { engineLocals, openFenceFeeds } from '../src/fence-scenarios'
import { rowViewsFromStore } from '../src/oracle/index'

describe('hand pool on the native renderer', () => {
  it('mounts every row; a heartbeat redraws no visible row, a rename redraws the renamed row', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'overlaid')
    const handle = handPoolArm.create(feeds.rows.source, feeds.locals.source)
    const mounted = await mountNativeForCounts(handle)
    try {
      // The native list is a lazy chunk (`React.lazy` in `pool/arm.ts`): it
      // commits once the import resolves, after the mount's own act.
      const list = await vi.waitFor(
        async () => {
          await act(async () => {})
          const found = document.querySelector('[data-testid="hand-pool-list"]')
          if (found === null) throw new Error('native list not mounted yet')
          return found
        },
        { timeout: 20_000, interval: 50 },
      )
      expect(list.querySelectorAll('[data-testid^="row-"]').length).toBe(
        handle.pool.issueIds().length,
      )

      mounted.log.reset()
      await act(async () => {
        await writeHeartbeat(ctx)
        feeds.flush()
      })
      const visible = rowViewsFromStore(ctx.engine.getSnapshot(), engineLocals(ctx))
      expect(
        [...mounted.log.counts.keys()].filter((id) => visible[id] !== undefined),
        'a heartbeat drew a VISIBLE row',
      ).toEqual([])

      await act(async () => {
        await writeTitleRename(ctx)
        feeds.flush()
      })
      expect([...mounted.log.counts.keys()]).toContain(ctx.targets.visibleRootId)
    } finally {
      mounted.unmount()
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 120_000)
})
