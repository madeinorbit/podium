import { referenceState } from '@podium/client-graph/diagnostics/reference-state'
import { reaction } from 'mobx'
import { describe, expect, it } from 'vitest'

import { allIssueViewModels } from '@podium/client-graph/diagnostics/reference/issue-view-models'
import { createWorklistPool } from '@podium/client-graph/create'
import { checkMissions, poolMissionSnapshot } from '@podium/client-graph/diagnostics/mission-check'
import { MISSION_SUMMARIES } from '@podium/client-graph/mission-schema'
import { createEngineLocals } from '@podium/client-graph/shared/engine-locals'
import type { MobxPool } from '@podium/client-graph/pool'
import { startScenarioEngine, writeRescopeGrow, writeRescopeBack } from '../../../shared/src/scenarios'
import { gen, genCorpus } from '../../../shared/src/gen/changes'
import { startGenRun } from '../../../shared/src/gen/run'
import { FENCE_SCENARIOS, openFenceFeeds } from '../fence-scenarios'
import { tracked } from '../adapters/mobx-pool'
import { installMobxWarnTrap } from '../mobx-trap'
import { writeResult } from '../results'

installMobxWarnTrap({ errors: true })
function settle(pool: MobxPool) {
  for (let round = 0; round < 64; round++) {
    tracked(() => poolMissionSnapshot(pool))
    if (pool.hydrate() === 0) return
  }
  throw new Error('Mission loading did not settle')
}

describe('mission differential replay', () => {
  for (const scale of [1, 4] as const) it(`corpus and every methodology change at ${scale}x`, async () => {
    const ctx = await startScenarioEngine(scale)
    const feeds = openFenceFeeds(ctx, 'pooled')
    const handle = createWorklistPool(feeds.rows.source, feeds.locals.source, { summaries: MISSION_SUMMARIES })
    const stop = reaction(() => poolMissionSnapshot(handle.pool), () => {}, { fireImmediately: true })
    const checks: unknown[] = []
    const check = (scenario: string) => {
      feeds.flush(); settle(handle.pool)
      const store = referenceState(ctx.engine)
      const result = tracked(() => checkMissions(handle.pool, allIssueViewModels(store.replica, store.issueProjections, store.issueUserStates), store.sessions))
      expect(result, scenario).toMatchObject({ differences: 0, first: null, pending: 0 })
      checks.push({ scenario, ...result })
    }
    try {
      check('corpus')
      for (const scenario of FENCE_SCENARIOS) { await scenario.write(ctx); check(scenario.scenario) }
      await writeRescopeGrow(ctx); check('rescopeGrowth')
      await writeRescopeBack(ctx); check('rescopeBack')
      writeResult(`mission-check-${scale}x`, { issue: 'POD-5088', scale, checks })
    } finally { stop(); handle.dispose(); feeds.dispose(); ctx.dispose() }
  }, 600_000)

  const firstSeed = Number(process.env['POD_POOL_GATE_FIRST_SEED'] ?? 1)
  const seeds = Number(process.env['POD_POOL_GATE_SEEDS'] ?? 3)
  const steps = Number(process.env['POD_POOL_GATE_STEPS'] ?? 200)
  for (let seed = firstSeed; seed < firstSeed + seeds; seed++) it(`every generated change, seed ${seed}`, async () => {
    const corpus = genCorpus(), changes = gen(seed, steps, {}, { corpus, forceSidebarValues: true })
    const run = await startGenRun({ corpus, feedMode: 'pooled' })
    let feed = run.feed(), locals = createEngineLocals(run.ctx.engine)
    let handle = createWorklistPool(feed.source, locals.source, { summaries: MISSION_SUMMARIES })
    const observe = () => reaction(() => poolMissionSnapshot(handle.pool), () => {}, { fireImmediately: true })
    let stop = observe()
    try {
      for (const [index, change] of changes.entries()) {
        await run.apply(change)
        if (feed !== run.feed()) {
          stop(); handle.dispose(); locals.dispose()
          feed = run.feed(); locals = createEngineLocals(run.ctx.engine)
          handle = createWorklistPool(feed.source, locals.source, { summaries: MISSION_SUMMARIES }); stop = observe()
        }
        locals.flush(); settle(handle.pool)
        const store = referenceState(run.ctx.engine)
        expect(tracked(() => checkMissions(handle.pool, allIssueViewModels(store.replica, store.issueProjections, store.issueUserStates), store.sessions)),
          `seed ${seed} step ${index} ${change.kind}`).toMatchObject({ differences: 0, first: null, pending: 0 })
      }
      writeResult(`mission-check-seed-${seed}`, { issue: 'POD-5088', seed, steps: changes.length, differences: 0 })
    } finally { stop(); handle.dispose(); locals.dispose(); run.dispose() }
  }, 600_000)
})
