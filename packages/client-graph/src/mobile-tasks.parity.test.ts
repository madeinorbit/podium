import { autorun, runInAction } from 'mobx'
import { afterEach, expect, it, vi } from 'vitest'
import { MobileTasksBoardBefore } from '../../../tests/worklist/diagnostics/mobile-tasks-before'
import { attachMobileScreens } from './mobile-screens'
import { MOBILE_SCREEN_SUMMARIES, type MobileTasksOptions } from './mobile-screens-schema'
import { MobileTasksBoard } from './mobile-tasks'
import { MobxPool } from './pool'
import { LOADING } from './worklist/rollup'

// POD-5865: the phone board's lists and proposal count moved from one
// hand-built pass to per-issue facts and compared lists. The old board is kept
// as the oracle; both answer on the same pool for every option combination.

const now = Date.parse('2026-10-03T12:00:00Z')
type Row = Record<string, unknown> & { id: string }
const issue = (id: string, patch: object = {}): Row => ({
  id,
  seq: 1,
  title: id,
  description: '',
  stage: 'in_progress',
  priority: 2,
  type: 'task',
  audience: 'human',
  repoPath: '/fixture',
  labels: [],
  deps: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...patch,
})

const disposals: (() => void)[] = []
afterEach(() => {
  for (const dispose of disposals.splice(0).reverse()) dispose()
})
async function setup(rows: Row[]) {
  const load = vi.fn((_kind: string, id: string) => rows.find((row) => row.id === id))
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: now }, undefined, {
    load,
    summaries: MOBILE_SCREEN_SUMMARIES,
    schedule: () => () => {},
  })
  pool.apply({
    type: 'replace',
    rows: rows.map((value) => ({ kind: 'issue' as const, id: value.id, value })),
  })
  await attachMobileScreens(pool)
  disposals.push(() => pool.dispose())
  return pool
}
const update = (pool: MobxPool, row: Row) =>
  runInAction(() => pool.apply({ type: 'update', rows: [{ kind: 'issue', id: row.id, value: row }] }))

type Board = Pick<MobileTasksBoard, 'sections' | 'proposals'>
const layout = (board: Board) => {
  const sections = board.sections
  if (sections === LOADING) throw new Error('Tasks still loading')
  return sections.map((section) => ({ ...section, rows: section.rows.map((row) => ({ ...row })) }))
}

/** A seeded forest with every rule the board knows: proposals under epics and
 * under other proposals, agent work under people's tasks, drafts, deleted and
 * archived work, finished work, parent cycles and parents that do not exist. */
function forest(seed: number): Row[] {
  let state = seed
  const random = () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const pick = <T>(values: readonly T[]) => values[Math.floor(random() * values.length)]!
  const stages = ['proposed', 'proposed', 'backlog', 'planning', 'in_progress', 'review', 'done']
  const rows: Row[] = []
  for (let i = 0; i < 36; i++) {
    const id = `t${String(i).padStart(2, '0')}`
    const parent =
      i > 0 && random() < 0.65
        ? random() < 0.05
          ? 'missing-parent'
          : rows[Math.floor(random() * rows.length)]!.id
        : undefined
    const stage = pick(stages)
    rows.push(
      issue(id, {
        seq: 100 - i,
        title: random() < 0.3 ? `alpha ${id}` : id,
        stage,
        priority: Math.floor(random() * 4),
        createdAt: `2026-0${1 + Math.floor(random() * 3)}-01T00:00:00Z`,
        updatedAt: `2026-0${1 + Math.floor(random() * 3)}-02T00:00:00Z`,
        ...(parent ? { parentId: parent } : {}),
        ...(stage === 'done' && random() < 0.4 ? { closedReason: 'cancelled' } : {}),
        ...(random() < 0.2 ? { audience: 'agent' } : {}),
        ...(random() < 0.05 ? { isDraftVessel: true } : {}),
        ...(random() < 0.05 ? { archived: true } : {}),
        ...(random() < 0.04 ? { deletedAt: '2026-02-01T00:00:00Z' } : {}),
      }),
    )
  }
  // A two-issue parent cycle with a child, and an issue that is its own parent.
  rows.push(
    issue('cycle-a', { parentId: 'cycle-b', seq: 7 }),
    issue('cycle-b', { parentId: 'cycle-a', seq: 8, stage: 'proposed' }),
    issue('cycle-kid', { parentId: 'cycle-a', seq: 9 }),
    issue('self', { parentId: 'self', seq: 6, stage: 'review' }),
    // An ordinary cycle (no proposal in it) with a child: its first member heads it.
    issue('loop-a', { parentId: 'loop-b', seq: 5 }),
    issue('loop-b', { parentId: 'loop-a', seq: 4 }),
    issue('loop-kid', { parentId: 'loop-b', seq: 3, stage: 'review' }),
    // A proposal whose nearest proposal ancestor sits above a hidden draft: the
    // draft cuts the shown tree, so the inner proposal is promoted.
    issue('outer-proposal', { stage: 'proposed', seq: 60 }),
    issue('hidden-draft', { parentId: 'outer-proposal', isDraftVessel: true, seq: 61 }),
    issue('cut-proposal', { parentId: 'hidden-draft', stage: 'proposed', seq: 62 }),
    // Agent work under a draft and under a parent nobody can see stays hidden.
    issue('agent-under-draft', { parentId: 'hidden-draft', audience: 'agent', seq: 63 }),
    issue('agent-orphan', { parentId: 'nowhere', audience: 'agent', seq: 64 }),
    issue('agent-under-person', { parentId: 'outer-proposal', audience: 'agent', seq: 65 }),
  )
  return rows
}

it('answers the old board’s sections, order, counts and proposals on seeded forests', async () => {
  let compared = 0
  for (const seed of [1, 2, 3, 5, 8, 13]) {
    const rows = forest(seed)
    const pool = await setup(rows)
    const ids = rows.map((row) => row.id)
    for (const ordering of ['priority', 'created', 'updated'] as const)
      for (const filter of [
        {},
        { text: 'alpha' },
        { stage: 'proposed' as const },
        { status: 'closed' as const },
        { archived: true },
      ])
        for (const showDone of [false, true])
          for (const showAgentTasks of [false, true])
            for (const expanded of [[], ids.filter((_, i) => i % 2 === 0), ids]) {
              const settings: MobileTasksOptions = {
                ordering,
                filter,
                showDone,
                showAgentTasks,
                expanded,
              }
              const before = new MobileTasksBoardBefore(pool, settings),
                after = new MobileTasksBoard(pool, settings)
              const stop = autorun(() => {
                before.sections
                before.proposals
                after.sections
                after.proposals
              })
              for (let round = 0; round < 5; round++) pool.hydrate()
              const expected = layout(before)
              expect(layout(after), JSON.stringify({ seed, settings })).toEqual(expected)
              expect(after.proposals).toBe(before.proposals)
              compared += expected.reduce((total, section) => total + section.rows.length, 0)
              stop()
            }
  }
  // The fixtures reach real rows, not only empty boards.
  expect(compared).toBeGreaterThan(1000)
  // 720 option combinations: minutes on a loaded test box.
}, 300_000)

it('fails the same comparison when the new answer is wrong', async () => {
  const pool = await setup(forest(3))
  const settings: MobileTasksOptions = {
    ordering: 'priority',
    filter: {},
    showDone: true,
    showAgentTasks: false,
    expanded: forest(3).map((row) => row.id),
  }
  const before = new MobileTasksBoardBefore(pool, settings),
    after = new MobileTasksBoard(pool, settings)
  disposals.push(autorun(() => [before.sections, after.sections, before.proposals, after.proposals]))
  const expected = layout(before)
  const wrong = (change: (sections: ReturnType<typeof layout>) => void) => {
    const sections = layout(after)
    change(sections)
    return sections
  }
  expect(layout(after)).toEqual(expected)
  // A swapped row, a wrong depth, a wrong child count and a wrong total each fail.
  const proposals = expected.findIndex((section) => section.stage === 'proposed')
  expect(expected[proposals]!.rows.length).toBeGreaterThan(1)
  for (const change of [
    (s: ReturnType<typeof layout>) => s[proposals]!.rows.reverse(),
    (s: ReturnType<typeof layout>) => void (s[proposals]!.rows.at(-1)!.depth += 1),
    (s: ReturnType<typeof layout>) => void (s[0]!.rows[0]!.childCount += 1),
    (s: ReturnType<typeof layout>) => void (s[0]!.total += 1),
  ])
    expect(() => expect(wrong(change)).toEqual(expected)).toThrow()
  expect(() => expect(after.proposals).toBe((before.proposals as number) + 1)).toThrow()
})

it('keeps every list identical, and redraws no section, when a change leaves membership alone', async () => {
  const pool = await setup([
    issue('epic', { seq: 1, priority: 1 }),
    issue('kid-1', { seq: 2, parentId: 'epic', priority: 1 }),
    issue('kid-2', { seq: 3, parentId: 'epic', priority: 2 }),
    issue('review-1', { seq: 4, stage: 'review', priority: 1 }),
    issue('review-2', { seq: 5, stage: 'review', priority: 2 }),
    issue('proposal', { seq: 6, stage: 'proposed', parentId: 'epic' }),
    issue('backlog', { seq: 7, stage: 'backlog' }),
  ])
  const board = new MobileTasksBoard(pool, {
    ordering: 'priority',
    filter: {},
    showDone: false,
    showAgentTasks: false,
    expanded: ['epic'],
  })
  const runs = new Map<string, number>()
  let banner = 0
  for (const lane of board.lanes)
    disposals.push(
      autorun(() => {
        lane.value
        runs.set(lane.stage, (runs.get(lane.stage) ?? 0) + 1)
      }),
    )
  disposals.push(
    autorun(() => {
      board.sections
      runs.set('sections', (runs.get('sections') ?? 0) + 1)
    }),
    autorun(() => {
      board.proposals
      banner++
    }),
  )
  const read = () => {
    const sections = board.sections
    if (sections === LOADING) throw new Error('Tasks still loading')
    return sections
  }
  const first = read(),
    counted = new Map(runs)
  expect(first.map((section) => section.stage)).toEqual(['in_progress', 'review', 'backlog', 'proposed'])
  expect(board.proposals).toBe(1)

  // A title, a description and a priority that keeps the order: no list moves.
  update(pool, issue('kid-2', { seq: 3, parentId: 'epic', priority: 2, title: 'Renamed' }))
  update(pool, issue('review-1', { seq: 4, stage: 'review', priority: 1, description: 'more' }))
  update(pool, issue('backlog', { seq: 7, stage: 'backlog', priority: 0 }))
  expect(read()).toBe(first)
  first.forEach((section, i) => expect(read()[i]!.rows).toBe(section.rows))
  expect(runs).toEqual(counted)
  expect(banner).toBe(1)

  // A reorder inside one lane redraws that lane only; its unchanged rows keep identity.
  update(pool, issue('review-2', { seq: 5, stage: 'review', priority: 0 }))
  const reordered = read()
  expect(reordered).not.toBe(first)
  expect(reordered[1]!.rows.map((row) => row.id)).toEqual(['review-2', 'review-1'])
  expect(reordered[1]!.rows[1]).toBe(first[1]!.rows[0])
  for (const i of [0, 2, 3]) expect(reordered[i]).toBe(first[i])
  expect(runs.get('review')).toBe(counted.get('review')! + 1)
  for (const stage of ['in_progress', 'backlog', 'proposed', 'planning', 'done'])
    expect(runs.get(stage), stage).toBe(counted.get(stage))
  expect(banner).toBe(1)

  // Folding the epic changes the epic's row and drops its children; no other row is rebuilt.
  const lane = read()[0]!
  runInAction(() => board.toggleExpanded('epic'))
  const folded = read()[0]!
  expect(folded.rows.map((row) => row.id)).toEqual(['epic'])
  expect(folded.rows[0]).not.toBe(lane.rows[0])
  expect(folded.rows[0]).toMatchObject({ id: 'epic', expanded: false, childCount: 2 })
  for (const i of [1, 2, 3]) expect(read()[i]).toBe(reordered[i])
  expect(banner).toBe(1)
})

it('counts proposals from one fact per issue and wakes the banner only when one changes', async () => {
  const pool = await setup([
    issue('epic'),
    issue('p1', { stage: 'proposed', parentId: 'epic' }),
    issue('p2', { stage: 'proposed' }),
    issue('inner', { stage: 'proposed', parentId: 'p2' }),
  ])
  const board = new MobileTasksBoard(pool, {
    ordering: 'priority',
    filter: {},
    showDone: false,
    showAgentTasks: false,
    expanded: [],
  })
  const counts: (number | typeof LOADING)[] = []
  disposals.push(autorun(() => void counts.push(board.proposals)))
  expect(counts).toEqual([2])
  // A proposal under another proposal is not counted until its parent stops being one.
  // p2 leaves and inner joins: the total is unchanged, so the banner stays quiet.
  update(pool, issue('p2', { stage: 'backlog' }))
  update(pool, issue('inner', { stage: 'proposed', parentId: 'p2', title: 'Renamed' }))
  update(pool, issue('epic', { title: 'Renamed epic' }))
  expect(counts).toEqual([2])
  update(pool, issue('p1', { stage: 'backlog', parentId: 'epic' }))
  expect(counts).toEqual([2, 1])
})
