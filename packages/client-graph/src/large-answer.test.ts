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

  /**
   * POD-7168: the deck's rows waited on one lookup after another. The Full
   * view's row walk stopped at its first row still loading, and a row's word
   * read each blocked-by target outside the tree as a whole record: one
   * record per round trip, and the operator's deck waited on about 18 in a
   * row. A dependency's reference and state are stub fields, and the walk
   * reads every row before it answers.
   */
  it('opens in two load hops when tree issues are blocked by issues outside it', async () => {
    let run: LargeDeckRun | undefined
    try {
      run = await openLargeDeck({
        members: MEMBERS,
        sessionsPerIssue: 2,
        outsideBlockers: 20,
        serverComesWith: true,
      })
      expect(run.ready).toBe(true)
      // The tree, then what its records come with (the server answers that
      // with the tree, as its route does): nothing waits on a third.
      expect(run.hops).toBeLessThanOrEqual(2)
      // No blocker outside the tree is loaded whole: the stubs answer for it.
      const lookups = run.fetches.filter((fetch) =>
        fetch.collections.includes('issueProjection.one'),
      )
      expect(lookups).toEqual([])
      expect(run.bursts).toBeLessThanOrEqual(Math.ceil(MEMBERS / 15))
      // The same answers: the proposed blockers are unmet, the done ones met.
      expect(new Map(run.unmetOutside)).toEqual(
        new Map(Array.from({ length: 10 }, (_, k) => [`M${60 * k + 1}`, [`X${2 * k + 1}`]])),
      )
    } finally {
      run?.dispose()
    }
  }, 120_000)

  /**
   * POD-7168: on a cold device the deck's tree was answered in under a second
   * and installed only once the whole first download was durable (25 s of
   * IndexedDB writes on the operator's host): every fetch installed behind the
   * load's last commit. A fetch made while that commit waits installs at once.
   */
  it('opens while the first download is still being written', async () => {
    let run: LargeDeckRun | undefined
    try {
      run = await openLargeDeck({
        members: MEMBERS,
        sessionsPerIssue: 2,
        outsideBlockers: 20,
        serverComesWith: true,
        holdLoadCommit: true,
      })
      expect(run.readyWhileCommitHeld).toBe(true)
      expect(run.ready).toBe(true)
      expect(run.rows).toBe(MEMBERS + 1)
      expect(run.hops).toBeLessThanOrEqual(2)
    } finally {
      run?.dispose()
    }
  }, 120_000)
})
