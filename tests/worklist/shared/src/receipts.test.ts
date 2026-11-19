// @vitest-environment happy-dom
/**
 * POD-4554 (L3b) — the receipts stream over the REAL runtime and both queues
 * (the compatibility queue the round-two counts ran on, and the kernel queue
 * the web app runs), driven by the scenario library's #9 steps
 * (`optimisticEchoAndRejection`) and by the write transport the phase-c arms
 * send through. Stub runtimes only where the real one cannot be made to fail
 * on cue (an enqueue that throws) or to answer twice.
 */

import type { OutboxEntry } from '@podium/client-core/outbox'
import type { OutboxOutcome } from '@podium/client-core/runtime-root'
import {
  asIssueId,
  asMutationId,
  asUserId,
  issueUserStateRowId,
  type MutationId,
} from '@podium/model'
import { Outbox as KernelOutbox } from '@podium/sync/outbox'
import { describe, expect, it, vi } from 'vitest'
import {
  createWriteTransport,
  type ReceiptEvent,
  type ReceiptsRuntime,
  subscribeReceipts,
} from './receipts'
import { createRowSource } from './row-source'
import {
  armMarkReadRejection,
  type ScenarioEngine,
  type ScenarioServer,
  startScenarioEngine,
  upsertIssue,
  writeOptimisticEcho,
  writeOptimisticPress,
} from './scenarios'
import type { WriteTransport } from './write-contract'

/** A mark-read: my own issue row's record edit (POD-6404). */
const markRead = (user: string, id: string) => ({
  kind: 'issueUserState' as const,
  id: issueUserStateRowId(asUserId(user), asIssueId(id)),
  patch: { readAt: '2026-11-05T00:00:00.000Z' },
})

const tick = (ms = 80): Promise<void> => new Promise((r) => setTimeout(r, ms))
const tx = (n: string): MutationId => asMutationId(`00000000-0000-4000-8000-${n.padStart(12, '0')}`)

/** Presses route through the pool transaction owner and applied entries are
 *  held for their echo by its truth-bound log: attach the same feed the pool
 *  host does (truth mode reads truth but never paints). The engine owns
 *  teardown through `ctx.dispose()`; dispose the feed first. */
function attachFeed(ctx: ScenarioEngine) {
  return createRowSource(ctx.engine, ctx.engine.replica, { mode: 'truth' })
}

function issueRow(ctx: ScenarioEngine, id: string): Record<string, unknown> {
  const row = ctx.cache.read('issueProjection', id)?.value as Record<string, unknown> | undefined
  if (!row) throw new Error(`issue ${id} missing from the server cache`)
  return row
}

/** Connectivity the test flips: offline until `goOnline()`. */
function switchableNetwork(): {
  isOnline: () => boolean
  onlineEvents: { add(cb: () => void): void; remove(cb: () => void): void }
  goOnline(): void
} {
  let online = false
  const listeners = new Set<() => void>()
  return {
    isOnline: () => online,
    onlineEvents: { add: (cb) => listeners.add(cb), remove: (cb) => listeners.delete(cb) },
    goOnline: () => {
      online = true
      for (const cb of [...listeners]) cb()
    },
  }
}

describe.each([
  'legacy',
  'kernel',
] as const)('#9 optimisticEchoAndRejection steps on the %s queue', (outbox) => {
  it('a queued press is accepted once by a receiptless server; echoes add no outcome; a refusal rejects once', async () => {
    const network = switchableNetwork()
    const ctx = await startScenarioEngine(1, { outbox, network })
    const feed = attachFeed(ctx)
    const id = ctx.targets.markReadId
    const events: ReceiptEvent[] = []
    const off = subscribeReceipts(ctx.engine, (e) => events.push(e))

    await writeOptimisticPress(ctx)
    expect(events).toEqual([])
    const queued = ctx.engine.services.outbox.queue
      .pending()
      .find((entry) => entry.kind === 'recordEdit')
    expect(queued).toBeDefined()
    network.goOnline()
    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(events).toEqual([{ type: 'accepted', txId: expect.any(String), kind: 'recordEdit', id }])
    // This fixture uses the old per-command routes, which return no covering
    // cursor. Acceptance names the queued press and retires it on the reply.
    const accepted = events[0]!.txId
    expect(accepted).toBe(queued?.mutationId)
    await vi.waitFor(() => expect(ctx.engine.services.outbox.queue.awaiting()).toEqual([]))
    expect(
      ctx.engine.services.outbox.queue.pending().map((entry) => entry.mutationId),
    ).not.toContain(accepted)

    // The echo is recognised by value downstream, not here: no event.
    await writeOptimisticEcho(ctx)
    expect(events).toHaveLength(1)
    // The same echo again (a replayed frame): still nothing.
    await writeOptimisticEcho(ctx)
    expect(events).toHaveLength(1)

    armMarkReadRejection(ctx)
    await writeOptimisticPress(ctx)
    await vi.waitFor(() => expect(events).toHaveLength(2))
    expect(events[1]).toEqual({
      type: 'rejected',
      txId: expect.any(String),
      kind: 'recordEdit',
      id,
      error: { message: 'recordEdit refused (invalid)', code: 'invalid', parked: false },
    })
    expect(events[1]!.txId).not.toBe(accepted)
    // The kernel's own rollback is untouched: the rejected read is gone from
    // every home, and a mark-read is discarded rather than parked.
    const all = [
      ...ctx.engine.services.outbox.queue.pending(),
      ...ctx.engine.services.outbox.queue.awaiting(),
    ]
    expect(all.map((e) => e.mutationId)).not.toContain(events[1]!.txId)
    expect(ctx.engine.services.outbox.queue.deadLetters()).toEqual([])
    off()
    feed.dispose()
    ctx.dispose()
  }, 60_000)
})

describe('write transport on the kernel queue', () => {
  it('sends under the caller txId; the server sees it; one accepted, even when the echo beats the response', async () => {
    const seen: string[] = []
    let ctx: ScenarioEngine | undefined
    const server: ScenarioServer = {
      issueUpdate: async (input) => {
        seen.push(input.mutationId)
        // The broadcast outruns the HTTP response (Linear's refresh race):
        // the echo lands before the command returns.
        upsertIssue(ctx!, input.id, { ...issueRow(ctx!, input.id), ...input.patch }, 5)
        await tick(20)
        return {}
      },
    }
    ctx = await startScenarioEngine(1, { outbox: 'kernel', server })
    const feed = attachFeed(ctx)
    const id = ctx.targets.visibleRootId
    const transport = createWriteTransport(ctx.engine)
    const events: ReceiptEvent[] = []
    transport.subscribe((e) => events.push(e))

    transport.send(tx('1'), { kind: 'issueUpdate', input: { id, patch: { title: 'Renamed' } } })
    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(seen).toEqual([tx('1')])
    expect(events).toEqual([{ type: 'accepted', txId: tx('1'), kind: 'issueUpdate', id }])
    // A second copy of the echo row: no second event.
    upsertIssue(ctx, id, { ...issueRow(ctx, id), title: 'Renamed' }, 6)
    await tick()
    expect(events).toHaveLength(1)
    // The arm's contract type accepts this transport as is.
    const asContract: WriteTransport = transport
    expect(typeof asContract.subscribe).toBe('function')
    feed.dispose()
    ctx.dispose()
  }, 60_000)

  it('a refused title is one rejected, parked for recovery, and the kernel still parks it', async () => {
    const server: ScenarioServer = {
      issueUpdate: async () => {
        throw Object.assign(new Error('nope'), { data: { code: 'BAD_REQUEST', httpStatus: 400 } })
      },
    }
    const ctx = await startScenarioEngine(1, { outbox: 'kernel', server })
    const feed = attachFeed(ctx)
    const id = ctx.targets.visibleRootId
    const transport = createWriteTransport(ctx.engine)
    const events: ReceiptEvent[] = []
    transport.subscribe((e) => events.push(e))
    transport.send(tx('2'), { kind: 'issueUpdate', input: { id, patch: { title: 'Refused' } } })
    await tick()
    expect(events).toEqual([
      {
        type: 'rejected',
        txId: tx('2'),
        kind: 'issueUpdate',
        id,
        error: { message: 'issueUpdate refused (invalid)', code: 'invalid', parked: true },
      },
    ])
    expect(ctx.engine.services.outbox.queue.deadLetters().map((d) => d.entry.mutationId)).toEqual([
      tx('2'),
    ])
    feed.dispose()
    ctx.dispose()
  }, 60_000)

  it('offline: a collapsed mark-read is superseded; pending() lists the survivor; online it is accepted, then acked', async () => {
    const network = switchableNetwork()
    const ctx = await startScenarioEngine(1, { outbox: 'kernel', network })
    const feed = attachFeed(ctx)
    const id = ctx.targets.markReadId
    const marker = ctx.cache.read(
      'issueUserState',
      issueUserStateRowId(ctx.engine.principal.userId, asIssueId(id)),
    )?.value as { readAt?: string | null } | undefined
    const readAtBefore = marker?.readAt ?? null
    const transport = createWriteTransport(ctx.engine)
    const events: ReceiptEvent[] = []
    transport.subscribe((e) => events.push(e))

    transport.send(tx('3'), {
      kind: 'recordEdit',
      input: markRead(ctx.engine.principal.userId, id),
    })
    await tick()
    transport.send(tx('4'), {
      kind: 'recordEdit',
      input: markRead(ctx.engine.principal.userId, id),
    })
    await tick()
    expect(events).toEqual([{ type: 'superseded', txId: tx('3'), kind: 'recordEdit', id }])
    const queued = transport.pending()
    expect(queued).toEqual([
      {
        txId: tx('4'),
        kind: 'recordEdit',
        input: markRead(ctx.engine.principal.userId, id),
        queuedAt: expect.any(Number),
        acked: false,
        base: { readAt: readAtBefore },
      },
    ])

    network.goOnline()
    await tick()
    expect(events.slice(1)).toEqual([{ type: 'accepted', txId: tx('4'), kind: 'recordEdit', id }])
    // No covering cursor came from these legacy routes: the reply retires
    // the accepted entry. The separate truth echo still reaches the replica.
    await vi.waitFor(() => expect(transport.pending()).toEqual([]))
    await writeOptimisticEcho(ctx, id)
    expect(events).toHaveLength(2)
    feed.dispose()
    ctx.dispose()
  }, 60_000)

  it('pending() survives a reload under the same txIds, with no base (the kernel keeps it in memory)', async () => {
    const network = switchableNetwork()
    const ctx = await startScenarioEngine(1, { outbox: 'kernel', network })
    const feed = attachFeed(ctx)
    const id = ctx.targets.visibleRootId
    const transport = createWriteTransport(ctx.engine)
    transport.send(tx('5'), { kind: 'issueUpdate', input: { id, patch: { title: 'Queued' } } })
    await tick()
    expect(transport.pending().map((p) => [p.txId, p.acked, p.base])).toEqual([
      [tx('5'), false, { title: issueRow(ctx, id).title }],
    ])
    await ctx.reload()
    const after = createWriteTransport(ctx.engine).pending()
    expect(after).toEqual([
      {
        txId: tx('5'),
        kind: 'issueUpdate',
        input: { id, patch: { title: 'Queued' } },
        queuedAt: expect.any(Number),
        acked: false,
      },
    ])
    feed.dispose()
    ctx.dispose()
  }, 60_000)

  it('the kernel queue scans for collapsible entries only while an outcome listener is subscribed', async () => {
    const network = switchableNetwork()
    const ctx = await startScenarioEngine(1, { outbox: 'kernel', network })
    const id = ctx.targets.markReadId
    const readsFor = async (txId: MutationId): Promise<number> => {
      const spy = vi.spyOn(KernelOutbox.prototype, 'pending')
      await ctx.engine.services.outbox.queue.enqueue(
        'recordEdit',
        markRead(ctx.engine.principal.userId, id),
        {
          mutationId: txId,
        },
      )
      await tick()
      const n = spy.mock.calls.length
      spy.mockRestore()
      return n
    }
    await readsFor(tx('6')) // something queued to collapse
    const unobserved = await readsFor(tx('7'))
    const events: ReceiptEvent[] = []
    const off = subscribeReceipts(ctx.engine, (e) => events.push(e))
    const observed = await readsFor(tx('8'))
    off()
    const afterOff = await readsFor(tx('9'))
    // One scan, and only while observed. The production runtime has no listener.
    expect(observed - unobserved).toBe(1)
    expect(afterOff).toBe(unobserved)
    expect(events).toEqual([{ type: 'superseded', txId: tx('7'), kind: 'recordEdit', id }])
    ctx.dispose()
  }, 60_000)

  it('a throwing outcome listener neither wedges the drain nor starves the stream', async () => {
    const ctx = await startScenarioEngine(1, { outbox: 'kernel' })
    const feed = attachFeed(ctx)
    ctx.engine.subscribeOutboxOutcomes(() => {
      throw new Error('bad observer')
    })
    const events: ReceiptEvent[] = []
    subscribeReceipts(ctx.engine, (e) => events.push(e))
    await writeOptimisticPress(ctx)
    expect(events.map((e) => e.type)).toEqual(['accepted'])
    // A broken observer does not prevent the receiptless reply from retiring.
    await vi.waitFor(() => expect(ctx.engine.services.outbox.queue.awaiting()).toEqual([]))
    feed.dispose()
    ctx.dispose()
  }, 60_000)
})

describe('receipts over a stub runtime', () => {
  const entry = (mutationId: MutationId): OutboxEntry => ({
    mutationId,
    kind: 'recordEdit',
    input: markRead('stub', 'i1'),
    queuedAt: 1,
  })
  function stub(opts: { enqueue?: () => Promise<void>; queued?: MutationId[] } = {}) {
    const listeners = new Set<(o: OutboxOutcome) => void>()
    const runtime: ReceiptsRuntime = {
      subscribeOutboxOutcomes: (l) => {
        listeners.add(l)
        return () => listeners.delete(l)
      },
      services: {
        outbox: {
          queue: {
            enqueue: () => (opts.enqueue ?? (() => Promise.resolve()))() as never,
            pending: () => (opts.queued ?? []).map(entry),
            awaiting: () => [],
          },
        },
      },
      replica: { row: () => undefined },
      principal: { userId: 'stub' },
    }
    const emit = (o: OutboxOutcome): void => {
      for (const l of [...listeners]) l(o)
    }
    return { runtime, emit, listeners }
  }

  it('delivers one outcome per txId: a second applied, or a late rejection, is dropped', () => {
    const { runtime, emit } = stub()
    const events: ReceiptEvent[] = []
    subscribeReceipts(runtime, (e) => events.push(e))
    emit({ type: 'applied', mutationId: tx('a'), entry: entry(tx('a')) })
    emit({ type: 'applied', mutationId: tx('a'), entry: entry(tx('a')) })
    emit({ type: 'rejected', mutationId: tx('a'), entry: entry(tx('a')), parked: false })
    expect(events).toEqual([{ type: 'accepted', txId: tx('a'), kind: 'recordEdit', id: 'i1' }])
  })

  it('an enqueue that fails before reaching the queue is one rejected for that txId', async () => {
    const { runtime } = stub({ enqueue: () => Promise.reject(new Error('disk full')) })
    const transport = createWriteTransport(runtime)
    const events: ReceiptEvent[] = []
    transport.subscribe((e) => events.push(e))
    transport.send(tx('b'), { kind: 'recordEdit', input: markRead('stub', 'i1') })
    await tick(0)
    expect(events).toEqual([
      {
        type: 'rejected',
        txId: tx('b'),
        kind: 'recordEdit',
        id: 'i1',
        error: { message: 'disk full', parked: false },
      },
    ])
  })

  it('a throw after the entry reached the queue is not a rejection: the kernel still owes the outcome', async () => {
    const { runtime, emit } = stub({
      enqueue: () => Promise.reject(new Error('late')),
      queued: [tx('c')],
    })
    const transport = createWriteTransport(runtime)
    const events: ReceiptEvent[] = []
    transport.subscribe((e) => events.push(e))
    transport.send(tx('c'), { kind: 'recordEdit', input: markRead('stub', 'i1') })
    await tick(0)
    expect(events).toEqual([])
    emit({ type: 'applied', mutationId: tx('c'), entry: entry(tx('c')) })
    expect(events.map((e) => e.type)).toEqual(['accepted'])
  })

  it('unsubscribing detaches from the runtime', () => {
    const { runtime, listeners } = stub()
    const off = createWriteTransport(runtime).subscribe(() => {})
    expect(listeners.size).toBe(1)
    off()
    expect(listeners.size).toBe(0)
  })
})
