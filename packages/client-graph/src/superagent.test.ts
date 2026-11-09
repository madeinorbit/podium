import type { ClientRuntime } from '@podium/client-core/engine'
import type { ReplicaAddressedBatch } from '@podium/client-core/replica'
import { withKeyedInputs } from '@podium/client-core/test-support/keyed-inputs'
import { disposeFixtureUi } from '@podium/client-core/test-support/ui'
import type { IssueEventWire } from '@podium/model'
import { issueEventRowId, type SuperagentThreadWire, superagentThreadRowId } from '@podium/model'
import { afterEach, expect, it, vi } from 'vitest'
import type { ReferenceState as Store } from '../../../tests/worklist/diagnostics/reference-state'
import { checkSuperagent } from '../../../tests/worklist/diagnostics/superagent-check'
import { omitGone } from './lookup'
import { NOTICE_ENTITIES } from './notice-schema'
import { NOTICE_SOURCE_KEY, NoticeSource } from './notice-source'
import { MobxPool } from './pool'
import {
  createSuperagentSource,
  SUPERAGENT_ENTITIES,
  SUPERAGENT_SOURCE_KEY,
  SUPERAGENT_SUMMARIES,
  superagentCursor,
  superagentFeed,
  superagentQuestion,
  superagentState,
  superagentThread,
} from './superagent'
import { LOADING } from './worklist/rollup'

const dispose: (() => void)[] = []
afterEach(() => {
  for (const stop of dispose.splice(0)) stop()
})
const ME = 'u-me'
/** One of my synced thread records (POD-6675), as the feed delivers it. */
const thread = (
  threadId: string,
  patch: Partial<SuperagentThreadWire> = {},
): SuperagentThreadWire =>
  ({
    threadId,
    ownerUserId: ME,
    kind: 'btw',
    archived: false,
    resumable: false,
    turnRunning: false,
    lastTurnFailure: null,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    ...patch,
  }) as SuperagentThreadWire
const poolThread = (row: SuperagentThreadWire) => {
  const id = superagentThreadRowId(ME as never, row.threadId)
  return { kind: 'superagentThread' as const, id, value: { ...row, id } as never }
}
const event = (id: number): IssueEventWire => ({
  id: issueEventRowId(id, 'synthetic'),
  eventId: id,
  ts: '2026-10-03T00:00:00Z',
  kind: 'issue.closed',
  subject: 'synthetic',
  repoPath: null,
  payload: null,
})
async function fixture() {
  let state = {
    superagentThreads: [
      thread('global', {
        kind: 'global',
        podiumSessionId: 's-a' as never,
        updatedAt: '2026-10-02T00:00:00Z',
      }),
      thread('btw-private', {
        podiumSessionId: 's-b' as never,
        originSessionId: 's-origin' as never,
      }),
    ],
    superThreadId: 'btw-private',
    sessions: [
      { sessionId: 's-a', cwd: '/synthetic', machineId: 'm' },
      { sessionId: 's-b', cwd: '/synthetic/b', machineId: 'm' },
    ],
    repos: [],
    paneA: null,
    selectedWorktree: null,
    issueEvents: [event(100), event(9), event(99)],
    pendingInteractions: [
      {
        id: 'z-first',
        sessionId: 's-a',
        kind: 'question',
        status: 'asked',
        payload: { questions: [] },
      },
      {
        id: 'a-second',
        sessionId: 's-a',
        kind: 'question',
        status: 'asked',
        payload: { questions: [] },
      },
    ],
  } as unknown as Store
  let cursor = { lastEventId: 9, seenAt: '2026-10-02T00:00:00Z' as string | null }
  const wakes = new Set<() => void>(),
    positions = new Set<() => void>(),
    batches = new Set<(b: ReplicaAddressedBatch) => void>()
  const rows = vi.fn((kind: string) =>
    kind === 'issueEvents'
      ? state.issueEvents
      : kind === 'pendingInteractions'
        ? state.pendingInteractions
        : [],
  )
  const replica = {
    rows,
    row: (kind: string, id: string) => rows(kind).find((r: { id: string }) => r.id === id),
    getCursor: () => 1,
    ids: (kind: string) => (kind === 'issueEvents' ? state.issueEvents : []).map((row) => row.id),
    subscribeAddressedBatch: (wake: (b: ReplicaAddressedBatch) => void) => {
      batches.add(wake)
      return () => batches.delete(wake)
    },
  }
  const owner = withKeyedInputs({
    replica,
    subscribe: (wake: () => void) => {
      wakes.add(wake)
      return () => wakes.delete(wake)
    },
    getSnapshot: () => state,
    readPosition: {
      get: () => cursor,
      subscribe: (wake: () => void) => {
        positions.add(wake)
        return () => positions.delete(wake)
      },
      advance: vi.fn(),
      hydrate: async () => {},
      replace: vi.fn(),
    },
    outbox: { subscribe: () => () => {}, deadLetters: () => [] },
  }) as unknown as ClientRuntime
  state = { ...state, readPosition: owner.readPosition }
  const load = vi.fn(
    (_entity: string, id: string) => state.sessions.find((row) => row.sessionId === id) as never,
  )
  const pool = new MobxPool(
    { selectedIssueId: null, coarseNow: Date.parse('2026-10-03T00:00:00Z') },
    undefined,
    { summaries: SUPERAGENT_SUMMARIES, load, schedule: () => () => {} },
  )
  pool.apply({
    type: 'replace',
    rows: [
      ...state.sessions.map((row) => ({
        kind: 'session' as const,
        id: row.sessionId,
        value: row as never,
      })),
      ...state.superagentThreads.map(poolThread),
    ],
  })
  const source = await createSuperagentSource(owner)
  await pool.sources.ensure(SUPERAGENT_SOURCE_KEY, SUPERAGENT_ENTITIES, () => source)
  await pool.sources.ensure(NOTICE_SOURCE_KEY, NOTICE_ENTITIES, () => new NoticeSource(owner))
  pool.sources.view('test.superagentFixture.ui', () => ({ dispose: () => disposeFixtureUi(owner) }))
  dispose.push(() => pool.dispose())
  return {
    pool,
    source,
    rows,
    load,
    get state() {
      return state
    },
    owner,
    publish(patch: Partial<Store>) {
      state = { ...state, ...patch }
      for (const wake of wakes) wake()
    },
    /** My thread records as the feed moves them: the replica and the pool. */
    threads(next: SuperagentThreadWire[]) {
      const gone = state.superagentThreads.filter(
        (row) => !next.some((other) => other.threadId === row.threadId),
      )
      state = { ...state, superagentThreads: next }
      pool.apply({
        type: 'update',
        rows: [
          ...next.map(poolThread),
          ...gone.map((row) => ({ ...poolThread(row), value: undefined as never })),
        ],
      })
    },
    batch(kind: 'issueEvents' | 'pendingInteractions' | 'sessions', id: string) {
      for (const wake of batches)
        wake({ type: 'update', rows: [{ kind, id }] } as ReplicaAddressedBatch)
    },
    cursor(next: typeof cursor) {
      cursor = next
      for (const wake of positions) wake()
    },
    replace() {
      for (const wake of batches) wake({ type: 'replace' } as ReplicaAddressedBatch)
    },
    listeners: () => wakes.size + positions.size + batches.size,
  }
}
async function settle(f: Awaited<ReturnType<typeof fixture>>) {
  checkSuperagent(f.pool, f.state)
  await Promise.resolve()
  checkSuperagent(f.pool, f.state)
  await Promise.resolve()
  f.pool.hydrate()
}

it('reads my thread records, the active selection and an exact differential', async () => {
  const f = await fixture()
  expect(superagentState(f.pool).loading).toBe(true)
  await settle(f)
  expect(checkSuperagent(f.pool, f.state)).toMatchObject({
    differences: 0,
    pending: 0,
    positions: 5,
  })
  expect(superagentState(f.pool).activeSessionId).toBe('s-b')
  expect(superagentThread(f.pool, 'global').thread?.podiumSessionId).toBe('s-a')
  // Newest write first, as the old list read answered.
  expect(superagentState(f.pool).threads.map((row) => row.id)).toEqual(['global', 'btw-private'])
})
it('never addresses an id it does not hold, and follows my records when they go', async () => {
  const f = await fixture()
  await settle(f)
  expect(superagentThread(f.pool, 'someone-elses-private')).toEqual({
    thread: undefined,
    loading: false,
  })
  f.threads([])
  await Promise.resolve()
  expect(superagentThread(f.pool, 'global').thread).toBeUndefined()
  expect(superagentState(f.pool).threads).toEqual([])
})
it('a thread made, renamed or archived on my other device moves the readers with no request (POD-6675)', async () => {
  const f = await fixture()
  await settle(f)
  const [global, btw] = f.state.superagentThreads
  f.threads([
    global!,
    btw!,
    thread('concierge-new', {
      kind: 'concierge',
      repoPath: '/r',
      updatedAt: '2026-10-03T00:00:00Z',
    }),
  ])
  expect(superagentState(f.pool).threads.map((row) => row.id)).toEqual([
    'concierge-new',
    'global',
    'btw-private',
  ])
  f.threads([
    { ...global!, title: 'renamed' },
    { ...btw!, archived: true },
  ])
  expect(superagentThread(f.pool, 'global').thread?.title).toBe('renamed')
  expect(superagentState(f.pool).threads.map((row) => row.id)).toEqual(['global'])
  expect(checkSuperagent(f.pool, f.state)).toMatchObject({ differences: 0 })
})
it('names my global thread by `global` under the server rule, and carries turn status', async () => {
  const f = await fixture()
  await settle(f)
  const failure = {
    at: '2026-10-03T00:00:00Z',
    message: 'the headless harness turn failed: offline',
    userText: 'hi',
  }
  // An old install can hold a stray `global`-kind row named for somebody else;
  // `global` is never that one.
  const stray = thread('global:u-other', { kind: 'global', updatedAt: '2026-10-09T00:00:00Z' })
  f.threads([
    stray,
    thread('global:u-me', {
      kind: 'global',
      podiumSessionId: 's-a' as never,
      turnRunning: true,
      lastTurnFailure: failure,
    }),
  ])
  expect(superagentThread(f.pool, 'global').thread).toMatchObject({
    id: 'global:u-me',
    turnRunning: true,
    lastTurnFailure: failure,
  })
  f.threads([
    stray,
    thread('global', { kind: 'global' }),
    thread('global:u-me', { kind: 'global' }),
  ])
  expect(superagentThread(f.pool, 'global').thread?.id).toBe('global')
})
it('keeps unrelated publications out of thread derivation and honors active-thread changes', async () => {
  const f = await fixture()
  await settle(f)
  const previous = superagentThread(f.pool, 'global').thread
  f.publish({ paletteOpen: true })
  await Promise.resolve()
  expect(superagentThread(f.pool, 'global').thread).toEqual(previous)
  f.publish({ superThreadId: 'global' as Store['superThreadId'] })
  await Promise.resolve()
  expect(superagentState(f.pool).activeSessionId).toBe('s-a')
})
it('keeps booting tied to server session presence while optimistic store sessions exist', async () => {
  const f = await fixture()
  vi.spyOn(f.owner.replica, 'getCursor').mockReturnValue(null)
  await settle(f)
  expect(f.state.sessions.length).toBeGreaterThan(0)
  expect(superagentState(f.pool).booting).toBe(true)
  f.rows.mockImplementation((kind) => (kind === 'sessions' ? (f.state.sessions as never) : []))
  // Server rows arrive with their addresses (POD-5433: no whole publication).
  f.batch('sessions', f.state.sessions[0]?.sessionId ?? '')
  await Promise.resolve()
  expect(superagentState(f.pool).booting).toBe(false)
})
it('orders numeric event ids, caps the tail and updates only addressed event rows', async () => {
  const f = await fixture()
  await settle(f)
  expect(superagentFeed(f.pool).events.map((row) => row.id)).toEqual([9, 99, 100])
  const scans = f.source.counts.eventCollections
  const many = Array.from({ length: 120 }, (_, index) => event(index + 1))
  f.publish({ issueEvents: many })
  f.replace()
  await Promise.resolve()
  expect(superagentFeed(f.pool).events.map((row) => row.id)).toEqual(
    Array.from({ length: 40 }, (_, index) => index + 81),
  )
  many.push(event(121))
  f.batch('issueEvents', many.at(-1)!.id)
  expect(superagentFeed(f.pool).events.at(-1)?.id).toBe(121)
  expect(f.source.counts.eventCollections).toBe(scans + 1)
  many.shift()
  f.batch('issueEvents', event(1).id)
  expect(omitGone(f.pool.row('superagentEvent', event(1).id))).toBeUndefined()
})
it('keeps the legacy 40-event tail through addressed changes, reading only the window at 1x and 4x history', async () => {
  const reads: number[] = [],
    seed = { value: 7 }
  const shuffle = <T>(values: T[]) => {
    for (let index = values.length - 1; index > 0; index--) {
      seed.value = (seed.value * 1103515245 + 12345) % 2147483648
      const other = seed.value % (index + 1)
      ;[values[index], values[other]] = [values[other]!, values[index]!]
    }
    return values
  }
  for (const size of [150, 600]) {
    const f = await fixture()
    await settle(f)
    f.publish({
      issueEvents: shuffle(Array.from({ length: size }, (_, index) => event(index + 1))),
    })
    const row = vi.spyOn(f.owner.replica, 'row'),
      events = () => row.mock.calls.filter(([kind]) => kind === 'issueEvents').length
    f.replace()
    await settle(f)
    expect(checkSuperagent(f.pool, f.state)).toMatchObject({ differences: 0, first: null })
    reads.push(events())
    const change = async (next: IssueEventWire[], id: string) => {
      f.publish({ issueEvents: next })
      f.batch('issueEvents', id)
      await settle(f)
      expect(checkSuperagent(f.pool, f.state)).toMatchObject({ differences: 0, first: null })
    }
    const newest = event(size + 10),
      member = issueEventRowId(size - 5, 'synthetic')
    await change([...f.state.issueEvents, newest], newest.id)
    await change([...f.state.issueEvents], newest.id)
    await change(
      f.state.issueEvents.filter((row) => row.id !== member),
      member,
    )
    await change(
      f.state.issueEvents.filter((row) => row.eventId !== 3),
      event(3).id,
    )
    await change([...f.state.issueEvents, event(size - 5)], member)
    await change(
      f.state.issueEvents.map((row) =>
        row.id === newest.id ? { ...row, kind: 'issue.reopened' } : row,
      ),
      newest.id,
    )
    await change(
      [
        ...f.state.issueEvents,
        { ...event(2), subject: 'second', id: issueEventRowId(2, 'second') },
      ],
      issueEventRowId(2, 'second'),
    )
    expect(superagentFeed(f.pool).events).toHaveLength(40)
    reads.push(events() - reads.at(-1)!)
  }
  // Initial demand reads 40 rows; addressed changes read their own row plus a refill of the window.
  expect(reads[0]).toBe(40)
  expect(reads[2]).toBe(reads[0])
  expect(reads[3]).toBe(reads[1])
})
it('borrows the per-principal read-position port, including another device advancing it', async () => {
  const f = await fixture()
  await settle(f)
  f.cursor({ lastEventId: 99, seenAt: '2026-10-03T00:00:00Z' })
  await Promise.resolve()
  expect(superagentCursor(f.pool).cursor.lastEventId).toBe(99)
  expect(f.owner.readPosition.advance).not.toHaveBeenCalled()
})
it('reuses notice payloads while preserving first-question insertion order', async () => {
  const f = await fixture()
  await settle(f)
  expect(superagentQuestion(f.pool, 's-a' as never).question?.id).toBe('z-first')
  const scans = f.source.counts.questionCollections
  f.publish({ pendingInteractions: f.state.pendingInteractions.slice(1) })
  f.batch('pendingInteractions', 'z-first')
  expect(superagentQuestion(f.pool, 's-a' as never).question?.id).toBe('a-second')
  expect(f.source.counts.questionCollections).toBe(scans)
})
it('batches addressed cold session loads without indexing cold session payloads', async () => {
  const f = await fixture()
  await settle(f)
  f.rows.mockClear()
  const cold = {
    sessionId: 'cold-private-session',
    cwd: '/synthetic',
    machineId: 'm',
    status: 'exited',
    archived: true,
    stoppedAt: '2025-01-01T00:00:00Z',
    createdAt: '2025-01-01T00:00:00Z',
    lastActiveAt: '2025-01-01T00:00:00Z',
  } as Store['sessions'][number]
  f.publish({ sessions: [...f.state.sessions, cold] })
  await Promise.resolve()
  f.pool.apply({
    type: 'update',
    rows: [{ kind: 'session', id: cold.sessionId, value: cold as never }],
  })
  f.load.mockClear()
  expect(omitGone(f.pool.row('session', cold.sessionId))).toBe(LOADING)
  expect(omitGone(f.pool.row('session', cold.sessionId))).toBe(LOADING)
  expect(f.pool.tables.session.has(cold.sessionId)).toBe(false)
  expect(f.rows.mock.calls.some(([kind]) => kind === 'sessions')).toBe(false)
  expect(f.load).not.toHaveBeenCalled()
  expect(f.pool.hydrate()).toBe(1)
  expect(f.load).toHaveBeenCalledTimes(1)
  expect(omitGone(f.pool.row('session', cold.sessionId))).toMatchObject({ cwd: '/synthetic' })
  expect(omitGone(f.pool.row('session', 'known-absent'))).toBeUndefined()
})
it('releases all scoped state and subscriptions, including an already queued demand', async () => {
  const f = await fixture()
  superagentState(f.pool)
  f.pool.dispose()
  await Promise.resolve()
  expect(f.source.counts.batches).toBe(0)
  expect(f.source.read('superagentLocal', 'local')).toBe(LOADING)
  expect(f.listeners()).toBe(0)
})
it('reports planted errors in every settled differential section without hiding them behind pending', async () => {
  const f = await fixture()
  await settle(f)
  const wrong = [
    {
      superagentThreads: [
        { ...f.state.superagentThreads[0]!, turnRunning: true },
        ...f.state.superagentThreads.slice(1),
      ],
    },
    { superThreadId: 'global' },
    { issueEvents: [event(101)] },
    { readPosition: { get: () => ({ lastEventId: 0, seenAt: null }) } },
    { selectedWorktree: '/wrong' },
    { pendingInteractions: [] },
  ]
  for (const patch of wrong)
    expect(checkSuperagent(f.pool, { ...f.state, ...patch } as Store).differences).toBeGreaterThan(
      0,
    )
})
