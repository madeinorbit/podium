import { screenOptions } from '@podium/client-graph/host'
import { createPoolProjection, createRuntimeWorklistPool } from '@podium/client-graph/runtime-pool'
import { LOADING } from '@podium/client-graph'
import { expect, it } from 'vitest'
import { startScenarioEngine } from '../../../../tests/worklist/shared/src/scenarios'
import { MissionScreen } from '@podium/client-graph/mission-screen'
import { settled } from '@podium/client-graph/mission-view'
import { poolBackedScreens } from './pool-screens'

it.each([1, 4] as const)('settles a cold production mission at %sx before its first visible pane', async (scale) => {
  const ctx = await startScenarioEngine(scale, { seed: 4443 })
  const handle = createRuntimeWorklistPool(ctx.engine, screenOptions(poolBackedScreens, ctx.engine))
  const input = { selectedIssueId: scale === 1 ? 'i1766' : 'i13916', paneA: 's0', paneB: null, split: false,
    mode: 'full' as const, handoff: false }
  const screen = new MissionScreen(handle.pool, input.selectedIssueId, { development: true })
  screen.open()
  // The deleted reader returned a lazy deck once its opening boundary was
  // ready. Preserve that question; rich fields load in their small observers.
  const projection = createPoolProjection(handle.pool, () => {
    if (!screen.ready) return LOADING
    for (const id of [input.paneA, input.split ? input.paneB : null])
      if (id && settled(() => handle.pool.sessionObject(id).exists) === LOADING) return LOADING
    return screen
  })
  const stop = projection.subscribe(() => {})
  let pane = projection.getSnapshot()
  try {
    const batches: number[] = []
    for (let turn = 0; turn < 8; turn++) {
      // Device preferences publish in microtasks independently of row hydration.
      // Keep the row-batch ceiling while allowing the opening's owner to settle.
      await Promise.resolve()
      const loaded = handle.pool.hydrate()
      batches.push(loaded)
      pane = projection.getSnapshot()
      if (!loaded && pane !== LOADING) break
    }
    expect(pane, `cold loader batches: ${batches.join(', ')}`).not.toBe(LOADING)
    console.info('[mission cold batches]', JSON.stringify({ scale, batches }))
    expect(batches.filter(Boolean).length, `cold loader batches: ${batches.join(', ')}`).toBeLessThanOrEqual(4)
    if (pane === LOADING) throw new Error('Cold mission did not settle')
    expect(pane.reader.issue(pane.rootId)).toMatchObject({ id: input.selectedIssueId })
    expect(pane.rows.length).toBeGreaterThan(0)
  } finally {
    screen.close()
    stop()
    projection.dispose()
    handle.dispose()
    ctx.dispose()
  }
}, 60_000)
