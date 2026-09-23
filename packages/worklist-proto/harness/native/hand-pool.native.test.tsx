// @vitest-environment happy-dom
/**
 * POD-4578 (Ha1) — the round-three hand-rolled pool on the native renderer:
 * `mountNative()` through `mountNativeForCounts`, one RowShell per pool
 * issue, a heartbeat redraws nothing (no a1 view reads a session) and a
 * rename redraws the renamed row. Parity and the counted scenarios are the
 * web lane's (`arms/hand/pool/counts.test.tsx`) until the pool has an order
 * (Hb1).
 */

import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { handPoolArm } from '../../arms/hand/pool/arm'
import { startScenarioEngine, writeHeartbeat, writeTitleRename } from '../../shared/src/scenarios'
import { mountNativeForCounts } from '../src/count-harness'
import { openFenceFeeds } from '../src/fence-scenarios'

describe('hand pool on the native renderer', () => {
  it('mounts every row; a heartbeat redraws nothing, a rename redraws the renamed row', async () => {
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
      expect([...mounted.log.counts.keys()]).toEqual([])

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
