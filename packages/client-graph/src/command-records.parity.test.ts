// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import { runInAction } from 'mobx'
import { startScenarioEngine } from '../../../tests/worklist/shared/src/scenarios'
import { createRuntimeWorklistPool } from './runtime-pool'
import { COMMAND_SUMMARIES } from './command-launch-schema'
import { attachCommandLaunchSource } from './command-launch-source'
import { attachHeaderSource } from './header-source'
import { commandLaunchViews } from './command-launch-views'
import { LOADING } from './loading'

it('reads the existing licensed command summaries without promoting historical payloads', async () => {
  const ctx = await startScenarioEngine(1)
  const handle = createRuntimeWorklistPool(ctx.engine, { summaries: COMMAND_SUMMARIES })
  let step = 'boot'
  try {
    for (let turn = 0; turn < 32 && handle.pool.hydrate(); turn++) {}
    await new Promise(resolve => setTimeout(resolve, 0))
    for (let turn = 0; turn < 32 && handle.pool.hydrate(); turn++) {}
    attachCommandLaunchSource(handle.pool, ctx.engine)
    const detach = attachHeaderSource(handle.pool, ctx.engine)
    step = 'palette'
    const data = runInAction(() => commandLaunchViews(handle.pool).palette())
    expect(data && data !== LOADING).toBeTruthy()
    if (!data || data === LOADING) throw new Error('No command data')
    for (const issue of data.issues) for (const key of COMMAND_SUMMARIES.issue) {
      step = `issue ${issue.id}.${key}`
      runInAction(() => { void issue[key] })
    }
    step = 'hydrate after summary reads'
    expect(handle.pool.hydrate()).toBe(0)
    detach()
  } catch (cause) {
    throw new Error(`${step}: ${String(cause)}`, { cause })
  } finally { handle.dispose(); ctx.dispose() }
}, 120_000)
