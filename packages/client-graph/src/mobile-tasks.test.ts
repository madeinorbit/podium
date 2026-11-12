import { autorun, runInAction } from 'mobx'
import { afterEach, expect, it, vi } from 'vitest'
import {
  insideArm,
  insideReader,
  measureWork,
  type WorkCounts,
} from '../../../tests/worklist/harness/src/work-meter'
import { attachMobileScreens } from './mobile-screens'
import { MOBILE_SCREEN_SUMMARIES, type MobileTasksOptions } from './mobile-screens-schema'
import { MOBILE_TASK_WINDOW_SIZE, MobileTasksBoard } from './mobile-tasks'
import { ProposalScreening } from './mobile-triage'
import { MobxPool } from './pool'
import { LOADING } from './worklist/rollup'

const now = Date.parse('2026-10-03T12:00:00Z')
const options: MobileTasksOptions = {
  showDone: true,
  expanded: ['root', 'proposal'],
  filter: {},
  ordering: 'priority',
  showAgentTasks: false,
}
const issue = (id: string, patch: object = {}) => ({
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
const seat = (id: string, patch: object = {}) => ({
  sessionId: id,
  issueId: 'root',
  cwd: '/fixture',
  title: id,
  status: 'live',
  agentKind: 'codex',
  archived: false,
  createdAt: '2026-01-01T00:00:00Z',
  lastActiveAt: new Date(now).toISOString(),
  agentState: { phase: 'working', since: new Date(now).toISOString() },
  ...patch,
})
const disposals: (() => void)[] = []
afterEach(() => {
  for (const dispose of disposals.splice(0).reverse()) dispose()
})
async function setup(rows: ReturnType<typeof issue>[], seats: ReturnType<typeof seat>[] = []) {
  const load = vi.fn((kind: string, id: string) =>
    kind === 'session'
      ? seats.find((row) => row.sessionId === id)
      : rows.find((row) => row.id === id),
  )
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: now }, undefined, {
    load,
    summaries: MOBILE_SCREEN_SUMMARIES,
    schedule: () => () => {},
  })
  pool.apply({
    type: 'replace',
    rows: [
      ...rows.map((value) => ({ kind: 'issue' as const, id: value.id, value })),
      ...seats.map((value) => ({ kind: 'session' as const, id: value.sessionId, value })),
    ],
  })
  await attachMobileScreens(pool)
  disposals.push(() => pool.dispose())
  return { pool, load }
}
const layout = (board: MobileTasksBoard) => {
  const sections = board.sections
  if (sections === LOADING) throw new Error('Tasks still loading')
  return sections.map((section) => ({ ...section, rows: section.rows.map((row) => ({ ...row })) }))
}

it('borrows cold board summaries for ID membership without loading rich rows or sessions', async () => {
  const { pool, load } = await setup([
    issue('root'),
    issue('cold', { archived: true, stage: 'done' }),
  ])
  const board = new MobileTasksBoard(pool, { ...options, filter: { archived: true } })
  disposals.push(autorun(() => board.sections))
  expect(layout(board)).toMatchObject([
    { stage: 'in_progress', rows: [{ id: 'root', depth: 0 }] },
    { stage: 'done', rows: [{ id: 'cold', depth: 0 }] },
  ])
  expect(pool.tables.issue.has('cold')).toBe(false)
  expect(pool.hydrate()).toBe(0)
  expect(load).not.toHaveBeenCalled()
})

it('keeps list membership, peer rows and proposals quiet when one drawn issue changes', async () => {
  const { pool } = await setup([
    issue('root'),
    issue('peer'),
    issue('proposal', { stage: 'proposed' }),
  ])
  const board = new MobileTasksBoard(pool, options)
  let sections = 0,
    banner = 0,
    root = 0,
    peer = 0
  disposals.push(
    autorun(() => {
      board.sections
      sections++
    }),
    autorun(() => {
      board.proposals
      banner++
    }),
    autorun(() => {
      pool.issueObject('root').title
      root++
    }),
    autorun(() => {
      pool.issueObject('peer').title
      peer++
    }),
  )
  const before = { sections, banner, root, peer },
    membership = board.sections
  runInAction(() =>
    pool.apply({
      type: 'update',
      rows: [{ kind: 'issue', id: 'root', value: issue('root', { title: 'Renamed task' }) }],
    }),
  )
  expect({ sections, banner, root, peer }).toEqual({ ...before, root: before.root + 1 })
  expect(board.sections).toBe(membership)
  board.configure({ ...options, expanded: [] })
  expect(banner).toBe(before.banner)
})

it('updates addressed confirmed workers at the inclusive expiry deadline without publishing new membership', async () => {
  const { pool } = await setup(
    [issue('root'), issue('child', { parentId: 'root' })],
    [seat('worker', { issueId: 'child' })],
  )
  const board = new MobileTasksBoard(pool, options),
    root = pool.issueObject('root')
  let sections = 0,
    live = 0
  disposals.push(
    autorun(() => {
      board.sections
      sections++
    }),
    autorun(() => {
      live = root.taskProgress?.liveAgents ?? 0
    }),
  )
  const before = sections
  expect(live).toBe(1)
  pool.clock.advance(now + 15 * 60_000)
  expect(live).toBe(1)
  pool.clock.advance(now + 15 * 60_000 + 1)
  expect(live).toBe(0)
  expect(sections).toBe(before)
  // Rewinds revive the same per-session fact, with no whole-board clock.
  pool.clock.advance(now)
  expect(live).toBe(1)
})

async function workAt(scale: number, plant = false) {
  const { pool } = await setup(
    [
      issue('root'),
      issue('child', { parentId: 'root' }),
      ...Array.from({ length: 16 * scale }, (_, i) =>
        issue(`unshown-${i}`, { repoPath: '/elsewhere' }),
      ),
    ],
    [seat('worker')],
  )
  const settings = { ...options, expanded: [], filter: { projectPaths: ['/fixture'] } }
  const board = new MobileTasksBoard(pool, settings)
  disposals.push(
    autorun(() => insideReader('phone.tasks.sections', () => board.sections)),
    autorun(() => insideReader('phone.tasks.proposals', () => board.proposals)),
    autorun(() =>
      insideReader('phone.tasks.row', () => {
        const model = pool.issueObject('root')
        model.title
        model.confirmedWorkingAgents
        model.taskProgress
        if (plant) [...pool.queries.ids({ kind: 'boardCatalog' })]
      }),
    ),
  )
  const changes = [
    () => board.configure({ ...settings, expanded: ['root'] }),
    () => board.configure({ ...settings, filter: { ...settings.filter, text: 'root' } }),
    () =>
      pool.applyLocals({ selectedIssueId: 'child', coarseNow: now }, new Set(['selectedIssueId'])),
    () =>
      pool.apply({
        type: 'update',
        rows: [{ kind: 'issue', id: 'root', value: issue('root', { title: 'Renamed root' }) }],
      }),
    () =>
      pool.apply({
        type: 'update',
        rows: [
          {
            kind: 'session',
            id: 'worker',
            value: seat('worker', { lastActiveAt: new Date(now + 1000).toISOString() }),
          },
        ],
      }),
  ]
  const counts: WorkCounts[] = []
  for (const change of changes)
    counts.push(
      (await measureWork(async () => insideArm(() => runInAction(change)), { pool })).work,
    )
  return counts
}
function assertPhoneWork(one: WorkCounts, four: WorkCounts) {
  for (const kind of ['rowsBy', 'derivationsBy', 'elementsBy'] as const) {
    const readers = new Set([...Object.keys(one[kind] ?? {}), ...Object.keys(four[kind] ?? {})])
    for (const reader of readers) {
      // POD-5561 owns the shared title/ref pass. Per-reader counts keep a row
      // scan visible even when both readers visit the same catalog identities.
      if (kind === 'elementsBy' && reader === 'IssueBoard.textIds') continue
      expect(four[kind]?.[reader] ?? 0, `${kind} ${reader}`).toBeLessThanOrEqual(
        one[kind]?.[reader] ?? 0,
      )
    }
  }
}
it('keeps phone board row calls, derivations and collection elements flat at a fixed shown set', async () => {
  const one = await workAt(1),
    four = await workAt(4)
  for (let i = 0; i < one.length; i++) {
    console.info('[phone Tasks work]', {
      action: ['expand', 'search', 'route', 'title', 'heartbeat'][i],
      at1x: one[i],
      at4x: four[i],
    })
    assertPhoneWork(one[i]!, four[i]!)
  }
  const planted1 = await workAt(1, true),
    planted4 = await workAt(4, true)
  expect(() => assertPhoneWork(planted1[3]!, planted4[3]!)).toThrow()
})

it('draws Proposed as the screening group and counts each lane for the subtitle', async () => {
  const { pool } = await setup([
    issue('working'),
    issue('waiting', { stage: 'review' }),
    issue('second', { stage: 'review' }),
    issue('idea', { stage: 'proposed' }),
    issue('finished', { stage: 'done', closedAt: '2026-01-02T00:00:00Z' }),
  ])
  const board = new MobileTasksBoard(pool, { ...options, expanded: [] })
  disposals.push(autorun(() => [board.groups, board.stageCounts]))
  const groups = board.groups
  if (groups === LOADING) throw new Error('Tasks still loading')
  expect(groups.map((group) => [group.stage, group.total])).toEqual([
    ['in_progress', 1],
    ['review', 2],
    ['proposed', 1],
    ['done', 1],
  ])
  expect(board.stageCounts).toMatchObject({ in_progress: 1, review: 2, planning: 0 })

  // A filter that hides the proposal keeps the group: the screening queue
  // does not change with the board's filter.
  board.setFilter({ stage: 'review' })
  const filtered = board.groups
  if (filtered === LOADING) throw new Error('Tasks still loading')
  expect(filtered.map((group) => [group.stage, group.total, group.rows.length])).toEqual([
    ['review', 2, 2],
    ['proposed', 1, 0],
  ])
})

it('uses shared attention for offers, archived seats, review and closed tasks', async () => {
  const { pool } = await setup([issue('root')], [seat('agent')])
  const board = new MobileTasksBoard(pool, options)
  const marks: string[] = []
  disposals.push(autorun(() => marks.push(board.task('root').mark)))
  expect(marks.at(-1)).toBe('working')
  const offer = {
    createdAt: '2026-10-03T12:00:00Z',
    message: 'Ready',
    actions: [{ label: 'Accept', prompt: 'Accept' }],
  }
  pool.apply({
    type: 'update',
    rows: [{ kind: 'session', id: 'agent', value: seat('agent', { offer }) }],
  })
  expect(marks.at(-1)).toBe('needs')
  pool.apply({
    type: 'update',
    rows: [{ kind: 'session', id: 'agent', value: seat('agent', { offer, archived: true }) }],
  })
  expect(marks.at(-1)).toBe('working')
  pool.apply({
    type: 'update',
    rows: [{ kind: 'issue', id: 'root', value: issue('root', { stage: 'review' }) }],
  })
  expect(marks.at(-1)).toBe('needs')
  pool.apply({
    type: 'update',
    rows: [
      {
        kind: 'issue',
        id: 'root',
        value: issue('root', { stage: 'done', closedReason: 'done', needsHuman: true }),
      },
    ],
  })
  expect(marks.at(-1)).toBe('done')
})

it('is seated while the task has an unarchived session, so a tap opens its chat (POD-2432)', async () => {
  const { pool } = await setup(
    [issue('root'), issue('child', { parentId: 'root' })],
    [seat('agent')],
  )
  const board = new MobileTasksBoard(pool, options)
  const seated: boolean[] = []
  disposals.push(autorun(() => seated.push(board.task('root').seated)))
  expect(seated.at(-1)).toBe(true)
  expect(runInAction(() => board.task('child').seated)).toBe(false)
  pool.apply({
    type: 'update',
    rows: [{ kind: 'session', id: 'agent', value: seat('agent', { archived: true }) }],
  })
  expect(seated.at(-1)).toBe(false)
})

it('releases offscreen row observers while scrolling forward and back through a large lane', async () => {
  const { pool } = await setup(
    Array.from({ length: 400 }, (_, index) => issue(`task-${index}`, { seq: index })),
  )
  const board = new MobileTasksBoard(pool, options)
  const lane = board.lanes.find((lane) => lane.stage === 'in_progress')!
  let reads = 0
  disposals.push(
    autorun(() => {
      lane.window.visibleRows.map((row) => board.issue(row.id).title)
      reads++
    }),
  )
  expect(lane.rows).toHaveLength(400)
  expect(lane.window.visibleRows).toHaveLength(0)
  lane.window.appear(lane.rows[0]!.id)
  expect(lane.window.visibleRows).toHaveLength(MOBILE_TASK_WINDOW_SIZE)
  for (let index = 1; index < 390; index++) {
    lane.window.appear(lane.rows[index]!.id)
    lane.window.disappear(lane.rows[index - 1]!.id)
    expect(lane.window.visibleRows.length).toBeLessThanOrEqual(MOBILE_TASK_WINDOW_SIZE)
  }
  const before = reads
  pool.apply({
    type: 'update',
    rows: [{ kind: 'issue', id: 'task-0', value: issue('task-0', { seq: 0, title: 'offscreen' }) }],
  })
  expect(reads).toBe(before)
  // Positive control: a title in the current window still wakes its observer.
  const shown = lane.window.visibleRows[0]!.id
  pool.apply({
    type: 'update',
    rows: [{ kind: 'issue', id: shown, value: issue(shown, { title: 'onscreen' }) }],
  })
  expect(reads).toBeGreaterThan(before)
  lane.window.appear(lane.rows[0]!.id)
  lane.window.disappear(lane.rows[389]!.id)
  expect(lane.window.visibleRows[0]!.id).toBe(lane.rows[0]!.id)
  expect(lane.window.visibleRows).toHaveLength(MOBILE_TASK_WINDOW_SIZE)
  lane.window.disappear(lane.rows[0]!.id)
  expect(lane.window.visibleRows).toHaveLength(0)
})

it('reads glyphs from cold session summaries without loading archived history', async () => {
  const offer = { createdAt: '2026-01-01T00:00:00Z', message: 'Review', actions: [] }
  const history = Array.from({ length: 400 }, (_, i) =>
    seat(`history-${i}`, { archived: true, status: 'exited', offer }),
  )
  const cold = seat('cold', {
    status: 'exited',
    lastActiveAt: '2025-01-01T00:00:00Z',
    stoppedAt: '2025-01-01T00:00:00Z',
    agentState: { phase: 'idle' },
  })
  const { pool, load } = await setup([issue('root', { archived: true })], [...history, cold])
  const board = new MobileTasksBoard(pool, options)
  expect(pool.tables.session.size).toBe(0)
  const marks: string[] = []
  const reads = vi.spyOn(pool, 'row')
  disposals.push(autorun(() => marks.push(board.task('root').mark)))
  expect(marks).toEqual(['working'])
  expect(
    reads.mock.calls.filter(([kind, id]) => kind === 'session' && id.startsWith('history-')),
  ).toEqual([])
  expect(pool.hydrate()).toBe(0)
  expect(load).not.toHaveBeenCalled()

  // The archived but unfinished task keeps its explicit roster cold.
  // Positive control: a cold unarchived sender's new offer still changes the glyph.
  pool.apply({ type: 'update', rows: [{ kind: 'session', id: 'cold', value: { ...cold, offer } }] })
  expect(marks.at(-1)).toBe('needs')
  pool.apply({
    type: 'update',
    rows: [{ kind: 'session', id: 'cold', value: { ...cold, offer, archived: true } }],
  })
  expect(marks.at(-1)).toBe('working')
  // The shared subset admits an unarchived historical sender without a payload lookup.
  pool.apply({ type: 'update', rows: [{ kind: 'session', id: 'cold', value: { ...cold, offer } }] })
  expect(marks.at(-1)).toBe('needs')
  // A late offer cannot revive a closed task's attention glyph.
  pool.apply({
    type: 'update',
    rows: [
      {
        kind: 'issue',
        id: 'root',
        value: issue('root', { stage: 'done', closedReason: 'done', archived: true }),
      },
    ],
  })
  expect(marks.at(-1)).toBe('done')
  pool.apply({
    type: 'update',
    rows: [
      { kind: 'session', id: 'cold', value: { ...cold, offer: { ...offer, message: 'Late' } } },
    ],
  })
  expect(marks.at(-1)).toBe('done')
  expect(pool.hydrate()).toBe(0)
  expect(load).not.toHaveBeenCalled()
  reads.mockRestore()
})

it('searches the Proposed screening count by the same title/ref rule as board rows', async () => {
  const { pool } = await setup([
    issue('plan', { seq: 2346, title: 'iOS redesign', stage: 'planning' }),
    issue('proposal', { seq: 2347, title: 'iOS follow-up', stage: 'proposed' }),
    issue('other', { seq: 765, title: 'Something else', stage: 'proposed' }),
  ])
  const board = new MobileTasksBoard(pool, options)
  disposals.push(autorun(() => board.groups))
  expect(board.proposals).toBe(2)
  board.search('iOS')
  expect(board.searching).toBe(true)
  expect(board.proposals).toBe(1)
  board.search('2346')
  expect(board.proposals).toBe(0)
  expect(board.groups).toMatchObject([{ stage: 'planning', total: 1 }])
  board.search('2347')
  expect(board.proposals).toBe(1)
  expect(board.groups).toMatchObject([{ stage: 'proposed', total: 1 }])
  board.search('no match')
  expect(board.proposals).toBe(0)
  expect(board.groups).toEqual([])
  board.search('')
  expect(board.searching).toBe(false)
  expect(board.proposals).toBe(2)
  // A saved text filter is the same board search, including for proposals.
  board.setFilter({ text: '2347' })
  expect(board.searching).toBe(true)
  expect(board.proposals).toBe(1)
})

it('opens exactly the advertised screening selection, including saved text filters', async () => {
  const { pool } = await setup([
    issue('match', { seq: 2347, title: 'iOS follow-up', stage: 'proposed' }),
    issue('unrelated', { seq: 9999, title: 'Something else', stage: 'proposed', priority: 0 }),
    issue('nested', { title: 'iOS child', stage: 'proposed', parentId: 'match' }),
    issue('agent', { title: 'iOS agent', stage: 'proposed', audience: 'agent' }),
  ])
  const board = new MobileTasksBoard(pool, options)
  disposals.push(autorun(() => board.groups))
  for (const text of ['iOS', '2347', 'no match', '']) {
    board.search(text)
    const deck = new ProposalScreening(pool, board.searchFilter.text)
    expect(deck.queue).toEqual(board.screeningIds)
    expect(board.proposals).toBe(text === 'no match' ? 0 : text ? 1 : 2)
    if (text && text !== 'no match') expect(deck.queue).toEqual(['match'])
    if (!text) expect(deck.queue).toEqual(['unrelated', 'match'])
  }
  board.setFilter({ text: '2347', stage: 'review' })
  const deck = new ProposalScreening(pool, board.searchFilter.text)
  expect(board.proposals).toBe(1)
  expect(deck.queue).toEqual(['match'])
  expect(board.groups).toMatchObject([{ stage: 'proposed', total: 1, rows: [] }])
})

it('scopes screening eligibility and order reads before a nonmatching pending ancestor', async () => {
  const { pool, load } = await setup([
    issue('match', { title: 'iOS follow-up', stage: 'proposed' }),
    issue('unrelated', { title: 'Something else', stage: 'proposed', parentId: 'pending' }),
  ])
  const row = pool.row.bind(pool)
  const reads = vi
    .spyOn(pool, 'row')
    .mockImplementation((entity, id, mode) =>
      entity === 'issue' && id === 'pending' ? LOADING : row(entity, id, mode),
    )
  const board = new MobileTasksBoard(pool, { ...options, filter: { text: 'iOS' } })
  const deck = new ProposalScreening(pool, 'iOS')
  disposals.push(autorun(() => [board.groups, deck.queue]))
  expect(board.groups).toMatchObject([{ stage: 'proposed', total: 1 }])
  expect(deck.queue).toEqual(['match'])
  expect(
    reads.mock.calls.filter(
      ([kind, id]) => kind === 'issue' && ['unrelated', 'pending'].includes(id),
    ),
  ).toEqual([])
  expect(pool.hydrate()).toBe(0)
  expect(load).not.toHaveBeenCalled()

  // A newly matching proposal starts its own ancestor demand, and only then
  // can that pending ancestor put this search into loading.
  pool.apply({
    type: 'update',
    rows: [
      {
        kind: 'issue',
        id: 'unrelated',
        value: issue('unrelated', {
          title: 'iOS second proposal',
          stage: 'proposed',
          parentId: 'pending',
        }),
      },
    ],
  })
  expect(deck.queue).toBe(LOADING)
  expect(board.groups).toBe(LOADING)
  expect(reads.mock.calls.some(([kind, id]) => kind === 'issue' && id === 'pending')).toBe(true)
  reads.mockRestore()
})

it('holds search groups open and ignores header taps without changing saved folds', async () => {
  const { pool } = await setup([])
  const board = new MobileTasksBoard(pool, options)
  let saved = true
  const toggleSaved = vi.fn(() => {
    saved = !saved
  })
  expect(board.isFolded(saved)).toBe(true)
  board.search('match')
  expect(board.isFolded(saved)).toBe(false)
  board.toggleFold(toggleSaved)
  expect(toggleSaved).not.toHaveBeenCalled()
  expect(saved).toBe(true)
  board.search('')
  expect(board.isFolded(saved)).toBe(true)
  // Positive control: a normal header tap writes the preference and folds change.
  board.toggleFold(toggleSaved)
  expect(toggleSaved).toHaveBeenCalledTimes(1)
  expect(board.isFolded(saved)).toBe(false)
  board.setFilter({ text: 'saved search' })
  board.toggleFold(toggleSaved)
  expect(toggleSaved).toHaveBeenCalledTimes(1)
  board.clearFilter('text')
  board.toggleFold(toggleSaved)
  expect(toggleSaved).toHaveBeenCalledTimes(2)
  expect(board.isFolded(saved)).toBe(true)
})
