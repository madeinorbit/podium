/**
 * Replica row-notification coalescing (#262 review [spec:SP-3fe2]): the
 * multi-transaction application paths — applySnapshot's delete+upsert,
 * applyChanges' remove+upsert, and a multi-kind batch() (how the hub wiring
 * applies a whole metadata snapshot/heal/delta) — must each deliver at most ONE
 * `subscribeRows` notification per kind, fired against the FINAL state. A
 * listener observing the transient list between the transactions is exactly
 * what yanked the engine's worktree selection (see engine.test.ts).
 */

import type { IssueWire, SessionMeta } from '@podium/protocol'
import { describe, expect, it, vi } from 'vitest'
import { createReplica, memoryStorage } from './replica'

function session(id: string): SessionMeta {
  return {
    sessionId: id,
    agentKind: 'claude-code',
    title: id,
    cwd: '/w',
    status: 'live',
    controllerId: 'c0',
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 1,
    createdAt: '2026-07-01T00:00:00.000Z',
    lastActiveAt: '2026-07-01T00:00:00.000Z',
    origin: { kind: 'spawn' },
    archived: false,
    readAt: null,
    unread: false,
  } as unknown as SessionMeta
}

const issue = (id: string): IssueWire => ({ id, title: id }) as unknown as IssueWire

describe('replica row-notification coalescing (#262 review)', () => {
  it('applySnapshot (delete + upsert) notifies once, against the final rows', () => {
    const replica = createReplica({ storage: memoryStorage() })
    replica.applySnapshot('sessions', [session('a')])
    const observed: string[][] = []
    replica.subscribeRows('sessions', () => {
      observed.push(replica.rows('sessions').map((s) => s.sessionId))
    })
    // Full replace a → b: internally a delete transaction THEN an upsert
    // transaction; the listener must never see the empty middle state.
    replica.applySnapshot('sessions', [session('b')])
    expect(observed).toEqual([['b']])
  })

  it('applyChanges (remove + upsert) notifies once, against the final rows', () => {
    const replica = createReplica({ storage: memoryStorage() })
    replica.applyChanges('sessions', [session('a')], [])
    const observed: string[][] = []
    replica.subscribeRows('sessions', () => {
      observed.push(replica.rows('sessions').map((s) => s.sessionId))
    })
    replica.applyChanges('sessions', [session('b')], ['a'])
    expect(observed).toEqual([['b']])
  })

  it('batch() spans kinds: a whole snapshot application notifies once per kind, after all kinds applied', () => {
    const replica = createReplica({ storage: memoryStorage() })
    replica.applySnapshot('sessions', [session('a')])
    replica.applySnapshot('issues', [issue('i1')])
    const observed: Array<{ kind: string; sessions: string[]; issues: string[] }> = []
    const record = (kind: string) => () =>
      observed.push({
        kind,
        sessions: replica.rows('sessions').map((s) => s.sessionId),
        issues: replica.rows('issues').map((i) => i.id),
      })
    replica.subscribeRows('sessions', record('sessions'))
    replica.subscribeRows('issues', record('issues'))
    // The hub-wiring shape: several applySnapshot calls in one batch. Every
    // notification fires AFTER the batch — both kinds already final.
    replica.batch(() => {
      replica.applySnapshot('sessions', [session('b')])
      replica.applySnapshot('issues', [issue('i2')])
    })
    expect(observed).toEqual([
      { kind: 'sessions', sessions: ['b'], issues: ['i2'] },
      { kind: 'issues', sessions: ['b'], issues: ['i2'] },
    ])
  })

  it('a listener that writes back into the replica converges iteratively (no recursion, no dropped notification)', () => {
    const replica = createReplica({ storage: memoryStorage() })
    let calls = 0
    replica.subscribeRows('sessions', () => {
      calls++
      // First delivery reacts by writing again — the follow-up must arrive as
      // ONE more delivery from the same (iterative) flush, not a recursive
      // re-entry duplicating notifications or growing the stack.
      if (calls === 1) replica.applyChanges('sessions', [session('b')], [])
    })
    replica.applyChanges('sessions', [session('a')], [])
    expect(calls).toBe(2)
    expect(
      replica
        .rows('sessions')
        .map((s) => s.sessionId)
        .sort(),
    ).toEqual(['a', 'b'])
  })

  it('a listener that writes on EVERY notification is cut off instead of looping forever', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const replica = createReplica({ storage: memoryStorage() })
      let calls = 0
      replica.subscribeRows('sessions', () => {
        calls++
        replica.applyChanges('sessions', [{ ...session('x'), title: `t${calls}` }], [])
      })
      // Must return (bounded rounds), not blow the stack or spin.
      replica.applyChanges('sessions', [session('a')], [])
      expect(calls).toBeGreaterThan(0)
      expect(calls).toBeLessThanOrEqual(101)
      expect(err.mock.calls.some((c) => String(c[0]).includes('did not converge'))).toBe(true)
    } finally {
      err.mockRestore()
    }
  })

  it('an untouched kind is not notified, and unsubscribe stops delivery', () => {
    const replica = createReplica({ storage: memoryStorage() })
    let sessionCalls = 0
    let issueCalls = 0
    const offSessions = replica.subscribeRows('sessions', () => sessionCalls++)
    replica.subscribeRows('issues', () => issueCalls++)
    replica.batch(() => replica.applySnapshot('sessions', [session('a')]))
    expect(sessionCalls).toBe(1)
    expect(issueCalls).toBe(0)
    offSessions()
    replica.applySnapshot('sessions', [session('b')])
    expect(sessionCalls).toBe(1)
  })
})
