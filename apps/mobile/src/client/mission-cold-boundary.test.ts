import { createWorklistPool } from '@podium/client-graph/create'
import { attachMobileScreens } from '@podium/client-graph/mobile-screens'
import { MOBILE_SCREEN_SUMMARIES } from '@podium/client-graph/mobile-screens-schema'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { onReactionError } from 'mobx'
import { expect, it, vi } from 'vitest'
import { observeMobileScreens, poolMobileScreensSnapshot, trackMobileScreenRead as tracked } from '../../../../tests/worklist/diagnostics/mobile-screens-snapshot'
import { openFenceFeeds } from '../../../../tests/worklist/harness/src/fence-scenarios'
import { FIXED_NOW } from '../../../../tests/worklist/harness/src/fixture/corpus'
import { startScenarioEngine } from '../../../../tests/worklist/shared/src/scenarios'
import { mostRelevantSession } from '../lib/mission-session'

it('keeps loading inside the phone mission boundary for cold corpus root i938', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(FIXED_NOW)
  const errors: unknown[] = []
  const stopErrors = onReactionError(error => errors.push(error))
  const ctx = await startScenarioEngine(1), feeds = openFenceFeeds(ctx, 'pooled')
  const handle = createWorklistPool(feeds.rows.source, feeds.locals.source, { summaries: MOBILE_SCREEN_SUMMARIES })
  const input = { selectedId: 'i938', mode: 'full' as const, tasks: null, selectSession: mostRelevantSession }
  let stop = () => {}
  try {
    await attachMobileScreens(handle.pool)
    stop = observeMobileScreens(handle.pool, input)
    // The inherited serial issue-load waterfall is tracked separately in
    // POD-5780; this ceiling isolates whether LOADING escapes to consumers.
    for (let round = 0; round < 512; round++) {
      const output = tracked(() => poolMobileScreensSnapshot(handle.pool, input))
      if (!handle.pool.hydrate()) {
        expect(output).not.toBe(LOADING)
        if (output === LOADING) throw new Error('Phone mission did not settle')
        expect(output.sections.find(section => section.key === 'mission')?.fields.root).toBe('i938')
        expect(errors).toEqual([])
        return
      }
    }
    throw new Error('Cold mission did not settle within the diagnostic ceiling')
  } finally {
    stop(); stopErrors(); handle.dispose(); feeds.dispose(); ctx.dispose(); vi.useRealTimers()
  }
}, 120_000)
