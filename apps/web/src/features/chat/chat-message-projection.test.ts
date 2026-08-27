import type { TranscriptItem } from '@podium/model/browser'
import { describe, expect, it } from 'vitest'
import type { PendingItem, QueuedChatMessage } from './chat'
import {
  pairPendingWithQueued,
  projectOptimisticMessages,
  reconcileQueued,
  tailAppendedUserItems,
} from './chat'

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

const pending = (id: string, text: string, at: number, toolPaths?: string[]): PendingItem => ({
  id,
  text,
  at,
  state: 'queued',
  ...(toolPaths ? { toolPaths } : {}),
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
    const p = pending('p1', 'hello', at)
    const q = queued('q1', 'hello', at)
    expect(projectOptimisticMessages([p], [q], [])).toEqual({
      pending: [{ ...p, durable: q }],
      queued: [],
    })
  })

  it('replaces a stale local ordinal with the durable reload position', () => {
    const at = Date.parse('2026-08-19T10:00:00.000Z')
    const p = { ...pending('p1', 'hello', at), deliveryId: 'q1', queuePosition: 4 }
    const q = { ...queued('q1', 'hello', at), injectedAt: null, queuePosition: 1 }
    expect(pairPendingWithQueued([p], [q])).toEqual({
      pending: [{ ...p, queuePosition: 1, durable: q }],
      queued: [],
    })
  })

  it('consumes identical logical messages FIFO without hiding a distinct send', () => {
    const at = Date.parse('2026-08-19T10:00:00.000Z')
    const p1 = pending('p1', 'again', at)
    const p2 = pending('p2', 'again', at + 1_000)
    const q2 = queued('q2', 'again', at + 1_000)
    const result = projectOptimisticMessages(
      [p1, p2],
      [queued('q1', 'again', at), q2],
      [user('u1', 'again', at)],
    )
    expect(result).toEqual({ pending: [{ ...p2, durable: q2 }], queued: [] })
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

  it('uses the delivery id instead of lending a new send an older identical queue row', () => {
    const at = Date.parse('2026-08-19T10:00:00.000Z')
    const old = queued('old-id', 'again', at - 10_000)
    const current = queued('new-id', 'again', at)
    const p = { ...pending('p1', 'again', at), deliveryId: 'new-id' }
    expect(pairPendingWithQueued([p], [old])).toEqual({ pending: [p], queued: [old] })
    expect(pairPendingWithQueued([p], [old, current])).toEqual({
      pending: [{ ...p, durable: current }],
      queued: [old],
    })
  })

  it('does not let an undated historical turn consume a new send', () => {
    const at = Date.parse('2026-08-19T10:00:00.000Z')
    const historical = { id: 'old', role: 'user', text: 'again' } as TranscriptItem
    const p = pending('p1', 'again', at)
    expect(projectOptimisticMessages([p], [], [historical])).toEqual({
      pending: [p],
      queued: [],
    })
  })

  it('collapses attachment sends after providers normalize paths out of the text', () => {
    const at = Date.parse('2026-08-19T10:00:00.000Z')
    const path = '/home/u/.podium/uploads/s1/shot.png'
    const q = queued('q1', `${path}\nlook at this`, at)
    const p = pending('p1', `${path}\nlook at this`, at, [path])
    const echoed = { ...user('u1', 'look at this', at), toolPaths: [path] }
    expect(projectOptimisticMessages([p], [q], [echoed])).toEqual({ pending: [], queued: [] })
    expect(projectOptimisticMessages([], [q], [echoed])).toEqual({ pending: [], queued: [] })
  })

  it('collapses attachment sends when the transcript retains the path only in text', () => {
    const at = Date.parse('2026-08-19T10:00:00.000Z')
    const path = '/home/u/.podium/uploads/s1/shot.png'
    const text = `${path}\nlook at this`
    const q = queued('q1', text, at)
    const p = pending('p1', text, at, [path])
    const echoed = user('u1', text, at)
    expect(projectOptimisticMessages([p], [q], [echoed])).toEqual({ pending: [], queued: [] })
  })

  it('reconciles a newly arrived undated attachment echo by id freshness', () => {
    const path = '/home/u/.podium/uploads/s1/shot.png'
    const q = queued('q1', `${path}\nlook at this`, Date.now())
    const echoed = {
      id: 'u1',
      role: 'user',
      text: 'look at this',
      toolPaths: [path],
    } as TranscriptItem
    expect(reconcileQueued([q], [echoed])).toEqual([])
  })

  it('does not classify prepended history as a newly delivered tail row', () => {
    const old = { id: 'old', role: 'user', text: 'again' } as TranscriptItem
    const tail = { id: 'tail', role: 'user', text: 'current tail' } as TranscriptItem
    const echo = { id: 'echo', role: 'user', text: 'again' } as TranscriptItem
    expect(tailAppendedUserItems([old, tail], tail.id, true)).toEqual([])
    expect(tailAppendedUserItems([old, tail, echo], tail.id, true)).toEqual([echo])
  })
})
