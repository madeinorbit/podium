import { TRPCClientError } from '@trpc/client'
import { describe, expect, it } from 'vitest'
import { SessionStore } from './store'
import {
  isDefinitiveRejection,
  optimisticIssuePatch,
  UpstreamForwarder,
  type UpstreamForwarderOptions,
} from './upstream-forwarder'

// Unit coverage for the node→hub issue write path (docs/spec/node-hub-issues.md §2.2):
// direct forward vs. durable enqueue, serial paced drain, flat retry, poison drop.
// The hub call is a seam; the outbox is the REAL SQLite table (durability is the point).

/** A hub the test scripts: each call consults `mode` at call time. */
function makeHub() {
  const calls: { proc: string; input: Record<string, unknown> }[] = []
  const state = { mode: 'ok' as 'ok' | 'down' | 'reject' }
  const call = async (proc: string, input: Record<string, unknown>): Promise<unknown> => {
    calls.push({ proc, input })
    if (state.mode === 'down') throw new TRPCClientError('fetch failed') // transport: no data
    if (state.mode === 'reject')
      throw new TRPCClientError('forbidden', {
        result: { error: { message: 'forbidden', code: -32003, data: { code: 'FORBIDDEN' } } },
      } as never)
    return { ok: true, proc }
  }
  return { calls, state, call }
}

function makeForwarder(overrides: Partial<UpstreamForwarderOptions> = {}) {
  const store = new SessionStore(':memory:')
  const hub = makeHub()
  const yields: number[] = []
  const forwarder = new UpstreamForwarder({
    store: store.sync,
    call: hub.call,
    paceMs: 7,
    retryMs: 20,
    sleep: async (ms) => {
      yields.push(ms)
    },
    ...overrides,
  })
  return { store, hub, forwarder, yields }
}

const until = async (pred: () => boolean, ms = 2000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('isDefinitiveRejection', () => {
  it('true only for a structured tRPC error response (hub SAW the mutation)', () => {
    expect(
      isDefinitiveRejection(
        new TRPCClientError('bad', {
          result: { error: { message: 'bad', code: -32600, data: { code: 'BAD_REQUEST' } } },
        } as never),
      ),
    ).toBe(true)
    expect(isDefinitiveRejection(new TRPCClientError('fetch failed'))).toBe(false)
    expect(isDefinitiveRejection(new TypeError('fetch failed'))).toBe(false)
  })
})

describe('UpstreamForwarder.forward', () => {
  it('hub up → the hub result comes straight back, nothing queued', async () => {
    const { hub, forwarder } = makeForwarder()
    const res = await forwarder.forward('update', { id: 'iss_h', mutationId: 'm1' })
    expect(res).toEqual({ ok: true, proc: 'update' })
    expect(forwarder.entries()).toHaveLength(0)
    expect(hub.calls[0]?.input.mutationId).toBe('m1')
    forwarder.stop()
  })

  it('hub unreachable → durably queued, resolves { queued: true }', async () => {
    const { hub, forwarder, store } = makeForwarder()
    hub.state.mode = 'down'
    const res = await forwarder.forward('close', { id: 'iss_h', mutationId: 'm2' })
    expect(res).toEqual({ queued: true })
    // Durable: the row is in SQLite, not just process memory.
    const rows = store.sync.listUpstreamOutbox()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.proc).toBe('close')
    expect(JSON.parse(rows[0]?.input ?? '{}').id).toBe('iss_h')
    forwarder.stop()
  })

  it('a definitive hub rejection propagates and is NOT queued', async () => {
    const { hub, forwarder } = makeForwarder()
    hub.state.mode = 'reject'
    await expect(forwarder.forward('delete', { id: 'iss_h', mutationId: 'm3' })).rejects.toThrow(
      'forbidden',
    )
    expect(forwarder.entries()).toHaveLength(0)
    forwarder.stop()
  })

  it('requires a mutationId (the outbox PK + hub idempotency key)', async () => {
    const { forwarder } = makeForwarder()
    await expect(forwarder.forward('update', { id: 'iss_h' })).rejects.toThrow(/mutationId/)
    forwarder.stop()
  })

  it('a replayed enqueue with the same mutationId is a no-op (PK dedupe)', async () => {
    const { hub, forwarder } = makeForwarder()
    hub.state.mode = 'down'
    await forwarder.forward('update', { id: 'iss_h', mutationId: 'dup' })
    await forwarder.forward('update', { id: 'iss_h', mutationId: 'dup' })
    expect(forwarder.entries()).toHaveLength(1)
    forwarder.stop()
  })
})

describe('UpstreamForwarder.drain', () => {
  // Drain tests enqueue via the store directly — forward() also auto-triggers a
  // background drain (spec: drain on enqueue), which would race the scripted one.
  const enqueue = (
    store: SessionStore,
    mutationId: string,
    proc: string,
    input: Record<string, unknown>,
    at: number,
  ) =>
    store.sync.enqueueUpstreamMutation({
      mutationId,
      proc,
      input: JSON.stringify({ ...input, mutationId }),
      queuedAt: at,
    })

  it('drains serially in FIFO order with a pacing yield between entries', async () => {
    const { hub, forwarder, store, yields } = makeForwarder()
    enqueue(store, 'q1', 'update', { id: 'iss_a' }, 1)
    enqueue(store, 'q2', 'close', { id: 'iss_b' }, 2)
    enqueue(store, 'q3', 'claim', { id: 'iss_c', assignee: 'me' }, 3)
    await forwarder.drain()
    expect(hub.calls.map((c) => c.proc)).toEqual(['update', 'close', 'claim'])
    // Each replay carries its OWN mutationId (hub-side idempotency, invariant 2).
    expect(hub.calls.map((c) => c.input.mutationId)).toEqual(['q1', 'q2', 'q3'])
    expect(store.sync.listUpstreamOutbox()).toHaveLength(0)
    // Watchdog pacing rule: a yield between drained entries.
    expect(yields.length).toBeGreaterThanOrEqual(3)
    expect(yields.every((ms) => ms === 7)).toBe(true)
    forwarder.stop()
  })

  it('a transport failure mid-drain stops the pass (order kept), bumps attempts, and the flat retry finishes the job', async () => {
    const { hub, forwarder, store } = makeForwarder()
    hub.state.mode = 'down'
    enqueue(store, 'r1', 'update', { id: 'iss_a' }, 1)
    enqueue(store, 'r2', 'close', { id: 'iss_b' }, 2)
    await forwarder.drain() // down: first entry fails, pass stops
    expect(hub.calls.map((c) => c.input.mutationId)).toEqual(['r1'])
    const rows = store.sync.listUpstreamOutbox()
    expect(rows).toHaveLength(2)
    expect(rows[0]?.attempts).toBe(1)
    // Hub returns; the armed flat retry (20ms) drains everything, in order.
    hub.state.mode = 'ok'
    await until(() => store.sync.listUpstreamOutbox().length === 0)
    expect(hub.calls.map((c) => c.input.mutationId)).toEqual(['r1', 'r1', 'r2'])
    forwarder.stop()
  })

  it('poison: a definitively rejected entry is dropped, SURFACED via onPoisoned, and the queue keeps draining (#25)', async () => {
    const store = new SessionStore(':memory:')
    const seen: string[] = []
    const poisoned: { proc: string; input: Record<string, unknown>; message: string }[] = []
    const forwarder = new UpstreamForwarder({
      store: store.sync,
      retryMs: 20,
      sleep: async () => {},
      onPoisoned: (proc, input, message) => poisoned.push({ proc, input, message }),
      call: async (_proc, input) => {
        seen.push(String(input.mutationId))
        if (input.mutationId === 'p1')
          throw new TRPCClientError('bad', {
            result: { error: { message: 'bad', code: -32600, data: { code: 'BAD_REQUEST' } } },
          } as never)
        return { ok: true }
      },
    })
    enqueue(store, 'p1', 'delete', { id: 'iss_poison' }, 1)
    enqueue(store, 'p2', 'update', { id: 'iss_fine' }, 2)
    await forwarder.drain()
    expect(seen).toEqual(['p1', 'p2']) // poison seen once, next entry proceeded
    expect(store.sync.listUpstreamOutbox()).toHaveLength(0)
    // The drop is surfaced, once, with the entry's own identity — not just logged.
    expect(poisoned).toHaveLength(1)
    expect(poisoned[0]).toMatchObject({
      proc: 'delete',
      input: { id: 'iss_poison', mutationId: 'p1' },
    })
    forwarder.stop()
  })

  it('drops a corrupt (unparseable) entry instead of wedging the queue', async () => {
    const { hub, forwarder, store } = makeForwarder()
    store.sync.enqueueUpstreamMutation({
      mutationId: 'bad',
      proc: 'update',
      input: 'not json',
      queuedAt: 1,
    })
    enqueue(store, 'good', 'close', { id: 'iss_b' }, 2)
    await forwarder.drain()
    expect(hub.calls.map((c) => c.input.mutationId)).toEqual(['good'])
    expect(store.sync.listUpstreamOutbox()).toHaveLength(0)
    forwarder.stop()
  })

  it('fires onQueueChanged on enqueue and on every dequeue (pendingSync re-derivation)', async () => {
    let changes = 0
    const { hub, forwarder, store } = makeForwarder({ onQueueChanged: () => (changes += 1) })
    hub.state.mode = 'down'
    await forwarder.forward('update', { id: 'iss_a', mutationId: 'c1' })
    expect(changes).toBe(1)
    hub.state.mode = 'ok'
    await until(() => store.sync.listUpstreamOutbox().length === 0 && changes === 2)
    forwarder.stop()
  })
})

describe('optimisticIssuePatch', () => {
  it('maps the representable procs onto IssueWire fields', () => {
    expect(
      optimisticIssuePatch('update', { id: 'i', patch: { title: 'T', priority: 1 } }, 'now'),
    ).toMatchObject({ title: 'T', priority: 1, updatedAt: 'now' })
    expect(optimisticIssuePatch('close', { id: 'i', reason: 'done!' }, 'now')).toMatchObject({
      stage: 'done',
      closedReason: 'done!',
    })
    expect(optimisticIssuePatch('claim', { id: 'i', assignee: 'me' }, 'now')).toMatchObject({
      assignee: 'me',
    })
    expect(optimisticIssuePatch('setLabels', { id: 'i', labels: ['a'] }, 'now')).toMatchObject({
      labels: ['a'],
    })
    expect(optimisticIssuePatch('defer', { id: 'i', until: '2027-01-01' }, 'now')).toMatchObject({
      deferUntil: '2027-01-01',
      deferred: true,
    })
    expect(optimisticIssuePatch('setNeedsHuman', { id: 'i', question: 'q?' }, 'now')).toMatchObject(
      { needsHuman: true, humanQuestion: 'q?' },
    )
    expect(optimisticIssuePatch('clearNeedsHuman', { id: 'i' }, 'now')).toMatchObject({
      needsHuman: false,
    })
    expect(optimisticIssuePatch('archive', { id: 'i' }, 'now')).toMatchObject({ archived: true })
    expect(optimisticIssuePatch('reparent', { id: 'i', parentId: 'p' }, 'now')).toMatchObject({
      parentId: 'p',
    })
  })

  it('unrepresentable procs yield a marker-only patch (pendingSync still shows)', () => {
    expect(optimisticIssuePatch('depAdd', { fromId: 'i', toId: 'j' }, 'now')).toEqual({
      updatedAt: 'now',
    })
    expect(optimisticIssuePatch('start', { id: 'i' }, 'now')).toEqual({ updatedAt: 'now' })
  })
})
