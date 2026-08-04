import { describe, expect, it, vi } from 'vitest'
import { UpdatesService } from './service'

function make(machines: unknown[]) {
  const send = vi.fn()
  let n = 0
  const svc = new UpdatesService({
    machines: () => machines as never,
    send,
    now: () => 1_000,
    nextGrantId: () => `g${++n}`,
    concurrency: 3,
  })
  return { svc, send }
}

const m = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  version: '0.4.1',
  state: 'current',
  online: true,
  busy: false,
  ...over,
})

describe('UpdatesService', () => {
  it('issues no grants until a target is set', () => {
    const { svc, send } = make([m('a')])
    svc.tick()
    expect(send).not.toHaveBeenCalled()
  })

  it('grants one canary on the first tick', () => {
    const { svc, send } = make([m('a'), m('b')])
    svc.setTarget({ version: '0.4.2', critical: false, artifacts: {} } as never)
    svc.tick()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('does not widen until the canary reports current AT the target', () => {
    const { svc, send } = make([m('a'), m('b'), m('c')])
    svc.setTarget({ version: '0.4.2', critical: false, artifacts: {} } as never)
    svc.tick()
    svc.onStatus('a', { type: 'updateStatus', state: 'current', version: '0.4.1' })
    svc.tick()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('widens once the canary reports current at the target version', () => {
    const { svc, send } = make([m('a'), m('b'), m('c')])
    svc.setTarget({ version: '0.4.2', critical: false, artifacts: {} } as never)
    svc.tick()
    svc.onStatus('a', { type: 'updateStatus', state: 'current', version: '0.4.2' })
    svc.tick()
    expect(send.mock.calls.length).toBeGreaterThan(1)
  })

  it('a rejected canary halts the wave entirely', () => {
    const { svc, send } = make([m('a'), m('b'), m('c')])
    svc.setTarget({ version: '0.4.2', critical: false, artifacts: {} } as never)
    svc.tick()
    svc.onStatus('a', { type: 'updateStatus', state: 'rejected', version: '0.4.1' })
    svc.tick()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('resets canary health when the target changes', () => {
    const { svc, send } = make([m('a'), m('b'), m('c')])
    svc.setTarget({ version: '0.4.2', critical: false, artifacts: {} } as never)
    svc.tick()
    svc.onStatus('a', { type: 'updateStatus', state: 'current', version: '0.4.2' })
    svc.setTarget({ version: '0.4.3', critical: false, artifacts: {} } as never)
    send.mockClear()
    svc.tick()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('is idempotent: a second tick with nothing changed grants nothing new', () => {
    const { svc, send } = make([m('a'), m('b')])
    svc.setTarget({ version: '0.4.2', critical: false, artifacts: {} } as never)
    svc.tick()
    svc.tick()
    expect(send).toHaveBeenCalledTimes(1)
  })
})
