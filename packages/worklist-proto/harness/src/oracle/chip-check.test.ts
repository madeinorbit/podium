import { allIssueViewModels } from '@podium/client-core/replica'
import { canonicalIssueRef } from '@podium/client-core/viewmodels'
import { createWorklistPool } from '@podium/client-graph/create'
import { checkIssueChips } from '@podium/client-graph/diagnostics/chip-check'
import { issueRefKey } from '@podium/client-graph/issue-reference'
import { describe, expect, it } from 'vitest'
import {
  startScenarioEngine,
  writeRescopeBack,
  writeRescopeGrow,
} from '../../../shared/src/scenarios'
import { FENCE_SCENARIOS, openFenceFeeds } from '../fence-scenarios'

describe('chip differential replay', () => {
  for (const scale of [1, 4] as const)
    it(`all chip values across corpus and methodology changes at ${scale}x`, async () => {
      const ctx = await startScenarioEngine(scale)
      const feeds = openFenceFeeds(ctx, 'overlaid')
      const legacy = () => {
        const state = ctx.engine.getSnapshot()
        return allIssueViewModels(ctx.replica, state.issueProjections, state.issues)
      }
      const handle = createWorklistPool(feeds.rows.source, feeds.locals.source, {
        resolveReferences: async (refs) => {
          // The synthetic authority owns all rows. This map is built in the
          // mocked authority batch, never in the client lookup or cold index.
          const byRef = new Map(
            legacy().map((row) => [issueRefKey(canonicalIssueRef(row)), row.id]),
          )
          return refs.map((ref) => ({ ref, id: byRef.get(ref) ?? null }))
        },
      })
      const check = async (phase: string) => {
        feeds.flush()
        const issues = legacy()
        const tokens = issues.map(canonicalIssueRef)
        for (let round = 0; round < 128; round++) {
          const result = checkIssueChips(handle.pool.references, issues, tokens)
          if (!result.pending) {
            expect(result, phase).toMatchObject({ differences: 0, first: null, pending: 0 })
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
