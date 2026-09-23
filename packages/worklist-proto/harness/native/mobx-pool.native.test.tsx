// @vitest-environment happy-dom
/**
 * POD-4565 (Ma1) — the round-three MobX pool on the native renderer:
 * `mountNative()` through `mountNativeForCounts`, one RowShell per pool issue,
 * a heartbeat redraws nothing and a rename redraws the renamed row. The
 * heartbeat's session belongs to a closed root that the worklist hides; since
 * Ma3 (POD-4567) that root and its session are COLD, so the heartbeat only
 * relinks a registry entry and the list, which draws every RESIDENT issue,
 * never drew the row (Ma2 redrew it: its `activityAt` moved). Since Mb1
 * (POD-4569) the list draws the visible collection in rank order, and a
 * rename redraws visible rows only (its hidden spin-off is not drawn).
 * Parity and the counted scenarios are the web lane's
 * (`arms/mobx/pool/worklist/visible.test.tsx`).
 */

import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { mobxPoolArm } from '../../arms/mobx/pool/arm'
import { tracked } from '../../arms/mobx/pool/pool'
import { startScenarioEngine, writeHeartbeat, writeTitleRename } from '../../shared/src/scenarios'
import { mountNativeForCounts } from '../src/count-harness'
import { openFenceFeeds } from '../src/fence-scenarios'

describe('mobx pool on the native renderer', () => {
  it('mounts every resident row; a heartbeat on a cold session redraws nothing, a rename redraws the renamed row', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'overlaid')
    // No load window closes on its own mid-step.
    const handle = mobxPoolArm.create(feeds.rows.source, feeds.locals.source, undefined, {
      schedule: () => () => {},
    })
    const mounted = await mountNativeForCounts(handle)
    try {
      // The native list is a lazy chunk (`React.lazy` in `pool/arm.ts`): it
      // commits once the import resolves, after the mount's own act.
      const list = await vi.waitFor(
        async () => {
          await act(async () => {})
          const found = document.querySelector('[data-testid="mobx-pool-list"]')
          if (found === null) throw new Error('native list not mounted yet')
          return found
        },
        { timeout: 20_000, interval: 50 },
      )
      // Mb1 (POD-4569): the list draws the VISIBLE collection. Visible rows
      // that are cold draw as loading placeholders until their load lands.
      const visible = tracked(() => handle.pool.worklist.order.length)
      const drawn = list?.querySelectorAll('[data-testid^="row-"]').length ?? 0
      const loading = list?.querySelectorAll('[data-testid^="loading-"]').length ?? 0
      expect(drawn + loading).toBe(visible)

      mounted.log.reset()
      await act(async () => {
        await writeHeartbeat(ctx)
        feeds.flush()
      })
      const heartbeatIssue = tracked(() =>
        handle.pool.relations.one('session', ctx.targets.heartbeatSessionId, 'issue'),
      )
      expect(heartbeatIssue).not.toBeNull()
      expect(handle.pool.residency?.isCold('issue', heartbeatIssue!)).toBe(true)
      expect(handle.pool.residency?.isCold('session', ctx.targets.heartbeatSessionId)).toBe(true)
      expect([...mounted.log.counts.keys()]).toEqual([])

      await act(async () => {
        await writeTitleRename(ctx)
        feeds.flush()
      })
      // Only visible rows redraw: the rename's hidden spin-off is not drawn (#4).
      const redrawn = [...mounted.log.counts.keys()]
      expect(redrawn).toContain(ctx.targets.visibleRootId)
      const shown = new Set(tracked(() => [...handle.pool.worklist.ids]))
      expect(redrawn.filter((id) => !shown.has(id))).toEqual([])
    } finally {
      mounted.unmount()
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 120_000)
})
