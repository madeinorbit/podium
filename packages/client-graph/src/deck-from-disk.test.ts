/**
 * POD-7159 — the deck reopened from disk (design POD-7157 "The loader: two
 * sources", "Leaving memory is not leaving the device"): the instances it
 * read leave memory and stay on the device, and opening it again reads them
 * from disk, with no server request, offline too. A reader of a row that left
 * memory sees LOADING and then the row, never REMOVED or NOT_VISIBLE. The
 * rows come back in bursts of a disk chunk, one publication each.
 */
import { describe, expect, it } from 'vitest'
import { type LargeDeckRun, openLargeDeck } from './large-answer.test.fixture'

const MEMBERS = 970

describe('the deck reopened from disk (POD-7159)', () => {
  for (const offline of [false, true]) {
    it(`is complete again with no server request${offline ? ', offline' : ''}`, async () => {
      let run: LargeDeckRun | undefined
      try {
        run = await openLargeDeck({ members: MEMBERS, sessionsPerIssue: 2, serverComesWith: true })
        expect(run.ready).toBe(true)
        expect(run.rows).toBe(MEMBERS + 1)
        const reopen = await run.reopenFromDisk({ offline })
        expect(reopen.unloaded).toBeGreaterThan(0)
        expect(reopen.rowsUnloaded).toBeGreaterThanOrEqual(MEMBERS)
        expect(reopen.ready).toBe(true)
        expect(reopen.rows).toBe(MEMBERS + 1)
        // Design invariant 3: reopening a screen whose instances are on disk
        // makes no server request, online too.
        expect(reopen.fetchedStates, 'no server request').toEqual({})
        expect(reopen.fetched).toEqual([])
        expect(reopen.fetches).toBe(0)
        expect(reopen.rowsLoaded).toBe(reopen.rowsUnloaded)
        // Unloaded is never removed: LOADING, then the row.
        expect(reopen.answers).toEqual(['loading', 'row'])
        // Install cost: bursts (one notification of the readers each) of a
        // disk chunk per read, never one per row (the per-load bound is in
        // the sync package's disk-layer test).
        expect(reopen.rowBursts).toBeLessThan(reopen.rowsLoaded / 100)
      } finally {
        run?.dispose()
      }
    }, 120_000)
  }
})
