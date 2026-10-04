import type { OutboxDeadLetterEntry, OutboxEntry } from '@podium/client-core/outbox'
import { asMutationId } from '@podium/model'
import { autorun } from 'mobx'
import { describe, expect, it } from 'vitest'
import { MobxPool } from '../pool'
import { createPoolTransactions } from './transactions'

function record(id: string, target: string, expired = false): OutboxDeadLetterEntry {
  return {
    entry: { mutationId: asMutationId(id), kind: 'issueUpdate', input: { id: target, patch: { title: id } }, queuedAt: 1 },
    reason: { code: expired ? 'max-age' : 'conflict' },
    parkedFrom: expired ? 'expired' : 'rejected', deadLetteredAt: 2, attempts: 1,
  }
}

function fixture(initial: OutboxDeadLetterEntry[] = []) {
  let parked = initial
  let publish = (_size: number) => {}
  const tx = createPoolTransactions({
    userId: 'u',
    outbox: {
      pending: () => [], awaiting: () => [], deadLetters: () => parked,
      subscribe: (listener) => { publish = listener; return () => {} },
    },
    outcomes: () => () => {}, enqueue: async () => {}, addressed: () => () => {},
  })
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  pool.attachTransactions(tx)
  return {
    tx, pool,
    set(next: OutboxDeadLetterEntry[]) { parked = next; publish(0) },
    dispose() { tx.dispose(); pool.dispose() },
  }
}

describe('row-local not-saved state from PoolTransactions', () => {
  it('restores refused and expired marks on boot without reading or loading targets', () => {
    const f = fixture([record('a', 'refused'), record('b', 'expired', true)])
    try {
      expect(f.pool.notSaved('issue', 'refused')).toBe(true)
      expect(f.pool.notSaved('issue', 'expired')).toBe(true)
      expect(f.pool.notSaved('issue', 'other')).toBe(false)
      expect(f.pool.notSaved('session', 'refused')).toBe(false)
      expect(f.pool.tables.issue.size).toBe(0)
    } finally { f.dispose() }
  })

  it('keeps a mark until the last parked change leaves, without waking unrelated rows', () => {
    const f = fixture()
    const target: boolean[] = [], other: boolean[] = []
    const stops = [
      autorun(() => target.push(f.pool.notSaved('issue', 'target'))),
      autorun(() => other.push(f.pool.notSaved('issue', 'other'))),
    ]
    try {
      const a = record('a', 'target'), b = record('b', 'target', true)
      f.set([a, b])
      f.set([b])
      expect(target).toEqual([false, true])
      f.set([])
      expect(target).toEqual([false, true, false])
      expect(other).toEqual([false])
    } finally { stops.forEach(stop => stop()); f.dispose() }
  })

  it('moves marks when a parked record is edited and follows session renames and chat sends', () => {
    const f = fixture([record('a', 'before')])
    try {
      f.set([record('a', 'after')])
      expect(f.pool.notSaved('issue', 'before')).toBe(false)
      expect(f.pool.notSaved('issue', 'after')).toBe(true)
      for (const kind of ['rename', 'sendText', 'resumeAndSend']) {
        const entry: OutboxEntry = {
          mutationId: asMutationId(kind), kind,
          input: { sessionId: 'session', name: 'mine', text: 'mine' }, queuedAt: 1,
        }
        f.set([{ ...record('a', 'after'), entry }])
        expect(f.pool.notSaved('session', 'session'), kind).toBe(true)
        expect(f.pool.notSaved('issue', 'after')).toBe(false)
      }
      f.set([])
      expect(f.pool.notSaved('session', 'session')).toBe(false)
    } finally { f.dispose() }
  })
})
