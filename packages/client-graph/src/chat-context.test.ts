import { omitGone } from './lookup'
import { afterEach, expect, it, vi } from 'vitest'
import { dedupeSessionsByResume } from '@podium/model'
import { autorun, observable, runInAction } from 'mobx'
import { chatContextReadStats, chatReferenceSessions, createChatContextReader, chatMentionMatches } from './chat-context'
import { CHAT_CONTEXT_SUMMARIES } from './chat-context-schema'
import { createMobileSessionReader } from './mobile-session-context'
import { MOBILE_SESSION_SUMMARIES } from './mobile-session-schema'
import { MobxPool } from './pool'
import { LOADING } from './worklist/rollup'

const pools: MobxPool[] = []
afterEach(() => {
  for (const pool of pools.splice(0)) pool.dispose()
  vi.restoreAllMocks()
})

function fixture(size = 2, resident = false, summaries: { session: readonly string[]; issue: readonly string[] } = CHAT_CONTEXT_SUMMARIES) {
  const issues = ['first', 'second', 'deleted'].map((id, index) => ({
    id, seq: index + 1, title: 'Matching task', repoId: 'repo', repoPath: '/synthetic',
    stage: resident ? 'in_progress' : 'done', archived: !resident, deletedAt: id === 'deleted' ? '2020-01-01T00:00:00Z' : undefined,
    closedAt: resident ? undefined : '2020-01-01T00:00:00Z', createdAt: '2020-01-01T00:00:00Z', updatedAt: '2020-01-01T00:00:00Z',
  }))
  const sessions = Array.from({ length: size }, (_, index) => ({
    sessionId: ['first-session', 'second-session'][index] ?? `session-${index}`,
    issueId: issues[resident ? 0 : index % issues.length]!.id, cwd: '/synthetic',
    title: ['first-session', 'second-session'][index] ?? `session-${index}`,
    agentKind: 'codex', status: resident ? 'live' : 'exited', archived: !resident, headless: false,
    lastActiveAt: '2020-01-01T00:00:00Z', stoppedAt: '2020-01-01T00:00:00Z',
    resume: { kind: 'codex', value: `native-${index}` },
  }))
  const load = vi.fn((entity: string, id: string) => entity === 'issue'
    ? issues.find(row => row.id === id) : sessions.find(row => row.sessionId === id))
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse('2026-10-03T00:00:00Z') }, undefined, {
    load, summaries, schedule: () => () => {},
  })
  pools.push(pool)
  pool.apply({ type: 'replace', rows: [
    { kind: 'worktree', id: '/synthetic', value: {
      path: '/synthetic', repoId: 'repo', repoPath: '/synthetic', repoName: 'Synthetic', prefix: 'POD',
    } },
    ...issues.map(value => ({ kind: 'issue' as const, id: value.id, value })),
    ...sessions.map(value => ({ kind: 'session' as const, id: value.sessionId, value })),
  ] })
  const order = observable.box<readonly string[]>(sessions.map(row => row.sessionId).reverse(), { deep: false })
  pool.sources.register(['chatIssueOrder', 'chatSessionOrder'], {
    read: entity => ({ ids: entity === 'chatIssueOrder'
      ? ['second', 'first', 'deleted'] : order.get() }),
    dispose() {},
  })
  return { pool, load, sessions, order }
}

it.each([false, true])('shares observed references and checks only changed %s-resident rows at 1x/4x', resident => {
  for (const size of [32, 128]) {
    const { pool, sessions, load } = fixture(size, resident)
    const reader = createChatContextReader(pool)
    const secondReader = createChatContextReader(pool)
    pool.sources.register(['chatContextReader'], { read: () => reader, dispose() {} })
    const seen: ReturnType<typeof chatReferenceSessions>[] = []
    const runs = Array<number>(6).fill(0)
    expect(reader.counts.referenceBuilds).toBe(0)
    const stops = runs.map((_, index) => autorun(() => {
      runs[index] = runs[index]! + 1
      seen[index] = index % 2 ? secondReader.sessions() : chatReferenceSessions(pool)
    }))
    try {
      const initial = seen[0]!
      expect(initial.pending).toBe(0)
      expect(pool.tables.session.size).toBe(resident ? size : 0)
      expect(initial.sessions.map(row => row.sessionId)).toEqual(sessions.map(row => row.sessionId).reverse())
      // Counts belong to the shared computation, rather than each panel.
      expect(reader.counts.referenceBuilds + secondReader.counts.referenceBuilds).toBe(1)
      expect(reader.counts.referenceSessionReads + secondReader.counts.referenceSessionReads).toBe(size)
      expect(seen.every(value => value === initial)).toBe(true)
      const publish = (patch: object) => pool.apply({ type: 'update', rows: [{
        kind: 'session', id: sessions[0]!.sessionId, value: { ...sessions[0]!, ...patch } as never,
      }] })
      for (let n = 1; n <= 10; n++) publish({
        agentState: { phase: 'working', since: '2026-10-03T00:00:00Z', workingMsTotal: n },
        queuedMessageCount: n, lastInputAt: `background-${n}`,
        resume: { ...sessions[0]!.resume },
      })
      expect(seen.every(value => value === initial)).toBe(true)
      expect(runs).toEqual([1, 1, 1, 1, 1, 1])
      expect(reader.counts.referenceBuilds + secondReader.counts.referenceBuilds).toBe(1)
      expect(reader.counts.referenceSessionReads + secondReader.counts.referenceSessionReads).toBe(size + 10)
      publish({ title: 'Renamed reference' })
      const renamed = seen[0]!
      expect(renamed.sessions.at(-1)?.title).toBe('Renamed reference')
      expect(renamed.sessions[0]).toBe(initial.sessions[0])
      expect(seen.every(value => value === renamed)).toBe(true)
      expect(runs).toEqual([2, 2, 2, 2, 2, 2])
      expect(reader.counts.referenceBuilds + secondReader.counts.referenceBuilds).toBe(2)
      expect(reader.counts.referenceSessionReads + secondReader.counts.referenceSessionReads).toBe(size + 11)
      expect(pool.hydrate()).toBe(0)
      expect(load).not.toHaveBeenCalled()
      for (const stop of stops) stop()
      publish({ title: 'Changed while closed' })
      expect(reader.counts.referenceBuilds + secondReader.counts.referenceBuilds).toBe(2)
      expect(reader.counts.referenceSessionReads + secondReader.counts.referenceSessionReads).toBe(size + 11)
      // Reopening observes real data without keeping closed projections alive.
      const reopen = autorun(() => { seen[0] = reader.sessions() })
      try {
        expect(seen[0]!.sessions.at(-1)?.title).toBe('Changed while closed')
        expect(reader.counts.referenceBuilds + secondReader.counts.referenceBuilds).toBe(3)
        expect(reader.counts.referenceSessionReads + secondReader.counts.referenceSessionReads).toBe(size * 2 + 11)
      } finally { reopen() }
    } finally { for (const stop of stops) stop() }
  }
})

it('updates reference fields, ordering, resume ranking and membership without stale data', () => {
  const { pool, sessions, order } = fixture()
  let seen!: ReturnType<typeof chatReferenceSessions>
  const stop = autorun(() => { seen = chatReferenceSessions(pool) })
  const publish = (index: number, patch: object) => {
    sessions[index] = { ...sessions[index]!, ...patch }
    pool.apply({ type: 'update', rows: [{ kind: 'session', id: sessions[index]!.sessionId, value: sessions[index]! as never }] })
  }
  try {
    publish(0, { refRepoId: 'repo', refSeq: 1, refLetter: 'A', cwd: '/moved', issueId: 'second', name: 'Named reference', agentKind: 'shell' })
    expect(seen.sessions[1]).toMatchObject({ displayRef: 'POD-1-A', cwd: '/moved', issueId: 'second', name: 'Named reference', agentKind: 'shell' })
    pool.apply({ type: 'update', rows: [{ kind: 'worktree', id: '/synthetic', value: {
      path: '/synthetic', repoId: 'repo', repoPath: '/synthetic', prefix: 'RENAMED',
    } as never }] })
    expect(seen.sessions[1]?.displayRef).toBe('RENAMED-1-A')
    runInAction(() => order.set(['first-session', 'second-session']))
    expect(seen.sessions.map(row => row.sessionId)).toEqual(['first-session', 'second-session'])
    publish(0, { resume: { kind: 'codex', value: 'shared-native' } })
    publish(1, { resume: { kind: 'codex', value: 'shared-native' }, lastActiveAt: '2021-01-01T00:00:00Z' })
    expect(seen.sessions.map(row => row.sessionId)).toEqual(['second-session'])
    publish(0, { lastActiveAt: '2022-01-01T00:00:00Z' })
    expect(seen.sessions.map(row => row.sessionId)).toEqual(['first-session'])
    publish(1, { status: 'live', archived: false })
    expect(seen.sessions.map(row => row.sessionId)).toEqual(['first-session', 'second-session'])
    expect(seen.sessions[1]).toMatchObject({ status: 'live', archived: false })
    publish(1, { status: 'exited', headless: true })
    expect(seen.sessions.map(row => row.sessionId)).toEqual(['first-session', 'second-session'])
    pool.apply({ type: 'update', rows: [{ kind: 'session', id: 'first-session', value: undefined }] })
    expect(seen.sessions.map(row => row.sessionId)).toEqual(['second-session'])
    publish(0, { title: 'Readmitted' })
    expect(seen.sessions.map(row => row.sessionId)).toEqual(['first-session', 'second-session'])
    expect(seen.sessions[0]?.title).toBe('Readmitted')
    pool.apply({ type: 'replace', rows: [{ kind: 'session', id: 'replacement', value: { ...sessions[0]!, sessionId: 'replacement' } as never }] })
    expect(seen.sessions.map(row => row.sessionId)).toEqual(['replacement'])
  } finally { stop() }
})

// The previous reader's algorithm, retained only as a same-fixture oracle.
function previousReferenceSessions(pool: MobxPool) {
  const order = omitGone(pool.row('chatSessionOrder', 'order'))
  const sessions: import('@podium/client-core/session-values').SessionView[] = []
  let pending = typeof order === 'symbol' ? 1 : 0
  if (!order || typeof order === 'symbol') return { sessions, pending }
  const known = pool.queries.ids({ kind: 'referenceSessions' }), present = new Set(known)
  for (const id of new Set([...order.ids.filter(id => present.has(id)), ...known])) {
    const row = omitGone(pool.row('session', id, 'summary-fields'))
    if (typeof row === 'symbol') pending++
    else if (row) sessions.push(row as unknown as import('@podium/client-core/session-values').SessionView)
  }
  return { sessions: dedupeSessionsByResume(sessions), pending }
}

it('matches the previous reference answers through field, rank, order and membership changes', () => {
  const { pool, sessions, order } = fixture()
  let current!: ReturnType<typeof chatReferenceSessions>
  const stop = autorun(() => { current = chatReferenceSessions(pool) })
  const fields = (result: ReturnType<typeof chatReferenceSessions>) => ({
    pending: result.pending,
    sessions: result.sessions.map(row => Object.fromEntries(CHAT_CONTEXT_SUMMARIES.session.map(key => [key, row[key]]))),
  })
  const parity = () => {
    const assertSame = (answer: typeof current) => expect(fields(answer)).toEqual(fields(previousReferenceSessions(pool)))
    assertSame(current)
    // The same comparison must reject a deliberately wrong new answer.
    const wrong = { ...current, sessions: current.sessions.map((row, index) => index ? row : { ...row, title: 'Wrong reference answer' }) }
    expect(() => assertSame(wrong)).toThrow()
  }
  const publish = (index: number, patch: object) => {
    sessions[index] = { ...sessions[index]!, ...patch }
    pool.apply({ type: 'update', rows: [{ kind: 'session', id: sessions[index]!.sessionId, value: sessions[index]! as never }] })
    parity()
  }
  try {
    parity()
    publish(0, { title: 'Renamed', refRepoId: 'repo', refSeq: 8, refLetter: 'B', name: 'Named', cwd: '/new', issueId: 'second' })
    publish(0, { resume: { kind: 'codex', value: 'shared' } })
    publish(1, { resume: { kind: 'codex', value: 'shared' }, lastActiveAt: '2021-01-01T00:00:00Z' })
    publish(0, { lastActiveAt: '2022-01-01T00:00:00Z' })
    publish(1, { status: 'live', archived: false, headless: true, agentKind: 'shell' })
    runInAction(() => order.set(['first-session', 'second-session']))
    parity()
    pool.apply({ type: 'update', rows: [{ kind: 'session', id: 'first-session', value: undefined }] })
    parity()
    publish(0, { title: 'Readmitted' })
    pool.apply({ type: 'replace', rows: [{ kind: 'session', id: 'replacement', value: { ...sessions[0]!, sessionId: 'replacement' } as never }] })
    parity()
  } finally { stop() }
})

it('preserves richer mobile roster fields while chat references ignore unrelated status details', () => {
  const { pool, sessions } = fixture(2, true, MOBILE_SESSION_SUMMARIES)
  const mobile = createMobileSessionReader(pool)
  let chat!: ReturnType<typeof chatReferenceSessions>, roster!: ReturnType<typeof mobile.sessions>
  const stopChat = autorun(() => { chat = chatReferenceSessions(pool) })
  const stopMobile = autorun(() => { roster = mobile.sessions() })
  try {
    const initialChat = chat
    pool.apply({ type: 'update', rows: [{ kind: 'session', id: sessions[0]!.sessionId, value: {
      ...sessions[0]!, agentState: { phase: 'working' }, agentColor: '#336699', busy: true,
    } as never }] })
    expect(chat).toBe(initialChat)
    expect(roster.sessions[1]).toMatchObject({ agentState: { phase: 'working' }, agentColor: '#336699', busy: true })
  } finally { stopChat(); stopMobile() }
})

it('constructs no mention candidates until demand, then preserves candidates and replica order using fields only', () => {
  const { pool, load } = fixture()
  const row = vi.spyOn(pool, 'row'), summary = vi.spyOn(pool.residency!, 'summary')
  const reader = createChatContextReader(pool)
  pool.sources.register(['chatContextReader'], { read: () => reader, dispose() {} })
  expect(row).not.toHaveBeenCalled()
  expect(chatContextReadStats(pool)).toEqual({
    mentionBuilds: 0, mentionIssueReads: 0, referenceBuilds: 0, referenceSessionReads: 0,
  })
  const mentions = reader.mentions()
  expect(mentions.pending).toBe(0)
  expect(mentions.issues.map(({ id, seq, title, archived, displayRef }) => ({ id, seq, title, archived, displayRef }))).toEqual([
    { id: 'second', seq: 2, title: 'Matching task', archived: true, displayRef: 'POD-2' },
    { id: 'first', seq: 1, title: 'Matching task', archived: true, displayRef: 'POD-1' },
  ])
  expect(reader.sessions()).toMatchObject({ pending: 0, sessions: [
    { sessionId: 'second-session' }, { sessionId: 'first-session' },
  ] })
  expect(chatContextReadStats(pool)).toMatchObject({
    mentionBuilds: 1, mentionIssueReads: 3, referenceBuilds: 1, referenceSessionReads: 2,
  })
  expect(summary.mock.calls.length).toBeGreaterThan(0)
  expect(summary.mock.calls.every(([, , decorate]) => decorate === false)).toBe(true)
  expect(row.mock.calls.filter(([entity]) => entity === 'issue' || entity === 'session')
    .every(([, , purpose]) => purpose === 'summary-fields' || purpose === 'mark')).toBe(true)
  expect(pool.tables.issue.size).toBe(0)
  expect(pool.tables.session.size).toBe(0)
  expect(pool.hydrate()).toBe(0)
  expect(load).not.toHaveBeenCalled()
})

it('keeps a known missing mention summary pending and coalesces its batched load', () => {
  const { pool, load } = fixture()
  const reader = createChatContextReader(pool)
  const summary = pool.residency!.summary.bind(pool.residency!)
  vi.spyOn(pool.residency!, 'summary').mockImplementation((entity, id, decorate) =>
    entity === 'issue' && id === 'first' ? undefined : summary(entity, id, decorate))
  expect(reader.issue('first')).toBe(LOADING)
  expect(reader.mentions()).toMatchObject({ pending: 1, issues: [{ id: 'second' }] })
  expect(reader.mentions().pending).toBe(1)
  expect(load).not.toHaveBeenCalled()
  expect(pool.hydrate()).toBe(1)
  expect(load).toHaveBeenCalledTimes(1)
  expect(reader.mentions()).toMatchObject({ pending: 0, issues: [{ id: 'second' }, { id: 'first' }] })
})


it('reads at most five source-ranked mention summaries on first/repeated 1x/4x histories, with no order catalog', () => {
  const work: number[] = []
  for (const size of [64, 256]) {
    const stamp = '2026-10-05T00:00:00Z', pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
    pools.push(pool)
    pool.apply({ type: 'replace', rows: Array.from({ length: size + 8 }, (_, i) => ({ kind: 'issue' as const, id: `issue-${i}`,
      value: { id: `issue-${i}`, seq: i, stage: 'in_progress', title: i < 8 ? 'Unique result' : 'Unrelated issue', repoPath: '/synthetic',
        createdAt: stamp, updatedAt: i < 8 ? stamp : '2020-01-01T00:00:00Z' },
    })) })
    const rows = vi.spyOn(pool, 'row')
    for (let n = 0; n < 2; n++) {
      rows.mockClear()
      const result = chatMentionMatches(pool, 'unique')
      expect(result.pending).toBe(0)
      expect(result.issues.map(issue => issue.seq)).toEqual([7, 6, 5, 4, 3])
      expect(rows.mock.calls.some(([kind]) => String(kind) === 'chatIssueOrder')).toBe(false)
      const summaries = rows.mock.calls.filter(([kind]) => kind === 'issue')
      expect(summaries).toHaveLength(5)
      expect(summaries.every(([, , purpose]) => purpose === 'summary-fields' || purpose === 'mark')).toBe(true)
      work.push(summaries.length)
    }
  }
  expect(work).toEqual([5, 5, 5, 5])
  console.info('POD-5569 mention summary reads [1x first,repeat;4x first,repeat]', work)
})
