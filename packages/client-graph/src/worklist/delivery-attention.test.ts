import type { ReplicaAddressedBatch } from '@podium/client-core/replica'
import { asSessionId, type MessageRecordWire } from '@podium/model'
import { autorun } from 'mobx'
import { expect, it, vi } from 'vitest'
import { NOTICE_ENTITIES } from '../notice-schema'
import { NoticeSource } from '../notice-source'
import { noticeSessionDeliveryAttention } from '../notice-views'
import { MobxPool } from '../pool'
import { worklistView } from './view-model'

it('scopes delivery attention to the task and follows confirmation, expiry and dismissal', async () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  const stamp = '2026-11-12T10:53:12Z'
  const message = (
    id: string,
    status: MessageRecordWire['status'],
    extra = {},
  ): MessageRecordWire => ({
    id,
    sessionId: asSessionId(`s-${id}`),
    body: 'Message',
    createdAt: stamp,
    status,
    senderUserId: 'user',
    ...extra,
  })
  let messages = [message('one', 'unknown'), message('two', 'failed')]
  const listeners = new Set<(batch: ReplicaAddressedBatch) => void>()
  const source = new NoticeSource({
    replica: {
      rows: (kind: string) => (kind === 'messageRecords' ? messages : []),
      row: (_kind: string, id: string) => messages.find((row) => row.id === id),
      subscribeAddressedBatch: (listener: (batch: ReplicaAddressedBatch) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    outbox: { deadLetters: () => [], subscribe: () => () => {} },
  } as unknown as ConstructorParameters<typeof NoticeSource>[0])
  pool.apply({
    type: 'replace',
    rows: [
      ...['one', 'two'].map((id) => ({
        kind: 'issue',
        id,
        value: {
          id,
          seq: 1,
          title: id,
          stage: 'in_progress',
          repoPath: '/repo',
          createdAt: stamp,
          updatedAt: stamp,
        },
      })),
      ...['one', 'two'].map((id) => ({
        kind: 'session',
        id: `s-${id}`,
        value: {
          sessionId: `s-${id}`,
          issueId: id,
          status: 'live',
          cwd: '/repo',
          agentKind: 'codex',
        },
      })),
    ] as never,
  })
  pool.sources.register(NOTICE_ENTITIES, source)
  const row = worklistView(pool).row(pool.issueObject('one'))
  const seen: unknown[] = []
  const stop = autorun(() => seen.push(row.deliveryAttention))
  const change = (status: MessageRecordWire['status'], extra = {}) => {
    messages = [message('one', status, extra), messages[1]!]
    for (const listener of listeners)
      listener({ type: 'update', rows: [{ kind: 'messageRecords', id: 'one' }] })
  }
  try {
    await Promise.resolve()
    expect(row.deliveryAttention).toBe('unknown')
    change('expired')
    expect(row.deliveryAttention).toBe('failed')
    change('confirmed')
    expect(row.deliveryAttention).toBeUndefined()
    change('failed')
    expect(row.deliveryAttention).toBe('failed')
    change('failed', { noticeDismissedAt: stamp })
    expect(row.deliveryAttention).toBeUndefined()
    expect(seen).toEqual([undefined, 'unknown', 'failed', undefined, 'failed', undefined])
    expect(worklistView(pool).row(pool.issueObject('two')).deliveryAttention).toBe('failed')
    expect(source.counts.collectionReads).toBe(2)
  } finally {
    stop()
    pool.dispose()
  }
})

it('keeps delivery attention reads scoped to one session at 1x/4x account size', async () => {
  const results: number[] = []
  for (const scale of [1, 4]) {
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
    const messages = new Map<string, MessageRecordWire>()
    const record = (
      id: string,
      sessionId: string,
      status: MessageRecordWire['status'],
    ): MessageRecordWire => ({
      id,
      sessionId: asSessionId(sessionId),
      status,
      body: 'Fixture',
      senderUserId: 'user',
      createdAt: '2026-11-12T10:00:00Z',
    })
    messages.set('selected-a', record('selected-a', 'selected', 'unknown'))
    messages.set('selected-b', record('selected-b', 'selected', 'confirmed'))
    for (let i = 0; i < 128 * scale; i++)
      messages.set(`foreign-${i}`, record(`foreign-${i}`, `other-${i}`, 'failed'))
    const listeners = new Set<(batch: ReplicaAddressedBatch) => void>()
    const source = new NoticeSource({
      replica: {
        rows: (kind: string) => (kind === 'messageRecords' ? [...messages.values()] : []),
        row: (_kind: string, id: string) => messages.get(id),
        subscribeAddressedBatch: (listener: (batch: ReplicaAddressedBatch) => void) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      },
      outbox: { deadLetters: () => [], subscribe: () => () => {} },
    } as unknown as ConstructorParameters<typeof NoticeSource>[0])
    pool.sources.register(NOTICE_ENTITIES, source)
    const read = vi.spyOn(pool, 'model')
    const stop = autorun(() => noticeSessionDeliveryAttention(pool, 'selected'))
    const change = (id: string, sessionId: string) => {
      messages.set(id, record(id, sessionId, 'accepted'))
      for (const listener of listeners)
        listener({ type: 'update', rows: [{ kind: 'messageRecords', id }] })
    }
    try {
      await Promise.resolve()
      read.mockClear()
      change('selected-b', 'selected')
      expect(read.mock.calls.map((call) => call[1])).toEqual(['selected-a', 'selected-b'])
      results.push(read.mock.calls.length)
      read.mockClear()
      change('foreign-0', 'other-0')
      expect(read).not.toHaveBeenCalled()
      expect(source.counts.collectionReads).toBe(2)
    } finally {
      stop()
      read.mockRestore()
      pool.dispose()
    }
  }
  expect(results).toEqual([2, 2])
})
