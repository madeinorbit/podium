import type { MetadataChange } from '@podium/protocol'
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
  const funnel = new WriteFunnel({ store, now: () => 1_000, bus, fanOutSnapshot, sendDelta })
  return { store, bus, fanOutSnapshot, sendDelta, funnel }
}

const spec = (id: string) => ({
  entity: 'conversation' as const,
  rows: [{ id, value: { id } }],
  snapshot: { type: 'conversationsChanged', conversations: [], diagnostics: [] } as never,
})

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

  it('authorize rejecting stops the write, the oplog append, and the broadcast', () => {
    const { funnel, fanOutSnapshot, bus } = makeFunnel()
    const write = vi.fn()
    const appended = vi.fn()
    bus.on('oplog.appended', appended)
    expect(() =>
      funnel.run({
        authorize: () => {
          throw new Error('forbidden')
        },
        write,
        publish: () => spec('c1'),
      }),
    ).toThrow('forbidden')
    expect(write).not.toHaveBeenCalled()
    expect(appended).not.toHaveBeenCalled()
    expect(fanOutSnapshot).not.toHaveBeenCalled()
    expect(funnel.cursor()).toBe(0)
  })

  it('a write throw stops the oplog append and the broadcast', () => {
    const { funnel, fanOutSnapshot, bus } = makeFunnel()
    const appended = vi.fn()
    bus.on('oplog.appended', appended)
    expect(() =>
      funnel.run({
        write: () => {
          throw new Error('db down')
        },
        publish: () => spec('c1'),
      }),
    ).toThrow('db down')
    expect(appended).not.toHaveBeenCalled()
    expect(fanOutSnapshot).not.toHaveBeenCalled()
    expect(funnel.cursor()).toBe(0)
  })

  it('publish returning null skips the oplog and the broadcast', () => {
    const { funnel, fanOutSnapshot } = makeFunnel()
    const result = funnel.run({ write: () => 'ok', publish: () => null })
    expect(result).toBe('ok')
    expect(fanOutSnapshot).not.toHaveBeenCalled()
    expect(funnel.cursor()).toBe(0)
  })
})

describe('WriteFunnel.changesSince', () => {
  it('serves ledger-appended changes from a cursor (one shared durable log)', () => {
    const { store, funnel } = makeFunnel()
    const ledger = new Ledger({
      repo: store.sync,
      now: () => 1_000,
      transact: (fn) => store.transact(fn),
    })
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
  })
})

describe('WriteFunnel ledger severance ([spec:SP-3fe2] #255/#256/#257 — ALL entity kinds)', () => {
  it('an issue spec through the legacy publish path trips the assertion and appends nothing', () => {
    const { funnel, fanOutSnapshot } = makeFunnel()
    expect(() =>
      funnel.publishSpec({
        entity: 'issue',
        rows: [{ id: 'iss_1', value: { id: 'iss_1' } }],
        snapshot: { type: 'issuesChanged', issues: [] } as never,
      }),
    ).toThrow(/ledger-owned/)
    expect(funnel.cursor()).toBe(0) // nothing double-appended
    expect(fanOutSnapshot).not.toHaveBeenCalled()
  })

  it('a session spec is equally severed', () => {
    const { funnel, fanOutSnapshot } = makeFunnel()
    expect(() =>
      funnel.publishSpec({
        entity: 'session',
        rows: [{ id: 's1', value: { id: 's1' } }],
        snapshot: { type: 'sessionsChanged', sessions: [] } as never,
      }),
    ).toThrow(/ledger-owned/)
    expect(funnel.cursor()).toBe(0)
    expect(fanOutSnapshot).not.toHaveBeenCalled()
  })

  it('a conversation spec is equally severed (#257 — the legacy oplog records NOTHING)', () => {
    const { funnel, fanOutSnapshot } = makeFunnel()
    expect(() => funnel.publishSpec(spec('c1'))).toThrow(/ledger-owned/)
    expect(funnel.cursor()).toBe(0)
    expect(fanOutSnapshot).not.toHaveBeenCalled()
  })

  it('record(…) is severed for every entity kind', () => {
    const { funnel } = makeFunnel()
    expect(() => funnel.record('issue', [{ id: 'iss_1', value: {} }])).toThrow(/ledger-owned/)
    expect(() => funnel.record('session', [{ id: 's1', value: {} }])).toThrow(/ledger-owned/)
    expect(() => funnel.record('conversation', [{ id: 'c1', value: {} }])).toThrow(/ledger-owned/)
    expect(funnel.cursor()).toBe(0)
  })

  it('a publish spec from run() trips the severance guard AFTER the write (no fan-out)', () => {
    const { funnel, fanOutSnapshot } = makeFunnel()
    const write = vi.fn(() => 'written')
    expect(() => funnel.run({ write, publish: () => spec('c1') })).toThrow(/ledger-owned/)
    expect(write).toHaveBeenCalledTimes(1)
    expect(fanOutSnapshot).not.toHaveBeenCalled()
  })
})

describe('WriteFunnel.publishComputed ([spec:SP-3fe2] #255/#256)', () => {
  it('fans out ONLY the legacy snapshot — no record, no metadataDelta', () => {
    const { funnel, fanOutSnapshot, sendDelta, bus } = makeFunnel()
    const appended = vi.fn()
    bus.on('oplog.appended', appended)
    const snapshot = { type: 'issueUpdated', issue: {} } as never
    funnel.publishComputed(snapshot)
    funnel.flushDeltas()
    expect(fanOutSnapshot).toHaveBeenCalledWith(snapshot, {})
    expect(sendDelta).not.toHaveBeenCalled() // deltas come from the onAppended pipe only
    expect(funnel.cursor()).toBe(0) // no oplog append
    expect(appended).not.toHaveBeenCalled()
  })

  it('bridges ledger appends onto the bus AND into the delta pipe', () => {
    const store = new SessionStore(':memory:')
    const bus = new EventBus()
    const listeners = new Set<(changes: MetadataChange[]) => void>()
    const ledger = {
      onAppended: (fn: (changes: MetadataChange[]) => void) => {
        listeners.add(fn)
        return () => listeners.delete(fn)
      },
    }
    const appended = vi.fn()
    const sendDelta = vi.fn()
    bus.on('oplog.appended', appended)
    const funnel = new WriteFunnel({
      store,
      now: () => 1_000,
      bus,
      fanOutSnapshot: vi.fn(),
      sendDelta,
      ledger: ledger as never,
    })
    const changes = [{ seq: 1, entity: 'issue', id: 'iss_1', op: 'remove' }] as MetadataChange[]
    for (const fn of listeners) fn(changes)
    expect(appended).toHaveBeenCalledWith({ changes })
    funnel.flushDeltas()
    expect(sendDelta).toHaveBeenCalledWith(changes)
  })
})

describe('the ordered metadataDelta pipe (#256)', () => {
  function pipedFunnel() {
    const store = new SessionStore(':memory:')
    const bus = new EventBus()
    const sendDelta = vi.fn()
    let emit: ((changes: MetadataChange[]) => void) | undefined
    const ledger = {
      onAppended: (fn: (changes: MetadataChange[]) => void) => {
        emit = fn
        return () => {}
      },
    }
    const funnel = new WriteFunnel({
      store,
      now: () => 1_000,
      bus,
      fanOutSnapshot: vi.fn(),
      sendDelta,
      ledger: ledger as never,
    })
    const appended = (changes: MetadataChange[]) => emit?.(changes)
    return { funnel, sendDelta, appended }
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
    // Strict append order, both writers interleaved — the pipe NEVER reorders.
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
