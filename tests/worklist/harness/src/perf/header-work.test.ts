// @vitest-environment happy-dom
import { createRuntimeWorklistPool } from '@podium/client-graph/runtime-pool'
import { headerView } from '@podium/client-graph/header-views'
import { autorun } from 'mobx'
import { expect, it } from 'vitest'
import { startScenarioEngine, writeHeartbeat, writeSelectionClick } from '../../../shared/src/scenarios'
import { headerStats } from './header'

const calls = () => Object.fromEntries(Object.entries(headerStats.read())
  .sort(([a], [b]) => a.localeCompare(b)).map(([name, count]) => [name, count.calls]))

it.each([1, 4] as const)('records actual header derivation work at %ix', async (scale) => {
  const ctx = await startScenarioEngine(scale)
  const health = { status: 'ok', rttMs: 12, since: 0 }
  Object.assign(ctx.engine.hub, {
    connectionHealth: () => health,
    onConnectionHealth: () => () => {},
  })
  headerStats.enable()
  headerStats.reset()
  const handle = createRuntimeWorklistPool(ctx.engine, { header: true })
  const view = headerView(handle.pool)
  const stop = autorun(() => {
    view.folded()
    view.working()
    view.workingCount()
    view.aggregate(undefined)
    view.occupancyKey()
  })
  const settle = async () => {
    for (let turn = 0; turn < 64; turn++) {
      if (handle.pool.hydrate() === 0) return
      await Promise.resolve()
    }
    throw new Error('Header work fixture did not settle')
  }
  try {
    await settle()
    const opening = calls()
    expect(opening['pool.workingCount']).toBeGreaterThan(0)
    expect(opening['pool.workingSession']).toBeGreaterThan(0)
    console.log('header opening work', JSON.stringify({ scale, counts: opening }))
    for (const [step, write] of [['heartbeat', writeHeartbeat], ['selection', writeSelectionClick]] as const) {
      headerStats.reset()
      await write(ctx)
      await settle()
      console.log('header change work', JSON.stringify({ scale, step, counts: calls() }))
    }
  } finally {
    stop()
    handle.dispose()
    ctx.dispose()
    headerStats.disable()
    headerStats.reset()
  }
}, 120_000)
