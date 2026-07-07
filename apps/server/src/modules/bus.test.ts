import { describe, expect, it, vi } from 'vitest'
import { EventBus } from './bus'

describe('EventBus', () => {
  it('delivers a typed payload to subscribers', () => {
    const bus = new EventBus()
    const seen: string[] = []
    bus.on('machine.connected', ({ machineId }) => seen.push(machineId))
    bus.emit('machine.connected', { machineId: 'm1' })
    bus.emit('machine.connected', { machineId: 'm2' })
    expect(seen).toEqual(['m1', 'm2'])
  })

  it('does not cross-deliver between events', () => {
    const bus = new EventBus()
    const connected = vi.fn()
    const disconnected = vi.fn()
    bus.on('machine.connected', connected)
    bus.on('machine.disconnected', disconnected)
    bus.emit('machine.connected', { machineId: 'm1' })
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
    bus.emit('issue.closed', { issueId: 'iss_1' })
    expect(a).not.toHaveBeenCalled()
    expect(b).not.toHaveBeenCalled()
    expect(bus.listenerCount('issue.closed')).toBe(0)
  })

  it('once() fires exactly once', () => {
    const bus = new EventBus()
    const fn = vi.fn()
    bus.once('issue.reopened', fn)
    bus.emit('issue.reopened', { issueId: 'iss_1' })
    bus.emit('issue.reopened', { issueId: 'iss_2' })
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith({ issueId: 'iss_1' })
  })

  it('isolates a throwing listener from its siblings and the emitter', () => {
    const bus = new EventBus()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const after = vi.fn()
    bus.on('session.exited', () => {
      throw new Error('boom')
    })
    bus.on('session.exited', after)
    expect(() => bus.emit('session.exited', { sessionId: 's1', code: 0 })).not.toThrow()
    expect(after).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('a listener unsubscribing mid-dispatch does not skip siblings', () => {
    const bus = new EventBus()
    const order: string[] = []
    const disposeFirst = bus.on('machine.disconnected', () => {
      order.push('first')
      disposeFirst()
    })
    bus.on('machine.disconnected', () => order.push('second'))
    bus.emit('machine.disconnected', { machineId: 'm1' })
    bus.emit('machine.disconnected', { machineId: 'm1' })
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
    bus.emit('machine.connected', { machineId: 'm1' })
    expect(fn).not.toHaveBeenCalled()
  })
})
