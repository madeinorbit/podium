import type { ClientRuntime } from '@podium/client-core/engine'
import type { ReplicaAddressedBatch } from '@podium/client-core/replica'
import { asSessionId, type MessageRecordWire } from '@podium/model'
import type { PendingInteractionWire } from '@podium/protocol'
import { autorun } from 'mobx'
import { expect, it, vi } from 'vitest'
import { noticeFixture } from '../diagnostics/notice-fixture'
import { insideArm, measureWork, type WorkCounts } from '../../worklist-proto/harness/src/work-meter'
import { chatInteractions, chatRecords } from './chat-context'
import { NOTICE_ENTITIES } from './notice-schema'
import { NoticeSource } from './notice-source'
import { noticeInteractions, noticeMessages, noticeNewestMessage, noticeRecovery } from './notice-views'
import { MobxPool } from './pool'
import { superagentQuestion } from './superagent'
import { LOADING } from './worklist/rollup'

const stamp = '2026-10-05T12:00:00Z'
const question = noticeFixture('selected').interactions[2]!
const message = (id: string, sessionId = 'selected', status: MessageRecordWire['status'] = 'confirmed', createdAt = stamp): MessageRecordWire =>
  ({ id, sessionId: asSessionId(sessionId), senderUserId: 'synthetic', body: 'Synthetic words', status, createdAt })
const ask = (id: string, sessionId = 'selected'): PendingInteractionWire =>
  ({ ...question, id, sessionId: asSessionId(sessionId), askedAt: stamp })
const compact = (work: WorkCounts) => ({ rows: work.rows ?? 0, derivations: work.derivations, elements: work.elements })

function fixture(scale: 1 | 4, attention = false) {
  const messages = new Map<string, MessageRecordWire>([
    ['z-message', message('z-message', 'selected', attention ? 'failed' : 'confirmed')],
    ['a-message', message('a-message', 'selected', attention ? 'unknown' : 'confirmed', '2026-10-04T12:00:00Z')],
    ...Array.from({ length: 128 * scale }, (_, index): [string, MessageRecordWire] => {
      const id = `other-message-${index}`
      return [id, message(id, `other-${index}`, attention ? 'failed' : 'confirmed', '2026-10-01T12:00:00Z')]
    }),
    ...Array.from({ length: 128 * scale }, (_, index): [string, MessageRecordWire] => {
      const id = `history-${index}`
      return [id, message(id, `history-session-${index}`)]
    }),
  ])
  const asks = new Map<string, PendingInteractionWire>([
    ['z-ask', ask('z-ask')], ['a-ask', ask('a-ask')],
    ...Array.from({ length: 128 * scale }, (_, index): [string, PendingInteractionWire] => {
      const id = `other-ask-${index}`
      return [id, ask(id, `other-${index}`)]
    }),
  ])
  const listeners = new Set<(batch: ReplicaAddressedBatch) => void>(), outboxListeners = new Set<() => void>()
  let parked = noticeFixture().deadLetters
  const rows = vi.fn((kind: string) => kind === 'messageRecords' ? Array.from(messages.values()) : Array.from(asks.values()))
  const row = vi.fn((kind: string, id: string) => kind === 'messageRecords' ? messages.get(id) : asks.get(id))
  const deadLetters = vi.fn(() => parked)
  const runtime = {
    replica: { rows, row, subscribeAddressedBatch(listener: (batch: ReplicaAddressedBatch) => void) {
      listeners.add(listener); return () => { listeners.delete(listener) }
    } },
    outbox: { deadLetters, subscribe(listener: () => void) { outboxListeners.add(listener); return () => { outboxListeners.delete(listener) } } },
  } as unknown as Pick<ClientRuntime, 'replica' | 'outbox'>
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
  pool.apply({ type: 'replace', rows: [{ kind: 'session', id: 'selected', value: {
    sessionId: 'selected', name: 'Synthetic agent', cwd: '/synthetic', agentKind: 'codex',
  } as never }] })
  const source = new NoticeSource(runtime)
  pool.sources.register(NOTICE_ENTITIES, source)
  function emit(batch: ReplicaAddressedBatch) { for (const listener of listeners) insideArm(() => listener(batch)) }
  return {
    pool, source, messages, asks, rows, row, deadLetters,
    writeMessage(id: string, next: MessageRecordWire | undefined) {
      if (next) messages.set(id, next); else messages.delete(id)
      return () => emit({ type: 'update', rows: [{ kind: 'messageRecords', id }] })
    },
    writeAsk(id: string, next: PendingInteractionWire | undefined) {
      if (next) asks.set(id, next); else asks.delete(id)
      return () => emit({ type: 'update', rows: [{ kind: 'pendingInteractions', id }] })
    },
    replace(nextMessages: MessageRecordWire[], nextAsks: PendingInteractionWire[]) {
      messages.clear(); asks.clear()
      for (const row of nextMessages) messages.set(row.id, row)
      for (const row of nextAsks) asks.set(row.id, row)
      emit({ type: 'replace', reason: 'rescope' })
    },
    outbox() { parked = [...parked].reverse(); for (const listener of outboxListeners) insideArm(listener) },
    listeners: () => listeners.size + outboxListeners.size,
  }
}

it('bounds conversation open, addressed edits and closed readers at 1x/4x, with a growing legacy scan control', async () => {
  const measured = []
  for (const scale of [1, 4] as const) {
    let stop: (() => void) | undefined
    let records: ReturnType<typeof chatRecords> = { records: [], pending: 0 }
    let interactions: ReturnType<typeof chatInteractions> = { blocked: false, question: undefined, pending: 0 }
    let picked: ReturnType<typeof superagentQuestion> | undefined
    const live = fixture(scale)
    try {
      const read = vi.spyOn(live.pool, 'row')
      const open = await measureWork(async () => {
        stop = autorun(() => {
          records = chatRecords(live.pool, 'selected')
          interactions = chatInteractions(live.pool, 'selected')
          picked = superagentQuestion(live.pool, 'selected' as never)
        }, { name: 'consumer:conversation' })
        await Promise.resolve()
      }, { pool: live.pool })
      expect(records.records.map(row => row.id)).toEqual(['z-message', 'a-message'])
      expect(interactions).toMatchObject({ blocked: true, question: { id: 'z-ask' }, pending: 0 })
      expect(picked).toMatchObject({ question: { id: 'z-ask' }, loading: false })
      expect(read.mock.calls.filter(([entity]) => entity === 'messageRecord' || entity === 'pendingInteraction')
        .every(([, id]) => ['z-message', 'a-message', 'z-ask', 'a-ask'].includes(id))).toBe(true)
      const otherMessage = live.writeMessage('other-message-0', { ...live.messages.get('other-message-0')!, body: 'Changed elsewhere' })
      const otherAsk = live.writeAsk('other-ask-0', { ...live.asks.get('other-ask-0')!, status: 'answered' })
      const background = await measureWork(async () => { otherMessage(); otherAsk() }, { pool: live.pool })
      expect(compact(background.work)).toMatchObject({ rows: 0, derivations: 0 })
      const edit = live.writeMessage('z-message', { ...live.messages.get('z-message')!, body: 'Changed here' })
      const selected = await measureWork(async () => edit(), { pool: live.pool })
      expect(records.records[0]?.body).toBe('Changed here')
      expect(selected.work.derivations).toBe(1)
      stop(); stop = undefined
      const closedEdit = live.writeMessage('z-message', { ...live.messages.get('z-message')!, body: 'Changed closed' })
      const closed = await measureWork(async () => closedEdit(), { pool: live.pool })
      expect(compact(closed.work)).toMatchObject({ rows: 0, derivations: 0 })
      expect(live.source.demand).toEqual({ keys: 0, catalog: false, attention: false, recovery: false })
      expect(live.rows).toHaveBeenCalledTimes(2)
      expect(live.deadLetters).not.toHaveBeenCalled()
      expect(live.source.counts).toMatchObject({ catalogBuilds: 0, attentionBuilds: 0, addressedRows: 4 })
      // The prior reader shape walks global IDs before selecting this session.
      // This negative control proves the element meter sees that hidden work.
      const control = await measureWork(async () => insideArm(() => {
        for (const id of live.messages.keys()) if (live.messages.get(id)?.sessionId === 'selected') live.pool.row('messageRecord', id)
        for (const id of live.asks.keys()) if (live.asks.get(id)?.sessionId === 'selected') live.pool.row('pendingInteraction', id)
      }), { pool: live.pool })
      measured.push({ scale, open: compact(open.work), background: compact(background.work), selected: compact(selected.work),
        closed: compact(closed.work), legacyControl: compact(control.work) })
    } finally { stop?.(); live.pool.dispose() }
  }
  const first = measured[0]!, second = measured[1]!
  for (const step of ['open', 'background', 'selected', 'closed'] as const) {
    expect(second[step].rows, step).toBe(first[step].rows)
    expect(second[step].derivations, step).toBe(first[step].derivations)
    expect(second[step].elements, step).toBeLessThanOrEqual(first[step].elements)
  }
  expect(second.legacyControl.elements).toBeGreaterThan(first.legacyControl.elements * 3)
  console.info('[conversation notice work]', JSON.stringify(measured))
})

it('bounds newest/count demand without reading ordinary history or non-newest payloads', async () => {
  const measured = []
  for (const scale of [1, 4] as const) {
    const f = fixture(scale, true)
    let current = noticeNewestMessage(f.pool)
    await Promise.resolve()
    const stop = autorun(() => { current = noticeNewestMessage(f.pool) }, { name: 'consumer:notice-banner' })
    try {
      expect(current).toMatchObject({ count: 128 * scale + 2, notice: { messageId: 'z-message' }, pending: 0 })
      const reads = vi.spyOn(f.pool, 'row')
      const history = f.writeMessage('history-0', { ...f.messages.get('history-0')!, body: 'Changed history' })
      const historyWork = await measureWork(async () => history(), { pool: f.pool })
      const older = f.writeMessage('other-message-0', { ...f.messages.get('other-message-0')!, body: 'Changed older notice' })
      const olderWork = await measureWork(async () => older(), { pool: f.pool })
      expect(compact(historyWork.work)).toMatchObject({ rows: 0, derivations: 0 })
      expect(compact(olderWork.work)).toMatchObject({ rows: 0, derivations: 0 })
      const newest = f.writeMessage('z-message', { ...f.messages.get('z-message')!, body: 'Changed newest' })
      const newestWork = await measureWork(async () => newest(), { pool: f.pool })
      expect(current.notice?.excerpt).toBe('Changed newest')
      const dismiss = f.writeMessage('z-message', { ...f.messages.get('z-message')!, status: 'confirmed' })
      const dismissWork = await measureWork(async () => dismiss(), { pool: f.pool })
      expect(current).toMatchObject({ count: 128 * scale + 1, notice: { messageId: 'a-message' } })
      expect(reads.mock.calls.filter(([entity]) => entity === 'messageRecord').map(([, id]) => id)).toEqual(['z-message', 'a-message'])
      expect(reads.mock.calls.some(([entity]) => entity === 'noticeMessageCatalog' || entity === 'noticeCatalog')).toBe(false)
      expect(f.source.counts).toMatchObject({ collectionReads: 2, attentionBuilds: 1, attentionUpdates: 1, catalogBuilds: 0, outboxReads: 0 })
      stop()
      expect(f.source.demand).toEqual({ keys: 0, catalog: false, attention: false, recovery: false })
      const inactive = f.writeMessage('a-message', { ...f.messages.get('a-message')!, status: 'confirmed' })
      const inactiveWork = await measureWork(async () => inactive(), { pool: f.pool })
      expect(f.source.counts.attentionUpdates).toBe(1)
      expect(compact(inactiveWork.work)).toMatchObject({ rows: 0, derivations: 0 })
      measured.push({ scale, history: compact(historyWork.work), older: compact(olderWork.work), newest: compact(newestWork.work),
        dismiss: compact(dismissWork.work), inactive: compact(inactiveWork.work) })
    } finally { stop(); f.pool.dispose() }
  }
  for (const step of ['history', 'older', 'newest', 'dismiss', 'inactive'] as const) {
    expect(measured[1]![step].rows, step).toBe(measured[0]![step].rows)
    expect(measured[1]![step].derivations, step).toBe(measured[0]![step].derivations)
    expect(measured[1]![step].elements, step).toBeLessThanOrEqual(measured[0]![step].elements)
  }
  console.info('[newest notice work]', JSON.stringify(measured))
})

it('retains replica order through session moves, optimistic insert/rollback and replacement, and preserves notice ties', async () => {
  const f = fixture(1)
  let records = chatRecords(f.pool, 'selected'), interactions = chatInteractions(f.pool, 'selected')
  const stop = autorun(() => { records = chatRecords(f.pool, 'selected'); interactions = chatInteractions(f.pool, 'selected') })
  try {
    await Promise.resolve()
    expect(records.records.map(row => row.id)).toEqual(['z-message', 'a-message'])
    expect(interactions.question?.id).toBe('z-ask')
    expect(noticeInteractions(f.pool, 'selected').cards.map(row => row.id)).toEqual(['a-ask', 'z-ask'])
    f.writeMessage('z-message', { ...f.messages.get('z-message')!, sessionId: asSessionId('moved') })()
    f.writeAsk('z-ask', { ...f.asks.get('z-ask')!, sessionId: asSessionId('moved') })()
    expect(records.records.map(row => row.id)).toEqual(['a-message'])
    expect(interactions.question?.id).toBe('a-ask')
    f.writeMessage('z-message', { ...f.messages.get('z-message')!, sessionId: asSessionId('selected') })()
    f.writeAsk('z-ask', { ...f.asks.get('z-ask')!, sessionId: asSessionId('selected') })()
    expect(records.records.map(row => row.id)).toEqual(['z-message', 'a-message'])
    expect(interactions.question?.id).toBe('z-ask')
    expect(f.pool.row('noticeSession', 'moved')).toBeUndefined()
    f.writeMessage('optimistic', message('optimistic', 'selected', 'typed'))()
    f.writeAsk('optimistic-ask', ask('optimistic-ask'))()
    expect(records.records.map(row => row.id)).toEqual(['z-message', 'a-message', 'optimistic'])
    f.writeMessage('optimistic', undefined)(); f.writeAsk('optimistic-ask', undefined)()
    expect(records.records.map(row => row.id)).toEqual(['z-message', 'a-message'])
    f.writeMessage('z-message', undefined)(); f.writeAsk('z-ask', undefined)()
    f.writeMessage('z-message', message('z-message'))(); f.writeAsk('z-ask', ask('z-ask'))()
    expect(records.records.map(row => row.id)).toEqual(['a-message', 'z-message'])
    expect(interactions.question?.id).toBe('a-ask')
    f.replace([message('z-message'), message('a-message')], [ask('z-ask'), ask('a-ask')])
    expect(records.pending).toBe(1)
    expect(interactions.pending).toBe(1)
    await Promise.resolve()
    expect(records.records.map(row => row.id)).toEqual(['z-message', 'a-message'])
    expect(interactions.question?.id).toBe('z-ask')
    f.replace([], [])
    await Promise.resolve()
    expect(records).toEqual({ records: [], pending: 0 })
    expect(interactions).toEqual({ blocked: false, question: undefined, pending: 0 })
  } finally { stop(); f.pool.dispose() }
})

it('keeps aggregate answers lazy, incremental while observed, and released with the last reader', async () => {
  const f = fixture(1, true)
  try {
    expect(f.source.demand).toEqual({ keys: 0, catalog: false, attention: false, recovery: false })
    const unopened = f.writeMessage('z-message', { ...f.messages.get('z-message')!, body: 'Changed before opening' })
    unopened(); f.outbox()
    expect(f.source.counts).toMatchObject({ catalogBuilds: 0, attentionBuilds: 0, outboxReads: 0, payloadReads: 0 })
    const cancel = autorun(() => f.pool.row('noticeSession', 'selected'))
    cancel(); await Promise.resolve()
    expect(f.source.counts.batches).toBe(0)
    expect(f.source.demand.keys).toBe(0)
    expect(f.pool.row('noticeSession', 'selected')).toBe(LOADING)
    await Promise.resolve()
    let catalog = f.pool.row('noticeCatalog', 'catalog')
    expect(f.source.demand.catalog).toBe(false)
    const stop = autorun(() => { catalog = f.pool.row('noticeCatalog', 'catalog') })
    const before = { ...f.source.counts }
    f.writeMessage('new-id', message('new-id'))()
    expect(catalog && catalog !== LOADING ? catalog.messages.includes('new-id') : false).toBe(true)
    expect(f.source.counts.catalogBuilds).toBe(before.catalogBuilds)
    expect(f.source.counts.catalogUpdates).toBe(before.catalogUpdates + 1)
    stop()
    expect(f.source.demand).toEqual({ keys: 0, catalog: false, attention: false, recovery: false })
    f.writeMessage('new-id', undefined)(); f.outbox()
    expect(f.source.counts.catalogUpdates).toBe(before.catalogUpdates + 1)
    expect(f.source.counts.outboxReads).toBe(before.outboxReads)
    const stopMessages = autorun(() => noticeMessages(f.pool))
    expect(f.source.demand).toMatchObject({ catalog: false, attention: true, recovery: false })
    stopMessages()
    const payloads = f.source.counts.payloadReads
    const stopRecovery = autorun(() => noticeRecovery(f.pool))
    expect(f.source.demand).toMatchObject({ catalog: false, attention: false, recovery: true })
    f.outbox(); await Promise.resolve()
    expect(f.source.counts.payloadReads).toBe(payloads)
    stopRecovery()
    expect(f.source.demand).toEqual({ keys: 0, catalog: false, attention: false, recovery: false })
  } finally { f.pool.dispose() }
  expect(f.listeners()).toBe(0)
})

it('keeps timestamp order and ID ties identical for newest and full message notices', async () => {
  const f = fixture(1)
  f.writeMessage('z-message', message('z-message', 'selected', 'failed'))()
  f.writeMessage('a-message', message('a-message', 'selected', 'unknown'))()
  let newest = noticeNewestMessage(f.pool), full = noticeMessages(f.pool)
  const stop = autorun(() => { newest = noticeNewestMessage(f.pool); full = noticeMessages(f.pool) })
  try {
    await Promise.resolve()
    expect(newest).toMatchObject({ count: 2, notice: { messageId: 'a-message' } })
    expect(full.notices.map(row => row.messageId)).toEqual(['a-message', 'z-message'])
    f.writeMessage('z-message', message('z-message', 'selected', 'failed', '2026-10-06T12:00:00Z'))()
    expect(newest.notice?.messageId).toBe('z-message')
    expect(full.notices.map(row => row.messageId)).toEqual(['z-message', 'a-message'])
    f.writeMessage('z-message', undefined)()
    expect(newest).toMatchObject({ count: 1, notice: { messageId: 'a-message' } })
  } finally { stop(); f.pool.dispose() }
})
