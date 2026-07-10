import { describe, expect, it, vi } from 'vitest'
import { SessionStore } from '../store'
import { EventBus } from './bus'
import { WriteFunnel } from './funnel'

function makeFunnel() {
  const store = new SessionStore(':memory:')
  const bus = new EventBus()
  const fanOut = vi.fn()
  const funnel = new WriteFunnel({ store, now: () => 1_000, bus, fanOut })
  return { store, bus, fanOut, funnel }
}

const spec = (id: string) => ({
  entity: 'session' as const,
  rows: [{ id, value: { id } }],
  snapshot: { type: 'sessionsChanged', sessions: [] } as never,
})

describe('WriteFunnel.run ordering', () => {
  it('runs authorize → write → publish and returns the write result', () => {
    const { funnel, fanOut, bus } = makeFunnel()
    const order: string[] = []
    bus.on('oplog.appended', () => order.push('oplog'))
    fanOut.mockImplementation(() => order.push('broadcast'))
    const result = funnel.run({
      authorize: () => order.push('authorize'),
      write: () => {
        order.push('write')
        return 42
      },
      publish: () => spec('iss_1'),
    })
    expect(result).toBe(42)
    expect(order).toEqual(['authorize', 'write', 'oplog', 'broadcast'])
  })

  it('authorize rejecting stops the write, the oplog append, and the broadcast', () => {
    const { funnel, fanOut, bus } = makeFunnel()
    const write = vi.fn()
    const appended = vi.fn()
    bus.on('oplog.appended', appended)
    expect(() =>
      funnel.run({
        authorize: () => {
          throw new Error('forbidden')
        },
        write,
        publish: () => spec('iss_1'),
      }),
    ).toThrow('forbidden')
    expect(write).not.toHaveBeenCalled()
    expect(appended).not.toHaveBeenCalled()
    expect(fanOut).not.toHaveBeenCalled()
    expect(funnel.cursor()).toBe(0)
  })

  it('a write throw stops the oplog append and the broadcast', () => {
    const { funnel, fanOut, bus } = makeFunnel()
    const appended = vi.fn()
    bus.on('oplog.appended', appended)
    expect(() =>
      funnel.run({
        write: () => {
          throw new Error('db down')
        },
        publish: () => spec('iss_1'),
      }),
    ).toThrow('db down')
    expect(appended).not.toHaveBeenCalled()
    expect(fanOut).not.toHaveBeenCalled()
    expect(funnel.cursor()).toBe(0)
  })

  it('publish returning null skips the oplog and the broadcast', () => {
    const { funnel, fanOut } = makeFunnel()
    const result = funnel.run({ write: () => 'ok', publish: () => null })
    expect(result).toBe('ok')
    expect(fanOut).not.toHaveBeenCalled()
    expect(funnel.cursor()).toBe(0)
  })
})

describe('WriteFunnel.publish / record', () => {
  it('records durably BEFORE fanning out, and advances the cursor', () => {
    const { funnel, fanOut, bus } = makeFunnel()
    let cursorAtBroadcast = -1
    let cursorAtAppend = -1
    bus.on('oplog.appended', () => {
      cursorAtAppend = funnel.cursor()
    })
    fanOut.mockImplementation(() => {
      cursorAtBroadcast = funnel.cursor()
    })
    funnel.publish('session', [{ id: 's1', value: { id: 's1' } }], {
      type: 'sessionsChanged',
      sessions: [],
    } as never)
    expect(cursorAtAppend).toBeGreaterThan(0)
    expect(cursorAtBroadcast).toBe(cursorAtAppend)
    expect(fanOut).toHaveBeenCalledTimes(1)
    const [, changes] = fanOut.mock.calls[0] as [unknown, { id: string }[]]
    expect(changes.map((c) => c.id)).toEqual(['s1'])
  })

  it('an unchanged re-publish appends nothing and emits no oplog event', () => {
    const { funnel, bus } = makeFunnel()
    const appended = vi.fn()
    bus.on('oplog.appended', appended)
    const rows = [{ id: 's1', value: { id: 's1' } }]
    const snapshot = { type: 'sessionsChanged', sessions: [] } as never
    funnel.publish('session', rows, snapshot)
    funnel.publish('session', rows, snapshot)
    expect(appended).toHaveBeenCalledTimes(1)
  })

  it('changesSince serves recorded changes from a cursor', () => {
    const { funnel } = makeFunnel()
    funnel.record('session', [{ id: 's1', value: { a: 1 } }])
    const cursor = funnel.cursor()
    funnel.record('session', [{ id: 's1', value: { a: 2 } }])
    const changes = funnel.changesSince(cursor)
    expect(changes?.map((c) => c.id)).toEqual(['s1'])
  })
})

describe('WriteFunnel issue severance ([spec:SP-3fe2] #255)', () => {
  it('an issue spec through the legacy publish path trips the assertion and appends nothing', () => {
    const { funnel, fanOut } = makeFunnel()
    expect(() =>
      funnel.publishSpec({
        entity: 'issue',
        rows: [{ id: 'iss_1', value: { id: 'iss_1' } }],
        snapshot: { type: 'issuesChanged', issues: [] } as never,
      }),
    ).toThrow(/ledger-owned/)
    expect(funnel.cursor()).toBe(0) // nothing double-appended
    expect(fanOut).not.toHaveBeenCalled()
  })

  it('record("issue", …) is equally severed', () => {
    const { funnel } = makeFunnel()
    expect(() => funnel.record('issue', [{ id: 'iss_1', value: {} }])).toThrow(/ledger-owned/)
    expect(funnel.cursor()).toBe(0)
  })
})

describe('WriteFunnel.publishComputed ([spec:SP-3fe2] #255)', () => {
  it('fans out without recording — the changes were appended at the write seam', () => {
    const { funnel, fanOut, bus } = makeFunnel()
    const appended = vi.fn()
    bus.on('oplog.appended', appended)
    const changes = [{ seq: 7, entity: 'issue', id: 'iss_1', op: 'upsert', value: {} }] as never[]
    const snapshot = { type: 'issueUpdated', issue: {} } as never
    funnel.publishComputed(snapshot, changes)
    expect(fanOut).toHaveBeenCalledWith(snapshot, changes)
    expect(funnel.cursor()).toBe(0) // no oplog append
    expect(appended).not.toHaveBeenCalled() // the LEDGER's onAppended bridge covers the bus
  })

  it('bridges ledger appends onto the bus as oplog.appended', () => {
    const store = new SessionStore(':memory:')
    const bus = new EventBus()
    const listeners = new Set<(changes: unknown) => void>()
    const ledger = {
      onAppended: (fn: (changes: unknown) => void) => {
        listeners.add(fn)
        return () => listeners.delete(fn)
      },
    }
    const appended = vi.fn()
    bus.on('oplog.appended', appended)
    void new WriteFunnel({ store, now: () => 1_000, bus, fanOut: vi.fn(), ledger: ledger as never })
    const changes = [{ seq: 1, entity: 'issue', id: 'iss_1', op: 'remove' }]
    for (const fn of listeners) fn(changes)
    expect(appended).toHaveBeenCalledWith({ changes })
  })
})
