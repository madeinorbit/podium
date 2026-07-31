import { asSessionId } from '@podium/model'
import type { SessionId } from '@podium/model'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createOutbox,
  type Outbox,
  type OutboxEntry,
  type OutboxStorage,

  parseOutboxEntries,
} from './outbox'

type Kinds = {
  rename: { sessionId: SessionId; name: string }
  snoozeClear: { sessionId: SessionId }
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
    const a = ob.enqueue('rename', { sessionId: asSessionId('s1'), name: 'one' })
    const b = ob.enqueue('snoozeClear', { sessionId: asSessionId('s2') })
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
    const a = first.enqueue('rename', { sessionId: asSessionId('s1'), name: 'one' })
    const b = first.enqueue('rename', { sessionId: asSessionId('s1'), name: 'two' })
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

  it('PARKS poison entries rather than dropping them, surfaces them, and keeps draining', async () => {
    // Renamed from "drops poison entries" (POD-316). The old name described the
    // defect: D9 invariant 1 forbids exactly this drop, and the assertion below
    // is the counterfactual — an implementation that still shifts-and-forgets
    // leaves `deadLetters()` empty and reddens here rather than passing under a
    // name nobody re-reads.
    const poison = Object.assign(new Error('bad input'), {
      data: { code: 'BAD_REQUEST', httpStatus: 400 },
    })
    const surfaced: OutboxEntry[] = []
    const { calls, executors } = makeExecutors(async (_kind, input) => {
      if ((input as { name?: string }).name === 'bad') throw poison
      return {}
    })
    const ob = createOutbox<Kinds>({
      executors,
      storage: memoryStorage().storage,
      onPoison: (entry) => surfaced.push(entry),
      randomId: deterministicIds(),
    })
    outboxes.push(ob)
    const bad = ob.enqueue('rename', { sessionId: asSessionId('s1'), name: 'bad' })
    const ok = ob.enqueue('rename', { sessionId: asSessionId('s1'), name: 'good' })
    await ob.drain()
    expect(surfaced.map((e) => e.kind)).toEqual(['rename'])
    expect(calls.at(-1)?.input.mutationId).toBe(ok.mutationId)
    expect(ob.size()).toBe(0)
    // The work is OUT of the drain queue and still THERE, with the author's own
    // text intact.
    const parked = ob.deadLetters()
    expect(parked.map((d) => d.entry.mutationId)).toEqual([bad.mutationId])
    expect(parked[0]?.entry.input).toEqual({ sessionId: 's1', name: 'bad' })
    expect(parked[0]?.reason.code).toBe('invalid')
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
    ob.enqueue('rename', { sessionId: asSessionId('s1'), name: 'one' })
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
    ob.enqueue('rename', { sessionId: asSessionId('s1'), name: 'one' })
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
    ob.enqueue('rename', { sessionId: asSessionId('s1'), name: 'one' })
    ob.enqueue('snoozeClear', { sessionId: asSessionId('s2') })
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
    ob.enqueue('rename', { sessionId: asSessionId('s1'), name: 'one' })
    await ob.drain()
    // The overlay handoff (#263) depends on this order: at the moment
    // subscribers see the entry gone, onApplied has already staged it.
    expect(events).toEqual(['size:1', 'applied:m-1', 'size:0'])
  })

  it('pending() snapshots the FIFO queue without exposing the live array', () => {
    const ob = make({ isOnline: () => false })
    const a = ob.enqueue('rename', { sessionId: asSessionId('s1'), name: 'one' })
    const b = ob.enqueue('snoozeClear', { sessionId: asSessionId('s2') })
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
    const a = ob1.enqueue('rename', { sessionId: asSessionId('s1'), name: 'one' })
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
    const b = ob2.enqueue('snoozeClear', { sessionId: asSessionId('s2') })
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
    const a = ob.enqueue('rename', { sessionId: asSessionId('s1'), name: 'one' }, { baseline: '{"n":0}' })
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
    const a = first.enqueue('rename', { sessionId: asSessionId('s1'), name: 'one' })
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
    second.enqueue('snoozeClear', { sessionId: asSessionId('s2') })
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

/**
 * POD-316 — the recovery surface, tested from the REFUSING arm first.
 *
 * The dominant defect of this fan-out is an instrument that cannot say no, and
 * an outbox suite that only enqueues and drains proves neither the lifecycle nor
 * the dead-letter path. Every test below is written so that reverting the
 * behaviour it guards reddens it: the two counterfactuals that matter are
 * "a definitive refusal retries forever" (the shipped bug) and "a parked entry
 * comes back as drainable work" (POD-1220's shape).
 */
describe('definitive refusals park for recovery instead of retrying forever', () => {
  const refusal = (data: Record<string, unknown>) => Object.assign(new Error('refused'), { data })

  function parkOn(error: unknown): {
    ob: Outbox<Kinds>
    calls: Array<{ kind: string; input: Record<string, unknown> }>
    deadLetterRaw: () => string | null
  } {
    let raw: string | null = null
    const { calls, executors } = makeExecutors(async (_kind, input) => {
      if ((input as { name?: string }).name === 'refused') throw error
      return {}
    })
    const ob = createOutbox<Kinds>({
      executors,
      storage: memoryStorage().storage,
      deadLetterStorage: {
        load: () => parseOutboxEntries(raw),
        save: (entries) => {
          raw = JSON.stringify(entries)
        },
      },
      retryMs: 5,
      randomId: deterministicIds(),
      now: () => 5000,
    })
    outboxes.push(ob)
    return { ob, calls, deadLetterRaw: () => raw }
  }

  // The table IS the point: before this change only the BAD_REQUEST row was
  // definitive, so every other row here retried against a server guaranteed to
  // refuse it identically — a wedged partition, forever, with the user's work
  // invisible behind it.
  it.each([
    ['UNAUTHORIZED (rights revoked while offline — D8/D16)', { code: 'UNAUTHORIZED' }, 'unauthorized'],
    ['FORBIDDEN', { httpStatus: 403 }, 'unauthorized'],
    ['NOT_FOUND (merged with unauthorized — property 15)', { code: 'NOT_FOUND' }, 'unauthorized'],
    ['CONFLICT (stale expectedRevision — D13.3)', { code: 'CONFLICT' }, 'conflict'],
    ['PRECONDITION_FAILED (out-of-scope — D8 outcome 3)', { httpStatus: 412 }, 'confirmation-required'],
    ['BAD_REQUEST (validation poison — D10)', { code: 'BAD_REQUEST' }, 'invalid'],
  ])('parks %s as %s with zero automatic retries', async (_label, data, expectedCode) => {
    const { ob, calls } = parkOn(refusal(data))
    ob.enqueue('rename', { sessionId: asSessionId('s1'), name: 'refused' })
    await ob.drain()
    expect(ob.deadLetters().map((d) => d.reason.code)).toEqual([expectedCode])
    expect(ob.size()).toBe(0)
    const attemptsAfterPark = calls.length
    // D10: zero automatic retries. A second drain must not re-send it.
    await ob.drain()
    expect(calls.length).toBe(attemptsAfterPark)
  })

  it('keeps an UNRECOGNISED refusal queued and retryable — an unknown code is transient, not a park', async () => {
    // Fails OPEN toward keeping the user's work. The opposite default would park
    // on a guess, and a parked entry is one the drain never touches again.
    const { ob } = parkOn(refusal({ code: 'TEAPOT', httpStatus: 418 }))
    ob.enqueue('rename', { sessionId: asSessionId('s1'), name: 'refused' })
    await ob.drain()
    expect(ob.deadLetters()).toEqual([])
    expect(ob.size()).toBe(1)
  })

  it('survives a reload: a parked entry is still recoverable, and is NOT in the drain queue', async () => {
    // POD-1220's shape, as a counterfactual. If the park were written into the
    // queued home (or the load path boolean-split on `state`), the reloaded
    // outbox would report size 1 and REPLAY a mutation the Authority definitively
    // refused. Both halves are asserted: recoverable AND not drainable.
    let queuedRaw: string | null = null
    let deadRaw: string | null = null
    const queued: OutboxStorage = {
      load: () => parseOutboxEntries(queuedRaw),
      save: (e) => {
        queuedRaw = JSON.stringify(e)
      },
    }
    const dead: OutboxStorage = {
      load: () => parseOutboxEntries(deadRaw),
      save: (e) => {
        deadRaw = JSON.stringify(e)
      },
    }
    const first = createOutbox<Kinds>({
      executors: makeExecutors(async () => {
        throw refusal({ code: 'UNAUTHORIZED' })
      }).executors,
      storage: queued,
      deadLetterStorage: dead,
      randomId: deterministicIds(),
    })
    outboxes.push(first)
    first.enqueue('rename', { sessionId: asSessionId('s1'), name: 'mine' })
    await first.drain()
    first.dispose()

    const { calls, executors } = makeExecutors()
    const second = createOutbox<Kinds>({
      executors,
      storage: queued,
      deadLetterStorage: dead,
      randomId: deterministicIds(),
    })
    outboxes.push(second)
    expect(second.size()).toBe(0)
    expect(second.deadLetters().map((d) => d.entry.input)).toEqual([
      { sessionId: 's1', name: 'mine' },
    ])
    await second.drain()
    expect(calls).toEqual([])
  })
})

describe('recovery affordances are enforced, not advertised', () => {
  function parked(code: string): Outbox<Kinds> {
    const ob = createOutbox<Kinds>({
      executors: makeExecutors(async (_k, input) => {
        if ((input as { name?: string }).name === 'refused')
          throw Object.assign(new Error('no'), { data: { code } })
        return {}
      }).executors,
      storage: memoryStorage().storage,
      randomId: deterministicIds(),
    })
    outboxes.push(ob)
    return ob
  }

  it('REFUSES a retry whose precondition is not satisfied — an authz denial cannot be waved through with a rebase', async () => {
    // The button the UI must not be able to offer. Without this the recovery
    // surface happily re-queues an entry that will be refused identically, which
    // is a retry loop with a human in it.
    const ob = parked('UNAUTHORIZED')
    const e = ob.enqueue('rename', { sessionId: asSessionId('s1'), name: 'refused' })
    await ob.drain()
    expect(ob.recoveryFor(e.mutationId)?.retry).toBe('rights-fix')
    expect(() => ob.retry(e.mutationId, { expectedRevision: 7 })).toThrow(/rights-fix/)
    expect(ob.deadLetters()).toHaveLength(1)
  })

  it('REFUSES every retry of a validation-poison entry — only an edit can succeed', async () => {
    const ob = parked('BAD_REQUEST')
    const e = ob.enqueue('rename', { sessionId: asSessionId('s1'), name: 'refused' })
    await ob.drain()
    expect(ob.recoveryFor(e.mutationId)?.retry).toBe('never')
    expect(() => ob.retry(e.mutationId, { rightsFixed: true })).toThrow()
    expect(() => ob.retry(e.mutationId, { expectedRevision: 1 })).toThrow()
  })

  it('re-queues on a satisfied precondition, and the retried entry applies', async () => {
    const ob = parked('CONFLICT')
    const e = ob.enqueue('rename', { sessionId: asSessionId('s1'), name: 'refused' })
    await ob.drain()
    expect(ob.recoveryFor(e.mutationId)?.retry).toBe('rebase')
    const requeued = ob.retry(e.mutationId, { expectedRevision: 9 })
    expect(requeued.mutationId).toBe(e.mutationId)
    expect(ob.deadLetters()).toEqual([])
    expect(ob.size()).toBe(1)
  })

  it('offers the SAME affordances for every flavour of unauthorized — the oracle must not leak through the button row', async () => {
    // amendment property 15 + POD-370's byte-identical constraint, asserted at
    // the surface POD-316 owns. A helpful "you lost access to issue X" string or
    // a withheld button for one flavour would re-open, in the UI, the existence
    // oracle the kernel closed in `normalizeRefusal`.
    const denied = parked('FORBIDDEN')
    const missing = parked('NOT_FOUND')
    const a = denied.enqueue('rename', { sessionId: asSessionId('s1'), name: 'refused' })
    const b = missing.enqueue('rename', { sessionId: asSessionId('s1'), name: 'refused' })
    await denied.drain()
    await missing.drain()
    expect(denied.recoveryFor(a.mutationId)).toEqual(missing.recoveryFor(b.mutationId))
    const [pa] = denied.deadLetters()
    const [pb] = missing.deadLetters()
    expect(pa?.reason).toEqual(pb?.reason)
  })

  it('edits with a NEW mutationId, and discards without touching the target', async () => {
    const ob = parked('BAD_REQUEST')
    const e = ob.enqueue('rename', { sessionId: asSessionId('s1'), name: 'refused' })
    await ob.drain()
    const revised = ob.edit(e.mutationId, { sessionId: asSessionId('s1'), name: 'fixed' })
    // D11.4: the original id may still hold a receipt, so a revised command must
    // not reuse it or the receipt would suppress the fix.
    expect(revised.mutationId).not.toBe(e.mutationId)
    expect(revised.input).toEqual({ sessionId: 's1', name: 'fixed' })

    const other = parked('FORBIDDEN')
    const f = other.enqueue('rename', { sessionId: asSessionId('s2'), name: 'refused' })
    await other.drain()
    expect(other.discard(f.mutationId)).toBe(true)
    expect(other.deadLetters()).toEqual([])
  })

  it('expires aged entries into dead-letter with a new-id precondition (D10 max-age / D11.4)', async () => {
    let clock = 1000
    const ob = createOutbox<Kinds>({
      executors: makeExecutors().executors,
      storage: memoryStorage().storage,
      isOnline: () => false,
      randomId: deterministicIds(),
      now: () => clock,
    })
    outboxes.push(ob)
    const old = ob.enqueue('rename', { sessionId: asSessionId('s1'), name: 'stale' })
    clock += 20_000
    const swept = ob.sweepExpired(10_000)
    expect(swept.map((d) => d.reason.code)).toEqual(['max-age'])
    expect(swept[0]?.parkedFrom).toBe('expired')
    expect(ob.size()).toBe(0)
    expect(ob.recoveryFor(old.mutationId)?.retry).toBe('new-mutation-id')
    // Retrying without minting a fresh id is refused — the old id may still have
    // a receipt past the dedupe horizon.
    expect(() => ob.retry(old.mutationId, { rightsFixed: true })).toThrow()
    const fresh = ob.retry(old.mutationId, { mutationId: 'm-fresh' })
    expect(fresh.mutationId).toBe('m-fresh')
  })
})
