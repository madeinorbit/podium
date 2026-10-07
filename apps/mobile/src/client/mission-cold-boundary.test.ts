import { createWorklistPool } from '@podium/client-graph/create'
import { attachMobileScreens } from '@podium/client-graph/mobile-screens'
import { MOBILE_SCREEN_SUMMARIES } from '@podium/client-graph/mobile-screens-schema'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { IssueModel, SessionModel } from '@podium/client-graph/models'
import { expect, it, vi } from 'vitest'
import { observeMobileScreens, poolMobileScreensSnapshot, trackMobileScreenRead as tracked } from '../../../../tests/worklist/diagnostics/mobile-screens-snapshot'
import { openFenceFeeds } from '../../../../tests/worklist/harness/src/fence-scenarios'
import { startScenarioEngine } from '../../../../tests/worklist/shared/src/scenarios'
import { mostRelevantSession } from '../lib/mission-session'

it('keeps loading inside the phone mission boundary for cold corpus root i938', async () => {
  let pendingField = ''
  for (const [prototype, fields] of [
    [IssueModel.prototype, ['visible', 'live', 'hasLead', 'memberSummary', 'memberLatestActivity']],
    [SessionModel.prototype, ['exists', 'archived', 'open', 'onRoster', 'atWork', 'asking', 'executing', 'motion', 'settled', 'phase', 'lastActivity', 'condition']],
  ] as const) for (const field of fields) {
    const get = Object.getOwnPropertyDescriptor(prototype, field)!.get!
    vi.spyOn(prototype, field as never, 'get').mockImplementation(function (this: { id: string }) {
      try { return get.call(this) }
      catch (error) {
        if (error === LOADING) pendingField = `${this.id}.${field}\n${new Error().stack}`
        throw error
      }
    })
  }
  const ctx = await startScenarioEngine(1), feeds = openFenceFeeds(ctx, 'pooled')
  const handle = createWorklistPool(feeds.rows.source, feeds.locals.source, { summaries: MOBILE_SCREEN_SUMMARIES })
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
    stop(); handle.dispose(); feeds.dispose(); ctx.dispose(); vi.restoreAllMocks()
  }
}, 120_000)
