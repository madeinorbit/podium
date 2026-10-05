import type { ReplicaAddressedBatch, ReplicaKind } from '@podium/client-core/replica'
import { observe } from 'mobx'
import type { ColdIndex } from './cold-index'
import type { PendingOverlay } from '@podium/client-core/command-reducers'
import { afterEach, expect, it, vi } from 'vitest'
import { createWorklistPool } from '../create'
import { fixedLocals } from './locals-source'
import { createRowSource, type RowSourceOptions, type RowSourceReplica } from './row-source'
import type { RowSourceEvent } from './source'

function fixture(options: RowSourceOptions = { mode: 'truth' }) {
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
    update(...ids: string[]) {
      addressed({ type: 'update', rows: ids.map((id) => ({ kind: 'sessions', id })) })
    },
  }
}

afterEach(() => vi.restoreAllMocks())

it('counts a throwing pool listener and replaces the half-applied pool on the next flush', () => {
  const f = fixture()
  for (const id of ['a', 'b', 'c']) f.session(id, 'before')
  const handle = createWorklistPool(
    f.source.source,
    fixedLocals({ selectedIssueId: null, coarseNow: 0 }).source,
  )
  const error = new Error('planted listener failure')
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
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
    expect(log).toHaveBeenCalledWith('[pool feed] listener:update failed', error)
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
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
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
    expect(log).toHaveBeenCalledTimes(1)
  } finally {
    f.source.dispose()
  }
})

it('counts every failure, logs once per event kind, and bounds a failing recovery', () => {
  const queued: (() => void)[] = []
  vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((callback) => {
    queued.push(callback)
  })
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
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
    expect(log).toHaveBeenCalledTimes(2)
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
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
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
    expect(log).toHaveBeenCalledWith('[pool feed] cold-index:update failed', error)
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
    mode: 'pooled',
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
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
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
  expect(log).toHaveBeenCalledTimes(1)
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
