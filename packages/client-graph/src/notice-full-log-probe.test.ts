import type { ClientRuntime } from '@podium/client-core/engine'
import type { ReplicaAddressedBatch } from '@podium/client-core/replica'
import { asSessionId, type MessageRecordWire } from '@podium/model'
import type { PendingInteractionWire } from '@podium/protocol'
import { autorun } from 'mobx'
import { expect, it, vi } from 'vitest'
import { noticeFixture } from '../../../tests/worklist/diagnostics/notice-fixture'
import { insideArm, measureWork, type WorkCounts } from '../../../tests/worklist/harness/src/work-meter'
import { NOTICE_ENTITIES } from './notice-schema'
import { NoticeSource } from './notice-source'
import { noticeMessages } from './notice-views'
import { MobxPool } from './pool'

// TEMPORARY PROBE for POD-5648: does the one live full-notice-log caller (web
// MessageNotices dialog, demand-gated on open) grow with the notice count?
// Measures open + one new notice + one session-label change at 1x vs 4x.
const stamp = '2026-10-05T12:00:00Z'
const question = noticeFixture('selected').interactions[2]!
const message = (id: string, sessionId = 'selected', status: MessageRecordWire['status'] = 'confirmed', createdAt = stamp): MessageRecordWire =>
  ({ id, sessionId: asSessionId(sessionId), senderUserId: 'synthetic', body: 'Synthetic words', status, createdAt })
const ask = (id: string, sessionId = 'selected'): PendingInteractionWire =>
  ({ ...question, id, sessionId: asSessionId(sessionId), askedAt: stamp })
const compact = (work: WorkCounts) => ({ rows: work.rows ?? 0, derivations: work.derivations, elements: work.elements })

function fixture(scale: 1 | 4) {
  const messages = new Map<string, MessageRecordWire>([
    ['z-message', message('z-message', 'selected', 'failed')],
    ['a-message', message('a-message', 'selected', 'unknown', '2026-10-04T12:00:00Z')],
    ...Array.from({ length: 128 * scale }, (_, index): [string, MessageRecordWire] => {
      const id = `other-message-${index}`
      return [id, message(id, `other-${index}`, 'failed', '2026-10-01T12:00:00Z')]
    }),
  ])
  const asks = new Map<string, PendingInteractionWire>([
    ['z-ask', ask('z-ask')], ['a-ask', ask('a-ask')],
  ])
  const listeners = new Set<(batch: ReplicaAddressedBatch) => void>(), outboxListeners = new Set<() => void>()
  const parked = noticeFixture().deadLetters
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
    pool, source, messages,
    writeMessage(id: string, next: MessageRecordWire | undefined) {
      if (next) messages.set(id, next); else messages.delete(id)
      return () => emit({ type: 'update', rows: [{ kind: 'messageRecords', id }] })
    },
    renameSelected(name: string) {
      pool.apply({ type: 'replace', rows: [{ kind: 'session', id: 'selected', value: {
        sessionId: 'selected', name, cwd: '/synthetic', agentKind: 'codex',
      } as never }] })
    },
  }
}

it('probes full notice log open, new notice and label change at 1x/4x', async () => {
  const measured = []
  for (const scale of [1, 4] as const) {
    const f = fixture(scale)
    let current = noticeMessages(f.pool)
    try {
      const open = await measureWork(async () => {
        const stop = autorun(() => { current = noticeMessages(f.pool) }, { name: 'consumer:full-notice-log' })
        await Promise.resolve()
        return stop
      }, { pool: f.pool })
      const stop = await open.value
      try {
        const noticeCount = 128 * scale + 2
        expect(current.notices).toHaveLength(noticeCount)
        expect(current.notices[0]?.messageId).toBe('z-message')
        const add = f.writeMessage('fresh-notice', message('fresh-notice', 'fresh-session', 'failed', '2026-10-06T12:00:00Z'))
        const added = await measureWork(async () => add(), { pool: f.pool })
        expect(current.notices).toHaveLength(noticeCount + 1)
        expect(current.notices[0]?.messageId).toBe('fresh-notice')
        const relabel = await measureWork(async () => f.renameSelected('Renamed agent'), { pool: f.pool })
        expect(current.notices.filter(row => row.sessionId === 'selected').map(row => row.sessionLabel))
          .toEqual(['Renamed agent', 'Renamed agent'])
        measured.push({ scale, notices: noticeCount, open: compact(open.work),
          added: compact(added.work), relabel: compact(relabel.work) })
      } finally { stop() }
    } finally { f.pool.dispose() }
  }
  console.info('[full notice log probe]', JSON.stringify(measured))
})
