// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import { runInAction } from 'mobx'
import { asIssueId } from '@podium/model/browser'
import { referenceState } from '../../../tests/worklist/diagnostics/reference-state'
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
    step = 'cold ids'
    const cold = handle.pool.queries.ids({ kind: 'commandIssues' }).filter(id => handle.pool.residency!.isCold('issue', id))
    expect(cold.length).toBeGreaterThan(0)
    step = 'reference state'
    const state = referenceState(ctx.engine)
    step = 'select issue'
    state.setSelectedIssueId(asIssueId(cold[0]!))
    step = 'selection microtask'
    await Promise.resolve()
    step = 'selected pending'
    const selected = runInAction(() => commandLaunchViews(handle.pool).palette())
    expect(selected && selected !== LOADING ? selected.pending : 0).toBeGreaterThan(0)
    expect(handle.pool.hydrate()).toBeGreaterThan(0)
    for (let turn = 0; turn < 32; turn++) {
      step = `selected turn ${turn}`
      const value = runInAction(() => commandLaunchViews(handle.pool).palette())
      if (value && value !== LOADING) {
        const issue = value.issues.find(issue => issue.id === cold[0])
        if (issue) for (const key of ['unread', 'readAt', 'memberSessionIds', 'childCount', 'childDoneCount', 'gitState', 'needsHuman', 'blocked', 'stage', 'closedReason'] as const) {
          step = `selected ${key}`
          runInAction(() => { void issue[key] })
        }
      }
      if (!handle.pool.hydrate()) break
    }
    detach()
  } catch (cause) {
    throw new Error(`${step}: ${String(cause)}`, { cause })
  } finally { handle.dispose(); ctx.dispose() }
}, 120_000)
