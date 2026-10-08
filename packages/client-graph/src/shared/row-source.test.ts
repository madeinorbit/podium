import { createRequire } from 'node:module'
import { EMPTY_PENDING } from '../../../../tests/worklist/shared/src/row-source'
import type { ReplicaAddressedBatch, ReplicaKind } from '@podium/client-core/replica'
import { addSink, resetLogging, type LogRecord } from '@podium/logger'
import { autorun, getDependencyTree, observe, Reaction } from 'mobx'
import { enableDebugNames } from '../debug-name'
import { IssueSessionFactsIndex, type IssueSessionFacts } from './issue-session-facts'
import type { ColdIndex } from './cold-index'
import type { PendingOverlay } from '@podium/client-core/command-reducers'
import { afterEach, expect, it, vi } from 'vitest'
import { createWorklistPool } from '../create'
import { fixedLocals } from './locals-source'
import { createRowSource, type RowSourceOptions, type RowSourceReplica } from './row-source'
import type { RowSourceEvent } from './source'

function fixture(options: RowSourceOptions = { pending: EMPTY_PENDING }) {
  const tables = new Map<ReplicaKind, Map<string, Record<string, unknown>>>()
  let addressed: (batch: ReplicaAddressedBatch) => void = () => {}
  const replica: RowSourceReplica = {
    row: (kind, id) => tables.get(kind)?.get(id),
    rows: vi.fn((kind: ReplicaKind) => [...(tables.get(kind)?.values() ?? [])]),
    subscribeAddressedBatch(listener) {
      addressed = listener
      return () => {
        addressed = () => {}
      }
    },
  }
  const repos: readonly never[] = []
  const source = createRowSource(
    {
      principal: { userId: 'operator' },
      readLocal: () => repos,
      onLocals: () => () => {},
    },
    replica,
    options,
  )
  function put(kind: ReplicaKind, id: string, value: Record<string, unknown>) {
    let table = tables.get(kind)
    if (!table) tables.set(kind, (table = new Map()))
    table.set(id, value)
  }
  function session(id: string, title: string) {
    put('sessions', id, { sessionId: id, title, status: 'running' })
  }
  return {
    source,
    replica,
    tables,
    put,
    session,
    replace() { addressed({ type: 'replace', reason: 'bootstrap' }) },
    update(...ids: string[]) {
      addressed({ type: 'update', rows: ids.map((id) => ({ kind: 'sessions', id })) })
    },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  resetLogging()
})

it.each([1, 4])('matches the old pending sweep through addressed edits and retirement at %sx', scale => {
  const maps = {
    sessions: new Map<string, readonly PendingOverlay[]>(),
    sessionUserStates: new Map<string, readonly PendingOverlay[]>(),
    issueProjections: new Map<string, readonly PendingOverlay[]>(),
    issueUserStates: new Map<string, readonly PendingOverlay[]>(),
  }
  const f = fixture({ pending: { byRow: kind => maps[kind] } })
  const held = new Map<string, unknown>()
  const stop = f.source.source.subscribe(event => {
    if (event.type === 'replace') held.clear()
    for (const row of event.rows) {
      if (row.value === undefined) held.delete(`${row.kind}:${row.id}`)
      else held.set(`${row.kind}:${row.id}`, row.value)
    }
  })
  // snapshot retains the old whole-kind pending resolver as the answer oracle.
  const parity = () => {
    const rebuilt = new Map<string, unknown>()
    for (const kind of ['session', 'issue'] as const)
      for (const row of f.source.source.snapshot(kind))
        if (row.value !== undefined) rebuilt.set(`${kind}:${row.id}`, row.value)
    expect(held).toEqual(rebuilt)
  }
  const edit = (entity: keyof typeof maps, id: string, patch: Record<string, unknown>) => {
    maps[entity].set(id, [{ op: 'patch', key: `${entity}:${id}`, entity, id, patch, coveredBy: () => false }])
    f.source.repaint([{ kind: entity.startsWith('session') ? 'session' : 'issue', id }])
    parity()
  }
  try {
    f.session('active', 'server')
    f.put('issueProjections', 'issue', { id: 'issue', title: 'server' })
    for (let i = 0; i < 32 * scale; i++) f.session(`pending-${i}`, 'server')
    f.replace(); f.source.flush(); parity()
    for (let i = 0; i < 32 * scale; i++) edit('sessions', `pending-${i}`, { title: 'pending' })
    edit('sessions', 'active', { title: 'painted' })
    edit('sessionUserStates', 'active', { readAt: '2026-10-08' })
    edit('issueProjections', 'issue', { title: 'painted issue' })
    edit('issueUserStates', 'issue', { snoozedUntil: '2026-10-10' })
    f.source.stats.reset()
    f.put('sessions', 'active', { sessionId: 'active', title: 'server', status: 'running', lastActiveAt: '2026-10-09' })
    f.update('active'); f.source.flush()
    console.info('[pending heartbeat]', JSON.stringify({ scale, rowsVisited: f.source.stats.rowsVisited }))
    expect(f.source.stats.rowsVisited).toBe(1)
    parity()
    for (const entity of Object.keys(maps) as (keyof typeof maps)[]) {
      const id = entity.startsWith('session') ? 'active' : 'issue'
      maps[entity].delete(id)
      f.source.repaint([{ kind: entity.startsWith('session') ? 'session' : 'issue', id }])
      parity()
    }
    // A pending insert and its rollback have no feed row to name them.
    edit('sessions', 'insert', { sessionId: 'insert', title: 'inserted' })
    maps.sessions.delete('insert')
    f.source.repaint([{ kind: 'session', id: 'insert' }]); parity()
    f.tables.get('sessions')!.delete('active')
    f.update('active'); f.source.flush(); parity()
  } finally { stop(); f.source.dispose() }
})

/** Feed failures log through @podium/logger (no console sink in tests), so
 * collect the records instead of spying on console.error. */
function collectFeedLogs() {
  const seen: LogRecord[] = []
  addSink({
    name: 'row-source-test',
    write: (record) => {
      seen.push(record)
    },
  })
  return seen
}

function expectFeedLogged(seen: LogRecord[], msg: string, error: unknown) {
  expect(seen).toHaveLength(1)
  expect(seen[0]).toMatchObject({
    level: 'error',
    ns: 'client-graph:feed-diagnostics',
    msg,
  })
  expect(seen[0]?.error).toBe(error)
}

it('counts a throwing pool listener and replaces the half-applied pool on the next flush', () => {
  const f = fixture()
  for (const id of ['a', 'b', 'c']) f.session(id, 'before')
  const handle = createWorklistPool(
    f.source.source,
    fixedLocals({ selectedIssueId: null, coarseNow: 0 }).source,
  )
  const error = new Error('planted listener failure')
  const seen = collectFeedLogs()
  let fail = true
  const stop = observe(handle.pool.tables.session, (change) => {
    if (change.name === 'b' && fail) {
      fail = false
      throw error
    }
  })
  const events: RowSourceEvent[] = []
  f.source.source.subscribe((event) => events.push(event))
  try {
    for (const id of ['a', 'b', 'c']) f.session(id, 'after')
    f.update('a', 'b', 'c')
    expect(f.source.flush()?.type).toBe('update')
    expect(handle.pool.row('session', 'a')).toMatchObject({ title: 'after' })
    expect(handle.pool.row('session', 'c')).toMatchObject({ title: 'before' })
    expect(f.source.stats).toMatchObject({ applyErrors: 1 })
    expect(handle.pool.diagnostics).toBe(f.source.source.diagnostics)
    expect(handle.pool.diagnostics).toMatchObject({ errors: 1, resyncPending: true })
    expectFeedLogged(seen, '[pool feed] listener:update failed', error)
    expect(f.source.flush()?.type).toBe('replace')
    expect(handle.pool.row('session', 'c')).toMatchObject({ title: 'after' })
    expect(events.map((event) => event.type)).toEqual(['update', 'replace'])
    expect(f.source.flush()).toBeNull()
    expect(handle.pool.diagnostics).toMatchObject({ replaceResyncs: 1, resyncPending: false })
  } finally {
    stop()
    handle.dispose()
    f.source.dispose()
  }
})

it('automatically resyncs without another replica signal and keeps other listeners running', async () => {
  const f = fixture()
  const seen = collectFeedLogs()
  const events: RowSourceEvent[] = []
  f.source.source.subscribe(
    vi.fn().mockImplementationOnce(() => {
      throw new Error('one failure')
    }),
  )
  f.source.source.subscribe((event) => events.push(event))
  try {
    f.session('a', 'new')
    f.update('a')
    await Promise.resolve()
    expect(events.map((event) => event.type)).toEqual(['update'])
    await Promise.resolve()
    expect(events.map((event) => event.type)).toEqual(['update', 'replace'])
    expect(f.source.source.diagnostics).toMatchObject({
      errors: 1,
      replaceResyncs: 1,
      resyncPending: false,
    })
    expect(seen).toHaveLength(1)
  } finally {
    f.source.dispose()
  }
})

it('counts every failure, logs once per event kind, and bounds a failing recovery', () => {
  const queued: (() => void)[] = []
  vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((callback) => {
    queued.push(callback)
  })
  const seen = collectFeedLogs()
  const f = fixture()
  const events: RowSourceEvent[] = []
  const stop = f.source.source.subscribe(() => {
    throw new Error('persistent failure')
  })
  f.source.source.subscribe((event) => events.push(event))
  try {
    f.session('a', 'new')
    f.update('a')
    queued.shift()!()
    expect(queued).toHaveLength(1)
    queued.shift()!()
    expect(queued).toHaveLength(0)
    expect(f.source.source.diagnostics).toMatchObject({
      errors: 2,
      resyncPending: true,
      replaceResyncs: 1,
      counts: { 'listener:update': 1, 'listener:replace': 1 },
    })
    f.update('a')
    queued.shift()!()
    expect(queued).toHaveLength(0)
    expect(events.map((event) => event.type)).toEqual(['update', 'replace', 'replace'])
    expect(f.source.stats.applyErrors).toBe(3)
    expect(seen).toHaveLength(2)
    stop()
    expect(f.source.flush()?.type).toBe('replace')
    expect(f.source.source.diagnostics?.resyncPending).toBe(false)
    f.source.stats.reset()
    expect(f.source.stats.applyErrors).toBe(0)
    expect(f.source.source.diagnostics?.errors).toBe(3)
  } finally {
    f.source.dispose()
  }
})

it('explicitly reseeds a failed cold index from the next replace with all declared fields', () => {
  const f = fixture()
  f.session('a', 'before')
  const index = f.source.source.cold!({ session: ['title'] }) as ColdIndex
  const error = new Error('planted cold-index failure')
  const seen = collectFeedLogs()
  vi.spyOn(index, 'apply').mockImplementationOnce(() => {
    throw error
  })
  const listener = vi.fn()
  f.source.source.subscribe(listener)
  try {
    f.session('a', 'after')
    f.session('b', 'added')
    f.update('a', 'b')
    expect(f.source.flush()?.type).toBe('update')
    expect(f.source.stats.applyErrors).toBe(1)
    expectFeedLogged(seen, '[pool feed] cold-index:update failed', error)
    expect(listener).not.toHaveBeenCalled()
    expect(() => f.source.source.cold!()).toThrow(/awaiting replacement resync/)
    expect(f.source.flush()?.type).toBe('replace')
    const repaired = f.source.source.cold!()
    expect(repaired).not.toBe(index)
    expect(repaired.count('session')).toBe(2)
    expect(repaired.heldFields('session', 'a', ['title'])).toEqual({ title: 'after' })
    expect(listener.mock.calls.map(([event]) => event.type)).toEqual(['replace'])
    vi.mocked(f.replica.rows).mockClear()
    f.session('a', 'ordinary')
    f.update('a')
    f.source.stats.reset()
    expect(f.source.flush()?.type).toBe('update')
    expect(f.replica.rows).not.toHaveBeenCalled()
    expect(f.source.stats.enumerations).toBe(0)
    expect(repaired.heldFields('session', 'a', ['title'])).toEqual({ title: 'ordinary' })
  } finally {
    f.source.dispose()
  }
})

it('recovery includes pending optimism, removals, and rollback', () => {
  const overlays = new Map<string, readonly PendingOverlay[]>()
  const f = fixture({
        pending: { byRow: (kind) => (kind === 'sessions' ? overlays : new Map()) },
  })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  f.session('removed', 'before')
  f.session('a', 'server')
  const handle = createWorklistPool(
    f.source.source,
    fixedLocals({ selectedIssueId: null, coarseNow: 0 }).source,
  )
  f.source.source.subscribe(
    vi.fn().mockImplementationOnce(() => {
      throw new Error('fail')
    }),
  )
  try {
    f.update('a')
    f.source.flush()
    overlays.set('a', [
      {
        op: 'patch',
        key: 'edit',
        entity: 'sessions',
        id: 'a',
        patch: { title: 'optimistic' },
        coveredBy: () => false,
      },
    ])
    f.tables.get('sessions')!.delete('removed')
    expect(f.source.repaint([{ kind: 'session', id: 'a' }])?.type).toBe('replace')
    expect(handle.pool.row('session', 'a')).toMatchObject({ title: 'optimistic' })
    expect(handle.pool.row('session', 'removed')).toBeUndefined()
    overlays.clear()
    f.source.repaint([{ kind: 'session', id: 'a' }])
    expect(handle.pool.row('session', 'a')).toMatchObject({ title: 'server' })
  } finally {
    handle.dispose()
    f.source.dispose()
  }
})

it('disposal cancels queued recovery and a fresh principal has fresh diagnostics', async () => {
  const f = fixture()
  const seen = collectFeedLogs()
  const listener = vi.fn(() => {
    throw new Error('fail')
  })
  f.source.source.subscribe(listener)
  f.session('a', 'value')
  f.update('a')
  f.source.flush()
  f.source.dispose()
  await Promise.resolve()
  expect(listener).toHaveBeenCalledTimes(1)
  expect(seen).toHaveLength(1)
  expect(f.source.flush()).toBeNull()
  expect(f.source.source.diagnostics?.resyncPending).toBe(false)
  const fresh = fixture()
  try {
    expect(fresh.source.source.diagnostics).toMatchObject({
      errors: 0,
      counts: {},
      resyncPending: false,
    })
  } finally {
    fresh.source.dispose()
  }
})

// Kept reference to the pre-change rebuild. This is deliberately independent
// of the running maxima so removal, archive and rehome errors are observable.
function rebuiltFacts(rows: Iterable<Record<string, unknown>>, owner: string): IssueSessionFacts {
  let replicaActivityAt: string | undefined, tipActivityAt: string | undefined
  let headlessStaffed = false, headlessOccupied = false
  for (const row of rows) {
    if (row.issueId !== owner) continue
    const replica = row.agentKind === 'shell' ? undefined : row.lastActiveAt as string | undefined
    const tip = row.archived === true ? undefined : row.lastActiveAt as string | undefined
    if (replica && (!replicaActivityAt || replica > replicaActivityAt)) replicaActivityAt = replica
    if (tip && (!tipActivityAt || tip > tipActivityAt)) tipActivityAt = tip
    headlessStaffed ||= row.headless === true && row.archived !== true && row.status !== 'exited'
    headlessOccupied ||= row.headless === true && row.archived !== true
  }
  return { replicaActivityAt, tipActivityAt, headlessStaffed, headlessOccupied }
}
const fields = ['replicaActivityAt', 'tipActivityAt', 'headlessStaffed', 'headlessOccupied'] as const

it('matches the old owner-history rebuild on every activity and membership transition', () => {
  const f = fixture(), index = new IssueSessionFactsIndex()
  for (const id of ['one', 'two']) f.put('issueProjections', id, { id })
  const change = (id: string, row?: Record<string, unknown>) => {
    if (row) f.put('sessions', id, { sessionId: id, ...row })
    else f.tables.get('sessions')?.delete(id)
    index.install(id, row)
    f.update(id); f.source.flush()
    for (const owner of ['one', 'two']) {
      const expected = rebuiltFacts(f.tables.get('sessions')?.values() ?? [], owner)
      const actual = Object.fromEntries(fields.map(field => [field, index.read(owner, field)]))
      expect(actual).toEqual(expected)
      // Both the feed and standalone index must match the old rebuild.
      const published = Object.fromEntries(fields.map(field => [field, f.source.source.issueSessionFact!(owner, field)]))
      expect(published).toEqual(expected)
    }
  }
  const seat = { issueId: 'one', agentKind: 'codex', lastActiveAt: '2026-10-01', status: 'live' }
  try {
    change('a', seat)
    change('b', { ...seat, headless: true, lastActiveAt: '2026-10-02' })
    change('archived', { ...seat, archived: true, lastActiveAt: '2026-10-05' })
    change('shell', { ...seat, agentKind: 'shell', lastActiveAt: '2026-10-06' })
    change('a', { ...seat, lastActiveAt: '2026-10-07' })
    change('a', { ...seat, lastActiveAt: '2026-09-01' })
    change('b', { ...seat, headless: true, archived: true, lastActiveAt: '2026-10-02' })
    change('b', { ...seat, headless: true, status: 'exited', issueId: 'two', lastActiveAt: '2026-10-02' })
    change('shell', { ...seat, agentKind: 'codex', lastActiveAt: '2026-10-06' })
    change('shell')
    change('archived')
    change('a')
    change('b')
    change('a', seat)
    index.clear()
    expect(Object.fromEntries(fields.map(field => [field, index.read('one', field)]))).toEqual(rebuiltFacts([], 'one'))
  } finally { f.source.dispose() }
})

it.each([1, 4])('records heartbeat owner-history work and watched fields at %sx', scale => {
  enableDebugNames()
  const f = fixture()
  f.put('issueProjections', 'one', { id: 'one', title: 'Issue', stage: 'in_progress', audience: 'human', repoId: 'repo', worktreePath: '/synthetic',
    createdAt: '2026-01-01', updatedAt: '2026-10-01', deps: [] })
  f.put('repos', 'repo', { id: 'repo', path: '/synthetic', prefix: 'POD' })
  const row = { cwd: '/synthetic', sessionId: 'active', issueId: 'one', agentKind: 'codex', status: 'live', archived: false,
    lastActiveAt: '2026-10-07', agentState: { phase: 'working', since: '2026-10-01' } }
  for (let i = 0; i < 128 * scale; i++) f.put('sessions', `history-${i}`, {
    ...row, sessionId: `history-${i}`, archived: true, status: 'exited', lastActiveAt: '2026-01-01' })
  f.put('sessions', 'active', row)
  f.replace(); f.source.flush()
  const handle = createWorklistPool(f.source.source, fixedLocals({ selectedIssueId: 'one', coarseNow: Date.parse('2026-10-08') }).source)
  const issue = handle.pool.issueObject('one'), work = handle.pool.worklistRow('one')!
  const watcher = new Reaction('probe:issue-activity', () => {})
  watcher.track(() => { void issue.title; void issue.stage; void issue.memberLatestActivity;
    void work.unread; void work.openOwn; void work.tip; void work.rollup })
  const names = new Set<string>()
  const visit = (tree: ReturnType<typeof getDependencyTree>) => {
    if (/^(IssueModel|WorklistIssue)[@.]/.test(tree.name)) names.add(tree.name)
    for (const child of tree.dependencies ?? []) visit(child)
  }
  visit(getDependencyTree(watcher))
  const runtime = globalThis as unknown as { Bun?: { gc(force: boolean): void } }
  const heap = () => {
    if (!runtime.Bun) return process.memoryUsage().heapUsed
    runtime.Bun.gc(true)
    runtime.Bun.gc(true)
    return (createRequire(import.meta.url)('bun:jsc') as { heapStats(): { heapSize: number } }).heapStats().heapSize
  }
  const original = handle.pool.row('issue', 'one')
  let storedRuns = 0
  const stop = autorun(() => { void issue.title; void issue.stage; storedRuns++ })
  try {
    f.source.stats.reset()
    f.put('sessions', 'active', { ...row, lastActiveAt: '2026-10-09' })
    f.update('active')
    const event = f.source.flush()
    expect(f.source.stats).toMatchObject({ sessionFactsVisited: 1, sessionFactsRescanned: 0, sessionStaffingChanges: 0 })
    expect(event?.rows.filter(record => record.kind === 'issue')).toHaveLength(0)
    expect(handle.pool.row('issue', 'one')).toBe(original)
    expect(storedRuns).toBe(1)
    expect(issue.lastActivityAt).toBe('2026-10-09')
    console.info('[issue heartbeat]', JSON.stringify({ scale, stats: f.source.stats,
      issueRows: event?.rows.filter(record => record.kind === 'issue').length,
      rowReplaced: original !== handle.pool.row('issue', 'one'), storedRuns,
      watchedFields: names.size, heapBytes: heap(), heapSource: runtime.Bun ? 'JSC full-GC heapSize' : 'process heapUsed' }))
  } finally { stop(); watcher.dispose(); handle.dispose(); f.source.dispose() }
})
