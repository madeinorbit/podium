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
 * Since Mb2 (POD-4570) the list is a `SectionList` (PINNED, then one section
 * per group): it draws a window from the top, not every row, so the renamed
 * row is the first drawn root. Parity and the counted scenarios are the web
 * lane's (`arms/mobx/pool/worklist/visible.test.tsx`, `groups.test.tsx`).
 *
 * THE TRAP (POD-4572, M3 note N3): this lane runs the pool under the MobX
 * trap with `errors` on, so a warning, or a throw inside a reaction (which
 * MobX reports through `console.error`), fails the test. Proven armed below
 * with a planted warning and a planted reaction error.
 */

import { observable, reaction, runInAction } from 'mobx'
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { mobxPoolArm } from '../../arms/mobx/pool/arm'
import { installMobxWarnTrap } from '../../arms/mobx/pool/mobx-trap'
import { tracked } from '../../arms/mobx/pool/pool'
import { sliceOrderOf } from '../../arms/mobx/pool/worklist/groups'
import { startScenarioEngine, writeHeartbeat, writeTitleRename } from '../../shared/src/scenarios'
import { mountNativeForCounts } from '../src/count-harness'
import { openFenceFeeds } from '../src/fence-scenarios'

const trap = installMobxWarnTrap({ errors: true })

describe('the MobX trap in the native lane (armed)', () => {
  it('traps a planted warning and a planted reaction error', () => {
    expect(() => console.warn('[plant] warning')).toThrow(/trapped/)
    expect(trap.warnings).toEqual(['[plant] warning'])
    const box = observable.box(0, { name: 'plant.box' })
    const stop = reaction(
      () => box.get(),
      () => {
        throw new Error('[plant] thrown inside a reaction')
      },
    )
    try {
      // MobX catches the throw and reports it through console.error.
      expect(() => runInAction(() => box.set(1))).not.toThrow()
    } finally {
      stop()
    }
    expect(trap.errors.join('\n')).toMatch(/\[plant\] thrown inside a reaction/)
    // Caught, so the proof itself passes the afterEach check.
    trap.warnings.length = 0
    trap.errors.length = 0
  })
})

describe('mobx pool on the native renderer', () => {
  it('draws a window of the grouped rows; a heartbeat on a cold session redraws nothing, a rename redraws the renamed row', async () => {
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
      // Mb2 (POD-4570): a window of the grouped list, from the top. Visible
      // rows that are cold draw as loading placeholders until their load lands.
      const visible = tracked(() => handle.pool.worklist.order.length)
      const drawnIds = [
        ...(list?.querySelectorAll('[data-testid^="row-"], [data-testid^="loading-"]') ?? []),
      ].map((el) => (el.getAttribute('data-testid') ?? '').replace(/^(row|loading)-/, ''))
      expect(drawnIds.length).toBeGreaterThan(0)
      expect(drawnIds.length).toBeLessThan(visible)
      const grouped = tracked(() => {
        const order = sliceOrderOf(handle.pool.groups.layout)
        return [
          ...order.pinnedIds,
          ...order.groups.flatMap((group) => [...group.rowIds, ...group.closedIds]),
        ]
      })
      expect(drawnIds).toEqual(grouped.slice(0, drawnIds.length))
      expect(list?.querySelector('[data-testid="group-PINNED"]')).not.toBeNull()

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

      // Rename a drawn, resident row: the first drawn row with its data.
      const target = drawnIds.find(
        (id) => list?.querySelector(`[data-testid="row-${id}"]`) !== null,
      )
      expect(target).toBeDefined()
      await act(async () => {
        await writeTitleRename(ctx, target)
        feeds.flush()
      })
      // Only drawn visible rows redraw.
      const redrawn = [...mounted.log.counts.keys()]
      expect(redrawn).toContain(target)
      const shown = new Set(tracked(() => [...handle.pool.worklist.ids]))
      expect(redrawn.filter((id) => !shown.has(id))).toEqual([])
    } finally {
      mounted.unmount()
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 120_000)
})
