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
import { createReadFence } from '../../shared/src/instrument/reads'
import { NativeSections, type Section } from '../../arms/mobx/pool/native/list'
import { writeResult } from '../src/results'
import { assertScaleInvariant, describeCells, scaleCell, scaleVerdicts, type ScaleCell } from '../src/scale-check'
import { describe, expect, it, vi } from 'vitest'
import { harnessMobxPoolArm, tracked, visibleOrderOf } from '../src/adapters/mobx-pool'
import { installMobxWarnTrap } from '../src/mobx-trap'
import { sliceOrderOf } from '@podium/client-graph/worklist/groups'
import { startScenarioEngine, writeHeartbeat, writeTitleRename } from '../../shared/src/scenarios'
import { mountNativeForCounts } from '../src/count-harness'
import { FENCE_SCENARIOS, openFenceFeeds, runFenceStep } from '../src/fence-scenarios'

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
    const feeds = openFenceFeeds(ctx, 'pooled')
    // No load window closes on its own mid-step.
    const handle = harnessMobxPoolArm.create(feeds.rows.source, feeds.locals.source, undefined, {
      schedule: () => () => {},
    })
    const mounted = await mountNativeForCounts(handle)
    try {
      // The native list is a lazy chunk (`React.lazy` in `pool/arm.ts`): it
      // commits once the import resolves, after the mount's own act. The
      // import must resolve INSIDE an act (React reports a suspended resource
      // finishing outside one, which the trap fails): the same module is
      // awaited inside an act, so the lazy chunk's promise settles there.
      await act(async () => {
        await import('../../arms/mobx/pool/native/list')
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
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
      const visible = tracked(() => visibleOrderOf(handle.pool).length)
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
      const shown = new Set(tracked(() => visibleOrderOf(handle.pool)))
      expect(redrawn.filter((id) => !shown.has(id))).toEqual([])
    } finally {
      mounted.unmount()
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 120_000)
})

/** The real SectionList mount, with the same work meter and scenarios as web. */
async function nativeCellsAt(scale: 1 | 4): Promise<ScaleCell[]> {
  const ctx = await startScenarioEngine(scale)
  const feeds = openFenceFeeds(ctx, 'pooled')
  const reads = createReadFence({ enabled: true })
  const handle = harnessMobxPoolArm.create(reads.wrapSource(feeds.rows.source), feeds.locals.source, reads, {
    schedule: () => () => {},
  })
  const sections = vi.spyOn(NativeSections.prototype, 'update')
  const mounted = await mountNativeForCounts(handle, reads)
  mounted.work = true
  mounted.locals = feeds.locals
  try {
    await act(async () => {
      await import('../../arms/mobx/pool/native/list')
      await new Promise((resolve) => setTimeout(resolve, 0))
      // The parity oracle reads every visible row; prime its cold inputs
      // outside the count so projection loads are not attributed to a step.
      handle.snapshot()
    })
    expect(document.querySelector('[data-testid="mobx-pool-list"]')).not.toBeNull()
    const latest = (): Section[] => {
      const result = sections.mock.results.at(-1)
      expect(result?.type).toBe('return')
      return result!.value as Section[]
    }
    let retained = 0
    let changed = 0
    const cells: ScaleCell[] = []
    for (const entry of FENCE_SCENARIOS) {
      const before = latest()
      const step = await runFenceStep(mounted, ctx, feeds.flush, entry)
      expect(step.result.parity, `${scale}x ${entry.methodology}`).toBe(true)
      cells.push(scaleCell(step))
      const after = latest()
      for (const section of after) {
        const old = before.find((previous) => previous.key === section.key)
        if (old === undefined) continue
        if (old.data.length === section.data.length && old.data.every((id, i) => id === section.data[i])) {
          expect(section.data, `${entry.methodology} ${section.key}: unchanged data identity`).toBe(old.data)
          expect(section, `${entry.methodology} ${section.key}: unchanged section identity`).toBe(old)
          retained += 1
        } else {
          expect(section.data, `${entry.methodology} ${section.key}: changed data`).not.toBe(old.data)
          changed += 1
        }
      }
      if (before.every((section, i) => section === after[i]) && before.length === after.length) {
        expect(after, `${entry.methodology}: unchanged sections container`).toBe(before)
      }
    }
    expect(retained, 'unchanged lanes were checked').toBeGreaterThan(0)
    expect(changed, 'a lane change was checked').toBeGreaterThan(0)
    return cells
  } finally {
    mounted.unmount()
    sections.mockRestore()
    feeds.dispose()
    ctx.engine.destroy()
  }
}

describe('work per change: MobX pool (native SectionList)', () => {
  it('keeps unchanged lanes by identity and stays within the changed neighbourhood at 1x and 4x', async () => {
    const at1x = await nativeCellsAt(1)
    const at4x = await nativeCellsAt(4)
    const verdicts = scaleVerdicts(at1x, at4x)
    writeResult('work-mobx-native', { at1x, at4x, verdicts })
    console.info(`[work] MobX pool (native SectionList)\n${describeCells(at1x, at4x)}`)
    expect(at1x.some((cell) => cell.work.derivations > 0 && cell.work.elements > 0)).toBe(true)
    assertScaleInvariant(verdicts)
  }, 1_200_000)
})
