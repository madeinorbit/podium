import { screenOptions } from '@podium/client-graph/host'
import { createPoolProjection, createRuntimeWorklistPool } from '@podium/client-graph/runtime-pool'
import { LOADING } from '@podium/client-graph'
import { expect, it } from 'vitest'
import { startScenarioEngine } from '../../../../packages/worklist-proto/shared/src/scenarios'
import { readMissionPane } from './mission-pane-reader'
import { poolBackedScreens } from './pool-screens'

it.each([1, 4] as const)('settles a cold production mission at %sx before its first visible pane', async (scale) => {
  const ctx = await startScenarioEngine(scale, { seed: 4443 })
  const handle = createRuntimeWorklistPool(ctx.engine, screenOptions(poolBackedScreens, ctx.engine))
  const input = { selectedIssueId: scale === 1 ? 'i1766' : 'i13916', paneA: 's0', paneB: null, split: false,
    mode: 'full' as const, handoff: false }
  const projection = createPoolProjection(handle.pool, () => readMissionPane(handle.pool, input))
  const stop = projection.subscribe(() => {})
  let pane = projection.getSnapshot()
  try {
    const batches: number[] = []
    for (let turn = 0; turn < 8; turn++) {
      const loaded = handle.pool.hydrate()
      batches.push(loaded)
      pane = projection.getSnapshot()
      if (!loaded) break
    }
    expect(pane, `cold loader batches: ${batches.join(', ')}`).not.toBe(LOADING)
    console.info('[mission cold batches]', JSON.stringify({ scale, batches }))
    expect(batches.filter(Boolean).length, `cold loader batches: ${batches.join(', ')}`).toBeLessThanOrEqual(4)
    if (pane === LOADING) throw new Error('Cold mission did not settle')
    expect(pane.mission.root?.id).toBe(input.selectedIssueId)
    expect(pane.mission.rows.length).toBeGreaterThan(0)
  } finally {
    stop()
    projection.dispose()
    handle.dispose()
    ctx.engine.destroy()
  }
}, 60_000)
