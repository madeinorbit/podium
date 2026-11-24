import type { SessionView } from '@podium/client-core/session-values'
import type { IssueNavigationModel } from '@podium/client-core/values'
import { autorun, runInAction } from 'mobx'
import { afterEach, expect, it, vi } from 'vitest'
import { fullDevice } from './full-device-fixture'
import { MissionScreen, missionRootId } from './mission-screen'
import { attachMissionTestPreferences } from './mission-screen.test.fixture'
import { missionView, settled } from './mission-view'
import { MobxPool } from './pool'
import { createPoolProjection } from './runtime-pool'
import { sessionSeats } from './session-seats'
import { LOADING } from './worklist/rollup'

const stamp = '2026-10-01T12:00:00Z',
  now = Date.parse(stamp)
const coldRoot = () =>
  issue('root', {
    stage: 'done',
    closedAt: '2026-09-20T12:00:00Z',
    updatedAt: '2026-09-20T12:00:00Z',
  })
const pools: MobxPool[] = []
afterEach(() => {
  for (const pool of pools.splice(0)) pool.dispose()
  vi.restoreAllMocks()
})
const issue = (id: string, patch: Record<string, unknown> = {}) =>
  ({
    id,
    seq: 1,
    stage: 'in_progress',
    title: 'Mission',
    description: '',
    deps: [],
    parentId: null,
    repoPath: '/synthetic',
    createdAt: stamp,
    updatedAt: stamp,
    readAt: stamp,
    ...patch,
  }) as unknown as IssueNavigationModel
const session = (sessionId: string, issueId: string, patch: Record<string, unknown> = {}) =>
  ({
    sessionId,
    issueId,
    cwd: '/synthetic',
    title: 'Agent',
    name: 'Named agent',
    agentKind: 'codex',
    status: 'exited',
    archived: true,
    createdAt: stamp,
    lastActiveAt: stamp,
    readAt: stamp,
    unread: false,
    ...patch,
  }) as unknown as SessionView
const openings = new WeakMap<MobxPool, Map<string, MissionScreen>>()
/** What the opened deck reads for a selection: one opening per mission root. */
function pane(pool: MobxPool, selectedId: string) {
  const rootId = missionRootId(pool, selectedId)
  if (rootId === LOADING) return LOADING
  if (!rootId)
    return {
      root: undefined,
      rows: [],
      archivedCount: 0,
      progress: { total: 0, done: 0, working: 0, waiting: 0, todo: 0 },
    }
  let byRoot = openings.get(pool)
  if (!byRoot) {
    byRoot = new Map()
    openings.set(pool, byRoot)
  }
  let screen = byRoot.get(rootId)
  if (!screen) {
    screen = new MissionScreen(pool, rootId)
    byRoot.set(rootId, screen)
  }
  if (!screen.ready) return LOADING
  const root = screen.reader.issue(rootId)
  return {
    root: root === LOADING ? undefined : root,
    rows: screen.rows,
    archivedCount: screen.archivedCount,
    progress: screen.progress,
  }
}
function tracked<T>(read: () => T): T {
  let value!: T
  const stop = autorun(() => {
    value = read()
  })
  stop()
  return value
}
function open(rows: IssueNavigationModel[], seats: SessionView[]) {
  const input = new Map<string, object>([
    ...rows.map((row) => [`issue:${row.id}`, row] as const),
    ...seats.map((row) => [`session:${row.sessionId}`, row] as const),
  ])
  const load = vi.fn((entity: string, id: string) => input.get(`${entity}:${id}`))
  const pool = fullDevice(
    new MobxPool({ selectedIssueId: null, coarseNow: now }, undefined, {
      load,
      schedule: () => () => {},
    }),
  )
  attachMissionTestPreferences(pool)
  pools.push(pool)
  pool.apply({
    type: 'replace',
    rows: [
      ...rows.map((value) => ({ kind: 'issue' as const, id: value.id, value })),
      ...seats.map((value) => ({ kind: 'session' as const, id: value.sessionId, value })),
    ],
  })
  return { pool, load, reader: missionView(pool) }
}

it('preserves real history errors at the mission pane boundary', () => {
  const { pool, reader } = open([issue('root')], [session('old', 'root')])
  const failure = new Error('Broken history')
  vi.spyOn(pool.sessionObject('old'), 'moved', 'get').mockImplementation(() => {
    throw failure
  })
  const projection = createPoolProjection(pool, () => pane(reader.pool, 'root'))
  try {
    expect(() => projection.getSnapshot()).toThrow(failure)
  } finally {
    projection.dispose()
  }
})

it('shares the observed seat flag when pane reads change a present session', () => {
  const live = session('live', 'root', { archived: false, status: 'live' })
  const { pool, reader } = open([issue('root')], [live])
  const stopSeat = autorun(() => {
    sessionSeats(pool).seat('live')
  })
  let count: number | typeof LOADING = LOADING
  const stopArchive = autorun(() => {
    count = reader.historyRosterCount('root')
  })
  const raw = vi.spyOn(reader, 'rawSession')
  try {
    expect(count).toBe(0)
    pool.apply({
      type: 'update',
      rows: [{ kind: 'session', id: 'live', value: { ...live, readAt: null, unread: true } }],
    })
    expect(count).toBe(0)
    expect(raw).not.toHaveBeenCalled()
    pool.apply({
      type: 'update',
      rows: [{ kind: 'session', id: 'live', value: { ...live, archived: true } }],
    })
    pool.hydrate()
    expect(count).toBe(1)
  } finally {
    stopArchive()
    stopSeat()
  }
})

it('keeps crew presentation unobserved when a hidden row asks only for its collapsed task count', () => {
  const { reader } = open(
    [issue('root'), issue('child', { parentId: 'root' })],
    [session('crew', 'child', { archived: false, status: 'live' })],
  )
  const roster = vi.spyOn(reader, 'roster')
  let count = -1
  const stop = autorun(() => {
    count = reader.deck('root').model('root').collapsedSummary.tasks
  })
  try {
    expect(count).toBe(1)
    expect(roster).not.toHaveBeenCalled()
  } finally {
    stop()
  }
})

it('bounds parent child-list reads for earliest-child parenting at 1x and 4x', () => {
  for (const scale of [1, 4]) {
    const children = Array.from({ length: 128 * scale }, (_, index) =>
      issue(`child-${index}`, { parentId: 'root', seq: index + 2 }),
    )
    const { pool, reader } = open([issue('root'), ...children], [])
    const many = vi.spyOn(pool.graph, 'many')
    const stop = autorun(() => {
      expect(reader.deck('root').topology).not.toBe(LOADING)
    })
    try {
      // Membership, topology and the parent's scalar question each consume
      // this bucket a bounded number of times, independent of its width.
      expect(
        many.mock.calls.filter(
          ([entity, id, relation]) =>
            entity === 'issue' && id === 'root' && relation === 'children',
        ).length,
      ).toBeLessThanOrEqual(4)
    } finally {
      stop()
      many.mockRestore()
    }
  }
})

it("renders an addressed dependency label without loading that target's unrelated dependents", () => {
  const root = issue('root', { blocked: true, deps: [{ id: 'blocker', type: 'blocked-by' }] })
  const { pool, reader } = open(
    [
      root,
      issue('blocker', { seq: 2, stage: 'backlog' }),
      issue('unrelated', {
        ...coldRoot(),
        id: 'unrelated',
        deps: [{ id: 'blocker', type: 'related' }],
      }),
    ],
    [],
  )
  const read = vi.spyOn(pool, 'row')
  expect(tracked(() => settled(() => reader.note(root, true)))).toMatchObject({
    kind: 'blocked',
    short: '#2',
    full: 'Blocked by #2',
  })
  expect(read.mock.calls.some(([entity, id]) => entity === 'issue' && id === 'unrelated')).toBe(
    false,
  )
})

it('reads only the selected mission attachment edges as unrelated sessions grow', () => {
  const { pool, reader } = open(
    [issue('root'), issue('other')],
    [
      session('own', 'root', { archived: false, status: 'live' }),
      ...Array.from({ length: 1000 }, (_, index) =>
        session(`other-${index}`, 'other', { archived: false, status: 'live' }),
      ),
    ],
  )
  const read = vi.spyOn(pool, 'row')
  const values = tracked(() => pane(pool, 'root'))
  expect(values).not.toBe(LOADING)
  expect(
    read.mock.calls.filter(([entity]) => entity === 'session').every(([, id]) => id === 'own'),
  ).toBe(true)
  expect(read.mock.calls.some(([, , absent]) => String(absent) === 'peek')).toBe(false)
  runInAction(() =>
    pool.apply({
      type: 'update',
      rows: [
        {
          kind: 'session',
          id: 'own',
          value: session('own', 'other', { archived: false, status: 'live' }),
        },
      ],
    }),
  )
  const moved = tracked(() => pane(pool, 'root'))
  if (moved === LOADING) throw new Error('Unsettled fixture')
  expect(moved.rows[0]?.sessions).toEqual([])
})

it('counts every same-type dependency while preserving first-origin navigation', () => {
  const deps = [
    { id: 'first', type: 'discovered-from' },
    { id: 'second', type: 'discovered-from' },
    { id: 'first', type: 'related' },
    { id: 'second', type: 'related' },
  ]
  const { pool, reader } = open(
    [
      issue('first', { stage: 'backlog' }),
      issue('second', { stage: 'backlog' }),
      issue('source', { stage: 'proposed', deps }),
    ],
    [],
  )
  expect(tracked(() => pool.graph.one('issue', 'source', 'discoveredFrom'))).toBe('first')
  expect(tracked(() => [...pool.graph.many('issue', 'source', 'pageDependencies')]).sort()).toEqual(
    ['first', 'second'],
  )
  expect(tracked(() => reader.issue('second'))).toMatchObject({
    dependents: [
      { id: 'source', type: 'discovered-from' },
      { id: 'source', type: 'related' },
    ],
  })
  const values = tracked(() => pane(pool, 'second'))
  expect(values).not.toBe(LOADING)
  if (values === LOADING) throw new Error('Unsettled fixture')
  expect(values.progress.total).toBe(0)
  runInAction(() =>
    pool.apply({
      type: 'update',
      rows: [
        {
          kind: 'issue',
          id: 'source',
          value: issue('source', {
            stage: 'proposed',
            deps: deps.filter((dep) => dep.id !== 'second'),
          }),
        },
      ],
    }),
  )
  expect(tracked(() => pool.graph.size('issue', 'second', 'pageDependents'))).toBe(0)
  expect(tracked(() => reader.issue('second'))).toMatchObject({ dependents: [] })
  const removed = tracked(() => pane(pool, 'second'))
  if (removed === LOADING) throw new Error('Unsettled fixture')
  expect(removed.progress.total).toBe(1)
})

it('keeps raw issue member IDs and the collapsed winner in its original roster position', () => {
  const resume = { kind: 'codex-thread', value: 'same-thread' }
  const { pool, reader } = open(
    [issue('root')],
    [
      session('a-old', 'root', { archived: false, status: 'hibernated', resume }),
      session('m-other', 'root', { archived: false, status: 'hibernated' }),
      session('z-winner', 'root', {
        archived: false,
        status: 'hibernated',
        resume,
        lastActiveAt: '2026-10-01T12:01:00Z',
      }),
    ],
  )
  expect(tracked(() => reader.issue('root'))).toMatchObject({
    memberSessionIds: ['a-old', 'm-other', 'z-winner'],
    sessionSummary: { total: 3, byPhase: { unknown: 3 } },
  })
  expect(tracked(() => reader.attached('root'))).not.toBe(LOADING)
  const attached = tracked(() => reader.attached('root'))
  if (attached === LOADING) throw new Error('Unsettled fixture')
  expect(attached.map((session) => session.sessionId)).toEqual(['z-winner', 'm-other'])
  runInAction(() =>
    pool.apply({
      type: 'update',
      rows: [
        { kind: 'issue', id: 'root', value: issue('root', { readAt: '2026-10-01T12:02:00Z' }) },
      ],
    }),
  )
  expect(tracked(() => reader.issue('root'))).toMatchObject({
    readAt: '2026-10-01T12:02:00Z',
    unread: false,
  })
})

it('updates ready at the deferral deadline without a row change', () => {
  const deadline = now + 60_000
  const { pool } = open(
    [issue('root', { stage: 'backlog', deferUntil: new Date(deadline).toISOString() })],
    [],
  )
  const seen: { deferred: boolean; ready: boolean }[] = []
  const stop = autorun(() => {
    const values = pane(pool, 'root')
    if (values === LOADING || !values.root) throw new Error('Unsettled fixture')
    seen.push({ deferred: values.root.deferred, ready: values.root.ready })
  })
  try {
    expect(seen).toEqual([{ deferred: true, ready: false }])
    pool.clock.advance(deadline - 1)
    expect(seen).toHaveLength(1)
    pool.clock.advance(deadline)
    expect(seen.at(-1)).toEqual({ deferred: false, ready: true })
    pool.clock.advance(deadline + 60_000)
    expect(seen).toHaveLength(2)
  } finally {
    stop()
  }
})

// POD-2171: the deck's counts, its Needs-you filter and its words follow the
// coordinated rule from the same seat facts as the sidebar.
const working = { status: 'live', archived: false, agentState: { phase: 'working', since: stamp } }
const idleDone = {
  status: 'live',
  archived: false,
  agentState: { phase: 'idle', since: stamp, idle: { kind: 'done' } },
}
const offered = { offer: { message: 'Ready', actions: [], createdAt: stamp } }
function deckFacts(
  coordinated: boolean,
  extra: { rows?: IssueNavigationModel[]; seats?: SessionView[] } = {},
) {
  const { reader } = open(
    [issue('root', coordinated ? { coordinatorSessionId: 'coord' } : {}), ...(extra.rows ?? [])],
    [
      session('coord', 'root', idleDone),
      session('helper', 'root', { ...working, ...offered }),
      ...(extra.seats ?? []),
    ],
  )
  return tracked(() => {
    const row = reader.deck('root').model('root')
    return {
      word: row.word,
      waiting: row.waitingAgentCount,
      actionable: row.actionableCount,
      matches: row.matchesNeedsYou,
      asking: row.askingSessionIds,
      collapsed: row.collapsedSummary.needsYou,
    }
  })
}

it('a coordinated deck row counts no delegate offer, and reads its work', () => {
  expect(deckFacts(true)).toEqual({
    word: 'working',
    waiting: 0,
    actionable: 0,
    matches: false,
    asking: [],
    collapsed: false,
  })
  expect(deckFacts(false)).toMatchObject({
    word: 'needs-you',
    waiting: 1,
    actionable: 1,
    matches: true,
    asking: ['helper'],
    collapsed: true,
  })
})

it('a coordinated deck row counts a sub-task’s exception but not its own requests', () => {
  const child = (patch: Record<string, unknown>) => ({
    rows: [issue('child', { parentId: 'root', ...patch })],
    seats: [session('impl', 'child', idleDone)],
  })
  expect(deckFacts(true, child({ stage: 'review' }))).toMatchObject({
    word: 'working',
    actionable: 0,
    collapsed: false,
  })
  expect(deckFacts(true, child({ type: 'decision' }))).toMatchObject({
    word: 'working',
    actionable: 0,
  })
  expect(deckFacts(false, child({ stage: 'review' }))).toMatchObject({ actionable: 2 })
  const crashed = {
    rows: [issue('child', { parentId: 'root' })],
    seats: [
      session('impl', 'child', {
        status: 'exited',
        archived: false,
        stopReason: 'oom',
        exitCode: 137,
      }),
    ],
  }
  expect(deckFacts(true, crashed)).toMatchObject({
    word: 'error',
    waiting: 1,
    actionable: 1,
    collapsed: true,
  })
})

it('R2-1/R2-2: a coordinated deck row counts the coordinator by the shared seat facts, and offered work as work', () => {
  const facts = (
    seats: SessionView[],
    interactions: Record<string, number> = {},
    coordinated = true,
  ) => {
    const { reader, pool } = open(
      [issue('root', coordinated ? { coordinatorSessionId: 'coord' } : {})],
      seats,
    )
    Object.defineProperty(pool, 'sessionOpenInteractions', {
      value: (id: string) =>
        interactions[id] ? { count: interactions[id], since: now } : { count: 0, since: null },
    })
    return tracked(() => {
      const row = reader.deck('root').model('root')
      return {
        word: row.word,
        actionable: row.actionableCount,
        waiting: row.waitingAgentCount,
        matches: row.matchesNeedsYou,
        working: row.workingAgentCount,
        matchesWorking: row.matchesWorking,
        workingIds: row.workingSessionIds,
      }
    })
  }
  // The coordinator idles with an open permission interaction: every surface asks.
  expect(facts([session('coord', 'root', idleDone)], { coord: 1 })).toMatchObject({
    word: 'needs-you',
    actionable: 1,
    waiting: 1,
    matches: true,
  })
  // The coordinator ended its turn with a question.
  const question = {
    ...idleDone,
    agentState: { phase: 'idle', since: stamp, idle: { kind: 'question' } },
  }
  expect(facts([session('coord', 'root', question)])).toMatchObject({
    word: 'needs-you',
    actionable: 1,
    matches: true,
  })
  // A delegate works while holding an offer: Working everywhere, and no ask.
  expect(
    facts([
      session('coord', 'root', idleDone),
      session('helper', 'root', { ...working, ...offered }),
    ]),
  ).toMatchObject({
    word: 'working',
    actionable: 0,
    working: 1,
    matchesWorking: true,
    workingIds: ['helper'],
  })
  // Uncoordinated rows read exactly as before: no interaction input, offers mask work.
  expect(facts([session('coord', 'root', idleDone)], { coord: 1 }, false)).toMatchObject({
    word: 'idle',
    actionable: 0,
    waiting: 0,
  })
  expect(facts([session('helper', 'root', { ...working, ...offered })], {}, false)).toMatchObject({
    working: 0,
    matchesWorking: false,
  })
})

it('preserves a nested coordinator boundary when a cyclic graft requires unique rollups', () => {
  const { reader } = open(
    [
      issue('root', { parentId: 'lead' }),
      issue('lead', { parentId: 'root', coordinatorSessionId: 'coord' }),
      issue('review', { parentId: 'lead', stage: 'review' }),
    ],
    [session('coord', 'lead', idleDone)],
  )
  const deck = reader.deck('root')
  expect(tracked(() => deck.overlap)).toBe(true)
  // The unstaffed review is a request to its live coordinator. A repeated
  // ancestry edge changes deduplication, never who is asked to act.
  expect(tracked(() => deck.model('root').actionableCount)).toBe(0)
  expect(tracked(() => deck.model('lead').actionableCount)).toBe(0)
})

it('keeps a matching graft under this root even when its natural parent is outside the root', () => {
  const { reader } = open(
    [
      issue('root', { seq: 1 }),
      issue('inside', { seq: 2, parentId: 'root', stage: 'done' }),
      issue('outside', { seq: 3, stage: 'done' }),
      issue('graft', {
        seq: 4,
        parentId: 'outside',
        startedBySession: 'starter',
        stage: 'review',
        needsHuman: true,
      }),
    ],
    [session('starter', 'inside')],
  )
  const expected = ['root', 'inside', 'graft']
  expect(tracked(() => reader.deck('root').rowIds())).toEqual(expected)
  expect(tracked(() => reader.deck('root', 'needs-you').rowIds())).toEqual(expected)
})
