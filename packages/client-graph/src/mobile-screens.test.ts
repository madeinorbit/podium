import { autorun, observable, runInAction } from 'mobx'
import { afterEach, expect, it, vi } from 'vitest'
import { attachMobileScreens } from './mobile-screens'
import { MOBILE_SCREEN_SUMMARIES, type MobileTasksOptions } from './mobile-screens-schema'
import { missions } from './mission'
import { MobxPool } from './pool'
import { LOADING } from './worklist/rollup'

const now = Date.parse('2026-10-03T12:00:00Z')
const options: MobileTasksOptions = {
  showDone: true,
  expanded: ['root', 'proposal'],
  filter: { archived: true },
  ordering: 'priority',
  showAgentTasks: false,
}
const issue = (id: string, patch: object = {}) => ({
  id,
  seq: 1,
  title: id,
  description: { value: 'summary description' },
  stage: 'in_progress',
  priority: 2,
  type: 'task',
  audience: 'human' as const,
  repoPath: '/fixture',
  labels: [],
  deps: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...patch,
})
const disposals: (() => void)[] = []
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose()
})
async function setup(
  rows: ReturnType<typeof issue>[],
  sessions: { sessionId: string; cwd: string; lastActiveAt: string }[] = [],
) {
  const load = vi.fn((kind: string, id: string) =>
    kind === 'session'
      ? sessions.find((row) => row.sessionId === id)
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
      ...sessions.map((value) => ({ kind: 'session' as const, id: value.sessionId, value })),
    ],
  })
  const scans = vi.spyOn(pool.residency!, 'ids')
  await attachMobileScreens(pool)
  disposals.push(() => {
    scans.mockRestore()
    pool.dispose()
  })
  const reader = pool.row('mobileScreenReader', 'reader')
  if (!reader || reader === LOADING) throw new Error('screen reader missing')
  return { pool, reader, load, scans }
}
it('reads cold Tasks through declared summaries without promoting or loading them', async () => {
  const { pool, reader, load, scans } = await setup([
    issue('root'),
    issue('cold', { archived: true, stage: 'done' }),
  ])
  const row = vi.spyOn(pool, 'row')
  const stop = autorun(() => reader.tasks(options))
  disposals.push(stop)
  expect(reader.tasks(options)).toMatchObject({
    board: [
      { stage: 'in_progress', rows: [{ issue: { id: 'root' }, depth: 0 }] },
      { stage: 'done', rows: [{ issue: { id: 'cold', title: 'cold' }, depth: 0 }] },
    ],
  })
  expect(pool.tables.issue.has('cold')).toBe(false)
  expect(pool.hydrate()).toBe(0)
  expect(load).not.toHaveBeenCalled()
  expect(row.mock.calls.some(([, , purpose]) => String(purpose) === 'peek')).toBe(false)
  expect(scans).not.toHaveBeenCalled()
})
it('reads archived mission crew display facts from declared summaries without loading their rows', async () => {
  const seat = {
    sessionId: 'seat',
    issueId: 'root',
    title: 'Archived seat',
    cwd: '/fixture',
    agentKind: 'codex',
    status: 'exited',
    archived: true,
    createdAt: '2026-01-01T00:00:00Z',
    lastActiveAt: '2026-01-01T00:00:00Z',
    spawnedBy: 'session:author',
    createdBy: { kind: 'user', id: 'u-fixture' },
    stopReason: 'user',
    resumable: true,
    refLetter: 'b',
    model: 'fixture-model',
  }
  const { pool, reader, load } = await setup(
    [
      issue('root', {
        stage: 'done',
        closedAt: '2026-01-01T00:00:00Z',
        readAt: '2026-01-01T00:00:00Z',
      }),
    ],
    [seat],
  )
  expect(pool.tables.session.has('seat')).toBe(false)
  expect(reader.mission('root')).toBe(LOADING)
  expect(pool.hydrate()).toBe(1)
  load.mockClear()
  expect(reader.mission('root')).toMatchObject({
    missionSessions: [],
    sessions: [seat],
  })
  expect(reader.deck('root', 'full')).toMatchObject({ sessions: [seat] })
  expect(pool.tables.session.has('seat')).toBe(false)
  expect(pool.hydrate()).toBe(0)
  expect(load).not.toHaveBeenCalled()
})
it('retains matching ancestors, promotes proposal blocks, and keeps collapsed child counts honest', async () => {
  const { reader } = await setup([
    issue('root', { seq: 10 }),
    issue('child', { seq: 11, parentId: 'root', stage: 'review' }),
    issue('proposal', { seq: 12, parentId: 'root', stage: 'proposed' }),
    issue('offered-child', { seq: 13, parentId: 'proposal', stage: 'backlog' }),
  ])
  const data = reader.tasks({ ...options, filter: {} })
  expect(data).toMatchObject({
    proposals: 1,
    board: [
      {
        stage: 'in_progress',
        rows: [
          { issue: { id: 'root' }, depth: 0, childCount: 1, expanded: true },
          { issue: { id: 'child' }, depth: 1, childCount: 0 },
        ],
      },
      {
        stage: 'proposed',
        rows: [
          { issue: { id: 'proposal' }, depth: 0, childCount: 1, expanded: true },
          { issue: { id: 'offered-child' }, depth: 1 },
        ],
      },
    ],
  })
  expect(reader.tasks({ ...options, filter: { text: 'child' }, expanded: [] })).toMatchObject({
    board: [{ stage: 'in_progress', rows: [{ issue: { id: 'root' }, depth: 0 }] }],
  })
})
it('does not resurrect a collapsed resume twin as a mission author', async () => {
  const seat = {
    issueId: 'elsewhere',
    title: 'Author',
    cwd: '/fixture',
    agentKind: 'codex',
    status: 'exited',
    archived: true,
    resume: { kind: 'codex', value: 'same-conversation' },
    createdAt: '2026-01-01T00:00:00Z',
    lastActiveAt: '2026-01-01T00:00:00Z',
  }
  const { pool, reader } = await setup(
    [
      issue('root', { startedBySession: 'old' }),
      issue('elsewhere', {
        stage: 'done',
        closedAt: '2026-01-01T00:00:00Z',
        readAt: '2026-01-01T00:00:00Z',
      }),
    ],
    [
      { ...seat, sessionId: 'old' },
      { ...seat, sessionId: 'new', lastActiveAt: '2026-01-02T00:00:00Z' },
    ],
  )
  expect(pool.graph.isCollapsed('session', 'old')).toBe(true)
  expect(reader.mission('root')).toMatchObject({ sessions: [] })
})
it('a known cold mission remains LOADING until one batched load supplies its row', async () => {
  const { pool, reader, load } = await setup([issue('cold', { archived: true, stage: 'done' })])
  expect(reader.mission('cold')).toBe(LOADING)
  expect(reader.deck('cold', 'full')).toBe(LOADING)
  expect(reader.mission('cold')).toBe(LOADING)
  expect(load).not.toHaveBeenCalled()
  expect(pool.hydrate()).toBe(1)
  expect(load).toHaveBeenCalledTimes(1)
  expect(reader.mission('cold')).toMatchObject({
    root: { id: 'cold' },
    missionSessions: [],
    progress: { total: 0, done: 0 },
  })
})
it('an archived root keeps its full header for the current session without loading hidden siblings', async () => {
  const root = issue('cold', {
    archived: true,
    stage: 'done',
    startedBySession: 'starter',
    coordinatorSessionId: 'current',
    notes: 'Root notes',
    activityNotes: 'Root activity',
    asked: 'Root question',
    needsHuman: true,
    closedReason: 'done',
    defaultAgent: 'codex',
    labels: ['root-label'],
  })
  const current = {
    sessionId: 'current', issueId: 'cold', cwd: '/fixture',
    status: 'working', agentKind: 'codex',
    lastActiveAt: new Date(now).toISOString(),
  }
  const { pool, reader, load } = await setup([
    root,
    issue('hidden-child', { parentId: 'cold', archived: true, stage: 'done' }),
  ], [current])
  disposals.push(autorun(() => reader.mission('cold')))
  expect(reader.mission('cold')).toBe(LOADING)
  expect(pool.hydrate()).toBe(1)
  const data = reader.mission('cold')
  expect(data).not.toBe(LOADING)
  if (data === LOADING) throw new Error('Archived mission is still loading')
  expect(data.missionSessions).toMatchObject([{ sessionId: 'current', issueId: 'cold' }])
  // MissionScreen chooses the current session's issue from this list before
  // falling back to root. Every header field must borrow the full root.
  const header = data.issues.find(row => row.id === data.missionSessions[0]?.issueId) ?? data.root
  expect(header).toBe(data.root)
  expect(header).toMatchObject({ ...root, description: 'summary description' })
  expect(header).toMatchObject({ memberSessionIds: ['current'] })
  expect(load).toHaveBeenCalledTimes(1)
  expect(load).toHaveBeenCalledWith('issue', 'cold')
  expect(pool.tables.issue.has('hidden-child')).toBe(false)
  expect(pool.hydrate()).toBe(0)
})
it('an explicitly opened archived mission counts accepted formal children without counting its root', async () => {
  const { pool, reader } = await setup([
    issue('cold', { archived: true, stage: 'done' }),
    issue('child', { parentId: 'cold' }),
  ])
  expect(reader.mission('cold')).toBe(LOADING)
  while (pool.hydrate()) {}
  expect(reader.mission('cold')).toMatchObject({
    root: { id: 'cold' },
    progress: { total: 1, done: 0, stall: 1 },
  })
  expect(reader.deck('cold', 'full')).toMatchObject({ rows: [], presence: null })
})
it('an unknown mission is not found in the complete principal replica and never queues a load', async () => {
  const { pool, reader, load } = await setup([issue('root')])
  expect(reader.mission('absent')).toMatchObject({ root: undefined, missionSessions: [] })
  expect(reader.deck('absent', 'full')).toMatchObject({ root: undefined, rows: [] })
  expect(pool.hydrate()).toBe(0)
  expect(load).not.toHaveBeenCalled()
})
it('observes an addressed mission without subscribing to unrelated issue content', async () => {
  const { pool, reader } = await setup([issue('root'), issue('unrelated')])
  const selected = observable.box('root')
  let draws = 0
  const stop = autorun(() => {
    reader.mission(selected.get())
    draws++
  })
  disposals.push(stop)
  while (pool.hydrate()) {}
  const before = draws
  const beforeWork = { ...reader.stats }
  runInAction(() =>
    pool.apply({
      type: 'update',
      rows: [{ kind: 'issue', id: 'unrelated', value: issue('unrelated', { title: 'new title' }) }],
    }),
  )
  expect(draws).toBe(before)
  expect(reader.stats).toEqual(beforeWork)
  expect(reader.mission('root')).toMatchObject({ root: { title: 'root' }, progress: { total: 1 } })
  runInAction(() => selected.set('unrelated'))
  expect(reader.mission('unrelated')).toMatchObject({ root: { title: 'new title' } })
})

it('keeps phone mission member visits flat on a seated heartbeat at 1x and 4x', async () => {
  const measurements: { memberVisits: number; memberBuilds: number }[] = []
  for (const scale of [1, 4]) {
    const seat = {
      sessionId: 'seat', issueId: 'root', cwd: '/fixture', agentKind: 'codex',
      status: 'running', archived: false, createdAt: '2026-01-01T00:00:00Z',
      lastActiveAt: '2026-01-01T00:00:00Z', agentState: { phase: 'working' },
    }
    const { pool, reader } = await setup([
      issue('root'), issue('child', { parentId: 'root' }),
      ...Array.from({ length: 8 * scale }, (_, index) => issue(`unshown-${index}`)),
    ], [seat, ...Array.from({ length: 8 * scale }, (_, index) => ({
      ...seat, sessionId: `history-${index}`, archived: true, status: 'exited',
    }))])
    const membership = missions(pool), readMembers = membership.members.bind(membership)
    const probes = new WeakMap<ReadonlySet<string>, ReadonlySet<string>>()
    let visits = 0
    const probe = vi.spyOn(membership, 'members').mockImplementation(id => {
      const ids = readMembers(id)
      if (ids === LOADING) return ids
      if (!probes.has(ids)) probes.set(ids, new Proxy(ids, {
        get(target, key) {
          if (key === Symbol.iterator) return function* () {
            for (const member of target) { visits++; yield member }
          }
          const value = Reflect.get(target, key, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      }))
      return probes.get(ids)!
    })
    disposals.push(() => probe.mockRestore())
    let activity: string | undefined
    const stop = autorun(() => {
      const data = reader.mission('root')
      reader.deck('root', 'full')
      if (data !== LOADING) activity = data.missionSessions.find(row => row.sessionId === 'seat')?.lastActiveAt
    })
    disposals.push(stop)
    while (pool.hydrate()) {}
    expect(visits).toBeGreaterThan(0)
    const builds = membership.stats.members
    visits = 0
    runInAction(() => pool.apply({ type: 'update', rows: [{
      kind: 'session', id: 'seat', value: { ...seat, lastActiveAt: '2026-01-02T00:00:00Z' },
    }] }))
    expect(activity).toBe('2026-01-02T00:00:00Z')
    expect(membership.stats.members - builds).toBe(0)
    const work = { memberVisits: visits, memberBuilds: membership.stats.members - builds }
    measurements.push(work)
    console.info('[phone mission heartbeat]', { scale, ...work })
  }
  expect(measurements[1]).toEqual(measurements[0])
})

for (const scale of [1, 4] as const)
  it(`keeps phone screen publication quiet for unshown changes at ${scale}x`, async () => {
    const { pool, reader } = await setup([
      issue('root'),
      issue('child', { parentId: 'root' }),
      ...Array.from({ length: 8 * scale }, (_, index) => issue(`unshown-${index}`)),
    ])
    const scoped = { ...options, filter: { text: 'root' } }
    let draws = 0
    const stop = autorun(() => {
      reader.tasks(scoped)
      reader.mission('root')
      reader.deck('root', 'full')
      draws++
    })
    disposals.push(stop)
    while (pool.hydrate()) {}
    const tasks = reader.tasks(scoped), mission = reader.mission('root'), deck = reader.deck('root', 'full')
    const before = draws, counters = { ...reader.stats }
    runInAction(() => pool.apply({ type: 'update', rows: [{
      kind: 'issue', id: 'unshown-0', value: issue('unshown-0', {
        description: { value: 'Unshown bookkeeping' },
      }),
    }] }))
    expect(draws).toBe(before)
    expect(reader.stats).toEqual(counters)
    expect(reader.tasks(scoped)).toBe(tasks)
    expect(reader.mission('root')).toBe(mission)
    expect(reader.deck('root', 'full')).toBe(deck)
    console.info('[phone screen unshown]', { scale, publications: draws - before, counters: {
      tasks: reader.stats.tasks - counters.tasks,
      mission: reader.stats.mission - counters.mission,
      deck: reader.stats.deck - counters.deck,
    } })
  })

it('preserves untouched phone task rows and sections when one shown title changes', async () => {
  const { pool, reader } = await setup([
    issue('root'), issue('peer'), issue('review', { stage: 'review' }),
  ])
  const stop = autorun(() => reader.tasks(options))
  disposals.push(stop)
  while (pool.hydrate()) {}
  const before = reader.tasks(options)
  if (before === LOADING) throw new Error('Tasks did not settle')
  const peer = before.board[0]!.rows.find(row => row.issue.id === 'peer')!
  const review = before.board.find(section => section.stage === 'review')!
  runInAction(() => pool.apply({ type: 'update', rows: [{
    kind: 'issue', id: 'root', value: issue('root', { title: 'Shown title changed' }),
  }] }))
  const after = reader.tasks(options)
  if (after === LOADING) throw new Error('Tasks became loading')
  expect(after.board[0]!.rows.find(row => row.issue.id === 'peer')).toBe(peer)
  expect(after.board.find(section => section.stage === 'review')).toBe(review)
  expect(after.board[0]!.rows.find(row => row.issue.id === 'root')!.issue.title).toBe('Shown title changed')
  expect(after.progressByIssue).toBe(before.progressByIssue)
  expect(after.workingByIssue).toBe(before.workingByIssue)
})
