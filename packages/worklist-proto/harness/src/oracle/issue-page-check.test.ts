import { createWorklistPool } from '@podium/client-graph/create'
import { poolIssuePageSnapshot } from '@podium/client-graph/diagnostics/issue-page-check'
import { ISSUE_PAGE_SUMMARIES } from '@podium/client-graph/issue-page-schema'
import type { MobxPool } from '@podium/client-graph/pool'
import { createEngineLocals } from '@podium/client-graph/shared/engine-locals'
import { reaction } from 'mobx'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { gen, genCorpus } from '../../../shared/src/gen/changes'
import { startGenRun } from '../../../shared/src/gen/run'
import {
  startScenarioEngine,
  writeRescopeBack,
  writeRescopeGrow,
} from '../../../shared/src/scenarios'
import { tracked } from '../adapters/mobx-pool'
import { FENCE_SCENARIOS, openFenceFeeds } from '../fence-scenarios'
import { FIXED_NOW } from '../fixture'
import { installMobxWarnTrap } from '../mobx-trap'
import { writeResult } from '../results'
import { expectPoolOutput } from './pool-output'

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
  for (const scale of [1, 4] as const)
    it(`corpus and every methodology change at ${scale}x`, async () => {
      const clock = vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW)
      const ctx = await startScenarioEngine(scale)
      clock.mockImplementation(() => ctx.engine.access.coarseNow)
      const feeds = openFenceFeeds(ctx, 'overlaid')
      const handle = createWorklistPool(feeds.rows.source, feeds.locals.source, {
        summaries: ISSUE_PAGE_SUMMARIES,
      })
      const stop = reaction(
        () => poolIssuePageSnapshot(handle.pool),
        () => {},
        { fireImmediately: true },
      )
      const checks: unknown[] = []
      const check = (scenario: string) => {
        feeds.flush()
        settle(handle.pool)
        expectPoolOutput(
          tracked(() => poolIssuePageSnapshot(handle.pool)),
          scenario,
        )
        checks.push({ scenario, frozenOutput: true })
      }
      try {
        check('corpus')
        for (const scenario of FENCE_SCENARIOS) {
          await scenario.write(ctx)
          check(scenario.scenario)
        }
        await writeRescopeGrow(ctx)
        check('rescopeGrowth')
        await writeRescopeBack(ctx)
        check('rescopeBack')
        writeResult(`issue-page-check-${scale}x`, { issue: 'POD-5437', scale, checks })
      } finally {
        stop()
        handle.dispose()
        feeds.dispose()
        ctx.engine.destroy()
      }
    }, 600_000)

  const firstSeed = Number(process.env['POD_POOL_GATE_FIRST_SEED'] ?? 1)
  const seeds = Number(process.env['POD_POOL_GATE_SEEDS'] ?? 3)
  const steps = Number(process.env['POD_POOL_GATE_STEPS'] ?? 200)
  for (let seed = firstSeed; seed < firstSeed + seeds; seed++)
    it(`every generated change, seed ${seed}`, async () => {
      const clock = vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW)
      const corpus = genCorpus(),
        changes = gen(seed, steps, {}, { corpus, forceSidebarValues: true })
      const run = await startGenRun({ corpus, feedMode: 'overlaid' })
      clock.mockImplementation(() => run.ctx.engine.access.coarseNow)
      let feed = run.feed(),
        locals = createEngineLocals(run.ctx.engine)
      let handle = createWorklistPool(feed.source, locals.source, {
        summaries: ISSUE_PAGE_SUMMARIES,
      })
      const observe = () =>
        reaction(
          () => poolIssuePageSnapshot(handle.pool),
          () => {},
          { fireImmediately: true },
        )
      let stop = observe()
      try {
        for (const [index, change] of changes.entries()) {
          await run.apply(change)
          if (feed !== run.feed()) {
            stop()
            handle.dispose()
            locals.dispose()
            feed = run.feed()
            locals = createEngineLocals(run.ctx.engine)
            handle = createWorklistPool(feed.source, locals.source, {
              summaries: ISSUE_PAGE_SUMMARIES,
            })
            stop = observe()
          }
          locals.flush()
          settle(handle.pool)
          expectPoolOutput(
            tracked(() => poolIssuePageSnapshot(handle.pool)),
            `step ${index}`,
          )
        }
        writeResult(`issue-page-check-seed-${seed}`, {
          issue: 'POD-5437',
          seed,
          steps: changes.length,
          frozenOutputs: changes.length,
        })
      } finally {
        stop()
        handle.dispose()
        locals.dispose()
        run.dispose()
      }
    }, 600_000)
})
