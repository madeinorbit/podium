import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createOutbox,
  type Outbox,
  type OutboxEntry,
  type OutboxStorage,
  parseOutboxEntries,
} from './outbox'

type Kinds = {
  rename: { sessionId: string; name: string }
  snoozeClear: { sessionId: string }
}

function memoryStorage(seed: string | null = null): {
  storage: OutboxStorage
  raw: () => string | null
} {
  let raw = seed
  return {
    storage: {
      load: () => parseOutboxEntries(raw),
      save: (entries) => {
        raw = JSON.stringify(entries)
      },
    },
    raw: () => raw,
  }
}

function deterministicIds(): () => string {
  let n = 0
  return () => `m-${++n}`
}

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

function make(
  init: {
    isOnline?: () => boolean
    retryMs?: number
    storage?: OutboxStorage
    randomId?: () => string
  } = {},
): Outbox<Kinds> {
  const { executors } = makeExecutors()
  const backing = init.storage ?? memoryStorage().storage
  const ob = createOutbox<Kinds>({
    executors,
    storage: backing,
    isOnline: init.isOnline,
    retryMs: init.retryMs,
    randomId: init.randomId ?? deterministicIds(),
  })
  outboxes.push(ob)
  return ob
}

afterEach(() => {
  for (const ob of outboxes.splice(0)) ob.dispose()
  vi.restoreAllMocks()
})

describe('storage-neutral outbox', () => {
  it('drains enqueued entries in FIFO order with stable mutation ids', async () => {
    const { calls, executors } = makeExecutors()
    const ob = createOutbox<Kinds>({
      executors,
      storage: memoryStorage().storage,
      randomId: deterministicIds(),
      now: () => 1000,
    })
    outboxes.push(ob)
    const a = ob.enqueue('rename', { sessionId: 's1', name: 'one' })
    const b = ob.enqueue('snoozeClear', { sessionId: 's2' })
    await ob.drain()
    expect(calls.map((c) => c.kind)).toEqual(['rename', 'snoozeClear'])
    expect(calls[0]?.input).toEqual({ sessionId: 's1', name: 'one', mutationId: a.mutationId })
    expect(calls[1]?.input).toEqual({ sessionId: 's2', mutationId: b.mutationId })
    expect([a.mutationId, b.mutationId]).toEqual(['m-1', 'm-2'])
    expect(ob.size()).toBe(0)
  })

  it('reloads persisted entries with the same mutation ids and FIFO order', async () => {
    const backing = memoryStorage()
    const first = createOutbox<Kinds>({
      executors: makeExecutors().executors,
      storage: backing.storage,
      isOnline: () => false,
      randomId: deterministicIds(),
    })
    outboxes.push(first)
    const a = first.enqueue('rename', { sessionId: 's1', name: 'one' })
    const b = first.enqueue('rename', { sessionId: 's1', name: 'two' })
    first.dispose()

    const { calls, executors } = makeExecutors()
    const second = createOutbox<Kinds>({
      executors,
      storage: backing.storage,
      isOnline: () => false,
      randomId: deterministicIds(),
    })
    outboxes.push(second)
    expect(second.size()).toBe(2)
    await second.drain()
    expect(calls.map((c) => c.input.mutationId)).toEqual([a.mutationId, b.mutationId])
    expect(backing.raw()).toBe('[]')
  })

  it('drops poison entries, surfaces them, and keeps draining', async () => {
    const poison = Object.assign(new Error('bad input'), {
      data: { code: 'BAD_REQUEST', httpStatus: 400 },
    })
    const dropped: OutboxEntry[] = []
    const { calls, executors } = makeExecutors(async (_kind, input) => {
      if ((input as { name?: string }).name === 'bad') throw poison
      return {}
    })
    const ob = createOutbox<Kinds>({
      executors,
      storage: memoryStorage().storage,
      onPoison: (entry) => dropped.push(entry),
      randomId: deterministicIds(),
    })
    outboxes.push(ob)
    ob.enqueue('rename', { sessionId: 's1', name: 'bad' })
    const ok = ob.enqueue('rename', { sessionId: 's1', name: 'good' })
    await ob.drain()
    expect(dropped.map((e) => e.kind)).toEqual(['rename'])
    expect(calls.at(-1)?.input.mutationId).toBe(ok.mutationId)
    expect(ob.size()).toBe(0)
  })

  it('keeps entries on network errors and retries on the flat timer', async () => {
    let fail = true
    const { calls, executors } = makeExecutors(async () => {
      if (fail) throw new Error('fetch failed')
      return {}
    })
    const ob = createOutbox<Kinds>({
      executors,
      storage: memoryStorage().storage,
      retryMs: 5,
      randomId: deterministicIds(),
    })
    outboxes.push(ob)
    ob.enqueue('rename', { sessionId: 's1', name: 'one' })
    await ob.drain()
    expect(calls).toHaveLength(1)
    expect(ob.size()).toBe(1)
    fail = false
    await vi.waitFor(() => expect(ob.size()).toBe(0))
    expect(calls).toHaveLength(2)
  })

  it('is single-flight: a drain during a drain joins the same pass', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const { calls, executors } = makeExecutors(() => gate)
    const ob = createOutbox<Kinds>({
      executors,
      storage: memoryStorage().storage,
      randomId: deterministicIds(),
    })
    outboxes.push(ob)
    ob.enqueue('rename', { sessionId: 's1', name: 'one' })
    const d1 = ob.drain()
    const d2 = ob.drain()
    await Promise.resolve()
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

  it('onApplied fires after the executor resolves, BEFORE subscribers observe the shrunken queue', async () => {
    const events: string[] = []
    const { executors } = makeExecutors()
    const ob = createOutbox<Kinds>({
      executors,
      storage: memoryStorage().storage,
      randomId: deterministicIds(),
      onApplied: (entry) => events.push(`applied:${entry.mutationId}`),
    })
    outboxes.push(ob)
    ob.subscribe((n) => events.push(`size:${n}`))
    ob.enqueue('rename', { sessionId: 's1', name: 'one' })
    await ob.drain()
    // The overlay handoff (#263) depends on this order: at the moment
    // subscribers see the entry gone, onApplied has already staged it.
    expect(events).toEqual(['size:1', 'applied:m-1', 'size:0'])
  })

  it('pending() snapshots the FIFO queue without exposing the live array', () => {
    const ob = make({ isOnline: () => false })
    const a = ob.enqueue('rename', { sessionId: 's1', name: 'one' })
    const b = ob.enqueue('snoozeClear', { sessionId: 's2' })
    const snap = ob.pending()
    expect(snap.map((e) => e.mutationId)).toEqual([a.mutationId, b.mutationId])
    snap.pop()
    expect(ob.size()).toBe(2)
  })

  it('a drain in flight at dispose() cannot persist over a successor outbox (provider recreation)', async () => {
    const backing = memoryStorage()
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const { executors } = makeExecutors(() => gate)
    const ob1 = createOutbox<Kinds>({
      executors,
      storage: backing.storage,
      randomId: deterministicIds(),
    })
    outboxes.push(ob1)
    const a = ob1.enqueue('rename', { sessionId: 's1', name: 'one' })
    const d1 = ob1.drain() // in flight, parked on the gate
    await Promise.resolve()
    // The replacement outbox loads the same storage and enqueues a NEW write.
    const ob2 = createOutbox<Kinds>({
      executors: makeExecutors().executors,
      storage: backing.storage,
      isOnline: () => false,
      randomId: () => 'm-succ',
    })
    outboxes.push(ob2)
    const b = ob2.enqueue('snoozeClear', { sessionId: 's2' })
    expect(parseOutboxEntries(backing.raw()).map((e) => e.mutationId)).toEqual([
      a.mutationId,
      b.mutationId,
    ])
    // Old engine disposed; its drain completes afterwards — it must NOT write
    // its stale queue (which lacks b) back over the successor's.
    ob1.dispose()
    release()
    await d1
    expect(parseOutboxEntries(backing.raw()).map((e) => e.mutationId)).toEqual([
      a.mutationId,
      b.mutationId,
    ])
    // a stays queued (its shift wasn't persisted) — the successor replays it,
    // deduped server-side by the stable mutationId.
    expect(ob2.size()).toBe(2)
  })

  it('reads corrupt storage as an empty queue', () => {
    expect(
      make({ isOnline: () => false, storage: memoryStorage('{not json').storage }).size(),
    ).toBe(0)
    const malformed = JSON.stringify([{ mutationId: 1 }, null])
    expect(make({ isOnline: () => false, storage: memoryStorage(malformed).storage }).size()).toBe(
      0,
    )
  })
})
