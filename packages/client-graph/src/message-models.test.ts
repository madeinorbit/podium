import { createKernelReplica, createSideCache, memoryStorage } from '@podium/client-core/replica'
import { InMemoryReplicaStore } from '../../sync/src/replica/memory-store'
import { Replica as SyncReplica } from '../../sync/src/replica/replica'
import { ConformanceAuthority, conformanceUser, requireHuman } from '../../sync/src/conformance/authority'
import type { MessageNotice, PendingInteractionCard } from '@podium/client-core/values'
import { messageRecordRowId, interactionRowId, asSessionId, asThreadId, type MessageRecordWire, type MessageLedgerWire } from '@podium/model'
import type { ClientRuntime } from '@podium/client-core/engine'
import type { ReplicaAddressedBatch } from '@podium/client-core/replica'
import { BeforeSends } from '../../client-core/src/conversation/sends.before.test.fixture'
import { Sends } from '../../client-core/src/conversation/sends'
import { TranscriptLog } from '../../client-core/src/conversation/transcript-log'
import { autorun, reaction } from 'mobx'
import { afterEach, expect, it, vi } from 'vitest'
import { noticeFixture } from '../../../tests/worklist/diagnostics/notice-fixture'
import { chatInteractions, chatRecords } from './chat-context'
import { here } from './lookup'
import { currentMessageRecord, ingestLedgerMessages, ingestMessageRecords } from './message-models'
import { MessageLedger } from './message-ledger'
import { LedgerEntry } from './ledger-entry'
import * as beforeLedger from './ledger-entry.before.test.fixture'
import { MobxPool } from './pool'
import { NoticeSource } from './notice-source'
import { NOTICE_ENTITIES } from './notice-schema'
import * as before from './notice-views.before.test.fixture'
import { noticeMessages, noticeInteractions } from './notice-views'

const stamp = '2026-10-10T12:00:00.000Z'
const record = (patch: Partial<MessageRecordWire> = {}): MessageRecordWire => ({
  id: 'message', sessionId: asSessionId('seat'), senderUserId: 'user', body: 'first line\nsecond line',
  createdAt: stamp, status: 'failed', reason: 'delivery-failed', ...patch,
})
const ledgerRow = (patch: Partial<MessageLedgerWire> = {}): MessageLedgerWire => ({
  id: 'message', threadId: asThreadId('thread'), inReplyTo: null, from: 'user', to: 'session:seat',
  kind: 'message', urgency: 'next-turn', lifecycle: 'wait', body: record().body, createdAt: stamp,
  deliveryStatus: 'failed', ackedBy: null, deliveredAt: null, deliveredTo: null, expiresAt: null,
  clampedFrom: null, hop: 0, ...patch,
})
const messageAnswer = (row: MessageNotice) => ({
  messageId: row.messageId, sessionId: row.sessionId, sessionLabel: row.sessionLabel,
  excerpt: row.excerpt, status: row.status, createdAt: row.createdAt, line: row.line,
})
const cardAnswer = (row: PendingInteractionCard) => ({
  id: row.id, sessionId: row.sessionId, kind: row.kind, title: row.title, detail: row.detail,
  actions: row.actions, note: row.note, surface: row.surface,
})
function fixture(initial = [record()]) {
  const asks = noticeFixture('seat').interactions
  const records = new Map(initial.map(row => [row.id, row]))
  const listeners = new Set<(batch: ReplicaAddressedBatch) => void>()
  const pool = new MobxPool({ coarseNow: Date.parse(stamp), selectedIssueId: null })
  pool.apply({ type: 'replace', rows: [{ kind: 'session', id: 'seat', value: {
    sessionId: 'seat', name: 'Named agent', title: 'Title', cwd: '/repo', agentKind: 'codex', status: 'live',
  } }] })
  const runtime = {
    replica: { rows: (kind: string) => kind === 'messageRecords' ? [...records.values()] : asks,
      row: (kind: string, id: string) => kind === 'messageRecords' ? records.get(id) : asks.find(row => row.id === id),
      subscribeAddressedBatch: (listener: (batch: ReplicaAddressedBatch) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } } },
    outbox: { deadLetters: () => [], subscribe: () => () => {} },
  } as unknown as Pick<ClientRuntime, 'replica' | 'outbox'>
  const source = new NoticeSource(runtime)
  pool.sources.register(NOTICE_ENTITIES, source)
  const update = (row: MessageRecordWire) => {
    records.set(row.id, row)
    for (const listener of listeners) listener({ type: 'update', rows: [{ kind: 'messageRecords', id: row.id }] })
  }
  const replace = () => {
    for (const listener of listeners) listener({ type: 'replace', reason: 'rescope' })
  }
  return { pool, source, records, asks, update, replace }
}
const settle = async () => { for (let turn = 0; turn < 8; turn++) await Promise.resolve() }
afterEach(() => vi.useRealTimers())

it('matches old notice facts and all interaction card answers on identical fixtures; detects a wrong answer', async () => {
  const f = fixture(['failed', 'expired', 'unknown'].map((status, i) => record({ id: `message-${i}`, status: status as MessageRecordWire['status'], body: 'long '.repeat(30) })))
  try {
    before.noticeMessages(f.pool); before.noticeInteractions(f.pool, 'seat')
    await settle()
    const expected = before.noticeMessages(f.pool).notices.map(messageAnswer)
    const actual = noticeMessages(f.pool).notices.map(messageAnswer)
    expect(actual).toEqual(expected)
    expect(() => expect(actual.map(row => ({ ...row, excerpt: 'wrong' }))).toEqual(expected)).toThrow()
    const cards = noticeInteractions(f.pool, 'seat').cards.map(cardAnswer)
    expect(cards).toEqual(before.noticeInteractions(f.pool, 'seat').cards.map(cardAnswer))
    expect(() => expect(cards.map(row => ({ ...row, detail: 'wrong' }))).toEqual(cards)).toThrow()
    expect(chatInteractions(f.pool, 'seat').question).toBe(here(f.pool.model('pendingInteraction', f.asks.find(row => row.kind === 'question')!.id)))
  } finally { f.pool.dispose() }
})

it('matches old Sends facts for every status, retract and transcript confirmation, with a wrong-answer control', async () => {
  const statuses: MessageRecordWire['status'][] = ['stored', 'dispatched', 'typing', 'typed', 'accepted', 'confirmed', 'failed', 'expired', 'cancelled', 'unknown']
  const f = fixture([])
  const transcript = new TranscriptLog({ sessionId: asSessionId('seat'), source: { read: async () => ({ items: [], hasMore: false }), subscribe: () => () => {} } })
  let current = record()
  const listeners = new Set<() => void>()
  const options = { sessionId: asSessionId('seat'), transcript, drafts: { get: () => '', set: () => {} },
    readContext: () => ({ canInterrupt: false }), createDeliveryId: () => 'local', deliver: async () => {},
    initialPending: [{ id: 'pending', deliveryId: 'message', text: 'first line\nsecond line', wire: 'first line\nsecond line', at: 1, state: 'sent' as const, kind: 'message' as const }],
    records: { getSnapshot: () => [current], subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } } },
  }
  ingestMessageRecords(f.pool, [current])
  const old = new BeforeSends(options)
  const next = new Sends({ ...options, records: { ...options.records, getSnapshot: () => [here(f.pool.model('messageRecord', 'message'))!] },
    messageRecords: { read: id => here(f.pool.model('messageRecord', id)), ingest: rows => ingestMessageRecords(f.pool, rows) } })
  const answer = (sends: Sends | BeforeSends) => sends.bubbles.map(({ record: row, ...bubble }) => ({
    ...bubble, record: row && { id: row.id, body: row.body, status: row.status, reason: row.reason,
      createdAt: row.createdAt, attachments: row.attachments, transcriptItem: row.transcriptItem, retractRequestedAt: row.retractRequestedAt },
  }))
  try {
    ingestMessageRecords(f.pool, [current])
    old.start(); next.start()
    for (const status of statuses) for (const retractRequestedAt of [undefined, stamp]) {
      current = record({ status, retractRequestedAt, transcriptItem: { id: 'native', cursor: 'cursor' } })
      ingestMessageRecords(f.pool, [current])
      for (const listener of listeners) listener()
      const expected = answer(old), actual = answer(next)
      expect(actual).toEqual(expected)
      if (actual.length) expect(() => expect(actual.map(row => ({ ...row, state: 'wrong' }))).toEqual(expected)).toThrow()
    }
  } finally { old.dispose(); next.dispose(); transcript.dispose(); f.pool.dispose() }
})

it('a pushed server record updates Sends, notices and a ledger holding the same model', async () => {
  const f = fixture()
  const transcript = new TranscriptLog({ sessionId: asSessionId('seat'), source: { read: async () => ({ items: [], hasMore: false }), subscribe: () => () => {} } })
  const sends = new Sends({ sessionId: asSessionId('seat'), transcript, drafts: { get: () => '', set: () => {} },
    readContext: () => ({ canInterrupt: false }), createDeliveryId: () => 'local', deliver: async () => {},
    records: { getSnapshot: () => chatRecords(f.pool, 'seat').records,
      subscribe: listener => reaction(() => chatRecords(f.pool, 'seat').records.map(row => row.row), listener) },
    messageRecords: { read: id => here(f.pool.model('messageRecord', id)), ingest: rows => ingestMessageRecords(f.pool, rows) },
  })
  const ledger = new MessageLedger(f.pool, { ledger: async () => [ledgerRow()] })
  const stop = autorun(() => { noticeMessages(f.pool) })
  try {
    await settle(); sends.start(); await ledger.refresh()
    const model = here(f.pool.model('messageRecord', 'message'))!
    expect(chatRecords(f.pool, 'seat').records[0]).toBe(model)
    expect(noticeMessages(f.pool).notices[0]?.message).toBe(model)
    expect(here(f.pool.model('messageRecord', ledger.ids![0]!))).toBe(model)
    f.update(record({ body: 'updated on the server', status: 'unknown' }))
    expect(sends.bubbles[0]).toMatchObject({ text: 'updated on the server', state: 'unknown' })
    expect(sends.bubbles[0]?.record).toBe(model)
    expect(noticeMessages(f.pool).notices[0]).toMatchObject({ excerpt: 'updated on the server', status: 'unknown' })
    expect(here(f.pool.model('messageRecord', ledger.ids![0]!))).toMatchObject({ body: 'updated on the server', status: 'unknown', from: 'user' })
  } finally { stop(); ledger.dispose(); sends.dispose(); transcript.dispose(); f.pool.dispose() }
})

it('lookup records absent from sync join the same table and preserve ledger metadata', async () => {
  const f = fixture([])
  try {
    ingestLedgerMessages(f.pool, [ledgerRow()])
    const model = here(f.pool.model('messageRecord', 'message'))!
    ingestMessageRecords(f.pool, [record()])
    expect(here(f.pool.model('messageRecord', 'message'))).toBe(model)
    expect(model).toMatchObject({ sessionId: 'seat', status: 'failed', from: 'user' })
    ingestMessageRecords(f.pool, [record({ status: 'confirmed', transcriptItem: { id: 'entry', cursor: 'c' } })])
    ingestMessageRecords(f.pool, [record({ status: 'stored' })])
    expect(model.transcriptItem).toBeUndefined()
  } finally { f.pool.dispose() }
})

it('polls every 15 seconds only while visible, and ignores answers after closing', async () => {
  vi.useFakeTimers()
  const pool = new MobxPool({ coarseNow: 0, selectedIssueId: null })
  const request = vi.fn(async () => [ledgerRow()])
  const ledger = new MessageLedger(pool, { ledger: request })
  try {
    ledger.setVisible(false); await vi.advanceTimersByTimeAsync(60_000)
    expect(request).not.toHaveBeenCalled()
    ledger.setVisible(true); await settle()
    expect(request).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(request).toHaveBeenCalledTimes(2)
    ledger.setVisible(false); await vi.advanceTimersByTimeAsync(60_000)
    expect(request).toHaveBeenCalledTimes(2)
    ledger.setVisible(true); await settle()
    expect(request).toHaveBeenCalledTimes(3)
    ledger.dispose(); await vi.advanceTimersByTimeAsync(60_000)
    expect(request).toHaveBeenCalledTimes(3)
    let resolve!: (rows: MessageLedgerWire[]) => void
    const closed = new MessageLedger(pool, { ledger: () => new Promise(yes => { resolve = yes }) })
    const pending = closed.refresh(); closed.dispose(); resolve([ledgerRow({ id: 'late' })]); await pending
    expect(closed.ids).toBeNull()
    expect(here(pool.model('messageRecord', 'late'))).toBeUndefined()
  } finally { ledger.dispose(); pool.dispose() }
})

it('an authority message update crosses the real replica boundary and reaches every shared reader', async () => {
  const authority = new ConformanceAuthority()
  await authority.resolveIdentity()
  const classOf = authority.policy.classOf.bind(authority.policy)
  vi.spyOn(authority.policy, 'classOf').mockImplementation(entity =>
    entity === 'message' || entity === 'pendingInteraction' ? 'personal' : classOf(entity))
  const principal = conformanceUser('message-model-user')
  const rowId = messageRecordRowId({ sessionId: 'seat', senderUserId: 'user', messageId: 'message' })
  authority.append({ entity: 'message', entityId: rowId, op: 'upsert', payload: record() })
  authority.grant(requireHuman(principal), 'message', rowId)
  const ask = noticeFixture('seat').interactions.find(row => row.kind === 'permission')!
  const askRowId = interactionRowId('seat', ask.id)
  authority.append({ entity: 'pendingInteraction', entityId: askRowId, op: 'upsert', payload: ask })
  authority.grant(requireHuman(principal), 'pendingInteraction', askRowId)
  const store = new InMemoryReplicaStore()
  const facade = createKernelReplica({ cache: store.cache,
    side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }),
    exits: (entity, id) => replica.exitKind(entity, id),
  })
  const replica = new SyncReplica({ store: store.cache, authority: authority.portFor(principal),
    onEvent: event => facade.onKernelEvent(event), batchEvents: emit => facade.batch(emit),
  })
  replica.connect(); await replica.settled()
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
  pool.apply({ type: 'replace', rows: [{ kind: 'session', id: 'seat', value: {
    sessionId: 'seat', name: 'Named agent', cwd: '/synthetic', agentKind: 'codex', status: 'live',
  } }] })
  pool.sources.register(NOTICE_ENTITIES, new NoticeSource({ replica: facade,
    outbox: { deadLetters: () => [], subscribe: () => () => {} },
  } as unknown as Pick<ClientRuntime, 'replica' | 'outbox'>))
  const transcript = new TranscriptLog({ sessionId: asSessionId('seat'), source: {
    read: async () => ({ items: [], hasMore: false }), subscribe: () => () => {},
  } })
  const sends = new Sends({ sessionId: asSessionId('seat'), transcript,
    drafts: { get: () => '', set: () => {} }, readContext: () => ({ canInterrupt: false }),
    createDeliveryId: () => 'local', deliver: async () => {},
    records: { getSnapshot: () => chatRecords(pool, 'seat').records,
      subscribe: listener => reaction(() => chatRecords(pool, 'seat').records.map(row => row.row), listener) },
    messageRecords: { read: id => here(pool.model('messageRecord', id)), ingest: rows => ingestMessageRecords(pool, rows) },
  })
  const ledger = new MessageLedger(pool, { ledger: async () => [ledgerRow()] })
  let notices = noticeMessages(pool)
  const stop = autorun(() => { notices = noticeMessages(pool) })
  try {
    await settle(); sends.start(); await ledger.refresh()
    const shared = here(pool.model('messageRecord', 'message'))!
    const sharedAsk = here(pool.model('pendingInteraction', ask.id))!
    expect(currentMessageRecord(pool, facade, 'message')).toEqual(record())
    const from = authority.head()
    authority.append({ entity: 'message', entityId: rowId, op: 'upsert', payload: record({ body: 'authority update', status: 'unknown' }) })
    await replica.receive(authority.frameFor(principal, from)); await replica.settled(); await settle()
    expect(sends.bubbles[0]).toMatchObject({ text: 'authority update', state: 'unknown' })
    expect(sends.bubbles[0]?.record).toBe(shared)
    expect(notices.notices[0]).toMatchObject({ excerpt: 'authority update', status: 'unknown' })
    expect(here(pool.model('messageRecord', ledger.ids![0]!))).toBe(shared)
    expect(ledger.row(shared).message.body).toBe('authority update')
    expect(ledger.row(shared).line).toBe('not confirmed · it may or may not have arrived')
    const beforeAsk = authority.head()
    authority.append({ entity: 'pendingInteraction', entityId: askRowId, op: 'upsert', payload: {
      ...ask, payload: { ...ask.payload, inputSummary: 'updated permission' },
    } })
    await replica.receive(authority.frameFor(principal, beforeAsk)); await replica.settled(); await settle()
    expect(here(pool.model('pendingInteraction', ask.id))).toBe(sharedAsk)
    expect(chatInteractions(pool, 'seat').blocked).toBe(true)
    const card = noticeInteractions(pool, 'seat').cards[0]!
    expect(card.detail).toBe('Read: updated permission')
    expect('interaction' in card && card.interaction).toBe(sharedAsk)
    const beforeRemove = authority.head()
    authority.append({ entity: 'message', entityId: rowId, op: 'remove' })
    authority.append({ entity: 'pendingInteraction', entityId: askRowId, op: 'remove' })
    await replica.receive(authority.frameFor(principal, beforeRemove)); await replica.settled(); await settle()
    expect(here(pool.model('messageRecord', 'message'))).toBeUndefined()
    expect(here(pool.model('pendingInteraction', ask.id))).toBeUndefined()
    expect(chatInteractions(pool, 'seat').blocked).toBe(false)
    expect(notices.notices).toEqual([])
  } finally { stop(); ledger.dispose(); sends.dispose(); transcript.dispose(); pool.dispose(); replica.disconnect() }
})

it('a session activity change leaves notice membership and label consumers quiet', async () => {
  const f = fixture()
  let membershipRuns = 0, labelRuns = 0
  const stop = autorun(() => { membershipRuns++; noticeMessages(f.pool) })
  try {
    await settle()
    const notice = noticeMessages(f.pool).notices[0]!
    const label = autorun(() => { labelRuns++; notice.sessionLabel })
    try {
      const initialMembershipRuns = membershipRuns, initialLabelRuns = labelRuns
      f.pool.apply({ type: 'update', rows: [{ kind: 'session', id: 'seat', value: {
        sessionId: 'seat', name: 'Named agent', title: 'Title', cwd: '/repo', agentKind: 'codex', status: 'live', lastActiveAt: stamp,
      } }] })
      expect(membershipRuns).toBe(initialMembershipRuns)
      expect(labelRuns).toBe(initialLabelRuns)
    } finally { label() }
  } finally { stop(); f.pool.dispose() }
})


it('retains shared identities on replica replacement, removing only missing synced records', async () => {
  const f = fixture([record(), record({ id: 'removed' })])
  try {
    const shared = here(f.pool.model('messageRecord', 'message'))!
    const interaction = here(f.pool.model('pendingInteraction', f.asks[0]!.id))!
    const removed = here(f.pool.model('messageRecord', 'removed'))!
    f.records.delete('removed')
    f.records.set('message', record({ body: 'replacement body' }))
    f.replace(); await settle()
    expect(here(f.pool.model('messageRecord', 'message'))).toBe(shared)
    expect(here(f.pool.model('pendingInteraction', f.asks[0]!.id))).toBe(interaction)
    expect(shared.body).toBe('replacement body')
    expect(here(f.pool.model('messageRecord', removed.id))).toBeUndefined()
  } finally { f.pool.dispose() }
})

it('a late lookup or ledger response preserves the current pushed record', async () => {
  const f = fixture([record({ body: 'new server body', status: 'unknown' })])
  const current = (id: string) => f.records.get(id)
  const ledger = new MessageLedger(f.pool, {
    ledger: async () => [ledgerRow({ body: 'stale ledger', deliveryStatus: 'stored' })],
    records: async () => [record({ body: 'stale lookup', status: 'stored' })], currentRecord: current,
  })
  try {
    const shared = here(f.pool.model('messageRecord', 'message'))!
    ingestMessageRecords(f.pool, [record({ body: 'old lookup' })], current)
    expect(shared).toMatchObject({ body: 'new server body', status: 'unknown' })
    await ledger.refresh()
    expect(shared).toMatchObject({ body: 'new server body', status: 'unknown', from: 'user' })
    expect(here(f.pool.model('messageRecord', ledger.ids![0]!))).toBe(shared)
  } finally { ledger.dispose(); f.pool.dispose() }
})

it('requests message records in the existing 100-ID batches', async () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  const rows = Array.from({ length: 205 }, (_, i) => ledgerRow({ id: `ledger-${i}` }))
  const records = vi.fn(async (ids: readonly string[]) => ids.map(id => record({ id })))
  const ledger = new MessageLedger(pool, { ledger: async () => rows, records })
  try {
    await ledger.refresh()
    expect(records.mock.calls.map(([ids]) => ids.length)).toEqual([100, 100, 5])
    expect(ledger.ids).toEqual(rows.map(row => row.id))
    expect(here(pool.model('messageRecord', 'ledger-204'))).toMatchObject({ body: record().body, from: 'user' })
  } finally { ledger.dispose(); pool.dispose() }
})


it('matches each old ledger fact on shared models, with wrong-answer controls', () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  const statuses: MessageRecordWire['status'][] = ['stored', 'dispatched', 'typing', 'typed', 'accepted', 'confirmed', 'failed', 'expired', 'cancelled', 'unknown']
  const metadata: Partial<MessageLedgerWire>[] = [
    {}, { queuePosition: 3, expiresAt: stamp }, { ackedBy: 'other', deliveredTo: 'seat' },
    { readAt: stamp, deliveredTo: 'seat' }, { deliveryDeferredAt: stamp, deliveryDeferredReason: 'busy' },
    { clampedFrom: JSON.stringify({ urgency: 'interrupt', lifecycle: 'wake', reasons: ['sleeping'] }) },
    { clampedFrom: 'invalid json' },
  ]
  try {
    for (const status of statuses) for (const patch of metadata) {
      const wire = ledgerRow({ ...patch, deliveryStatus: status })
      ingestLedgerMessages(pool, [wire])
      const model = here(pool.model('messageRecord', wire.id))!
      const entry = new LedgerEntry(model)
      const expected = { clamp: beforeLedger.clampSummary(wire), tone: beforeLedger.ledgerStatusTone(status), line: beforeLedger.deliveryLine(wire) }
      const actual = { clamp: entry.clamp, tone: entry.tone, line: entry.line }
      expect(actual).toEqual(expected)
      for (const field of ['clamp', 'tone', 'line'] as const)
        expect(() => expect({ ...actual, [field]: 'wrong' }).toEqual(expected)).toThrow()
    }
  } finally { pool.dispose() }
})
