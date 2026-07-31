import type { MetadataChange } from '@podium/protocol'
import type { AuthorityPort, ScopedChange, ScopedDelivery } from '@podium/sync'
import { Ledger } from '@podium/sync'
import { describe, expect, it, vi } from 'vitest'
import { SessionStore } from '../store'
import { EventBus } from './bus'
import { WriteFunnel } from './funnel'

/** A serving edge that records what it was handed. The funnel's whole output. */
function recordingServing() {
  const published: ScopedDelivery[] = []
  return {
    published,
    port: {
      publish: (_principal: unknown, delivery: ScopedDelivery) => published.push(delivery),
      // Fixed identity: these cases exercise the publication pipe, not D1. The
      // v2 catch-up read has its own coverage where the identity actually varies.
      identity: () => ({ feedId: 'feed-test', epoch: 'epoch-test' }),
      retentionFloor: () => 0,
    },
    /** Every row across every published delivery, in publication order. */
    rows: () =>
      published.flatMap((d) => (d.kind === 'batch' ? d.changes : [])),
  }
}

function makeFunnel() {
  const store = new SessionStore(':memory:')
  const bus = new EventBus()
  const serving = recordingServing()
  const onPublished = vi.fn()
  const ledger = new Ledger({
    repo: store.sync,
    now: () => 1_000,
    transact: (fn) => store.transact(fn),
  })
  // THE SAME Authority the Ledger wraps — the wiring production uses (POD-305).
  const funnel = new WriteFunnel({
    bus,
    serving: serving.port,
    onPublished,
    authority: ledger.authority,
  })
  return { store, bus, serving, onPublished, ledger, funnel }
}

/**
 * A fake Authority exposing only the subscribe bridge (pipe-focused tests).
 *
 * `emit` takes WIRE rows and converts, so these tests keep stating their
 * fixtures in the shape the pipe delivers to clients — which is what they are
 * about — while the funnel still receives the kernel shape it will see in
 * production. Restating every fixture in kernel vocabulary would have changed
 * what these tests are asserting as a side effect of a refactor.
 */
function fakeAuthority() {
  const listeners = new Set<(delivery: ScopedDelivery) => void>()
  const authority = {
    // Two parameters since POD-1077: the feed is per principal, and the funnel's
    // subscription names the device-grade one. This fake ignores WHICH principal
    // on purpose — these cases are about the ordered pipe, and the scoping
    // properties belong to `packages/sync/src/authority/authority.scoped.test.ts`
    // rather than being half-asserted here against a fake that decides nothing.
    subscribe: (_principal: unknown, fn: (delivery: ScopedDelivery) => void) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    changesSince: () => null,
    cursor: () => 0,
  } as unknown as AuthorityPort
  const toKernel = (c: MetadataChange): ScopedChange =>
    ({ seq: c.seq, entity: c.entity, entityId: c.id, op: c.op, value: (c as { value?: unknown }).value }) as ScopedChange
  const deliver = (delivery: ScopedDelivery) => {
    for (const fn of listeners) fn(delivery)
  }
  return {
    authority,
    /** Kernel rows verbatim — for the ops the v1 wire vocabulary cannot spell. */
    emitKernel: (changes: ScopedChange[]) =>
      deliver({
        kind: 'batch',
        throughSeq: changes[changes.length - 1]?.seq ?? 0,
        changes,
      }),
    emitRescope: (throughSeq: number, reason: string) =>
      deliver({ kind: 'rescope', throughSeq, reason }),
    emit: (changes: MetadataChange[]) => {
      const kernel = changes.map(toKernel)
      // The delivery carries the evaluated range beside the rows (D13), so this
      // fake cannot hand the funnel a filtered list with no certified range —
      // the shape the production type forbids is unavailable to the fake too.
      const delivery: ScopedDelivery = {
        kind: 'batch',
        throughSeq: kernel[kernel.length - 1]?.seq ?? 0,
        changes: kernel,
      }
      deliver(delivery)
    },
  }
}

describe('WriteFunnel.run ordering', () => {
  it('runs authorize → write and returns the write result', () => {
    const { funnel } = makeFunnel()
    const order: string[] = []
    const result = funnel.run({
      authorize: () => order.push('authorize'),
      write: () => {
        order.push('write')
        return 42
      },
    })
    expect(result).toBe(42)
    expect(order).toEqual(['authorize', 'write'])
  })

  it('authorize rejecting stops the write', () => {
    const { funnel } = makeFunnel()
    const write = vi.fn()
    expect(() =>
      funnel.run({
        authorize: () => {
          throw new Error('forbidden')
        },
        write,
      }),
    ).toThrow('forbidden')
    expect(write).not.toHaveBeenCalled()
  })
})

describe('WriteFunnel.changesSince / cursor (ledger passthrough)', () => {
  it('serves ledger-appended changes from a cursor (one shared durable log)', () => {
    const { funnel, ledger } = makeFunnel()
    ledger.commit({
      write: () => {},
      changes: () => [{ entity: 'conversation', id: 'c1', op: 'upsert', value: { a: 1 } }],
    })
    const cursor = funnel.cursor()
    ledger.commit({
      write: () => {},
      changes: () => [{ entity: 'conversation', id: 'c1', op: 'upsert', value: { a: 2 } }],
    })
    const changes = funnel.changesSince(cursor)
    expect(changes?.map((c) => c.id)).toEqual(['c1'])
    expect(funnel.cursor()).toBe(2)
  })
})

/**
 * THE ASSERTION THAT FLIPPED (POD-1203).
 *
 * This block used to be `WriteFunnel.publishComputed`, and its first case
 * asserted that a snapshot handed to the funnel reached `fanOutSnapshot` — the
 * SECOND serving path. There is no such method and no such dep, so the case is
 * replaced by its positive form rather than deleted: the funnel's ONLY output is
 * the coalesced delivery it hands the serving edge, and a caller has no way to
 * push a message of its own through it. `expect(funnel).not.toHaveProperty` is
 * the half that would fail if the tail came back under another name.
 */
describe('the funnel has ONE output, and it is the feed', () => {
  it('exposes no way to publish a message beside the feed', () => {
    const { funnel, serving } = makeFunnel()
    expect(funnel).not.toHaveProperty('publishComputed')
    expect(funnel).not.toHaveProperty('fanOutSnapshot')
    // And nothing reaches the edge without an append behind it.
    funnel.flushDeltas()
    expect(serving.published).toEqual([])
    expect(funnel.cursor()).toBe(0)
  })

  it('bridges Authority appends onto the bus AND into the delivery pipe', () => {
    const bus = new EventBus()
    const fake = fakeAuthority()
    const appended = vi.fn()
    const serving = recordingServing()
    bus.on('oplog.appended', appended)
    const funnel = new WriteFunnel({
      bus,
      serving: serving.port,
      onPublished: vi.fn(),
      authority: fake.authority,
    })
    const changes = [{ seq: 1, entity: 'issue', id: 'iss_1', op: 'remove' }] as MetadataChange[]
    fake.emit(changes)
    expect(appended).toHaveBeenCalledWith({ changes })
    funnel.flushDeltas()
    expect(serving.rows().map((c) => c.entityId)).toEqual(['iss_1'])
  })

  it('an evict appends NO bus row — a visibility move is not an entity transition', () => {
    // The bus event drives message-delivery eligibility, which asks "did this
    // entity change?". An evict answers no: the entity is unchanged and one
    // principal's view of it moved. Feeding it through as a remove would be the
    // ADR 2 Am1 D14.5 error in a second place.
    const bus = new EventBus()
    const fake = fakeAuthority()
    const appended = vi.fn()
    const serving = recordingServing()
    bus.on('oplog.appended', appended)
    const funnel = new WriteFunnel({
      bus,
      serving: serving.port,
      onPublished: vi.fn(),
      authority: fake.authority,
    })
    fake.emitKernel([{ seq: 1, entity: 'session', entityId: 's1', op: 'evict' }] as ScopedChange[])
    expect(appended).not.toHaveBeenCalled()
    // It still reaches the EDGE, which is the whole point of the cutover: v2 can
    // express it, and the v1 adapter is where the refusal now lives.
    funnel.flushDeltas()
    expect(serving.rows().map((c) => c.op)).toEqual(['evict'])
  })

  it('a rescope is passed through, in order, instead of throwing', () => {
    // POD-1077 had to THROW here: the pre-cutover wire had no frame for "your
    // rights changed, re-bootstrap", and degrading it to silence is the
    // invisible-gap failure. This is that tripwire in its positive form.
    const bus = new EventBus()
    const fake = fakeAuthority()
    const serving = recordingServing()
    const funnel = new WriteFunnel({
      bus,
      serving: serving.port,
      onPublished: vi.fn(),
      authority: fake.authority,
    })
    fake.emitKernel([{ seq: 1, entity: 'session', entityId: 's1', op: 'upsert', value: {} }] as ScopedChange[])
    fake.emitRescope(2, 'rights-changed')
    fake.emitKernel([{ seq: 3, entity: 'session', entityId: 's2', op: 'upsert', value: {} }] as ScopedChange[])
    funnel.flushDeltas()
    // THREE deliveries, not two: a rescope may not be merged into a batch, so it
    // breaks the coalescing run rather than being swallowed by it.
    expect(serving.published.map((d) => d.kind)).toEqual(['batch', 'rescope', 'batch'])
  })
})

describe('the ordered, coalesced delivery pipe (#256)', () => {
  function pipedFunnel() {
    const bus = new EventBus()
    const serving = recordingServing()
    const onPublished = vi.fn()
    const fake = fakeAuthority()
    const funnel = new WriteFunnel({
      bus,
      serving: serving.port,
      onPublished,
      authority: fake.authority,
    })
    return { funnel, serving, onPublished, appended: fake.emit }
  }

  const up = (
    seq: number,
    entity: 'issue' | 'session' | 'conversation',
    id: string,
  ): MetadataChange => ({ seq, entity, id, op: 'upsert', value: { id } }) as MetadataChange

  it('a synchronous burst of ledger batches — all three entity kinds — emits as ONE batch in append (= seq) order', () => {
    const { funnel, serving, appended } = pipedFunnel()
    appended([up(1, 'session', 's1')])
    appended([up(2, 'issue', 'i1'), up(3, 'issue', 'i2')])
    appended([up(4, 'conversation', 'c1')]) // conversations ride the same pipe (#257)
    appended([up(5, 'session', 's1')])
    expect(serving.published).toEqual([]) // coalescing: nothing mid-burst
    funnel.flushDeltas()
    expect(serving.published).toHaveLength(1)
    // COALESCED BEFORE FRAMING, which is what keeps a boot reconcile one frame
    // per connection instead of one per commit: the merged delivery certifies
    // through the LAST range evaluated.
    expect(serving.published[0]?.throughSeq).toBe(5)
    // Strict append order, batches interleaved — the pipe NEVER reorders.
    expect(serving.rows().map((c) => `${c.entity}:${c.entityId}`)).toEqual([
      'session:s1',
      'issue:i1',
      'issue:i2',
      'conversation:c1',
      'session:s1',
    ])
  })

  it('flushes on the microtask boundary without an explicit flush', async () => {
    const { serving, appended } = pipedFunnel()
    appended([up(1, 'session', 's1')])
    await Promise.resolve()
    expect(serving.published).toHaveLength(1)
  })

  it('tells the publication worker the feed advanced, ONCE per coalesced batch', () => {
    // Not once per recipient and not once per commit: the worker's cursor is a
    // fact about the feed's position. Four appends, one advance, at the head.
    const { funnel, onPublished, appended } = pipedFunnel()
    appended([up(1, 'session', 's1')])
    appended([up(2, 'issue', 'i1')])
    funnel.flushDeltas()
    expect(onPublished.mock.calls).toEqual([[2]])
  })

  it('queues the batch into the pipe BEFORE the bus emit — a reentrant commit cannot reorder it (#247)', () => {
    // Real Ledger + real bus: a bus listener that commits AGAIN during
    // 'oplog.appended' gets a later seq. If the bridge emitted the bus event
    // first, the inner commit's batch would enter the pipe before the outer
    // one — [N+1, N] — and a delta client's cursor would jump past N without
    // healing. Pipe-first makes arrival order equal append order.
    const { funnel, bus, serving, ledger } = makeFunnel()
    let reentered = false
    bus.on('oplog.appended', () => {
      if (reentered) return
      reentered = true
      ledger.commit({
        write: () => {},
        changes: () => [{ entity: 'issue', id: 'inner', op: 'upsert', value: { id: 'inner' } }],
      })
    })
    ledger.commit({
      write: () => {},
      changes: () => [{ entity: 'issue', id: 'outer', op: 'upsert', value: { id: 'outer' } }],
    })
    funnel.flushDeltas()
    const emitted = serving.rows()
    expect(emitted.map((c) => c.entityId)).toEqual(['outer', 'inner'])
    // Strict seq order with no gaps — exactly what the client gap rule requires.
    const seqs = emitted.map((c) => c.seq)
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBe((seqs[i - 1] as number) + 1)
  })

  it('an EMPTY evaluated range is published as a watermark, not swallowed', () => {
    // THE OTHER ASSERTION THAT FLIPPED. The old pipe dropped an empty batch
    // ("empty batches never emit"), which was safe only because nothing was ever
    // filtered: under private-by-default an empty range is the normal path, and
    // dropping it is the permanent invisible gap D13 exists to close. The funnel
    // now hands it on; whether it certifies anything is the publisher's decision,
    // made against each connection's own position.
    const { funnel, serving, appended } = pipedFunnel()
    appended([])
    funnel.flushDeltas()
    expect(serving.published.map((d) => [d.kind, d.throughSeq])).toEqual([['batch', 0]])
  })

  it('a flushed pipe stays quiet until new appends arrive', () => {
    const { funnel, serving, appended } = pipedFunnel()
    appended([up(1, 'session', 's1')])
    funnel.flushDeltas()
    funnel.flushDeltas() // second flush: nothing pending
    expect(serving.published).toHaveLength(1)
  })
})
