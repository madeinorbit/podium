import { reaction } from 'mobx'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { allIssueViewModels } from '@podium/client-core/replica'
import { createWorklistPool } from '@podium/client-graph/create'
import { checkIssuePages, poolIssuePageSnapshot, startIssuePageCheck } from '@podium/client-graph/diagnostics/issue-page-check'
import { bindSidebarPerf, createSidebarPerf, storeStats } from '@podium/client-core/perf'
import { ISSUE_PAGE_SUMMARIES } from '@podium/client-graph/issue-page-schema'
import { createEngineLocals } from '@podium/client-graph/shared/engine-locals'
import type { MobxPool } from '@podium/client-graph/pool'
import { startScenarioEngine, writeRescopeGrow, writeRescopeBack } from '../../../shared/src/scenarios'
import { gen, genCorpus } from '../../../shared/src/gen/changes'
import { startGenRun } from '../../../shared/src/gen/run'
import { FENCE_SCENARIOS, openFenceFeeds } from '../fence-scenarios'
import { tracked } from '../adapters/mobx-pool'
import { installMobxWarnTrap } from '../mobx-trap'
import { writeResult } from '../results'
import { FIXED_NOW } from '../fixture'

installMobxWarnTrap({ errors: true })
afterEach(() => vi.restoreAllMocks())
function settle(pool: MobxPool) {
  for (let round = 0; round < 64; round++) {
    tracked(() => poolIssuePageSnapshot(pool))
    if (pool.hydrate() === 0) return
  }
  throw new Error('Issue page loading did not settle')
}

describe('issue page differential replay', () => {
  it('owns the diagnostic timer, brackets legacy check work and releases it after errors or disposal', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW)
    const run = await startGenRun({ corpus: genCorpus(), feedMode: 'overlaid' })
    clock.mockImplementation(() => run.ctx.engine.getSnapshot().coarseNow)
    const locals = createEngineLocals(run.ctx.engine)
    const handle = createWorklistPool(run.feed().source, locals.source, { summaries: ISSUE_PAGE_SUMMARIES })
    const perf = createSidebarPerf(), unbind = bindSidebarPerf(run.ctx.engine, perf)
    let stop: (() => void) | undefined
    try {
      settle(handle.pool)
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }); storeStats.enable()
      const report = vi.fn()
      stop = startIssuePageCheck(run.ctx.engine, handle.pool, report, 50)
      expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'waiting', checks: 0 }))
      vi.advanceTimersByTime(50)
      expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'match', differences: 0, pending: 0, checks: 1 }))
      expect(perf.read().idle.derivations).toBe(0)
      vi.spyOn(run.ctx.engine, 'getSnapshot').mockImplementationOnce(() => { throw new Error('Synthetic failure') })
      vi.advanceTimersByTime(50)
      expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'error' }))
      stop(); stop()
      expect(vi.getTimerCount()).toBe(0)
      const count = report.mock.calls.length
      vi.advanceTimersByTime(100)
      expect(report.mock.calls.length).toBe(count)
      expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'off', checks: 1 }))
      expect(() => startIssuePageCheck(run.ctx.engine, handle.pool, report, 0)).toThrow(/positive/)
    } finally {
      stop?.(); unbind(); vi.useRealTimers(); vi.restoreAllMocks(); storeStats.enable(false); storeStats.reset()
      handle.dispose(); locals.dispose(); run.dispose()
    }
  })
  for (const scale of [1, 4] as const) it(`corpus and every methodology change at ${scale}x`, async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW)
    const ctx = await startScenarioEngine(scale)
    clock.mockImplementation(() => ctx.engine.getSnapshot().coarseNow)
    const feeds = openFenceFeeds(ctx, 'overlaid')
    const handle = createWorklistPool(feeds.rows.source, feeds.locals.source, { summaries: ISSUE_PAGE_SUMMARIES })
    const stop = reaction(() => poolIssuePageSnapshot(handle.pool), () => {}, { fireImmediately: true })
    const checks: unknown[] = []
    const check = (scenario: string) => {
      feeds.flush(); settle(handle.pool)
      const store = ctx.engine.getSnapshot()
      const result = tracked(() => checkIssuePages(handle.pool, allIssueViewModels(store.replica, store.issueProjections, store.issueUserStates), store.sessions))
      expect(result, scenario).toMatchObject({ differences: 0, first: null, pending: 0 })
      checks.push({ scenario, ...result })
    }
    try {
      check('corpus')
      for (const scenario of FENCE_SCENARIOS) { await scenario.write(ctx); check(scenario.scenario) }
      await writeRescopeGrow(ctx); check('rescopeGrowth')
      await writeRescopeBack(ctx); check('rescopeBack')
      writeResult(`issue-page-check-${scale}x`, { issue: 'POD-5091', scale, checks })
    } finally { stop(); handle.dispose(); feeds.dispose(); ctx.engine.destroy() }
  }, 600_000)

  const firstSeed = Number(process.env['POD_POOL_GATE_FIRST_SEED'] ?? 1)
  const seeds = Number(process.env['POD_POOL_GATE_SEEDS'] ?? 3)
  const steps = Number(process.env['POD_POOL_GATE_STEPS'] ?? 200)
  for (let seed = firstSeed; seed < firstSeed + seeds; seed++) it(`every generated change, seed ${seed}`, async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW)
    const corpus = genCorpus(), changes = gen(seed, steps, {}, { corpus, forceSidebarValues: true })
    const run = await startGenRun({ corpus, feedMode: 'overlaid' })
    clock.mockImplementation(() => run.ctx.engine.getSnapshot().coarseNow)
    let feed = run.feed(), locals = createEngineLocals(run.ctx.engine)
    let handle = createWorklistPool(feed.source, locals.source, { summaries: ISSUE_PAGE_SUMMARIES })
    const observe = () => reaction(() => poolIssuePageSnapshot(handle.pool), () => {}, { fireImmediately: true })
    let stop = observe()
    try {
      for (const [index, change] of changes.entries()) {
        await run.apply(change)
        if (feed !== run.feed()) {
          stop(); handle.dispose(); locals.dispose()
          feed = run.feed(); locals = createEngineLocals(run.ctx.engine)
          handle = createWorklistPool(feed.source, locals.source, { summaries: ISSUE_PAGE_SUMMARIES }); stop = observe()
        }
        locals.flush(); settle(handle.pool)
        const store = run.ctx.engine.getSnapshot()
        expect(tracked(() => checkIssuePages(handle.pool, allIssueViewModels(store.replica, store.issueProjections, store.issueUserStates), store.sessions)),
          `seed ${seed} step ${index} ${change.kind}`).toMatchObject({ differences: 0, first: null, pending: 0 })
      }
      writeResult(`issue-page-check-seed-${seed}`, { issue: 'POD-5091', seed, steps: changes.length, differences: 0 })
    } finally { stop(); handle.dispose(); locals.dispose(); run.dispose() }
  }, 600_000)
})
