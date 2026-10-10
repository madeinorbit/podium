import type { MessageNotice, PendingInteractionCard } from '@podium/client-core/values'
import { asSessionId, asThreadId, type MessageRecordWire, type MessageLedgerWire } from '@podium/model'
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
import { ingestLedgerMessages, ingestMessageRecords } from './message-models'
import { MessageLedger } from './message-ledger'
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
  return { pool, source, records, asks, update }
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
