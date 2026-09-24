// @vitest-environment happy-dom
/**
 * POD-4578 (Ha1) — the round-three hand-rolled pool on the native renderer:
 * `mountNative()` through `mountNativeForCounts`, one RowShell per VISIBLE
 * row grouped (Hb2, POD-4583: the PINNED section, then each group's open
 * lane and closed fold), a heartbeat redraws no row and a rename redraws
 * the renamed row and no hidden one. Parity and the counted scenarios are
 * the web lane's (`arms/hand/pool/worklist/visible.test.tsx`,
 * `arms/hand/pool/worklist/groups.test.tsx`,
 * `arms/hand/pool/counts.test.tsx`).
 *
 * Ha2 (POD-4579): `activityAt` reads `issue.sessions`, so the heartbeat
 * moved its session's issue and the a1 list, which drew every issue,
 * redrew that hidden row. Since Ha3 (POD-4580) that closed root and its
 * session are COLD: the heartbeat relinks a registry entry and the list,
 * which draws every RESIDENT issue, never drew the row, so the heartbeat
 * redraws nothing at all. The load window never closes on its own here, so
 * the mount's queued loads cannot land inside the counted steps.
 */

import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { handPoolArm } from '../../arms/hand/pool/arm'
import { startScenarioEngine, writeHeartbeat, writeTitleRename } from '../../shared/src/scenarios'
import { mountNativeForCounts } from '../src/count-harness'
import { openFenceFeeds } from '../src/fence-scenarios'

describe('hand pool on the native renderer', () => {
  it('mounts the visible rows in order; a heartbeat on a cold session redraws nothing, a rename redraws the renamed row only among drawn rows', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'overlaid')
    // No load window closes on its own mid-step.
    const handle = handPoolArm.create(feeds.rows.source, feeds.locals.source, undefined, {
      schedule: () => () => {},
    })
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
      const drawnIds = [...list.querySelectorAll('[data-testid^="row-"]')].map((row) =>
        (row.getAttribute('data-testid') ?? '').slice('row-'.length),
      )
      // POD-4583: the native list draws the PINNED section, then each
      // group's open lane and closed fold: the visible set, grouped.
      const view = handle.pool.groupsView()
      expect(drawnIds).toEqual([
        ...view.pinnedIds,
        ...view.keys.flatMap((key) => {
          const lanes = handle.pool.groupLanes(key)
          return [...lanes.rowIds, ...lanes.closedIds]
        }),
      ])

      mounted.log.reset()
      await act(async () => {
        await writeHeartbeat(ctx)
        feeds.flush()
      })
      const heartbeatIssue = handle.pool.relations.one(
        'session',
        ctx.targets.heartbeatSessionId,
        'issue',
      )
      expect(heartbeatIssue).not.toBeNull()
      expect(handle.pool.residency?.isCold('issue', heartbeatIssue!)).toBe(true)
      expect(handle.pool.residency?.isCold('session', ctx.targets.heartbeatSessionId)).toBe(true)
      expect([...mounted.log.counts.keys()], 'a heartbeat on a cold session drew a row').toEqual([])

      await act(async () => {
        await writeTitleRename(ctx)
        feeds.flush()
      })
      const redrawn = [...mounted.log.counts.keys()]
      expect(redrawn).toContain(ctx.targets.visibleRootId)
      // Only visible rows redraw: a hidden spin-off of the renamed root is not drawn.
      const shown = new Set(handle.pool.order())
      expect(redrawn.filter((id) => !shown.has(id))).toEqual([])
    } finally {
      mounted.unmount()
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 120_000)
})
