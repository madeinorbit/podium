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
import { MobxPool } from '@podium/client-graph/pool'

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
  it('asks a selected parent for its mission root progress, with zero for an invisible root', () => {
    const stamp = '2026-10-01T12:00:00Z'
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
    const rows = [
      ['root', null, 'in_progress', false],
      ['branch', 'root', 'in_progress', false],
      ['leaf', 'branch', 'done', false],
      ['sibling', 'root', 'review', false],
      ['hidden', null, 'done', true],
    ] as const
    pool.apply({ type: 'replace', rows: rows.map(([id, parentId, stage, archived]) => ({
      kind: 'issue', id, value: { id, parentId, stage, archived, title: id, seq: 1,
        deps: [], createdAt: stamp, updatedAt: stamp, readAt: stamp },
    })) })
    try {
      const answers = ask(pool, startupQuestions({ roots: [], parents: ['branch', 'hidden'], needles: [] }))
      expect(answers.get('closed-children:mission:branch')).toEqual({
        total: 3, done: 1, review: 1, stall: 1, run: 0, block: 0, wait: 0,
      })
      expect(answers.get('closed-children:mission:hidden')).toEqual({
        total: 0, done: 0, review: 0, stall: 0, run: 0, block: 0, wait: 0,
      })
    } finally { pool.dispose() }
  })

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

  it('propagates a failed or cyclic answer instead of comparing truncated maps', () => {
    const pool = fullPool(feed)
    try {
      const broken = { name: 'counts:broken', group: 'counts' as const, read: () => { throw new Error('broken reader') } }
      expect(() => ask(pool, [broken])).toThrow('broken reader')
      const cycle: { owner?: unknown } = {}
      cycle.owner = cycle
      expect(() => ask(pool, [{ ...broken, read: () => cycle }])).toThrow(/cyclic answer/)
      expect(() => ask(pool, [{ ...broken, read: () => 1 }, { ...broken, read: () => 1 }])).toThrow(/duplicate question/)
    } finally {
      pool.dispose()
    }
  })
})

describe('startup states against the full bootstrap (h1a1)', () => {
  it('a second full bootstrap answers every question the same', () => {
    const pool = fullPool(feed)
    const report = checkNoWrongNumber(control, ask(pool, questions))
    pool.dispose()
    expect(report.asked).toBe(questions.length)
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
