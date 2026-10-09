import { omitGone } from './lookup'
import { headerEntities } from './header-entities'
import type { ClientRuntime } from '@podium/client-core/engine'
import type { ReferenceState as Store } from '../../../tests/worklist/diagnostics/reference-state'
import type { ReplicaAddressedBatch } from '@podium/client-core/replica'
import { autorun, runInAction } from 'mobx'
import { expect, it, vi } from 'vitest'
import { asSessionId } from '@podium/model'
import { checkNotices } from '../../../tests/worklist/diagnostics/notice-check'
import { noticeFixture } from '../../../tests/worklist/diagnostics/notice-fixture'
import { MobxPool } from './pool'
import { NOTICE_ENTITIES, NOTICE_SUMMARIES } from './notice-schema'
import { NoticeSource } from './notice-source'
import { noticeInteractions, noticeMessages, noticeRecovery } from './notice-views'
import { LOADING } from './worklist/rollup'

function fixture() {
  const data = noticeFixture()
  Object.assign(data.sessions[1]!, { issueId: 'notice-archived', privateBody: 'Not a declared summary field' })
  let messages = data.messages, interactions = data.interactions, deadLetters = data.deadLetters
  const listeners = new Set<(batch: ReplicaAddressedBatch) => void>(), outboxListeners = new Set<() => void>()
  const rows = vi.fn((kind: string) => kind === 'messageRecords' ? messages : interactions)
  const runtime = {
    replica: { rows, row: (kind: string, id: string) => (kind === 'messageRecords' ? messages : interactions).find(row => row.id === id),
      subscribeAddressedBatch: (listener: (batch: ReplicaAddressedBatch) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } } },
    outbox: { deadLetters: () => deadLetters, subscribe: (listener: () => void) => { outboxListeners.add(listener); return () => { outboxListeners.delete(listener) } } },
  } as unknown as Pick<ClientRuntime, 'replica' | 'outbox'>
  const pool = new MobxPool({ coarseNow: Date.parse('2026-10-01T13:00:00Z'), selectedIssueId: null }, undefined,
    { load: (_entity, id) => data.sessions.find(row => row.sessionId === id) as never, summaries: NOTICE_SUMMARIES, schedule: () => () => {} })
  pool.apply({ type: 'replace', rows: [
    ...data.sessions.map(row => ({ kind: 'session' as const, id: row.sessionId, value: row as never })),
    { kind: 'issue', id: 'notice-archived', value: { id: 'notice-archived', seq: 1, stage: 'done', archived: true,
      title: 'Archived synthetic task', createdAt: '2020-01-01T00:00:00Z', updatedAt: '2020-01-01T00:00:00Z',
      repoPath: '/synthetic', deps: [] } as never },
  ] })
  headerEntities(pool).apply([{ kind: 'window', id: 'window', value: { view: 'workspace', paneA: null, fileTabs: [], outboxSize: 3 } }])
  const source = new NoticeSource(runtime)
  pool.sources.register(NOTICE_ENTITIES, source)
  const state = () => ({ messageRecords: messages, sessions: data.sessions, pendingInteractions: interactions, outboxDeadLetters: deadLetters, outboxSize: 3 }) as Store
  const check = () => runInAction(() => checkNotices(pool, state(), ['synthetic-session-0', 'other-session']))
  let stopWatching: (() => void) | undefined
  const dispose = pool.dispose.bind(pool)
  pool.dispose = () => { stopWatching?.(); dispose() }
  const load = async () => {
    // Mounted demand retains answers; imperative differential reads do not.
    stopWatching ??= autorun(() => { noticeMessages(pool); noticeRecovery(pool); noticeInteractions(pool, 'synthetic-session-0') })
    await Promise.resolve(); pool.hydrate(); return check()
  }
  return { pool, source, data, rows, check, load, state, listeners, outboxListeners,
    updateMessages(next: typeof messages, ids = next.map(row => row.id)) {
      messages = next
      for (const listener of listeners) listener({ type: 'update', rows: ids.map(id => ({ kind: 'messageRecords', id })) })
    },
    updateAsks(next: typeof interactions, ids = next.map(row => row.id)) {
      interactions = next
      for (const listener of listeners) listener({ type: 'update', rows: ids.map(id => ({ kind: 'pendingInteractions', id })) })
    },
    replaceEmpty() { messages = []; interactions = []; for (const listener of listeners) listener({ type: 'replace', reason: 'rescope' }) },
    outbox(next: typeof deadLetters) { deadLetters = next; for (const listener of outboxListeners) listener() },
  }
}

it('coalesces initial LOADING demand and matches messages, all asks and parked input', async () => {
  const f = fixture()
  try {
    expect(omitGone(f.pool.row('noticeCatalog', 'catalog'))).toBe(LOADING)
    expect(omitGone(f.pool.row('noticeSession', 'synthetic-session-0'))).toBe(LOADING)
    expect(f.rows).toHaveBeenCalledTimes(2)
    const result = await f.load()
    expect(result).toMatchObject({ differences: 0, pending: 0, positions: 20 })
    expect(f.source.counts).toMatchObject({ batches: 1, collectionReads: 2, outboxReads: 1 })
  } finally { f.pool.dispose() }
})

it('maintains session membership, ordering and removal from addressed deltas', async () => {
  const f = fixture()
  try {
    await f.load()
    const stop = autorun(() => { noticeMessages(f.pool); noticeInteractions(f.pool, 'synthetic-session-0') })
    f.updateMessages(f.data.messages.map(row => row.id === 'notice-message-0' ? { ...row, status: 'confirmed' } : row))
    f.updateAsks(f.data.interactions.map((row, i) => i === 0 ? { ...row, sessionId: asSessionId('other-session') } : row))
    expect(f.check()).toMatchObject({ differences: 0, pending: 0 })
    f.updateAsks(f.data.interactions.slice(1), ['notice-ask-0'])
    expect(omitGone(f.pool.row('noticeSession', 'other-session'))).toBeUndefined()
    expect(f.check().differences).toBe(0)
    expect(f.source.counts.collectionReads).toBe(2)
    stop()
  } finally { f.pool.dispose() }
})

it('keeps only declared cold session label fields without loading their payload', async () => {
  const f = fixture()
  try {
    await f.load()
    expect(f.pool.tables.session.has('cold-notice-session')).toBe(false)
    const summary = omitGone(f.pool.row('session', 'cold-notice-session', 'summary'))
    expect(summary).toMatchObject({ title: 'Saved agent', cwd: '/synthetic/saved' })
    expect(summary).not.toHaveProperty('privateBody')
    expect(noticeMessages(f.pool).notices.find(row => row.messageId === 'notice-message-1')?.sessionLabel).toBe('Saved agent')
    expect(f.pool.hydrate()).toBe(0)
  } finally { f.pool.dispose() }
})

it('marks a missing cold label pending and batches repeated session loads', async () => {
  const f = fixture()
  try {
    await f.load()
    vi.spyOn(f.pool.residency!, 'summary').mockReturnValue(undefined)
    const first = noticeMessages(f.pool), second = noticeMessages(f.pool)
    expect(first.pendingIds).toEqual(['notice-message-1'])
    expect(second.pending).toBe(1)
    expect(f.pool.hydrate()).toBe(1)
  } finally { f.pool.dispose() }
})

it('preserves outbox order across message updates and never reads recovery targets', async () => {
  const f = fixture()
  try {
    await f.load()
    f.outbox([...f.data.deadLetters].reverse())
    await Promise.resolve()
    f.updateMessages(f.data.messages.map(row => ({ ...row, body: `${row.body}!` })))
    const read = vi.spyOn(f.pool, 'row')
    expect(noticeRecovery(f.pool).deadLetters).toEqual([...f.data.deadLetters].reverse())
    expect(read.mock.calls.every(([entity]) => ['noticeRecoveryCatalog', 'outboxDeadLetter'].includes(entity))).toBe(true)
    expect(f.check().differences).toBe(0)
    expect(f.rows.mock.calls.every(([kind]) => kind === 'messageRecords' || kind === 'pendingInteractions')).toBe(true)
  } finally { f.pool.dispose() }
})

it('clears a replacement scope and cancels a pending load on disposal', async () => {
  const f = fixture()
  await f.load()
  f.replaceEmpty()
  await Promise.resolve()
  expect(f.check().differences).toBe(0)
  expect(omitGone(f.pool.row('noticeSession', 'synthetic-session-0'))).toBeUndefined()
  f.pool.dispose()
  expect(f.listeners.size).toBe(0)
  expect(f.outboxListeners.size).toBe(0)
  const fresh = fixture()
  omitGone(fresh.pool.row('noticeCatalog', 'catalog'))
  fresh.pool.dispose()
  await Promise.resolve()
  expect(fresh.rows).toHaveBeenCalledTimes(2)
  expect(fresh.source.counts).toMatchObject({ batches: 0, payloadReads: 0, outboxReads: 0 })
})

it('detects a planted wrong value in each notice comparison section', async () => {
  const f = fixture()
  try {
    await f.load()
    const state = f.state()
    for (const wrong of [
      { ...state, messageRecords: state.messageRecords.slice(1) },
      { ...state, pendingInteractions: state.pendingInteractions.slice(1) },
      { ...state, outboxDeadLetters: state.outboxDeadLetters.slice(1) },
      { ...state, outboxSize: 99 },
    ]) expect(checkNotices(f.pool, wrong, ['synthetic-session-0']).differences).toBeGreaterThan(0)
  } finally { f.pool.dispose() }
})
