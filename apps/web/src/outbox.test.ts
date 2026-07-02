import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOutbox, OUTBOX_LS_KEY, type Outbox, type OutboxEntry } from './outbox'

// ---------------------------------------------------------------------------
// Outbox (docs/spec/outbox-write-path.md §2.3): durable FIFO of covered
// mutations. Entries persist to localStorage under podium.outbox.v1, drain
// sequentially with a stable mutationId, drop only on validation (poison)
// errors, and survive network failures for the next trigger.
// ---------------------------------------------------------------------------

type Kinds = {
  rename: { sessionId: string; name: string }
  snoozeClear: { sessionId: string }
}

/** Executor recorder: every drained call lands in `calls`, resolved via `impl`. */
function makeExecutors(
  impl: (kind: string, input: unknown) => Promise<unknown> = async () => ({}),
) {
  const calls: Array<{ kind: string; input: Record<string, unknown> }> = []
  const wrap =
    (kind: string) =>
    async (input: Record<string, unknown>): Promise<unknown> => {
      calls.push({ kind, input })
      return impl(kind, input)
    }
  return { calls, executors: { rename: wrap('rename'), snoozeClear: wrap('snoozeClear') } }
}

const outboxes: Outbox<Kinds>[] = []
function make(init: { isOnline?: () => boolean; retryMs?: number } = {}): Outbox<Kinds> {
  const { executors } = makeExecutors()
  const ob = createOutbox<Kinds>({ executors, isOnline: init.isOnline, retryMs: init.retryMs })
  outboxes.push(ob)
  return ob
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  for (const ob of outboxes.splice(0)) ob.dispose()
  vi.restoreAllMocks()
})

describe('outbox', () => {
  it('drains enqueued entries in FIFO order with their mutationIds', async () => {
    const { calls, executors } = makeExecutors()
    const ob = createOutbox<Kinds>({ executors })
    outboxes.push(ob)
    const a = ob.enqueue('rename', { sessionId: 's1', name: 'one' })
    const b = ob.enqueue('snoozeClear', { sessionId: 's2' })
    await ob.drain()
    expect(calls.map((c) => c.kind)).toEqual(['rename', 'snoozeClear'])
    expect(calls[0]?.input).toEqual({ sessionId: 's1', name: 'one', mutationId: a.mutationId })
    expect(calls[1]?.input).toEqual({ sessionId: 's2', mutationId: b.mutationId })
    expect(ob.size()).toBe(0)
  })

  it('keeps mutationIds stable across a simulated reload (re-init from localStorage)', async () => {
    // "Offline" first life: entries persist but never drain.
    const first = make({ isOnline: () => false })
    const a = first.enqueue('rename', { sessionId: 's1', name: 'one' })
    const b = first.enqueue('rename', { sessionId: 's1', name: 'two' })
    first.dispose()
    // Second life re-reads the same localStorage key — same ids, same order.
    const { calls, executors } = makeExecutors()
    const second = createOutbox<Kinds>({ executors })
    outboxes.push(second)
    expect(second.size()).toBe(2)
    await second.drain()
    expect(calls.map((c) => c.input.mutationId)).toEqual([a.mutationId, b.mutationId])
    expect(localStorage.getItem(OUTBOX_LS_KEY)).toBe('[]')
  })

  it('drops a poison (BAD_REQUEST) entry, surfaces it, and keeps draining', async () => {
    const poison = Object.assign(new Error('bad input'), {
      data: { code: 'BAD_REQUEST', httpStatus: 400 },
    })
    const dropped: OutboxEntry[] = []
    const { calls, executors } = makeExecutors(async (_kind, input) => {
      if ((input as { name?: string }).name === 'bad') throw poison
      return {}
    })
    const ob = createOutbox<Kinds>({ executors, onPoison: (entry) => dropped.push(entry) })
    outboxes.push(ob)
    ob.enqueue('rename', { sessionId: 's1', name: 'bad' })
    const ok = ob.enqueue('rename', { sessionId: 's1', name: 'good' })
    await ob.drain()
    // The poison entry is gone, the one behind it still delivered.
    expect(dropped.map((e) => e.kind)).toEqual(['rename'])
    expect(calls.at(-1)?.input.mutationId).toBe(ok.mutationId)
    expect(ob.size()).toBe(0)
  })

  it('keeps the entry on a network error and retries on the flat timer', async () => {
    let fail = true
    const { calls, executors } = makeExecutors(async () => {
      if (fail) throw new Error('fetch failed')
      return {}
    })
    const ob = createOutbox<Kinds>({ executors, retryMs: 5 })
    outboxes.push(ob)
    ob.enqueue('rename', { sessionId: 's1', name: 'one' })
    await ob.drain()
    // Failed pass: attempted once, entry retained (never dropped silently).
    expect(calls).toHaveLength(1)
    expect(ob.size()).toBe(1)
    fail = false
    // The flat retry timer re-drains without any external trigger.
    await vi.waitFor(() => expect(ob.size()).toBe(0))
    expect(calls).toHaveLength(2)
  })

  it('is single-flight: a drain during a drain joins the same pass', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const { calls, executors } = makeExecutors(() => gate)
    const ob = createOutbox<Kinds>({ executors })
    outboxes.push(ob)
    ob.enqueue('rename', { sessionId: 's1', name: 'one' })
    const d1 = ob.drain()
    const d2 = ob.drain()
    await Promise.resolve()
    // Only one executor call in flight despite two drain calls (+ the enqueue trigger).
    expect(calls).toHaveLength(1)
    release()
    await Promise.all([d1, d2])
    expect(calls).toHaveLength(1)
    expect(ob.size()).toBe(0)
  })

  it('notifies subscribers with the reactive size on enqueue and dequeue', async () => {
    const sizes: number[] = []
    const ob = make({ isOnline: () => false })
    const off = ob.subscribe((n) => sizes.push(n))
    ob.enqueue('rename', { sessionId: 's1', name: 'one' })
    ob.enqueue('snoozeClear', { sessionId: 's2' })
    expect(sizes).toEqual([1, 2])
    await ob.drain()
    expect(sizes).toEqual([1, 2, 1, 0])
    off()
  })

  it('reads a corrupt localStorage blob as an empty queue', () => {
    localStorage.setItem(OUTBOX_LS_KEY, '{not json')
    expect(make({ isOnline: () => false }).size()).toBe(0)
    localStorage.setItem(OUTBOX_LS_KEY, JSON.stringify([{ mutationId: 1 }, null]))
    expect(make({ isOnline: () => false }).size()).toBe(0)
  })
})
