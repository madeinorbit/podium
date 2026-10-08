// @vitest-environment happy-dom
/**
 * POD-4577 (Mc5) — the round-three MobX pool (`harnessMobxPoolArm`, `arms/mobx/pool`,
 * NOT the round-two arm) on the native renderer: scenarios #1-#3 through the
 * shared fence steps with counts from outside (rows committed per `RowShell`,
 * reads per change) plus parity, and a planted whole-list re-render that fails
 * the count on this renderer.
 *
 * RENDERER (stated limitation). `react-native` resolves to `react-native-web`
 * under the worklist test workspace package config — the same mapping `expo export -p
 * web` builds against and `apps/mobile/vitest.config.ts` uses — so this mounts
 * real RN primitives (`View`/`Text`) counted by the same `RowShell`
 * profilers. The real React Native test renderer (`react-test-renderer`) is
 * NOT a dependency of any repo lane — apps/mobile's lane provides no real RN
 * renderer either (no such dependency; its vitest config carries the same
 * react-native-web alias) — so this lane is the brief's "otherwise" branch:
 * the existing react-native-web lane, limitation stated, not worked around.
 *
 * THE COUNT MOUNT DRAWS THE FULL VISIBLE LIST. The parity snapshot derives
 * every visible row, and the pool's real native list is windowed (Mb2): rows
 * outside the window stay cold, and the step's `snapshot()` loads them after
 * the step settled its own loads (G2: charged to no step) — the #1 late-load
 * failure this lane found and the diagnostic round proved (cells stable,
 * nothing remounted, nothing changed, yet the snapshot phase landed the
 * loads). So the count mount renders every visible row through the same
 * `RowShell`s without virtualization — the same resident set the web lane
 * compares — and the commit fence is the exact one (`assertCommits`, no
 * window intersection). The windowed real mount (`mountNative()`, the
 * `SectionList`) is covered by Ma1 (`mobx-pool.native.test.tsx`: the grouped
 * prefix, a cold heartbeat redrawing nothing, a rename redrawing the renamed
 * row); the bootstrap test below also mounts it.
 *
 * Parity and the counted scenarios are the web lane's (`arms/mobx/pool/
 * counts.test.tsx` for #1-#4, `worklist/visible.test.tsx` for #1-#5): the same
 * `runFenceStep`, the same reads budgets, the same copy sweep. The lazy pool
 * (cold rows stay out, POD-4567; lazy nodes, POD-4705) is the baseline: the
 * mount queues loads, and the bootstrap cell reports the observables the
 * native mount builds.
 *
 * Run through the package config (never `test:file`, which routes these files
 * to the node lane where they are excluded):
 *   bun ../../scripts/validation-admission.ts focused -- bun --bun \
 *     ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts \
 *     harness/native/mobx-pool-fence.native.test.tsx
 */

import { spy } from 'mobx'
import { observer } from 'mobx-react-lite'
import { act, type ReactElement } from 'react'
import { View } from 'react-native'
import { describe, expect, it, vi } from 'vitest'
import { installMobxWarnTrap } from '../src/mobx-trap'
import { PoolNativeRow } from '../../arms/mobx/pool/native/row'
import { type MobxPool } from '@podium/client-graph/pool'
import {
  type HarnessMobxPoolHandle,
  harnessMobxPoolArm,
  tracked,
  visibleOrderOf,
} from '../src/adapters/mobx-pool'
import { createReadFence, DISABLED_READ_FENCE } from '../../shared/src/instrument/reads'
import { RowShell } from '../../shared/src/row-shell'
import { startScenarioEngine } from '../../shared/src/scenarios'
import { assertCommits, assertReads, mountNativeForCounts } from '../src/count-harness'
import { FENCE_SCENARIOS, openFenceFeeds, runFenceStep } from '../src/fence-scenarios'
import { writeResult } from '../src/results'

// The pool's enforcement only warns, so every pool test installs the trap;
// the native lane's `{ errors: true }` proof stays in Ma1's file
// (`mobx-pool.native.test.tsx`), where the lazy chunk is also proven armed.
installMobxWarnTrap()

const RENDERER =
  'react-native-web aliased from react-native under the worklist test workspace vitest config ' +
  '(same mapping as apps/mobile/vitest.config.ts and expo export -p web); ' +
  'no react-test-renderer in any repo lane'

function drawnIds(list: Element): string[] {
  return [...list.querySelectorAll('[data-testid^="row-"]')].map((row) =>
    (row.getAttribute('data-testid') ?? '').slice('row-'.length),
  )
}

describe('mobx pool on the native renderer, fence steps #1-#3', () => {
  it('meets the shared fences with counts from outside plus parity', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'pooled')
    const reads = createReadFence({ enabled: true })
    const clean = harnessMobxPoolArm.create(
      reads.wrapSource(feeds.rows.source),
      feeds.locals.source,
      reads,
      {
        // No load window closes on its own mid-step: every load lands through
        // the shared fence's settleLoads (G2), none by a timer in a later step.
        schedule: () => () => {},
      },
    )
    // The count mount draws the full visible list (see the header): one slot
    // per visible id, each observing only its own view, stable keys, no data
    // arrays passed as props — the same rows through the same RowShells as
    // the windowed mount, without virtualization.
    const full: HarnessMobxPoolHandle = {
      ...clean,
      mountNative: () => <FullNativeList pool={clean.pool} />,
    }
    const mounted = await mountNativeForCounts(full, reads)
    try {
      const list = await vi.waitFor(
        async () => {
          await act(async () => {})
          const found = document.querySelector('[data-testid="mobx-pool-list"]')
          if (found === null) throw new Error('full native list not mounted yet')
          return found
        },
        { timeout: 20_000, interval: 50 },
      )
      expect(drawnIds(list).length, 'the count mount draws rows').toBeGreaterThan(0)

      const cells = []
      let nonVacuous = 0
      for (const methodology of ['#1', '#2', '#3']) {
        const entry = FENCE_SCENARIOS.find((candidate) => candidate.methodology === methodology)
        if (entry === undefined) throw new Error(`missing fence scenario ${methodology}`)
        const { result, readsBudget } = await runFenceStep(mounted, ctx, feeds.flush, entry)
        const at = `${result.methodology} ${result.scenario}`
        expect(result.parity, `${at}: ${result.parityDiff ?? ''}`).toBe(true)
        assertCommits(result)
        assertReads(result, { readsPerChange: readsBudget })
        mounted.reads.assertNoCopies(mounted.handle)
        if ((result.oracleChangedRows ?? []).length > 0) nonVacuous += 1
        console.info(
          `[mobx-pool-native] ${at}: committed=${result.rowsCommitted} ` +
            `changed=[${(result.oracleChangedRows ?? []).join(',')}] ` +
            `drawn=[${(result.drawnRows ?? []).join(',')}] reads=${result.readsPerChange}/${readsBudget} parity=pass`,
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
      // Not 0 == 0 throughout: at least one of #2/#3 changed a drawn row (#1
      // is the 0-budget heartbeat by methodology).
      expect(
        nonVacuous,
        'no step changed a drawn row: the commit cells are vacuous',
      ).toBeGreaterThan(0)
      writeResult('mobx-pool-native-1x', { scale: 1, renderer: RENDERER, cells })
    } finally {
      mounted.unmount()
      feeds.dispose()
      ctx.dispose()
    }
  }, 300_000)

  it('a whole-list re-render per change fails the count on the native renderer', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'pooled')
    const reads = createReadFence({ enabled: true })
    const clean = harnessMobxPoolArm.create(
      reads.wrapSource(feeds.rows.source),
      feeds.locals.source,
      reads,
      {
        schedule: () => () => {},
      },
    )
    // THE PLANT: every slot reads every visible title, so one rename
    // re-renders every slot and every drawn RowShell commits — the whole-list
    // work the per-row observers exist to avoid. Parity still holds (the
    // mistake is performance, not correctness).
    const planted: HarnessMobxPoolHandle = {
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
      const visible = tracked(() => visibleOrderOf(clean.pool).length)
      // The plant draws the whole visible list: every drawn row is visible,
      // and far more than the real mount's window draws.
      const plantedIds = drawnIds(list)
      expect(plantedIds.length, 'the plant draws every visible row').toBeGreaterThan(24)
      expect(plantedIds.length).toBeLessThanOrEqual(visible)
      const entry = FENCE_SCENARIOS.find((candidate) => candidate.methodology === '#4')
      if (entry === undefined) throw new Error('missing fence scenario #4')
      const { result } = await runFenceStep(mounted, ctx, feeds.flush, entry)
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
      ctx.dispose()
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
    const feeds = openFenceFeeds(ctx, 'pooled')
    const handle = harnessMobxPoolArm.create(feeds.rows.source, feeds.locals.source, DISABLED_READ_FENCE, {
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
          issue: handle.pool.residency?.ids('issue').length ?? 0,
          session: handle.pool.residency?.ids('session').length ?? 0,
        },
        residentSessions: tracked(() => handle.pool.tables.session.size),
        observables: Object.values(built).reduce((a, b) => a + b, 0),
        byMap: built,
        drawn: drawn.length,
        visible: tracked(() => visibleOrderOf(handle.pool).length),
        pendingLoads: handle.pendingLoads(),
      }
      // The lazy baseline (POD-4567, POD-4705): cold rows stay out, the mount
      // queues their loads, and no model is built before its row draws.
      expect(drawn.length, 'the native mount draws rows').toBeGreaterThan(0)
      expect(cell.cold.issue, 'cold issues stay out at bootstrap').toBeGreaterThan(0)
      expect(cell.pendingLoads, 'the mount queues loads').toBeGreaterThan(0)
      console.info(
        `[mobx-pool-native] bootstrap observables=${cell.observables} residentSessions=${cell.residentSessions} ` +
          `drawn=${cell.drawn}/${cell.visible} coldIssues=${cell.cold.issue} ` +
          `coldSessions=${cell.cold.session} pendingLoads=${cell.pendingLoads}`,
      )
      writeResult('mobx-pool-native-bootstrap', { scale: 1, renderer: RENDERER, cell })
    } finally {
      mounted.unmount()
      feeds.dispose()
      ctx.dispose()
    }
  }, 300_000)
})

/** The count mount: one slot per visible id, each observing only whether its issue is in memory; the row observes its fields. */
const FullNativeSlot = observer(function FullNativeSlot({
  pool,
  id,
}: {
  pool: MobxPool
  id: string
}): ReactElement | null {
  const model = pool.worklistRow(id)
  if (model === undefined || !model.inMemory) return null
  return <RowShell row={model} component={PoolNativeRow} />
})

const FullNativeList = observer(function FullNativeList({
  pool,
}: {
  pool: MobxPool
}): ReactElement {
  return (
    <View testID="mobx-pool-list">
      {visibleOrderOf(pool).map((id) => (
        <FullNativeSlot key={id} pool={pool} id={id} />
      ))}
    </View>
  )
})

/** THE PLANT: one slot per visible id, each reading every visible title. */
const PlantedSlot = observer(function PlantedSlot({
  pool,
  id,
}: {
  pool: MobxPool
  id: string
}): ReactElement | null {
  for (const other of visibleOrderOf(pool)) void pool.issue(other)?.title
  const model = pool.worklistRow(id)
  if (model === undefined || !model.inMemory) return null
  return <RowShell row={model} component={PoolNativeRow} />
})

const PlantedNativeList = observer(function PlantedNativeList({
  pool,
}: {
  pool: MobxPool
}): ReactElement {
  return (
    <View testID="mobx-pool-list">
      {visibleOrderOf(pool).map((id) => (
        <PlantedSlot key={id} pool={pool} id={id} />
      ))}
    </View>
  )
})
