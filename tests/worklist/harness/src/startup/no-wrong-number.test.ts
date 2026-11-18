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
 * - the policy set with markers (POD-7086): what the device holds since the
 *   first download is the policy's collections. Today's readers still read the
 *   pool and answer smaller numbers, not LOADING; the answers are recorded
 *   below so a change that makes them worse fails, and POD-7088 brings the
 *   wrong ones to zero by moving the readers onto collections and stubs.
 * The lazy pool (before and after its cold rows load) is in
 * `no-wrong-number.lazy.test.ts`: its own worker, for memory.
 */

import { MobxPool } from '@podium/client-graph/pool'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { beforeAll, describe, expect, it } from 'vitest'
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
  collectGarbage,
  FIRST_DOWNLOAD_STEPS,
  firstDownloadPool,
  fullPool,
  openStartupFeed,
  partialPool,
  policySetPool,
  type StartupFeed,
} from './startup-states'

/**
 * The policy set's answers on h1a1 (seed 4443), per group: equal / LOADING /
 * wrong. Recorded by POD-7086; POD-7088 must bring every `wrong` to zero, and
 * this test then asserts that. A change here is a change of what users see.
 */
const POLICY_SET_BASELINE = {
  'first-screen': { equal: 24, loading: 0, wrong: 0 },
  counts: { equal: 0, loading: 0, wrong: 4 },
  search: { equal: 4, loading: 0, wrong: 9 },
  'board-archive': { equal: 0, loading: 0, wrong: 1 },
  'closed-children': { equal: 39, loading: 0, wrong: 57 },
}

/**
 * POD-7087 added questions whose readers it moved onto the stubs: two counts
 * and two per parent. The policy set holds every stub, so each is equal.
 */
const withStubQuestions = (parents: number) => ({
  ...POLICY_SET_BASELINE,
  counts: { ...POLICY_SET_BASELINE.counts, equal: POLICY_SET_BASELINE.counts.equal + 2 },
  'closed-children': {
    ...POLICY_SET_BASELINE['closed-children'],
    equal: POLICY_SET_BASELINE['closed-children'].equal + 2 * parents,
  },
})

/**
 * Each intermediate state of a first download on h1a1 (seed 4443), per group:
 * equal / LOADING / wrong (POD-7087, vega). The readers POD-7087 moved are
 * never among the wrong ones; the rest are POD-7088's, like the policy set's.
 */
const FIRST_DOWNLOAD_BASELINE: Record<string, unknown> = {
  always: {
    'first-screen': { equal: 0, loading: 24, wrong: 0 },
    counts: { equal: 0, loading: 2, wrong: 4 },
    search: { equal: 0, loading: 0, wrong: 13 },
    'board-archive': { equal: 0, loading: 0, wrong: 1 },
    'closed-children': { equal: 15, loading: 48, wrong: 81 },
  },
  'always+recent': {
    'first-screen': { equal: 0, loading: 24, wrong: 0 },
    counts: { equal: 0, loading: 2, wrong: 4 },
    search: { equal: 4, loading: 0, wrong: 9 },
    'board-archive': { equal: 0, loading: 0, wrong: 1 },
    'closed-children': { equal: 36, loading: 48, wrong: 60 },
  },
  'always+recent+sidebar': {
    'first-screen': { equal: 24, loading: 0, wrong: 0 },
    counts: { equal: 0, loading: 2, wrong: 4 },
    search: { equal: 4, loading: 0, wrong: 9 },
    'board-archive': { equal: 0, loading: 0, wrong: 1 },
    'closed-children': { equal: 39, loading: 48, wrong: 57 },
  },
  'always+recent+sidebar+stubs': {
    'first-screen': { equal: 24, loading: 0, wrong: 0 },
    counts: { equal: 2, loading: 0, wrong: 4 },
    search: { equal: 4, loading: 0, wrong: 9 },
    'board-archive': { equal: 0, loading: 0, wrong: 1 },
    'closed-children': { equal: 87, loading: 0, wrong: 57 },
  },
}

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
    writeResult('startup-no-wrong-number-partial-h1a1', {
      groups,
      wrong: report.wrong.slice(0, 40),
    })
    expect(() => assertNoWrongNumber(report, 'partial store')).toThrow(/wrong numbers/)
    for (const group of ['counts', 'search', 'board-archive', 'closed-children'] as const)
      expect(groups[group]?.wrong ?? 0, group).toBeGreaterThan(0)
  }, 600_000)

  it('the policy set with markers answers as recorded (POD-7086); POD-7088 brings the wrong ones to zero', () => {
    collectGarbage()
    const pool = policySetPool(feed)
    const report = checkNoWrongNumber(control, ask(pool, questions))
    pool.dispose()
    const groups = summarize(report)
    console.info(`[no-wrong-number] policy set: ${JSON.stringify(groups)}`)
    console.info(
      `[no-wrong-number] policy set wrong: ${JSON.stringify(report.wrong.map((w) => w.name))}`,
    )
    writeResult('startup-no-wrong-number-policy-set-h1a1', {
      groups,
      wrong: report.wrong.map((w) => ({
        name: w.name,
        control: w.control,
        candidate: w.candidate,
      })),
    })
    expect(report.asked).toBe(questions.length)
    expect(groups).toEqual(withStubQuestions(startupTargets(feed.rows).parents.length))
  }, 600_000)

  it('no intermediate state of a first download adds a wrong answer (POD-7087 acceptance 5)', () => {
    // The last state is the policy set: its wrong answers are POD-7088's
    // (recorded above). No reader POD-7087 moved (the sidebar's rows, the stub
    // counts) is ever wrong. Earlier states have more wrong answers among the
    // readers POD-7088 moves (mention search, closed children): recorded per
    // state in FIRST_DOWNLOAD_BASELINE, so a change that adds one fails.
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
    writeResult('startup-no-wrong-number-first-download-h1a1', states)
    for (const [name, state] of Object.entries(states)) {
      expect(state.moved, `${name}: moved readers`).toEqual([])
      // The readers POD-7088 moves answer from fewer rows in an earlier state:
      // recorded per state, like the policy set's, so worse fails.
      expect(state.groups, `${name}: answers per group`).toEqual(FIRST_DOWNLOAD_BASELINE[name])
    }
  }, 1_800_000)
})
