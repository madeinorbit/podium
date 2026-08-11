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

  it('treats a second global Apply as authority to retry a failed canary', () => {
    const { svc, send } = make([m('a'), m('b')])
    svc.setTarget({ version: '0.4.2', critical: false, artifacts: {} } as never)
    expect(svc.authorize()).toEqual(['a'])
    svc.onStatus('a', { type: 'updateStatus', state: 'rejected', version: '0.4.1' })
    send.mockClear()

    expect(svc.authorize()).toEqual(['a'])
    expect(send).toHaveBeenCalledTimes(1)
    expect(svc.fleet()[0]).toMatchObject({ state: 'granted' })
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

  describe('per-machine apply outcomes', () => {
    const target = { version: '0.4.2', critical: false, artifacts: {} } as never

    it('names why no grant was issued instead of returning an empty list', () => {
      const { svc } = make([
        m('current', { version: '0.4.2' }),
        m('offline', { online: false }),
        m('flying'),
      ])
      svc.setTarget(target)

      expect(svc.authorizeMachine('current')).toEqual({
        result: 'already-current',
        version: '0.4.2',
      })
      expect(svc.authorizeMachine('offline')).toEqual({ result: 'offline' })
      expect(svc.authorizeMachine('missing')).toEqual({ result: 'unknown-machine' })

      expect(svc.authorizeMachine('flying')).toMatchObject({ result: 'granted' })
      // A second apply while the first is still converging is not a failure.
      expect(svc.authorizeMachine('flying')).toEqual({ result: 'in-flight', state: 'granted' })
    })

    it('explains an unresolved authority rather than reporting a missing grant', () => {
      const { svc } = make([m('a')])
      expect(svc.authorizeMachine('a')).toMatchObject({ result: 'no-target' })
    })

    /** The regression behind repro 2: retry was permanently impossible. */
    it('lets a human retry a machine the planner had excluded forever', () => {
      const { svc, send } = make([m('a')])
      svc.setTarget(target)
      svc.authorize()
      svc.onStatus('a', {
        type: 'updateStatus',
        state: 'stuck',
        version: '0.4.1',
        detail: 'did not come back',
      })
      expect(svc.fleet()[0]).toMatchObject({ state: 'stuck' })
      send.mockClear()

      expect(svc.authorizeMachine('a')).toEqual({ result: 'granted', version: '0.4.2' })
      expect(send).toHaveBeenCalledTimes(1)
    })
  })

  describe('bounded convergence', () => {
    const target = { version: '0.4.2', critical: false, artifacts: {} } as never
    const makeClock = (machines: unknown[]) => {
      let clock = 1_000
      const send = vi.fn()
      let n = 0
      const svc = new UpdatesService({
        machines: () => machines as never,
        send,
        now: () => clock,
        nextGrantId: () => `g${++n}`,
        concurrency: 3,
        grantDeadlineMs: 60_000,
      })
      return { svc, send, tick: (ms: number) => (clock += ms) }
    }

    it('ages a silent machine into a visible failure instead of converging forever', () => {
      const { svc, tick } = makeClock([m('a')])
      svc.setTarget(target)
      svc.authorize()
      expect(svc.fleet()[0]).toMatchObject({ state: 'granted' })

      tick(60_000)
      expect(svc.fleet()[0]).toMatchObject({
        state: 'stuck',
        detail: 'The machine stopped reporting progress while updating.',
      })
    })

    it('measures silence, not duration: progress reports keep a slow update alive', () => {
      const { svc, tick } = makeClock([m('a')])
      svc.setTarget(target)
      svc.authorize()

      for (let i = 0; i < 4; i++) {
        tick(50_000)
        svc.onStatus('a', { type: 'updateStatus', state: 'downloading', version: '0.4.1' })
        expect(svc.fleet()[0]).toMatchObject({ state: 'downloading' })
      }

      tick(60_000)
      expect(svc.fleet()[0]).toMatchObject({ state: 'stuck' })
    })

    it('records an abandoned wait so giving up is visible, not silent', () => {
      const { svc } = makeClock([m('a'), m('b', { version: '0.4.2' })])
      svc.setTarget(target)
      svc.authorize()

      expect(svc.abandonWait(['a', 'b'], 'the server stopped waiting')).toEqual(['a'])
      expect(svc.fleet()[0]).toMatchObject({ state: 'stuck', detail: 'the server stopped waiting' })
    })
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
