// @vitest-environment happy-dom
/**
 * POD-4577 (Mc5) — the round-three MobX pool (`mobxPoolArm`, `arms/mobx/pool`,
 * NOT the round-two arm) on the native renderer: scenarios #1-#3 through the
 * shared fence steps with counts from outside (rows committed per `RowShell`,
 * reads per change) plus parity, and a planted whole-list re-render that fails
 * the count on this renderer.
 *
 * RENDERER (stated limitation). `react-native` resolves to `react-native-web`
 * under the worklist-proto package config — the same mapping `expo export -p
 * web` builds against and `apps/mobile/vitest.config.ts` uses — so this mounts
 * real RN primitives (`SectionList`/`View`/`Text`) counted by the same
 * `RowShell` profilers. The real React Native test renderer
 * (`react-test-renderer`) is NOT a dependency of any repo lane, so no lane can
 * mount through it; that is stated here, not worked around. `SectionList`
 * windowing under the test renderer draws the initial window (`INITIAL_ROWS`)
 * from the top and never grows it (no layout, no scroll), so the fence counts
 * COMMITS, not rows rendered (the Mc5 pitfall): a changed row outside the
 * drawn window cannot commit, and the commit cell is the oracle-changed rows
 * intersected with the drawn window. The planted list below draws every
 * visible row and re-renders all of them per change, and fails that cell.
 *
 * Parity and the counted scenarios are the web lane's (`arms/mobx/pool/
 * counts.test.tsx` for #1-#4, `worklist/visible.test.tsx` for #1-#5): the same
 * `runFenceStep`, the same reads budgets, the same copy sweep. The lazy pool
 * (cold rows stay out, POD-4567; lazy nodes, POD-4705) is the baseline: the
 * mount queues loads, and the bootstrap cell reports the observables the
 * native mount builds.
 *
 * Run through the package config (never `test:file`, which silently skips the
 * native tests):
 *   bun ../../scripts/validation-admission.ts focused -- bun --bun \
 *     ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts \
 *     harness/native/mobx-pool-fence.native.test.tsx
 */

import { observer } from 'mobx-react-lite'
import { spy } from 'mobx'
import { act, type ReactElement } from 'react'
import { View } from 'react-native'
import { describe, expect, it, vi } from 'vitest'
import { mobxPoolArm, type MobxPoolHandle } from '../../arms/mobx/pool/arm'
import { installMobxWarnTrap } from '../../arms/mobx/pool/mobx-trap'
import { type MobxPool, tracked } from '../../arms/mobx/pool/pool'
import { PoolNativeRow } from '../../arms/mobx/pool/native/row'
import { sliceOrderOf } from '../../arms/mobx/pool/worklist/groups'
import {
  assertCommits,
  assertReads,
  mountNativeForCounts,
  type MountedArm,
} from '../src/count-harness'
import {
  FENCE_SCENARIOS,
  openFenceFeeds,
  runFenceStep,
  type FenceFeeds,
} from '../src/fence-scenarios'
import { writeResult } from '../src/results'
import { DISABLED_READ_FENCE, createReadFence } from '../../shared/src/instrument/reads'
import { RowShell } from '../../shared/src/row-shell'
import { startScenarioEngine, type ScenarioEngine } from '../../shared/src/scenarios'

// The pool's enforcement only warns, so every pool test installs the trap;
// the native lane's `{ errors: true }` proof stays in Ma1's file
// (`mobx-pool.native.test.tsx`), where the lazy chunk is also proven armed.
installMobxWarnTrap()

const RENDERER =
  'react-native-web aliased from react-native under the worklist-proto vitest config ' +
  '(same mapping as apps/mobile/vitest.config.ts and expo export -p web); ' +
  'no react-test-renderer in any repo lane'

interface MountedPool {
  ctx: ScenarioEngine
  feeds: FenceFeeds
  handle: MobxPoolHandle
  mounted: MountedArm
  list: Element
}

/** The pool on the native list, with the lazy chunk resolved inside act (Ma1). */
async function mountPool(): Promise<MountedPool> {
  const ctx = await startScenarioEngine(1)
  const feeds = openFenceFeeds(ctx, 'overlaid')
  const reads = createReadFence({ enabled: true })
  const handle = mobxPoolArm.create(reads.wrapSource(feeds.rows.source), feeds.locals.source, reads, {
    // No load window closes on its own mid-step: every load lands through the
    // shared fence's settleLoads (G2), none by a timer in a later step.
    schedule: () => () => {},
  })
  const mounted = await mountNativeForCounts(handle, reads)
  // The native list is a lazy chunk (`React.lazy` in `pool/arm.ts`): it
  // commits once the import resolves, after the mount's own act. The import
  // must resolve INSIDE an act (Ma1).
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
  return { ctx, feeds, handle, mounted, list }
}

function drawnIds(list: Element): string[] {
  return [...list.querySelectorAll('[data-testid^="row-"]')].map((row) =>
    (row.getAttribute('data-testid') ?? '').slice('row-'.length),
  )
}

/** The window as drawn: resident rows plus loading placeholders for cold ones (Ma1). */
function windowIds(list: Element): string[] {
  return [...list.querySelectorAll('[data-testid^="row-"], [data-testid^="loading-"]')].map((el) =>
    (el.getAttribute('data-testid') ?? '').replace(/^(row|loading)-/, ''),
  )
}

function shutdown(mount: Pick<MountedPool, 'ctx' | 'feeds' | 'mounted'>): void {
  mount.mounted.unmount()
  mount.feeds.dispose()
  mount.ctx.engine.destroy()
}

describe('mobx pool on the native renderer, fence steps #1-#3', () => {
  it('meets the shared fences with counts from outside plus parity', async () => {
    const mount = await mountPool()
    const { ctx, feeds, handle, mounted, list } = mount
    try {
      // Windowed (Mb2): a strict prefix of the grouped order, from the top
      // (placeholders included: cold visible rows draw as loading).
      const visible = tracked(() => handle.pool.worklist.order.length)
      const window = windowIds(list)
      expect(window.length, 'the window draws rows').toBeGreaterThan(0)
      expect(window.length, 'the window draws a prefix, not the set').toBeLessThan(visible)
      const grouped = tracked(() => {
        const order = sliceOrderOf(handle.pool.groups.layout)
        return [
          ...order.pinnedIds,
          ...order.groups.flatMap((group) => [...group.rowIds, ...group.closedIds]),
        ]
      })
      expect(window, 'the window draws the grouped prefix').toEqual(grouped.slice(0, window.length))

      const cells = []
      let nonVacuous = 0
      for (const methodology of ['#1', '#2', '#3']) {
        const entry = FENCE_SCENARIOS.find((candidate) => candidate.methodology === methodology)
        expect(entry, methodology).toBeDefined()
        const { result, readsBudget } = await runFenceStep(mounted, ctx, feeds.flush, entry!)
        const at = `${result.methodology} ${result.scenario}`
        expect(result.parity, `${at}: ${result.parityDiff ?? ''}`).toBe(true)
        assertReads(result, { readsPerChange: readsBudget })
        mounted.reads.assertNoCopies(mounted.handle)
        // Window-aware commits: the redrawn rows must EQUAL the oracle-changed
        // rows intersected with the RESIDENT drawn rows (`drawnIds`: loading
        // placeholders mount no RowShell and cannot commit). A changed row
        // outside the window cannot commit (it was never mounted); a drawn row
        // that commits with an unchanged view is the whole-list work this lane
        // exists to catch (the plant below fails exactly here).
        expect(result.oracleChangedRows, `${at}: no commit cell`).not.toBeNull()
        expect(result.drawnRows, `${at}: no commit cell`).not.toBeNull()
        const now = new Set(drawnIds(list))
        const expected = (result.oracleChangedRows ?? []).filter((id) => now.has(id)).sort()
        const drawnRows = [...(result.drawnRows ?? [])].sort()
        expect(drawnRows, `${at}: commits`).toEqual(expected)
        const shown = new Set(tracked(() => [...handle.pool.worklist.ids]))
        expect(drawnRows.filter((id) => !shown.has(id)), `${at}: commits outside the list`).toEqual(
          [],
        )
        if (expected.length > 0) nonVacuous += 1
        console.info(
          `[mobx-pool-native] ${at}: committed=${result.rowsCommitted} ` +
            `changed=[${(result.oracleChangedRows ?? []).join(',')}] ` +
            `drawn=[${drawnRows.join(',')}] reads=${result.readsPerChange}/${readsBudget} parity=pass`,
        )
        cells.push({
          methodology: result.methodology,
          scenario: result.scenario,
          rowsCommitted: result.rowsCommitted,
          oracleChanged: result.oracleChangedRows,
          drawn: result.drawnRows,
          readsPerChange: result.readsPerChange,
          readsBudget,
          readsByEntity: result.reads?.byEntity,
          visibleRows: result.visibleRows,
          stats: result.stats,
          parity: result.parity,
        })
      }
      // Not 0 == 0 throughout: at least one of #2/#3 changed a drawn row.
      expect(nonVacuous, 'no step changed a drawn row: the commit cells are vacuous').toBeGreaterThan(
        0,
      )
      writeResult('mobx-pool-native-1x', { scale: 1, renderer: RENDERER, cells })
    } finally {
      shutdown(mount)
    }
  }, 300_000)

  it('a whole-list re-render per change fails the count on the native renderer', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'overlaid')
    const reads = createReadFence({ enabled: true })
    const clean = mobxPoolArm.create(reads.wrapSource(feeds.rows.source), feeds.locals.source, reads, {
      schedule: () => () => {},
    })
    // THE PLANT: every slot reads every visible title, so one rename
    // re-renders every slot and every drawn RowShell commits — the whole-list
    // work the windowed list exists to avoid. Parity still holds (the mistake
    // is performance, not correctness).
    const planted: MobxPoolHandle = {
      ...clean,
      mountNative: () => <PlantedNativeList pool={clean.pool} />,
    }
    const mounted = await mountNativeForCounts(planted, reads)
    try {
      const list = await vi.waitFor(
        async () => {
          await act(async () => {})
          const found = document.querySelector('[data-testid="mobx-pool-list"]')
          if (found === null) throw new Error('planted native list not mounted yet')
          return found
        },
        { timeout: 20_000, interval: 50 },
      )
      const visible = tracked(() => clean.pool.worklist.order.length)
      // The plant draws the whole visible list, not the window.
      expect(drawnIds(list).length, 'the plant draws every visible row').toBeGreaterThan(24)
      const entry = FENCE_SCENARIOS.find((candidate) => candidate.methodology === '#4')
      expect(entry, '#4').toBeDefined()
      const { result } = await runFenceStep(mounted, ctx, feeds.flush, entry!)
      expect(result.parity, `#4 plant parity: ${result.parityDiff ?? ''}`).toBe(true)
      console.info(
        `[mobx-pool-native] plant #4 visibleTitleRename: committed=${result.rowsCommitted}/` +
          `${result.visibleRows} changed=[${(result.oracleChangedRows ?? []).join(',')}]`,
      )
      expect(result.rowsCommitted, 'the plant redraws the list, not the row').toBeGreaterThan(1)
      expect(() => assertCommits(result)).toThrow(/over=\[[^\]]/)
    } finally {
      mounted.unmount()
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 300_000)

  it('reports bootstrap observables on the native mount (lazy baseline)', async () => {
    const built: Record<string, number> = {}
    const off = spy((event) => {
      if (event.type !== 'add') return
      const name = String((event as { debugObjectName?: string }).debugObjectName).replace(
        /@\d+$/,
        '',
      )
      built[name] = (built[name] ?? 0) + 1
    })
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'overlaid')
    const handle = mobxPoolArm.create(feeds.rows.source, feeds.locals.source, DISABLED_READ_FENCE, {
      schedule: () => () => {},
    })
    const mounted = await mountNativeForCounts(handle)
    try {
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
      off()
      const drawn = drawnIds(list)
      const cell = {
        rows: tracked(() => ({
          issue: handle.pool.tables.issue.size,
          session: handle.pool.tables.session.size,
          worktree: handle.pool.tables.worktree.size,
          repo: handle.pool.tables.repo.size,
        })),
        cold: {
          issue: handle.pool.residency?.size('issue') ?? 0,
          session: handle.pool.residency?.size('session') ?? 0,
        },
        models: handle.pool.stats.counters.modelsCreated,
        observables: Object.values(built).reduce((a, b) => a + b, 0),
        byMap: built,
        drawn: drawn.length,
        visible: tracked(() => handle.pool.worklist.order.length),
        pendingLoads: handle.pendingLoads(),
      }
      // The lazy baseline (POD-4567, POD-4705): cold rows stay out, the mount
      // queues their loads, and no model is built before its row draws.
      expect(drawn.length, 'the native mount draws rows').toBeGreaterThan(0)
      expect(cell.cold.issue, 'cold issues stay out at bootstrap').toBeGreaterThan(0)
      expect(cell.pendingLoads, 'the mount queues loads').toBeGreaterThan(0)
      console.info(
        `[mobx-pool-native] bootstrap observables=${cell.observables} models=${cell.models} ` +
          `drawn=${cell.drawn}/${cell.visible} coldIssues=${cell.cold.issue} ` +
          `coldSessions=${cell.cold.session} pendingLoads=${cell.pendingLoads}`,
      )
      writeResult('mobx-pool-native-bootstrap', { scale: 1, renderer: RENDERER, cell })
    } finally {
      mounted.unmount()
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 300_000)
})

/** THE PLANT: one slot per visible id, each reading every visible title. */
const PlantedSlot = observer(function PlantedSlot({
  pool,
  id,
}: {
  pool: MobxPool
  id: string
}): ReactElement | null {
  for (const other of pool.worklist.order) void pool.issue(other)?.view?.title
  const model = pool.issue(id)
  if (model === undefined) return null
  const view = model.view
  if (view === undefined) return null
  return <RowShell row={view} component={PoolNativeRow} />
})

const PlantedNativeList = observer(function PlantedNativeList({
  pool,
}: {
  pool: MobxPool
}): ReactElement {
  return (
    <View testID="mobx-pool-list">
      {pool.worklist.order.map((id) => (
        <PlantedSlot key={id} pool={pool} id={id} />
      ))}
    </View>
  )
})
