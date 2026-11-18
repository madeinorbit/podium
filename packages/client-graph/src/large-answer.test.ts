/**
 * POD-7165 — opening a flight deck over a large tree installs its answer in
 * bounded work. The operator's deck (about 1,000 issues and thousands of their
 * sessions) froze the page for about two minutes: every chunk of an answer was
 * its own install, the loader told the views of the stubs once per issue row,
 * outside any action, and the cache trim walked every row after each of the
 * twenty comes-with answers.
 *
 * Over the real kernel Replica, facade, row source, pool and mission screen:
 * the answers install in a few bursts (not one per chunk), the views hear of
 * each burst a bounded number of times (not once per row), and one trim runs
 * once the fetches are done.
 */
import { describe, expect, it } from 'vitest'
import { type LargeDeckRun, openLargeDeck } from './large-answer.test.fixture'

const MEMBERS = 600
const SESSIONS_PER_ISSUE = 4

describe('a large tree and its sessions install in bounded work (POD-7165)', () => {
  it('opens the deck in a few bursts and publications, with one trim', async () => {
    let run: LargeDeckRun | undefined
    try {
      run = await openLargeDeck({ members: MEMBERS, sessionsPerIssue: SESSIONS_PER_ISSUE })
      expect(run.ready).toBe(true)
      expect(run.rows).toBe(MEMBERS + 1)
      // Every tree issue comes with four instances (its sessions, read state,
      // git state, dependencies): 2,400 instances of 4,200 rows over 500-row
      // chunks. They used to install one chunk per burst, thousands of them.
      // Arrived chunks now install together: a burst per answer group.
      expect(run.bursts).toBeLessThanOrEqual(Math.ceil(MEMBERS / 15))
      // The loader tells each kind of change once per burst, never per row.
      expect(run.notifications).toBeLessThanOrEqual(3 * run.bursts)
      // One publication into the pool per burst that brought rows, at most.
      expect(run.flushes).toBeLessThanOrEqual(run.bursts)
      // The trim runs once the fetches in flight are done, not after each.
      expect(run.trims).toBeLessThanOrEqual(3)
    } finally {
      run?.dispose()
    }
  }, 120_000)
})
