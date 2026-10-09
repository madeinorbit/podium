/**
 * POD-5594 — the "no wrong number" check, proven armed and fair.
 *
 * Over the base cell of the two-axis corpus (h1a1), on the real engine's
 * pooled feed, the check compares four candidate states with the full
 * bootstrap (`no-wrong-number.ts`, `startup-states.ts`):
 * - a second full bootstrap: every answer equal (the check is not noisy);
 * - a partial store without markers (active rows only): wrong numbers in
 *   counts, search, the board's closed tabs and closed-children progress.
 *   That is the failure POD-5595's markers must turn into LOADING;
 * The lazy pool (before and after its cold rows load) is in
 * `no-wrong-number.lazy.test.ts`: its own worker, for memory.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { writeResult } from '../results'
import {
  ask,
  assertNoWrongNumber,
  checkNoWrongNumber,
  startupQuestions,
  startupTargets,
  summarize,
} from './no-wrong-number'
import { collectGarbage, fullPool, openStartupFeed, partialPool, type StartupFeed } from './startup-states'
import { LOADING } from '@podium/client-graph/worklist/rollup'

let feed: StartupFeed
let questions: ReturnType<typeof startupQuestions>
let control: Map<string, unknown>

beforeAll(async () => {
  feed = await openStartupFeed({ history: 1, active: 1 })
  questions = startupQuestions(startupTargets(feed.rows))
  const pool = fullPool(feed)
  control = ask(pool, questions)
  pool.dispose()
  collectGarbage()
}, 600_000)

describe('the check itself', () => {
  it('accepts equal and LOADING, flags anything else, refuses an unsettled control', () => {
    const expected = new Map<string, unknown>([['counts:a', 3], ['search:b', ['x']], ['counts:c', 1]])
    const report = checkNoWrongNumber(expected, new Map<string, unknown>([['counts:a', 3], ['search:b', LOADING], ['counts:c', 0]]))
    expect(report.equal).toEqual(['counts:a'])
    expect(report.loading).toEqual(['search:b'])
    expect(report.wrong).toEqual([{ name: 'counts:c', control: 1, candidate: 0 }])
    expect(() => assertNoWrongNumber(report)).toThrow(/1 of 3 answers are wrong numbers/)
    expect(() => checkNoWrongNumber(new Map([['counts:a', LOADING]]), new Map([['counts:a', 1]]))).toThrow(/unsettled/)
  })

  it('asks every group the brief names, with real targets', () => {
    const groups = new Set(questions.map((q) => q.group))
    expect([...groups].sort()).toEqual(['board-archive', 'closed-children', 'counts', 'first-screen', 'search'])
    const targets = startupTargets(feed.rows)
    expect(targets.roots.length).toBeGreaterThan(0)
    expect(targets.parents.length).toBeGreaterThan(0)
    expect(targets.needles.length).toBeGreaterThan(0)
  })
})

describe('startup states against the full bootstrap (h1a1)', () => {
  it('a second full bootstrap answers every question the same', () => {
    const pool = fullPool(feed)
    const report = checkNoWrongNumber(control, ask(pool, questions))
    pool.dispose()
    expect(report.loading).toEqual([])
    assertNoWrongNumber(report, 'second full bootstrap')
  }, 600_000)

  it('a partial store without markers gives wrong numbers (the check fails)', () => {
    collectGarbage()
    const pool = partialPool(feed)
    const report = checkNoWrongNumber(control, ask(pool, questions))
    pool.dispose()
    const groups = summarize(report)
    console.info(`[no-wrong-number] partial store: ${JSON.stringify(groups)}`)
    writeResult('startup-no-wrong-number-partial-h1a1', { groups, wrong: report.wrong.slice(0, 40) })
    expect(() => assertNoWrongNumber(report, 'partial store')).toThrow(/wrong numbers/)
    for (const group of ['counts', 'search', 'board-archive', 'closed-children'] as const)
      expect(groups[group]?.wrong ?? 0, group).toBeGreaterThan(0)
  }, 600_000)
})
