import { createWorklistPool } from '@podium/client-graph/create'
import { attachMobileScreens } from '@podium/client-graph/mobile-screens'
import { MOBILE_SCREEN_SUMMARIES } from '@podium/client-graph/mobile-screens-schema'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { SessionModel } from '@podium/client-graph/models'
import { expect, it, vi } from 'vitest'
import { observeMobileScreens, poolMobileScreensSnapshot, trackMobileScreenRead as tracked } from '../../../../tests/worklist/diagnostics/mobile-screens-snapshot'
import { openFenceFeeds } from '../../../../tests/worklist/harness/src/fence-scenarios'
import { FIXED_NOW } from '../../../../tests/worklist/harness/src/fixture/corpus'
import { startScenarioEngine } from '../../../../tests/worklist/shared/src/scenarios'
import { mostRelevantSession } from '../lib/mission-session'

it('keeps loading inside the phone mission boundary for cold corpus root i938', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(FIXED_NOW)
  let pendingField = ''
  const stored = SessionModel.prototype.storedField
  vi.spyOn(SessionModel.prototype, 'storedField').mockImplementation(function (this: SessionModel, field) {
    try { return stored.call(this, field) }
    catch (error) {
      if (error === LOADING) pendingField = `${this.id}.${field}\n${new Error().stack}`
      throw error
    }
  })
  const ctx = await startScenarioEngine(1), feeds = openFenceFeeds(ctx, 'pooled')
  const handle = createWorklistPool(feeds.rows.source, feeds.locals.source, { summaries: MOBILE_SCREEN_SUMMARIES })
  const readRow = handle.pool.row.bind(handle.pool)
  vi.spyOn(handle.pool, 'row').mockImplementation(((...args: Parameters<typeof readRow>) => {
    const value = readRow(...args)
    if (value === LOADING) pendingField = `${args.join(':')}\n${new Error().stack}`
    return value
  }) as typeof readRow)
  await attachMobileScreens(handle.pool)
  const input = { selectedId: 'i938', mode: 'full' as const, tasks: null, selectSession: mostRelevantSession }
  let stop = () => {}
  try {
    stop = observeMobileScreens(handle.pool, input)
    for (let round = 0; round < 512; round++) {
      let output
      try { output = tracked(() => poolMobileScreensSnapshot(handle.pool, input)) }
      catch (error) {
        if (error === LOADING) throw new Error(`LOADING escaped the phone boundary at ${pendingField}`)
        throw error
      }
      if (!handle.pool.hydrate()) {
        expect(output).not.toBe(LOADING)
        if (output === LOADING) throw new Error('Phone mission did not settle')
        expect(output.sections.find(section => section.key === 'mission')?.fields.root).toBe('i938')
        return
      }
    }
    throw new Error('Cold mission did not settle within the diagnostic ceiling')
  } finally {
    stop(); handle.dispose(); feeds.dispose(); ctx.dispose(); vi.restoreAllMocks(); vi.useRealTimers()
  }
}, 120_000)
