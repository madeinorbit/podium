import type { MetadataChange } from '@podium/protocol'
import type { AuthorityPort, ScopedChange, ScopedDelivery } from '@podium/sync'
import { Ledger } from '@podium/sync'
import { describe, expect, it, vi } from 'vitest'
import { SessionStore } from '../store'
import { EventBus } from './bus'
import { WriteFunnel } from './funnel'

function makeFunnel() {
  const store = new SessionStore(':memory:')
  const bus = new EventBus()
  const fanOutSnapshot = vi.fn()
  const sendDelta = vi.fn()
  const ledger = new Ledger({
    repo: store.sync,
    now: () => 1_000,
    transact: (fn) => store.transact(fn),
  })
  // THE SAME Authority the Ledger wraps — the wiring production uses (POD-305).
  const funnel = new WriteFunnel({ bus, fanOutSnapshot, sendDelta, authority: ledger.authority })
  return { store, bus, fanOutSnapshot, sendDelta, ledger, funnel }
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
  return {
    authority,
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
      for (const fn of listeners) fn(delivery)
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

describe('WriteFunnel.publishComputed ([spec:SP-3fe2] #255/#256)', () => {
  it('fans out ONLY the legacy snapshot — no change append, no metadataDelta', () => {
    const { funnel, fanOutSnapshot, sendDelta, bus } = makeFunnel()
    const appended = vi.fn()
    bus.on('oplog.appended', appended)
    const snapshot = { type: 'issueUpdated', issue: {} } as never
    funnel.publishComputed(snapshot)
    funnel.flushDeltas()
    expect(fanOutSnapshot).toHaveBeenCalledWith(snapshot, {})
    expect(sendDelta).not.toHaveBeenCalled() // deltas come from the subscribe pipe only
    expect(funnel.cursor()).toBe(0) // no change-log append
    expect(appended).not.toHaveBeenCalled()
  })

  it('bridges Authority appends onto the bus AND into the delta pipe', () => {
    const bus = new EventBus()
    const fake = fakeAuthority()
    const appended = vi.fn()
    const sendDelta = vi.fn()
    bus.on('oplog.appended', appended)
    const funnel = new WriteFunnel({
      bus,
      fanOutSnapshot: vi.fn(),
      sendDelta,
      authority: fake.authority,
    })
    const changes = [{ seq: 1, entity: 'issue', id: 'iss_1', op: 'remove' }] as MetadataChange[]
    fake.emit(changes)
    expect(appended).toHaveBeenCalledWith({ changes })
    funnel.flushDeltas()
    expect(sendDelta).toHaveBeenCalledWith(changes)
  })
})

describe('the ordered metadataDelta pipe (#256)', () => {
  function pipedFunnel() {
    const bus = new EventBus()
    const sendDelta = vi.fn()
    const fake = fakeAuthority()
    const funnel = new WriteFunnel({
      bus,
      fanOutSnapshot: vi.fn(),
      sendDelta,
      authority: fake.authority,
    })
    return { funnel, sendDelta, appended: fake.emit }
  }

  const up = (
    seq: number,
    entity: 'issue' | 'session' | 'conversation',
    id: string,
  ): MetadataChange => ({ seq, entity, id, op: 'upsert', value: { id } }) as MetadataChange

  it('a synchronous burst of ledger batches — all three entity kinds — emits as ONE batch in append (= seq) order', () => {
    const { funnel, sendDelta, appended } = pipedFunnel()
    appended([up(1, 'session', 's1')])
    appended([up(2, 'issue', 'i1'), up(3, 'issue', 'i2')])
    appended([up(4, 'conversation', 'c1')]) // conversations ride the same pipe (#257)
    appended([up(5, 'session', 's1')])
    expect(sendDelta).not.toHaveBeenCalled() // coalescing: nothing mid-burst
    funnel.flushDeltas()
    expect(sendDelta).toHaveBeenCalledTimes(1)
    const [batch] = sendDelta.mock.calls[0] as [MetadataChange[]]
    // Strict append order, batches interleaved — the pipe NEVER reorders.
    expect(batch.map((c) => `${c.entity}:${c.id}`)).toEqual([
      'session:s1',
      'issue:i1',
      'issue:i2',
      'conversation:c1',
      'session:s1',
    ])
  })

  it('flushes on the microtask boundary without an explicit flush', async () => {
    const { sendDelta, appended } = pipedFunnel()
    appended([up(1, 'session', 's1')])
    await Promise.resolve()
    expect(sendDelta).toHaveBeenCalledTimes(1)
  })

  it('queues the batch into the pipe BEFORE the bus emit — a reentrant commit cannot reorder it (#247)', () => {
    // Real Ledger + real bus: a bus listener that commits AGAIN during
    // 'oplog.appended' gets a later seq. If the bridge emitted the bus event
    // first, the inner commit's batch would enter the pipe before the outer
    // one — [N+1, N] — and a delta client's cursor would jump past N without
    // healing. Pipe-first makes arrival order equal append order.
    const { funnel, bus, sendDelta, ledger } = makeFunnel()
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
    const emitted = sendDelta.mock.calls.flatMap(([batch]) => batch as MetadataChange[])
    expect(emitted.map((c) => c.id)).toEqual(['outer', 'inner'])
    // Strict seq order with no gaps — exactly what the client gap rule requires.
    const seqs = emitted.map((c) => c.seq)
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBe((seqs[i - 1] as number) + 1)
  })

  it('a flushed pipe stays quiet until new appends arrive; empty batches never emit', () => {
    const { funnel, sendDelta, appended } = pipedFunnel()
    appended([])
    funnel.flushDeltas()
    expect(sendDelta).not.toHaveBeenCalled()
    appended([up(1, 'session', 's1')])
    funnel.flushDeltas()
    funnel.flushDeltas() // second flush: nothing pending
    expect(sendDelta).toHaveBeenCalledTimes(1)
  })
})
