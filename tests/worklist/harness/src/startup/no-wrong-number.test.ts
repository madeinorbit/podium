/**
 * POD-5594 — the "no wrong number" check, proven armed and fair.
 *
 * Over the base cell of the two-axis corpus (h1a1), on the real engine's
 * pooled feed, the check compares four candidate states with the full
 * bootstrap (`no-wrong-number.ts`, `startup-states.ts`):
 * - a second full bootstrap: every answer equal (the check is not noisy);
 * - a partial store without markers (the policy set's rows only): wrong numbers in
 *   counts, search, the board's closed tabs and closed-children progress.
 *   That is the failure POD-5595's markers must turn into LOADING;
 * - the policy set with markers (POD-7086): what the device holds since the
 *   first download is the policy's collections. Today's readers still read the
 *   pool and answer smaller numbers, not LOADING; the answers are recorded
 *   below so a change that makes them worse fails, and POD-7088 brings the
 *   wrong ones to zero by moving the readers onto collections and stubs.
 * The production pool on the whole feed is in `no-wrong-number.live.test.ts`.
 */

import { MobxPool } from '@podium/client-graph/pool'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { beforeAll, describe, expect, it } from 'vitest'
import { parseCell } from '../fixture'
import { writeResult } from '../results'
import {
  ask,
  assertNoWrongNumber,
  checkNoWrongNumber,
  MOVED_READERS,
  startupQuestions,
  startupTargets,
  summarize,
} from './no-wrong-number'
import {
  afterGapPool,
  collectGarbage,
  FIRST_DOWNLOAD_STEPS,
  firstDownloadPool,
  fullPool,
  gapPool,
  openStartupFeed,
  partialPool,
  policySetPool,
  type StartupFeed,
} from './startup-states'

/**
 * Search surfaces now use device IDs plus the server answer (POD-7089).
 * Every policy and first-download state must have zero wrong search answers.
 * All other groups retain POD-7088's zero-wrong assertions (`MOVED_READERS`).
 */
const SEARCH_WRONG_AT_MOST: Readonly<Record<string, number>> = {
  'policy set': 0,
  always: 0,
  'always+recent': 0,
  'always+recent+sidebar': 0,
  'always+recent+sidebar+stubs': 0,
}

/** The answers of one state, held to POD-7088's acceptance. */
function expectMoved(name: string, report: ReturnType<typeof checkNoWrongNumber>) {
  const groups = summarize(report)
  const moved = report.wrong.filter((w) => MOVED_READERS.test(w.name))
  expect(moved, `${name}: moved readers answer wrong`).toEqual([])
  expect(groups.search?.wrong ?? 0, `${name}: search`).toBeLessThanOrEqual(
    SEARCH_WRONG_AT_MOST[name]!,
  )
  for (const w of report.wrong) expect(w.name, `${name}: only search is left`).toMatch(/^search:/)
  return groups
}

let feed: StartupFeed
let questions: ReturnType<typeof startupQuestions>
let control: Map<string, unknown>
const cell = process.env['PODIUM_STARTUP_CELL'] ?? 'h1a1'

beforeAll(async () => {
  feed = await openStartupFeed(parseCell(cell))
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
    pool.apply({
      type: 'replace',
      rows: rows.map(([id, parentId, stage, archived]) => ({
        kind: 'issue' as const,
        id,
        value: {
          id,
          parentId,
          stage,
          archived,
          title: id,
          seq: 1,
          repoPath: '/synthetic',
          deps: [],
          createdAt: stamp,
          updatedAt: stamp,
          readAt: stamp,
        },
      })),
    })
    try {
      const answers = ask(
        pool,
        startupQuestions({ roots: [], parents: ['branch', 'hidden'], needles: [] }),
      )
      expect(answers.get('closed-children:mission:branch')).toEqual({
        total: 2,
        done: 1,
        waiting: 1,
        working: 0,
        todo: 0,
      })
      expect(answers.get('closed-children:mission:hidden')).toEqual({
        total: 0,
        done: 0,
        waiting: 0,
        working: 0,
        todo: 0,
      })
    } finally {
      pool.dispose()
    }
  })

  it('accepts equal and LOADING, flags anything else, refuses an unsettled control', () => {
    const expected = new Map<string, unknown>([
      ['counts:a', 3],
      ['search:b', ['x']],
      ['counts:c', 1],
    ])
    const report = checkNoWrongNumber(
      expected,
      new Map<string, unknown>([
        ['counts:a', 3],
        ['search:b', LOADING],
        ['counts:c', 0],
      ]),
    )
    expect(report.equal).toEqual(['counts:a'])
    expect(report.loading).toEqual(['search:b'])
    expect(report.wrong).toEqual([{ name: 'counts:c', control: 1, candidate: 0 }])
    expect(() => assertNoWrongNumber(report)).toThrow(/1 of 3 answers are wrong numbers/)
    expect(() =>
      checkNoWrongNumber(new Map([['counts:a', LOADING]]), new Map([['counts:a', 1]])),
    ).toThrow(/unsettled/)
  })

  it('asks every group the brief names, with real targets', () => {
    const groups = new Set(questions.map((q) => q.group))
    expect([...groups].sort()).toEqual([
      'board-archive',
      'closed-children',
      'counts',
      'first-screen',
      'search',
    ])
    const targets = startupTargets(feed.rows)
    expect(targets.roots.length).toBeGreaterThan(0)
    expect(targets.parents.length).toBeGreaterThan(0)
    expect(targets.needles.length).toBeGreaterThan(0)
  })

  it('propagates a failed or cyclic answer instead of comparing truncated maps', () => {
    const pool = fullPool(feed)
    try {
      const broken = {
        name: 'counts:broken',
        group: 'counts' as const,
        read: () => {
          throw new Error('broken reader')
        },
      }
      expect(() => ask(pool, [broken])).toThrow('broken reader')
      const cycle: { owner?: unknown } = {}
      cycle.owner = cycle
      expect(() => ask(pool, [{ ...broken, read: () => cycle }])).toThrow(/cyclic answer/)
      expect(() =>
        ask(pool, [
          { ...broken, read: () => 1 },
          { ...broken, read: () => 1 },
        ]),
      ).toThrow(/duplicate question/)
    } finally {
      pool.dispose()
    }
  })
})

describe(`startup states against the full bootstrap (${cell})`, () => {
  it('after a gap, before the reload: refreshing numbers equal the control at the device cursor', () => {
    const pool = afterGapPool(feed)
    try {
      expect(pool.collections.status({ collection: 'issueProjection.stubs', part: 'stub' })).toBe(
        'refreshing',
      )
      const answers = ask(pool, questions)
      const report = checkNoWrongNumber(control, answers)
      assertNoWrongNumber(report, 'after a gap, before the reload')
      expect(report.wrong).toEqual([])
      expect(report.loading.filter((name) => /^(counts:|closed-children:)/.test(name))).toEqual([])
      console.info(
        `[no-wrong-number] after a gap, before the reload: ${JSON.stringify(summarize(report))}`,
      )
    } finally {
      pool.dispose()
    }
  }, 600_000)

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
    writeResult(`startup-no-wrong-number-partial-${cell}`, {
      groups,
      wrong: report.wrong.slice(0, 40),
    })
    expect(() => assertNoWrongNumber(report, 'partial store')).toThrow(/wrong numbers/)
    for (const group of ['counts', 'search', 'board-archive', 'closed-children'] as const)
      expect(groups[group]?.wrong ?? 0, group).toBeGreaterThan(0)
  }, 600_000)

  it('the policy set with markers gives no wrong number (POD-7088, POD-7089)', () => {
    collectGarbage()
    const pool = policySetPool(feed)
    const report = checkNoWrongNumber(control, ask(pool, questions))
    pool.dispose()
    const groups = summarize(report)
    console.info(`[no-wrong-number] policy set: ${JSON.stringify(groups)}`)
    console.info(
      `[no-wrong-number] policy set wrong: ${JSON.stringify(report.wrong.map((w) => w.name))}`,
    )
    writeResult(`startup-no-wrong-number-policy-set-${cell}`, {
      groups,
      wrong: report.wrong.map((w) => ({
        name: w.name,
        control: w.control,
        candidate: w.candidate,
      })),
    })
    expect(report.asked).toBe(questions.length)
    expectMoved('policy set', report)
  }, 600_000)

  it('after a gap, before and after reading the stale instances, no answer is wrong (POD-7160)', () => {
    const states: Record<string, ReturnType<typeof summarize>> = {}
    for (const read of [false, true]) {
      collectGarbage()
      const pool = gapPool(feed, { read })
      const report = checkNoWrongNumber(control, ask(pool, questions))
      pool.dispose()
      const name = read ? 'gap then read' : 'gap'
      states[name] = summarize(report)
      expect(report.asked).toBe(questions.length)
      assertNoWrongNumber(report, name)
      // Read from disk, the stale instances answer at once: nothing waits.
      if (read) expect(report.loading).toEqual([])
    }
    console.info(`[no-wrong-number] gap states: ${JSON.stringify(states)}`)
    writeResult(`startup-no-wrong-number-gap-${cell}`, states)
  }, 600_000)

  it('no intermediate state of a first download gives a wrong number (POD-7087, POD-7088, POD-7089)', () => {
    // The last state is the policy set. Every moved reader, including
    // the search surfaces, answers equal or LOADING in every state.
    const states: Record<
      string,
      { groups: ReturnType<typeof summarize>; added: string[]; moved: string[] }
    > = {}
    let allowed: Set<string> | undefined
    for (const steps of [FIRST_DOWNLOAD_STEPS.length, 1, 2, 3]) {
      collectGarbage()
      const pool = firstDownloadPool(feed, steps)
      const report = checkNoWrongNumber(control, ask(pool, questions))
      pool.dispose()
      const name = FIRST_DOWNLOAD_STEPS.slice(0, steps).join('+')
      allowed ??= new Set(report.wrong.map((w) => w.name))
      states[name] = {
        groups: summarize(report),
        added: report.wrong.filter((w) => !allowed!.has(w.name)).map((w) => w.name),
        moved: report.wrong.filter((w) => MOVED_READERS.test(w.name)).map((w) => w.name),
      }
    }
    console.info(`[no-wrong-number] first download states: ${JSON.stringify(states)}`)
    writeResult(`startup-no-wrong-number-first-download-${cell}`, states)
    for (const [name, state] of Object.entries(states)) {
      expect(state.moved, `${name}: moved readers`).toEqual([])
      expect(state.groups.search?.wrong ?? 0, `${name}: search`).toBeLessThanOrEqual(
        SEARCH_WRONG_AT_MOST[name]!,
      )
      for (const group of Object.keys(state.groups))
        if (group !== 'search')
          expect(state.groups[group as keyof typeof state.groups]?.wrong, `${name}: ${group}`).toBe(
            0,
          )
    }
  }, 1_800_000)
})
