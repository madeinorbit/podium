import type { MetadataChange } from '@podium/protocol'
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
  it('runs authorize → write → publish and returns the write result', () => {
    const { funnel, fanOutSnapshot, bus } = makeFunnel()
    const order: string[] = []
    bus.on('oplog.appended', () => order.push('oplog'))
    fanOutSnapshot.mockImplementation(() => order.push('broadcast'))
    const result = funnel.run({
      authorize: () => order.push('authorize'),
      write: () => {
        order.push('write')
        return 42
      },
      publish: () => spec('c1'),
    })
    expect(result).toBe(42)
    expect(order).toEqual(['authorize', 'write', 'oplog', 'broadcast'])
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

describe('WriteFunnel.publish / record', () => {
  it('records durably BEFORE fanning out, and advances the cursor', () => {
    const { funnel, fanOutSnapshot, bus } = makeFunnel()
    let cursorAtBroadcast = -1
    let cursorAtAppend = -1
    bus.on('oplog.appended', () => {
      cursorAtAppend = funnel.cursor()
    })
    fanOutSnapshot.mockImplementation(() => {
      cursorAtBroadcast = funnel.cursor()
    })
    funnel.publish('conversation', [{ id: 'c1', value: { id: 'c1' } }], {
      type: 'conversationsChanged',
      conversations: [],
      diagnostics: [],
    } as never)
    expect(cursorAtAppend).toBeGreaterThan(0)
    expect(cursorAtBroadcast).toBe(cursorAtAppend)
    expect(fanOutSnapshot).toHaveBeenCalledTimes(1)
  })

  it('an unchanged re-publish appends nothing and emits no oplog event', () => {
    const { funnel, bus } = makeFunnel()
    const appended = vi.fn()
    bus.on('oplog.appended', appended)
    const rows = [{ id: 'c1', value: { id: 'c1' } }]
    const snapshot = { type: 'conversationsChanged', conversations: [], diagnostics: [] } as never
    funnel.publish('conversation', rows, snapshot)
    funnel.publish('conversation', rows, snapshot)
    expect(appended).toHaveBeenCalledTimes(1)
  })

  it('changesSince serves recorded changes from a cursor', () => {
    const { funnel } = makeFunnel()
    funnel.record('conversation', [{ id: 'c1', value: { a: 1 } }])
    const cursor = funnel.cursor()
    funnel.record('conversation', [{ id: 'c1', value: { a: 2 } }])
    const changes = funnel.changesSince(cursor)
    expect(changes?.map((c) => c.id)).toEqual(['c1'])
  })
})

describe('WriteFunnel ledger severance ([spec:SP-3fe2] #255 issues, #256 sessions)', () => {
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

  it('record("issue"/"session", …) is equally severed', () => {
    const { funnel } = makeFunnel()
    expect(() => funnel.record('issue', [{ id: 'iss_1', value: {} }])).toThrow(/ledger-owned/)
    expect(() => funnel.record('session', [{ id: 's1', value: {} }])).toThrow(/ledger-owned/)
    expect(funnel.cursor()).toBe(0)
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

  const up = (seq: number, entity: 'issue' | 'session', id: string): MetadataChange =>
    ({ seq, entity, id, op: 'upsert', value: { id } }) as MetadataChange

  it('a synchronous burst — ledger batches interleaved with a legacy record — emits as ONE batch in append (= seq) order', () => {
    const { funnel, sendDelta, appended } = pipedFunnel()
    appended([up(1, 'session', 's1')])
    appended([up(2, 'issue', 'i1'), up(3, 'issue', 'i2')])
    funnel.record('conversation', [{ id: 'c1', value: { id: 'c1' } }]) // seq 4, same pipe
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
