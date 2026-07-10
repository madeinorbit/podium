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
      onApplied: (entry) => {
        events.push(`applied:${entry.mutationId}`)
      },
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

  it('onApplied returning true holds the entry DURABLY as awaiting-truth in the SEPARATE home; retireAwaiting deletes it (#263 finding 1 + round 2)', async () => {
    const backing = memoryStorage()
    const awaitingBacking = memoryStorage()
    const { executors } = makeExecutors()
    const ob = createOutbox<Kinds>({
      executors,
      storage: backing.storage,
      awaitingStorage: awaitingBacking.storage,
      randomId: deterministicIds(),
      now: () => 4242,
      onApplied: () => true,
    })
    outboxes.push(ob)
    const a = ob.enqueue('rename', { sessionId: 's1', name: 'one' }, { baseline: '{"n":0}' })
    await ob.drain()
    // Out of the QUEUE (subscriber-visible size), but not out of storage.
    expect(ob.size()).toBe(0)
    expect(ob.pending()).toEqual([])
    expect(ob.awaiting()).toEqual([
      {
        mutationId: a.mutationId,
        kind: 'rename',
        input: { sessionId: 's1', name: 'one' },
        queuedAt: 4242,
        baseline: '{"n":0}',
        state: 'awaiting-truth',
        resolvedAt: 4242,
      },
    ])
    // Round 2 (#263): the held entry lives ONLY in the awaiting home. The
    // queued collection is empty — an OLD build (PWA rollback) reading it
    // must find nothing to re-drain.
    expect(parseOutboxEntries(backing.raw())).toEqual([])
    expect(
      parseOutboxEntries(awaitingBacking.raw()).map((e) => [e.mutationId, e.state, e.baseline]),
    ).toEqual([[a.mutationId, 'awaiting-truth', '{"n":0}']])
    // Retirement is the durable delete.
    ob.retireAwaiting(a.mutationId)
    expect(ob.awaiting()).toEqual([])
    expect(awaitingBacking.raw()).toBe('[]')
    ob.retireAwaiting(a.mutationId) // unknown id — converging no-op
  })

  it('a reloaded awaiting-truth entry restores into awaiting() and is NOT re-executed (new-build round-trip)', async () => {
    const backing = memoryStorage()
    const awaitingBacking = memoryStorage()
    const first = createOutbox<Kinds>({
      executors: makeExecutors().executors,
      storage: backing.storage,
      awaitingStorage: awaitingBacking.storage,
      randomId: deterministicIds(),
      onApplied: () => true,
    })
    outboxes.push(first)
    const a = first.enqueue('rename', { sessionId: 's1', name: 'one' })
    await first.drain()
    first.dispose()
    const { calls, executors } = makeExecutors()
    const second = createOutbox<Kinds>({
      executors,
      storage: backing.storage,
      awaitingStorage: awaitingBacking.storage,
      randomId: () => 'm-succ',
    })
    outboxes.push(second)
    expect(second.size()).toBe(0)
    expect(second.awaiting().map((e) => e.mutationId)).toEqual([a.mutationId])
    // Queued writes drain normally alongside the held entry.
    second.enqueue('snoozeClear', { sessionId: 's2' })
    await second.drain()
    expect(calls.map((c) => c.kind)).toEqual(['snoozeClear']) // no rename replay
    expect(second.awaiting()).toHaveLength(1)
  })

  it('adopts awaiting-marked rows found in the legacy queued collection into the new home — never re-drained (#263 round 2 migration)', async () => {
    // A PREVIOUS build persisted the held entry in the queued collection with
    // state:'awaiting-truth'. The new build must move it to the separate home
    // and delete it from the legacy one, so a subsequent OLD-build load (PWA
    // cache rollback) finds nothing to replay.
    const legacyRows = [
      {
        mutationId: 'm-held',
        kind: 'rename',
        input: { sessionId: 's1', name: 'stale' },
        queuedAt: 1000,
        state: 'awaiting-truth',
        resolvedAt: 1500,
      },
      { mutationId: 'm-q', kind: 'snoozeClear', input: { sessionId: 's2' }, queuedAt: 2000 },
    ]
    const backing = memoryStorage(JSON.stringify(legacyRows))
    const awaitingBacking = memoryStorage()
    const { calls, executors } = makeExecutors()
    const ob = createOutbox<Kinds>({
      executors,
      storage: backing.storage,
      awaitingStorage: awaitingBacking.storage,
      randomId: () => 'm-x',
    })
    outboxes.push(ob)
    // Adopted, not queued: the held row moved homes and only the queued row drains.
    expect(ob.awaiting().map((e) => e.mutationId)).toEqual(['m-held'])
    expect(parseOutboxEntries(backing.raw()).map((e) => e.mutationId)).toEqual(['m-q'])
    expect(parseOutboxEntries(awaitingBacking.raw()).map((e) => e.mutationId)).toEqual(['m-held'])
    await ob.drain()
    expect(calls.map((c) => c.kind)).toEqual(['snoozeClear']) // the stale rename never replayed
    // The legacy collection stays clean of awaiting rows from here on.
    expect(parseOutboxEntries(backing.raw())).toEqual([])
    expect(ob.awaiting()).toHaveLength(1)
  })

  it('adoption dedupes against rows already in the awaiting home (idempotent re-migration)', () => {
    const held = {
      mutationId: 'm-held',
      kind: 'rename',
      input: { sessionId: 's1', name: 'stale' },
      queuedAt: 1000,
      state: 'awaiting-truth' as const,
      resolvedAt: 1500,
    }
    const backing = memoryStorage(JSON.stringify([held]))
    const awaitingBacking = memoryStorage(JSON.stringify([held]))
    const ob = createOutbox<Kinds>({
      executors: makeExecutors().executors,
      storage: backing.storage,
      awaitingStorage: awaitingBacking.storage,
      randomId: () => 'm-x',
    })
    outboxes.push(ob)
    expect(ob.awaiting().map((e) => e.mutationId)).toEqual(['m-held'])
    expect(parseOutboxEntries(backing.raw())).toEqual([])
  })

  it('without an awaitingStorage, legacy awaiting rows are still removed from the queued collection (memory-only hold)', async () => {
    const held = {
      mutationId: 'm-held',
      kind: 'rename',
      input: { sessionId: 's1', name: 'stale' },
      queuedAt: 1000,
      state: 'awaiting-truth' as const,
      resolvedAt: 1500,
    }
    const backing = memoryStorage(JSON.stringify([held]))
    const { calls, executors } = makeExecutors()
    const ob = createOutbox<Kinds>({
      executors,
      storage: backing.storage,
      randomId: () => 'm-x',
    })
    outboxes.push(ob)
    expect(ob.awaiting().map((e) => e.mutationId)).toEqual(['m-held'])
    expect(parseOutboxEntries(backing.raw())).toEqual([]) // old builds see nothing
    await ob.drain()
    expect(calls).toEqual([]) // never re-drained
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
