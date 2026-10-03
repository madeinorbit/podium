import { allIssueViewModels } from '@podium/client-core/replica'
import { canonicalIssueRef } from '@podium/client-core/viewmodels'
import { LOADING } from '@podium/client-graph'
import { createWorklistPool } from '@podium/client-graph/create'
import { describe, expect, it } from 'vitest'
import {
  startScenarioEngine,
  writeRescopeBack,
  writeRescopeGrow,
} from '../../../shared/src/scenarios'
import { FENCE_SCENARIOS, openFenceFeeds } from '../fence-scenarios'
import { expectPoolOutput } from './pool-output'

describe('chip differential replay', () => {
  for (const scale of [1, 4] as const)
    it(`all chip values across corpus and methodology changes at ${scale}x`, async () => {
      const ctx = await startScenarioEngine(scale)
      const feeds = openFenceFeeds(ctx, 'overlaid')
      const fixtureIssues = () => {
        const state = ctx.engine.getSnapshot()
        return allIssueViewModels(ctx.replica, state.issueProjections, state.issueUserStates)
      }
      const handle = createWorklistPool(feeds.rows.source, feeds.locals.source)
      const check = async (phase: string) => {
        feeds.flush()
        const issues = fixtureIssues()
        const tokens = issues.map(canonicalIssueRef)
        for (let round = 0; round < 128; round++) {
          const values = tokens.map((token) => handle.pool.references.read(token))
          if (!values.some((value) => value === LOADING)) {
            expect(values.length).toBe(tokens.length)
            expectPoolOutput(values, phase)
            return
          }
          handle.pool.hydrate()
          await Promise.resolve()
        }
        throw new Error('Chip load windows failed to settle')
      }
      try {
        await check('bootstrap')
        // Rescope and newIssue deliberately reuse the fixture's next sequence
        // number. Exercise rescope first so references remain unique, as the
        // server guarantees, throughout this chip-value replay.
        await writeRescopeGrow(ctx)
        await check('rescopeGrowth')
        await writeRescopeBack(ctx)
        await check('rescopeBack')
        for (const scenario of FENCE_SCENARIOS) {
          await scenario.write(ctx)
          await check(scenario.scenario)
        }
      } finally {
        handle.dispose()
        feeds.dispose()
        ctx.engine.destroy()
      }
    }, 180_000)
})
