/**
 * POD-4608 — the engine-backed locals source on a real runtime: the #8 tick
 * notifies with `{coarseNow}` only, the #3 click with the selection key only,
 * and a row write (the #4 rename, the #1 heartbeat) notifies nothing. The
 * keys are the point: a tick must not wake selection consumers, a click must
 * not wake the clock.
 */

import { describe, expect, it } from 'vitest'
import {
  startScenarioEngine,
  writeClockTick,
  writeHeartbeat,
  writeSelectionClick,
  writeTitleRename,
} from '../../shared/src/scenarios'
import type { LocalsKey } from '../../shared/src/slice-types'
import { createEngineLocals, localsOfEngine } from './engine-locals'

describe('engine-backed locals source', () => {
  it('names exactly the keys each engine write moved', async () => {
    const ctx = await startScenarioEngine(1)
    const locals = createEngineLocals(ctx.engine)
    const seen: LocalsKey[][] = []
    locals.source.subscribe((changed) => seen.push([...changed].sort()))
    try {
      const start = locals.source.get()
      expect(start).toEqual(localsOfEngine(ctx.engine))
      expect(start.selectedIssueId).toBeNull()

      await writeHeartbeat(ctx)
      locals.flush()
      await writeTitleRename(ctx)
      locals.flush()
      expect(seen).toEqual([])
      expect(locals.stats.notifications).toBe(0)
      // Row writes did signal: the drain ran and found no local moved.
      expect(locals.stats.flushes).toBeGreaterThan(0)

      locals.stats.reset()
      await writeClockTick(ctx)
      locals.flush()
      expect(seen).toEqual([['coarseNow']])
      expect(locals.source.get().coarseNow).toBe(start.coarseNow + 60_000)
      expect(locals.stats.keys).toEqual({ selectedIssueId: 0, selectedIssueWasFolded: 0, coarseNow: 1 })

      locals.stats.reset()
      const clicked = await writeSelectionClick(ctx)
      locals.flush()
      expect(seen).toEqual([['coarseNow'], ['selectedIssueId']])
      expect(locals.source.get().selectedIssueId).toBe(clicked)
      expect(locals.stats.keys).toEqual({ selectedIssueId: 1, selectedIssueWasFolded: 0, coarseNow: 0 })
      expect(locals.stats.notifications).toBe(1)
    } finally {
      locals.dispose()
      ctx.engine.destroy()
    }
  }, 60_000)
})
