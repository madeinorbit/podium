import { taskStateWord } from '@podium/client-core/values'
import { autorun, runInAction } from 'mobx'
import { afterEach, expect, it, vi } from 'vitest'
import { createLegacyMobileTasks } from '../../../tests/worklist/diagnostics/legacy-mobile-tasks'
import { readMobileTaskSnapshot } from '../../../tests/worklist/diagnostics/mobile-task-snapshot'
import {
  insideArm,
  insideReader,
  measureWork,
  type WorkCounts,
} from '../../../tests/worklist/harness/src/work-meter'
import { attachMobileScreens } from './mobile-screens'
import { MOBILE_SCREEN_SUMMARIES, type MobileTasksOptions } from './mobile-screens-schema'
import { MobileTasksBoard } from './mobile-tasks'
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

it('matches the old shown rows, order, counts, proposals and task state across the existing phone rules', async () => {
  const { pool } = await setup(
    [
      issue('root', { seq: 10 }),
      issue('child', { seq: 11, parentId: 'root', stage: 'review' }),
      issue('proposal', { seq: 12, parentId: 'root', stage: 'proposed' }),
      issue('offered-child', { seq: 13, parentId: 'proposal', stage: 'backlog' }),
      issue('other-proposal', { seq: 15, stage: 'proposed' }),
      issue('agent', { seq: 16, parentId: 'root', audience: 'agent' }),
      issue('hidden-agent', { seq: 17, audience: 'agent' }),
      issue('draft', { seq: 18, isDraftVessel: true }),
      issue('closed', { seq: 19, stage: 'done', closedReason: 'cancelled' }),
      issue('cycle-a', { seq: 20, parentId: 'cycle-b' }),
      issue('cycle-b', { seq: 21, parentId: 'cycle-a' }),
    ],
    [
      seat('root-worker'),
      seat('child-worker', { issueId: 'child' }),
      seat('archived', { archived: true }),
      seat('headless', { headless: true }),
      seat('shell', { agentKind: 'shell' }),
      seat('reconnecting', { status: 'reconnecting' }),
      seat('stale', { lastActiveAt: '2026-01-01T00:00:00Z', agentState: { phase: 'working' } }),
    ],
  )
  const legacy = createLegacyMobileTasks(pool)
  disposals.push(() => legacy.dispose())
  for (const ordering of ['priority', 'created', 'updated'] as const)
    for (const filter of [
      {},
      { text: 'child' },
      { stage: 'review' as const },
      { status: 'closed' as const },
    ])
      for (const showDone of [false, true])
        for (const showAgentTasks of [false, true]) {
          const settings = { ...options, ordering, filter, showDone, showAgentTasks }
          const board = new MobileTasksBoard(pool, settings)
          const stop = autorun(() => {
            board.sections
            board.proposals
            legacy.tasks(settings)
            readMobileTaskSnapshot(pool, settings)
          })
          for (let round = 0; round < 5; round++) pool.hydrate()
          const before = legacy.tasks(settings),
            after = readMobileTaskSnapshot(pool, settings)
          if (before === LOADING || after === LOADING) throw new Error('Parity did not settle')
          const expected = before.board.map((section) => ({
            stage: section.stage,
            title: section.title,
            total: section.rows.filter((row) => row.depth === 0).length,
            rows: section.rows.map(({ issue, ...placement }) => ({ id: issue.id, ...placement })),
          }))
          expect(layout(board)).toEqual(expected)
          // A deliberately wrong answer must fail this same parity comparison.
          if (expected.length)
            expect(() =>
              expect(
                layout(board).map((section) => ({ ...section, total: section.total + 1 })),
              ).toEqual(expected),
            ).toThrow()
          expect(board.proposals).toBe(before.proposals)
          for (const section of before.board)
            for (const row of section.rows) {
              const model = pool.issueObject(row.issue.id)
              expect(model.confirmedWorkingAgents, row.issue.id).toBe(
                before.workingByIssue.get(row.issue.id),
              )
              expect(model.taskProgress, row.issue.id).toEqual(
                before.progressByIssue.get(row.issue.id),
              )
              expect(
                taskStateWord(
                  model as unknown as Parameters<typeof taskStateWord>[0],
                  model.confirmedWorkingAgents,
                  model.taskProgress,
                ),
              ).toEqual(
                taskStateWord(
                  row.issue,
                  before.workingByIssue.get(row.issue.id)!,
                  before.progressByIssue.get(row.issue.id),
                ),
              )
            }
          stop()
        }
})

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

async function workAt(scale: number, plant = false, legacy = false) {
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
  if (legacy) {
    const old = createLegacyMobileTasks(pool)
    disposals.push(
      () => old.dispose(),
      autorun(() => insideReader('phone.tasks.legacy', () => old.tasks({
        showDone: board.showDone,
        expanded: board.expanded,
        filter: board.filter,
        ordering: board.ordering,
        showAgentTasks: board.showAgentTasks,
      }))),
    )
  } else disposals.push(
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
      expect(four[kind]?.[reader] ?? 0, `${kind} ${reader}`)
        .toBeLessThanOrEqual(one[kind]?.[reader] ?? 0)
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
  const old1 = await workAt(1, false, true),
    old4 = await workAt(4, false, true)
  for (const [before, after] of [[old1[1]!, one[1]!], [old4[1]!, four[1]!]] as const) {
    console.info('[phone Tasks total search before/after]', { before, after })
    for (const kind of ['derivations', 'elements'] as const)
      expect(after[kind]).toBeLessThanOrEqual(before[kind])
  }
  // Addressed placement reads add a constant overhead; no counter may grow
  // faster than before, including the unchanged shared title/ref query.
  for (const kind of ['rows', 'derivations', 'elements'] as const)
    expect(four[1]![kind]! - one[1]![kind]!).toBeLessThanOrEqual(old4[1]![kind]! - old1[1]![kind]!)
  const planted1 = await workAt(1, true),
    planted4 = await workAt(4, true)
  expect(() => assertPhoneWork(planted1[3]!, planted4[3]!)).toThrow()
})
