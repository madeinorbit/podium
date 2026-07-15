/**
 * Replica row-notification coalescing (#262 review [spec:SP-3fe2]): the
 * multi-transaction application paths — applySnapshot's delete+upsert,
 * applyChanges' remove+upsert, and a multi-kind batch() (how the hub wiring
 * applies a whole metadata snapshot/heal/delta) — must each deliver at most ONE
 * `subscribeRows` notification per kind, fired against the FINAL state. A
 * listener observing the transient list between the transactions is exactly
 * what yanked the engine's worktree selection (see engine.test.ts).
 */

import type { AutomationRunWire, AutomationWire, IssueWire, SessionMeta } from '@podium/protocol'
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

const automation = (id: string, name = id): AutomationWire => ({
  id,
  name,
  enabled: true,
  repoPath: '/r',
  cron: '* * * * *',
  agentKind: 'codex',
  model: 'auto',
  effort: 'auto',
  prompt: 'Run it.',
  sessionMode: 'fresh',
  nextRunAt: '2026-07-01T00:01:00.000Z',
  lastRunAt: null,
  createdAt: '2026-07-01T00:00:00.000Z',
})

const automationRun = (id: string, automationId: string): AutomationRunWire => ({
  id,
  automationId,
  firedAt: '2026-07-01T00:00:00.000Z',
  sessionId: 'sess_1',
  outcome: 'spawned',
  detail: null,
})

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

  it('mirrors automation definitions and run history as independent durable kinds', () => {
    const replica = createReplica({ storage: memoryStorage() })
    const a = automation('aut_1', 'Nightly')
    const run = automationRun('arun_1', a.id)
    const observed: Array<{ automations: string[]; runs: string[] }> = []
    const record = () =>
      observed.push({
        automations: replica.rows('automations').map((row) => row.name),
        runs: replica.rows('automationRuns').map((row) => row.id),
      })
    replica.subscribeRows('automations', record)
    replica.subscribeRows('automationRuns', record)

    replica.batch(() => {
      replica.applySnapshot('automations', [a])
      replica.applySnapshot('automationRuns', [run])
    })
    expect(observed).toEqual([
      { automations: ['Nightly'], runs: ['arun_1'] },
      { automations: ['Nightly'], runs: ['arun_1'] },
    ])

    replica.batch(() => {
      replica.applyChanges('automations', [automation(a.id, 'Nightly v2')], [])
      replica.applyChanges('automationRuns', [], [run.id])
    })
    expect(replica.rows('automations').map((row) => row.name)).toEqual(['Nightly v2'])
    expect(replica.rows('automationRuns')).toEqual([])
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

  it('a write landing around the flush cap still reaches subscribers via the deferred microtask flush (#263 finding 5)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const replica = createReplica({ storage: memoryStorage() })
      let calls = 0
      replica.subscribeRows('sessions', () => {
        calls++
        // Writes past the synchronous 100-round cap, then stops: a converging
        // burst. The old cap CLEARED the remainder at round 101, leaving
        // subscribers stuck behind replica truth until the next write.
        if (calls <= 150) {
          replica.applyChanges('sessions', [{ ...session('x'), title: `t${calls}` }], [])
        }
      })
      replica.applyChanges('sessions', [session('a')], [])
      // The synchronous flush stops at the cap (the stack stays bounded) …
      expect(calls).toBeLessThanOrEqual(101)
      expect(err.mock.calls.some((c) => String(c[0]).includes('did not converge'))).toBe(true)
      await new Promise((r) => setTimeout(r, 0))
      // … and the microtask continuation delivered EVERY remaining
      // notification: the final write is observed, nothing dropped. (>= — the
      // collection's async persistence can add a trailing delivery.)
      expect(calls).toBeGreaterThanOrEqual(151)
      expect(replica.rows('sessions').some((s) => (s as { title?: string }).title === 't150')).toBe(
        true,
      )
      // A CONVERGING burst is never cut off: the drop branch (which strands
      // subscribers behind replica truth until the next unrelated write —
      // finding 5's bug) must not have fired. In this harness the collection's
      // trailing async events can mask a drop by restarting delivery, so the
      // no-drop pin is the discriminator.
      expect(err.mock.calls.some((c) => String(c[0]).includes('dropping the remainder'))).toBe(
        false,
      )
    } finally {
      err.mockRestore()
    }
  })

  it('a listener that writes on EVERY notification is cut off after bounded deferrals instead of spinning forever', async () => {
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
      // The deferred continuations are BOUNDED: the pathological writer is
      // dropped loudly after a fixed number of microtask rounds, so the
      // microtask queue cannot spin forever. (The collection's async
      // persistence events can restart a bounded burst or two — the ceiling
      // is loose on purpose; the property under test is TERMINATION.)
      await new Promise((r) => setTimeout(r, 0))
      expect(calls).toBeLessThanOrEqual(5000)
      expect(err.mock.calls.some((c) => String(c[0]).includes('dropping the remainder'))).toBe(true)
      // …and it stays terminated (no self-rescheduling ghost flushes).
      const settled = calls
      await new Promise((r) => setTimeout(r, 0))
      expect(calls).toBe(settled)
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

describe('replica outbox storage: in-place entry transitions (#263 review finding 1)', () => {
  it('persists a queued → awaiting-truth transition on an existing mutationId across reloads', () => {
    const storage = memoryStorage()
    const prefix = 'ob.transition'
    const entry = {
      mutationId: 'm-1',
      kind: 'rename',
      input: { sessionId: 's1', name: 'one' },
      queuedAt: 1000,
      baseline: '{"n":0}',
    }
    const a = createReplica({ storage, keyPrefix: prefix }).outboxStorage()
    a.save([entry])
    // The transition rewrites the SAME mutationId with new fields — the old
    // insert/delete-only diff silently dropped it (the row stayed 'queued').
    a.save([{ ...entry, state: 'awaiting-truth' as const, resolvedAt: 2000 }])
    const b = createReplica({ storage, keyPrefix: prefix }).outboxStorage()
    expect(b.load()).toEqual([{ ...entry, state: 'awaiting-truth', resolvedAt: 2000 }])
    // Deleting at retirement round-trips too.
    b.save([])
    const c = createReplica({ storage, keyPrefix: prefix }).outboxStorage()
    expect(c.load()).toEqual([])
  })
})
