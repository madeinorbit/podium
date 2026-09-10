import { asMachineId, asIssueId, asSessionId, asUserId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import { captureLogs } from '../test-support/capture-logs'
import { EventBus } from './bus'
import { openTestStore } from '../test-support/open-test-store'

describe('EventBus', () => {
  it('delivers a typed payload to subscribers', () => {
    const bus = new EventBus()
    const seen: string[] = []
    bus.on('machine.connected', ({ machineId }) => seen.push(machineId))
    bus.emit('machine.connected', { machineId: asMachineId('m1') })
    bus.emit('machine.connected', { machineId: asMachineId('m2') })
    expect(seen).toEqual(['m1', 'm2'])
  })

  it('does not cross-deliver between events', () => {
    const bus = new EventBus()
    const connected = vi.fn()
    const disconnected = vi.fn()
    bus.on('machine.connected', connected)
    bus.on('machine.disconnected', disconnected)
    bus.emit('machine.connected', { machineId: asMachineId('m1') })
    expect(connected).toHaveBeenCalledTimes(1)
    expect(disconnected).not.toHaveBeenCalled()
  })

  it('on() returns a disposer; off() removes a listener', () => {
    const bus = new EventBus()
    const a = vi.fn()
    const b = vi.fn()
    const disposeA = bus.on('issue.closed', a)
    bus.on('issue.closed', b)
    disposeA()
    bus.off('issue.closed', b)
    bus.emit('issue.closed', { issueId: asIssueId('iss_1') })
    expect(a).not.toHaveBeenCalled()
    expect(b).not.toHaveBeenCalled()
    expect(bus.listenerCount('issue.closed')).toBe(0)
  })

  it('once() fires exactly once', () => {
    const bus = new EventBus()
    const fn = vi.fn()
    bus.once('issue.reopened', fn)
    bus.emit('issue.reopened', { issueId: asIssueId('iss_1') })
    bus.emit('issue.reopened', { issueId: asIssueId('iss_2') })
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith({ issueId: 'iss_1' })
  })

  it('isolates a throwing listener from its siblings and the emitter', () => {
    const bus = new EventBus()
    const logs = captureLogs()
    const after = vi.fn()
    bus.on('session.exited', () => {
      throw new Error('boom')
    })
    bus.on('session.exited', after)
    expect(() =>
      bus.emit('session.exited', { sessionId: asSessionId('s1'), code: 0 }),
    ).not.toThrow()
    expect(after).toHaveBeenCalledTimes(1)
    expect(logs.at('warn')).not.toHaveLength(0)
    logs.restore()
  })

  it('a listener unsubscribing mid-dispatch does not skip siblings', () => {
    const bus = new EventBus()
    const order: string[] = []
    const disposeFirst = bus.on('machine.disconnected', () => {
      order.push('first')
      disposeFirst()
    })
    bus.on('machine.disconnected', () => order.push('second'))
    bus.emit('machine.disconnected', { machineId: asMachineId('m1') })
    bus.emit('machine.disconnected', { machineId: asMachineId('m1') })
    expect(order).toEqual(['first', 'second', 'second'])
  })

  it('emitting with no listeners is a no-op', () => {
    const bus = new EventBus()
    expect(() => bus.emit('oplog.appended', { changes: [] })).not.toThrow()
  })

  it('removeAll() drops every subscription', () => {
    const bus = new EventBus()
    const fn = vi.fn()
    bus.on('machine.connected', fn)
    bus.removeAll()
    bus.emit('machine.connected', { machineId: asMachineId('m1') })
    expect(fn).not.toHaveBeenCalled()
  })
  it('carries the three cloud-analytics signals', () => {
    const bus = new EventBus()
    const login = vi.fn()
    const created = vi.fn()
    const crashed = vi.fn()
    bus.on('auth.login', login)
    bus.on('issue.created', created)
    bus.on('client.crashed', crashed)

    bus.emit('auth.login', { userId: asUserId('user:sole'), delivery: 'cookie' })
    bus.emit('issue.created', {
      issueId: asIssueId('iss_1'),
      title: 'a title',
      ownerUserId: asUserId('user:sole'),
    })
    bus.emit('client.crashed', {
      origin: { role: 'web' },
      err: { name: 'TypeError', message: 'boom' },
    })

    expect(login).toHaveBeenCalledWith({ userId: 'user:sole', delivery: 'cookie' })
    expect(created).toHaveBeenCalledWith({
      issueId: 'iss_1',
      title: 'a title',
      ownerUserId: 'user:sole',
    })
    expect(crashed).toHaveBeenCalledTimes(1)
  })
})

/**
 * Under the async store executor a listener that opens its own transaction JOINS
 * whatever span the EMITTER has open, as a savepoint. The emitter's next
 * statement then addresses a frame with an open child and is refused, and the
 * listener's orphaned savepoint dies when the span closes. `emit` is a
 * notification — an observer must never be able to break the mutation path that
 * announced the change [POD-3806].
 *
 * The listener here is production-shaped: it opens a REAL store transaction,
 * which is exactly what `session-authz.primeOwnerMemo` does on
 * `issue.sessionDerived`.
 */
describe('EventBus under the async store (POD-3806)', () => {
  it('a listener that opens a transaction does not break the span that emitted', async () => {
    const store = await openTestStore(':memory:')
    const bus = new EventBus()
    bus.on('machine.connected', async () => {
      await store.transact(async () => {
        await store.issues.getIssue(asIssueId('iss_listener'))
      })
    })

    await store.transact(async () => {
      await store.issues.getIssue(asIssueId('iss_before'))
      bus.emit('machine.connected', { machineId: asMachineId('m1') })
      // The statement the lock bug died on: same span, after the emit.
      await store.issues.getIssue(asIssueId('iss_after'))
    })
  })

  it('defers the listener until the emitting span has committed', async () => {
    const store = await openTestStore(':memory:')
    const bus = new EventBus()
    const order: string[] = []
    bus.on('machine.connected', () => {
      order.push('listener')
    })

    await store.transact(async () => {
      bus.emit('machine.connected', { machineId: asMachineId('m1') })
      order.push('span-tail')
      await store.issues.getIssue(asIssueId('iss_after'))
    })

    expect(order).toEqual(['span-tail', 'listener'])
  })

  it('still dispatches synchronously with no span open', () => {
    const bus = new EventBus()
    const seen: string[] = []
    bus.on('machine.connected', ({ machineId }) => seen.push(machineId))
    bus.emit('machine.connected', { machineId: asMachineId('m1') })
    expect(seen).toEqual(['m1'])
  })
})
