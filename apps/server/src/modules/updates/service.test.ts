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
  it('resolves a machine target without re-entering the enriched machine projection', () => {
    const machines = vi.fn(() => {
      throw new Error('wire projection re-entered')
    })
    const target = { version: '0.4.2', critical: false, artifacts: {} } as never
    const svc = new UpdatesService({
      machines,
      channelFor: (machineId) => (machineId === 'a' ? 'edge' : undefined),
      send: vi.fn(),
      now: () => 1_000,
      nextGrantId: () => 'g1',
      concurrency: 3,
    })

    svc.setTarget('edge', target)

    expect(svc.targetFor('a')).toBe(target)
    expect(svc.targetUnavailableReasonFor('a')).toBeUndefined()
    expect(machines).not.toHaveBeenCalled()
  })

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

  it('carries one authorization from the canary into the wider wave', () => {
    const { svc, send } = make([m('a'), m('b'), m('c')])
    svc.setTarget({ version: '0.4.2', critical: false, artifacts: {} } as never)

    expect(svc.authorize()).toEqual(['a'])
    expect(send).toHaveBeenCalledTimes(1)

    svc.onStatus('a', { type: 'updateStatus', state: 'current', version: '0.4.2' })
    expect(send).toHaveBeenCalledTimes(3)
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

  it('reconciles a restarted machine from its reported target version', () => {
    const machines = [m('a'), m('b')]
    const { svc } = make(machines)
    svc.setTarget({ version: '0.4.2', critical: false, artifacts: {} } as never)
    svc.tick()

    const first = machines[0]
    if (!first) throw new Error('test machine missing')
    first.version = '0.4.2'
    expect(svc.fleet()[0]).toMatchObject({ state: 'current', version: '0.4.2' })
  })

  it('requires the raw reconnect identity instead of optimistic current status', () => {
    const machines = [m('a')]
    const { svc } = make(machines)
    svc.setTarget({ version: '0.4.2', critical: false, artifacts: {} } as never)
    svc.authorize()
    svc.onStatus('a', { type: 'updateStatus', state: 'current', version: '0.4.2' })

    expect(svc.fleet()[0]).toMatchObject({ state: 'current', version: '0.4.2' })
    expect(svc.machineBootedAtTarget('a', '0.4.2')).toBe(false)

    const machine = machines[0]
    if (!machine) throw new Error('test machine missing')
    machine.version = '0.4.2'
    expect(svc.machineBootedAtTarget('a', '0.4.2')).toBe(true)
  })

  it('is idempotent: a second tick with nothing changed grants nothing new', () => {
    const { svc, send } = make([m('a'), m('b')])
    svc.setTarget({ version: '0.4.2', critical: false, artifacts: {} } as never)
    svc.tick()
    svc.tick()
    expect(send).toHaveBeenCalledTimes(1)
  })
})

describe('setTargetUnavailable', () => {
  it('withdraws the stale target and explains why the channel has none', () => {
    const { svc } = make([m('a', { channel: 'dev' })])
    svc.setTarget('dev', { version: 'dev+aaaaaaa', critical: false, artifacts: {} } as never)
    expect(svc.target('dev')?.version).toBe('dev+aaaaaaa')

    svc.setTargetUnavailable('dev', 'The source checkout has 2 uncommitted changes.')

    // Nothing may still be handed dev+aaaaaaa once HEAD has moved past it.
    expect(svc.target('dev')).toBeUndefined()
    expect(svc.targetVersion()).toBeUndefined()
    expect(svc.targetUnavailableReasonFor('a')).toBe(
      'The source checkout has 2 uncommitted changes.',
    )
  })

  it('ends an in-flight rollout observably instead of stranding it', () => {
    const machines = [m('a', { channel: 'dev' })]
    const { svc } = make(machines)
    svc.setTarget('dev', { version: 'dev+aaaaaaa', critical: false, artifacts: {} } as never)
    svc.authorize('dev')
    expect(svc.fleet().find((machine) => machine.id === 'a')?.state).toBe('granted')

    svc.setTargetUnavailable('dev', 'The source checkout has 2 uncommitted changes.')

    // Without this the row keeps saying "granted" forever: the pending record
    // is gone, so nothing can ever age it and no status report is accepted.
    const row = svc.fleet().find((machine) => machine.id === 'a')
    expect(row?.state).toBe('stuck')
    expect(row?.detail).toBe('The source checkout has 2 uncommitted changes.')
  })

  it('is cleared by the next successful publication', () => {
    const { svc } = make([m('a', { channel: 'dev' })])
    svc.setTargetUnavailable('dev', 'Building the development bundle for dev+bbbbbbb.')
    svc.setTarget('dev', { version: 'dev+bbbbbbb', critical: false, artifacts: {} } as never)

    expect(svc.target('dev')?.version).toBe('dev+bbbbbbb')
    expect(svc.targetUnavailableReasonFor('a')).toBeUndefined()
  })
})
