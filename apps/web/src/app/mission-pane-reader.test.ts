import { screenOptions } from '@podium/client-graph/host'
import { missionView } from '@podium/client-graph/mission-view'
import { createPoolProjection, createRuntimeWorklistPool } from '@podium/client-graph/runtime-pool'
import { LOADING } from '@podium/client-graph'
import { expect, it } from 'vitest'
import { startScenarioEngine } from '../../../../packages/worklist-proto/shared/src/scenarios'
import { readMissionPane } from './mission-pane-reader'
import { poolBackedScreens } from './pool-screens'

it('settles a cold production mission before its first visible pane', async () => {
  const ctx = await startScenarioEngine(1, { seed: 4443 })
  const handle = createRuntimeWorklistPool(ctx.engine, screenOptions(poolBackedScreens, ctx.engine))
  const input = { selectedIssueId: 'i1766', paneA: 's0', paneB: null, split: false,
    mode: 'full' as const, handoff: false }
  const projection = createPoolProjection(handle.pool, () => readMissionPane(handle.pool, input))
  const stop = projection.subscribe(() => {})
  let pane = projection.getSnapshot()
  try {
    for (let turn = 0; turn < 100; turn++) {
      const loaded = handle.pool.hydrate()
      pane = projection.getSnapshot()
      if (!loaded) break
    }
    const diagnostic: Record<string, unknown> = {}
    const inspect = createPoolProjection(handle.pool, () => {
      const view = missionView(handle.pool), deck = view.deck(input.selectedIssueId)
      diagnostic.root = view.selectedRoot(input.selectedIssueId)
      diagnostic.topology = deck.topology
      diagnostic.progress = deck.progress
      diagnostic.archive = view.archiveCount(deck)
      diagnostic.session = view.session(input.paneA)
      return diagnostic
    })
    inspect.getSnapshot()
    inspect.dispose()
    expect(pane, JSON.stringify(diagnostic, (_key, value) =>
      value === LOADING ? 'LOADING' : value instanceof Map || value instanceof Set ? [...value] : value)).not.toBe(LOADING)
    if (pane === LOADING) throw new Error('Cold mission did not settle')
    expect(pane.mission.root?.id).toBe(input.selectedIssueId)
    expect(pane.mission.rows.length).toBeGreaterThan(0)
  } finally {
    stop()
    projection.dispose()
    handle.dispose()
    ctx.engine.destroy()
  }
}, 30_000)
