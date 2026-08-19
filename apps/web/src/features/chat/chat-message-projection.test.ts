import type { TranscriptItem } from '@podium/model/browser'
import { describe, expect, it } from 'vitest'
import type { PendingItem, QueuedChatMessage } from './chat'
import { projectOptimisticMessages } from './chat'

const queued = (id: string, text: string, at: number): QueuedChatMessage => ({
  id,
  text,
  at,
  injectedAt: at,
})

const user = (id: string, text: string, at: number): TranscriptItem => ({
  id,
  role: 'user',
  text,
  ts: new Date(at).toISOString(),
})

const pending = (id: string, text: string, at: number): PendingItem => ({
  id,
  text,
  at,
  state: 'queued',
})

describe('queued message projection', () => {
  it('lets the authoritative transcript replace an injected ledger row', () => {
    const at = Date.parse('2026-08-19T10:00:00.000Z')
    expect(
      projectOptimisticMessages([], [queued('q1', 'hello', at)], [user('u1', 'hello', at)]),
    ).toEqual({ pending: [], queued: [] })
  })

  it('treats a local bubble and its durable ledger row as one message', () => {
    const at = Date.parse('2026-08-19T10:00:00.000Z')
    expect(
      projectOptimisticMessages([pending('p1', 'hello', at)], [queued('q1', 'hello', at)], []),
    ).toEqual({ pending: [pending('p1', 'hello', at)], queued: [] })
  })

  it('consumes identical logical messages FIFO without hiding a distinct send', () => {
    const at = Date.parse('2026-08-19T10:00:00.000Z')
    const p1 = pending('p1', 'again', at)
    const p2 = pending('p2', 'again', at + 1_000)
    const result = projectOptimisticMessages(
      [p1, p2],
      [queued('q1', 'again', at), queued('q2', 'again', at + 1_000)],
      [user('u1', 'again', at)],
    )
    expect(result).toEqual({ pending: [p2], queued: [] })
  })

  it('does not let an old identical turn consume a new ledger row', () => {
    const at = Date.parse('2026-08-19T10:00:00.000Z')
    expect(
      projectOptimisticMessages(
        [],
        [queued('q1', 'again', at)],
        [user('old', 'again', at - 60_000)],
      ),
    ).toEqual({ pending: [], queued: [queued('q1', 'again', at)] })
  })
})
