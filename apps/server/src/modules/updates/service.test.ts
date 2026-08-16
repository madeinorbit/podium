import {
  asMachineId,
  DEFAULT_FLEET_UPDATE_CHANNEL,
  resolveMachineChannel,
  type UpdateChannel,
} from '@podium/model'
import { resolveUpdateChannel } from '@podium/runtime/config'
import { describe, expect, it, vi } from 'vitest'
import { UpdatesService } from './service'

/**
 * These cases are about the DEVELOPMENT wave, so they state a `dev` fleet
 * default rather than relying on one. Before POD-2100 the service assumed `dev`
 * for any machine with no channel while the fleet handlers assumed `stable`; the
 * assumption is gone, so a test that wants a dev wave has to say so.
 */
function make(machines: unknown[]) {
  const send = vi.fn()
  let n = 0
  const svc = new UpdatesService({
    machines: () => machines as never,
    send,
    now: () => 1_000,
    nextGrantId: () => `g${++n}`,
    concurrency: 3,
    fleetChannel: () => 'dev',
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

    expect(svc.targetFor(asMachineId('a'))).toBe(target)
    expect(svc.targetUnavailableReasonFor(asMachineId('a'))).toBeUndefined()
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
    svc.onStatus(asMachineId('a'), { type: 'updateStatus', state: 'current', version: '0.4.1' })
    svc.tick()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('widens once the canary reports current at the target version', () => {
    const { svc, send } = make([m('a'), m('b'), m('c')])
    svc.setTarget({ version: '0.4.2', critical: false, artifacts: {} } as never)
    svc.tick()
    svc.onStatus(asMachineId('a'), { type: 'updateStatus', state: 'current', version: '0.4.2' })
    svc.tick()
    expect(send.mock.calls.length).toBeGreaterThan(1)
  })

  it('carries one authorization from the canary into the wider wave', () => {
    const { svc, send } = make([m('a'), m('b'), m('c')])
    svc.setTarget({ version: '0.4.2', critical: false, artifacts: {} } as never)

    expect(svc.authorize()).toEqual(['a'])
    expect(send).toHaveBeenCalledTimes(1)

    svc.onStatus(asMachineId('a'), { type: 'updateStatus', state: 'current', version: '0.4.2' })
    expect(send).toHaveBeenCalledTimes(3)
  })

  it('a rejected canary halts the wave entirely', () => {
    const { svc, send } = make([m('a'), m('b'), m('c')])
    svc.setTarget({ version: '0.4.2', critical: false, artifacts: {} } as never)
    svc.tick()
    svc.onStatus(asMachineId('a'), { type: 'updateStatus', state: 'rejected', version: '0.4.1' })
    svc.tick()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('treats a second global Apply as authority to retry a failed canary', () => {
    const { svc, send } = make([m('a'), m('b')])
    svc.setTarget({ version: '0.4.2', critical: false, artifacts: {} } as never)
    expect(svc.authorize()).toEqual(['a'])
    svc.onStatus(asMachineId('a'), { type: 'updateStatus', state: 'rejected', version: '0.4.1' })
    send.mockClear()

    expect(svc.authorize()).toEqual(['a'])
    expect(send).toHaveBeenCalledTimes(1)
    expect(svc.fleet()[0]).toMatchObject({ state: 'granted' })
  })

  it('issues no grants when authorization is only remembered', () => {
    const { svc, send } = make([m('a')])
    svc.setTarget({ version: 'dev+47a01e3', critical: false, artifacts: { web: { digest: '47a01e3' } } } as never)
    svc.markAuthorized()
    expect(send).not.toHaveBeenCalled()
  })

  it('ticks an authorized wave when the same version gains a headless artifact', () => {
    const { svc, send } = make([m('a')])
    svc.setTarget({
      version: 'dev+47a01e3',
      critical: false,
      artifacts: { web: { digest: '47a01e3' } },
    } as never)
    svc.markAuthorized()
    expect(send).not.toHaveBeenCalled()

    svc.setTarget({
      version: 'dev+47a01e3',
      critical: false,
      artifacts: {
        web: { digest: '47a01e3' },
        headless: { delivery: 'bundle', platforms: { 'linux-x64': { url: 'http://x', digest: 'd', signature: 's' } } },
      },
    } as never)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]?.[1]).toMatchObject({ type: 'updateGrant' })
  })

  it('does not auto-grant when a same-version tarball appears without authorization', () => {
    const { svc, send } = make([m('a')])
    svc.setTarget({
      version: 'dev+47a01e3',
      critical: false,
      artifacts: { web: { digest: '47a01e3' } },
    } as never)
    svc.setTarget({
      version: 'dev+47a01e3',
      critical: false,
      artifacts: {
        web: { digest: '47a01e3' },
        headless: { delivery: 'bundle', platforms: { 'linux-x64': { url: 'http://x', digest: 'd', signature: 's' } } },
      },
    } as never)
    expect(send).not.toHaveBeenCalled()
  })

  it('resets canary health when the target changes', () => {
    const { svc, send } = make([m('a'), m('b'), m('c')])
    svc.setTarget({ version: '0.4.2', critical: false, artifacts: {} } as never)
    svc.tick()
    svc.onStatus(asMachineId('a'), { type: 'updateStatus', state: 'current', version: '0.4.2' })
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

  it('continues an authorized wave when the canary proves current by reconnecting', () => {
    const machines = [m('a'), m('b'), m('c')]
    const { svc, send } = make(machines)
    svc.setTarget({ version: '0.4.2', critical: false, artifacts: {} } as never)

    expect(svc.authorize()).toEqual(['a'])
    expect(send).toHaveBeenCalledTimes(1)

    const canary = machines[0]
    if (!canary) throw new Error('test canary missing')
    canary.version = '0.4.2'
    svc.fleet()

    expect(send).toHaveBeenCalledTimes(3)
  })

  it('requires the raw reconnect identity instead of optimistic current status', () => {
    const machines = [m('a')]
    const { svc } = make(machines)
    svc.setTarget({ version: '0.4.2', critical: false, artifacts: {} } as never)
    svc.authorize()
    svc.onStatus(asMachineId('a'), { type: 'updateStatus', state: 'current', version: '0.4.2' })

    expect(svc.fleet()[0]).toMatchObject({ state: 'current', version: '0.4.2' })
    expect(svc.machineBootedAtTarget(asMachineId('a'), '0.4.2')).toBe(false)

    const machine = machines[0]
    if (!machine) throw new Error('test machine missing')
    machine.version = '0.4.2'
    expect(svc.machineBootedAtTarget(asMachineId('a'), '0.4.2')).toBe(true)
  })

  it('proves a restart handoff only after a correlated restart report and disconnect', () => {
    const machines = [m('a')]
    const { svc } = make(machines)
    svc.setTarget({ version: '0.4.2', critical: false, artifacts: {} } as never)
    svc.authorize()

    svc.onStatus(asMachineId('a'), {
      type: 'updateStatus',
      grantId: 'wrong-grant',
      state: 'restarting',
      version: '0.4.1',
    })
    machines[0] = m('a', { online: false })
    expect(svc.machineCrossedRestartBoundary(asMachineId('a'), '0.4.2')).toBe(false)

    machines[0] = m('a')
    svc.onStatus(asMachineId('a'), {
      type: 'updateStatus',
      grantId: 'g1',
      state: 'restarting',
      version: '0.4.1',
    })
    expect(svc.machineCrossedRestartBoundary(asMachineId('a'), '0.4.2')).toBe(false)

    machines[0] = m('a', { online: false })
    expect(svc.machineCrossedRestartBoundary(asMachineId('a'), '0.4.2')).toBe(true)
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

      expect(svc.authorizeMachine(asMachineId('current'))).toEqual({
        result: 'already-current',
        version: '0.4.2',
      })
      expect(svc.authorizeMachine(asMachineId('offline'))).toEqual({ result: 'offline' })
      expect(svc.authorizeMachine(asMachineId('missing'))).toEqual({ result: 'unknown-machine' })

      expect(svc.authorizeMachine(asMachineId('flying'))).toMatchObject({ result: 'granted' })
      // A second apply while the first is still converging is not a failure.
      expect(svc.authorizeMachine(asMachineId('flying'))).toEqual({
        result: 'in-flight',
        state: 'granted',
      })
    })

    it('explains an unresolved authority rather than reporting a missing grant', () => {
      const { svc } = make([m('a')])
      expect(svc.authorizeMachine(asMachineId('a'))).toMatchObject({ result: 'no-target' })
    })

    /** The regression behind repro 2: retry was permanently impossible. */
    it('lets a human retry a machine the planner had excluded forever', () => {
      const { svc, send } = make([m('a')])
      svc.setTarget(target)
      svc.authorize()
      svc.onStatus(asMachineId('a'), {
        type: 'updateStatus',
        state: 'stuck',
        version: '0.4.1',
        detail: 'did not come back',
      })
      expect(svc.fleet()[0]).toMatchObject({ state: 'stuck' })
      send.mockClear()

      expect(svc.authorizeMachine(asMachineId('a'))).toEqual({
        result: 'granted',
        version: '0.4.2',
      })
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
        fleetChannel: () => 'dev',
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
        svc.onStatus(asMachineId('a'), {
          type: 'updateStatus',
          state: 'downloading',
          version: '0.4.1',
        })
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
    expect(svc.targetUnavailableReasonFor(asMachineId('a'))).toBe(
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
    expect(svc.targetUnavailableReasonFor(asMachineId('a'))).toBeUndefined()
  })
})

/**
 * ONE DEFAULT (POD-2100). The shipped disagreement was structural, not a typo:
 * `channelOf` answered `dev` for a machine with no pin while the fleet handlers
 * answered `stable` for the same machine, so which authority a machine belonged
 * to depended on which code path asked. Both now resolve through
 * `resolveMachineChannel`, and the fleet default is INJECTED rather than
 * assumed, which is what makes these four rows expressible at all.
 */
describe('channel resolution', () => {
  const build = (machine: Record<string, unknown>, fleetDefault?: UpdateChannel) =>
    new UpdatesService({
      machines: () => [{ ...m('a'), ...machine }] as never,
      send: vi.fn(),
      now: () => 1_000,
      nextGrantId: () => 'g1',
      concurrency: 3,
      ...(fleetDefault ? { fleetChannel: () => fleetDefault } : {}),
    })

  const cases: { name: string; pin?: UpdateChannel; fleetDefault?: UpdateChannel; expected: UpdateChannel }[] =
    [
      { name: 'an explicit pin wins over the fleet default', pin: 'edge', fleetDefault: 'stable', expected: 'edge' },
      { name: 'a pin is honoured even when it matches nothing else', pin: 'dev', fleetDefault: 'stable', expected: 'dev' },
      { name: 'no pin follows a stable fleet default', fleetDefault: 'stable', expected: 'stable' },
      { name: 'no pin follows an edge fleet default', fleetDefault: 'edge', expected: 'edge' },
      { name: 'no pin follows a dev fleet default', fleetDefault: 'dev', expected: 'dev' },
      { name: 'no pin and no stated fleet default falls back to the one shared constant', expected: DEFAULT_FLEET_UPDATE_CHANNEL },
    ]

  for (const { name, pin, fleetDefault, expected } of cases) {
    it(name, () => {
      const svc = build(pin ? { channel: pin } : {}, fleetDefault)
      expect(svc.channelOf({ ...m('a'), ...(pin ? { channel: pin } : {}) } as never)).toBe(expected)
    })
  }

  /**
   * @podium/model cannot import @podium/runtime (it is the lower layer), so the
   * fallback literal is stated twice by necessity. This is the assertion that
   * keeps the two copies one value.
   */
  it('the model fallback is the same channel runtime resolves with nothing configured', () => {
    expect(resolveUpdateChannel({}, {})).toBe(DEFAULT_FLEET_UPDATE_CHANNEL)
  })

  it('the fleet default is the channel an unpinned machine lands on', () => {
    expect(build({}, 'edge').fleetDefaultChannel()).toBe('edge')
    expect(build({}).fleetDefaultChannel()).toBe(DEFAULT_FLEET_UPDATE_CHANNEL)
  })

  /**
   * The acceptance criterion in prose: the handlers resolve through the same
   * helper the service does, so "which channel is machine a on" has ONE answer.
   * `resolveMachineChannel` is what both call; asserting the identity here is
   * cheaper and more honest than asserting a grep.
   */
  it('resolves an unpinned machine identically through the service and the shared helper', () => {
    const svc = build({}, 'edge')
    expect(svc.channelOf(m('a') as never)).toBe(resolveMachineChannel(undefined, 'edge'))
    expect(svc.channelOf(m('a') as never)).toBe(svc.fleetDefaultChannel())
  })
})

/**
 * REFRESH BOOKKEEPING AND CADENCE (POD-2100, spec §9.2). "Checked 2 h ago" is
 * only sayable if the check is recorded, and a boot-time failure must not be
 * pinned as the eternal truth for the life of the process.
 */
describe('target refresh bookkeeping', () => {
  const target = { version: '1.0.0', critical: false, artifacts: {} } as never

  const build = (
    resolveTarget: (channel: 'edge' | 'stable') => Promise<never>,
    opts: { fleetChannel?: UpdateChannel; machines?: unknown[] } = {},
  ) => {
    let clock = 1_000
    const svc = new UpdatesService({
      // One unpinned machine, so `targetUnavailableReasonFor` has somebody to
      // answer about — the reason is per MACHINE, resolved through its channel.
      machines: () => (opts.machines ?? [m('a')]) as never,
      send: vi.fn(),
      now: () => clock,
      nextGrantId: () => 'g1',
      concurrency: 3,
      resolveTarget,
      fleetChannel: () => opts.fleetChannel ?? 'stable',
    })
    return { svc, advance: (ms: number) => (clock += ms) }
  }

  it('records when a channel was checked and that it succeeded', async () => {
    const { svc } = build(async () => target)
    await svc.refreshTarget('stable')
    expect(svc.channelChecks()).toEqual([
      { channel: 'stable', checkedAt: 1_000, outcome: { status: 'ok' } },
    ])
  })

  it('records the reason a check failed, carrying the resolver message', async () => {
    const { svc } = build(async () => {
      throw new Error('stable target unavailable: fetch failed')
    })
    await svc.refreshTarget('stable')
    expect(svc.channelChecks()).toEqual([
      {
        channel: 'stable',
        checkedAt: 1_000,
        outcome: { status: 'unavailable', reason: 'stable target unavailable: fetch failed' },
      },
    ])
  })

  /**
   * The failure this whole slice exists for: a feed that was unreachable in the
   * one second the server booted used to keep saying so forever, because nothing
   * ever asked again.
   */
  it('clears a failed boot-time reason once a later refresh succeeds', async () => {
    let fail = true
    const { svc, advance } = build(async () => {
      if (fail) throw new Error('stable target unavailable: fetch failed')
      return target
    })

    await svc.refreshTarget('stable')
    expect(svc.targetUnavailableReasonFor(asMachineId('a'))).toBe(
      'stable target unavailable: fetch failed',
    )

    fail = false
    advance(24 * 60 * 60_000)
    await svc.refreshTarget('stable')

    expect(svc.target('stable')).toBe(target)
    expect(svc.targetUnavailableReasonFor(asMachineId('a'))).toBeUndefined()
    expect(svc.channelChecks()).toEqual([
      { channel: 'stable', checkedAt: 1_000 + 24 * 60 * 60_000, outcome: { status: 'ok' } },
    ])
  })

  /**
   * A resolve that fails while a good target stands describes the CHECK, not the
   * target: clients keep the target they can still use, and the check says the
   * feed was unreachable. Conflating the two is how a working instance would
   * start reporting itself broken.
   */
  it('a failed re-check does not retract a target that already resolved', async () => {
    let fail = false
    const { svc, advance } = build(async () => {
      if (fail) throw new Error('stable target unavailable: fetch failed')
      return target
    })
    await svc.refreshTarget('stable')

    fail = true
    advance(60_000)
    await svc.refreshTarget('stable')

    expect(svc.target('stable')).toBe(target)
    expect(svc.targetUnavailableReasonFor(asMachineId('a'))).toBeUndefined()
    expect(svc.channelChecks()[0]?.outcome).toEqual({
      status: 'unavailable',
      reason: 'stable target unavailable: fetch failed',
    })
  })

  it('records dev as checked without polling anything — dev is publisher-pushed', async () => {
    const { svc } = build(async () => target, { fleetChannel: 'dev' })
    await svc.refreshTarget('dev')
    expect(svc.channelChecks()).toEqual([
      {
        channel: 'dev',
        checkedAt: 1_000,
        outcome: {
          status: 'unavailable',
          reason: 'Development target is not currently published by this source server.',
        },
      },
    ])

    svc.setTarget('dev', target)
    await svc.refreshTarget('dev')
    expect(svc.channelChecks()[0]?.outcome).toEqual({ status: 'ok' })
  })

  describe('checkNow', () => {
    it('checks the fleet default and every channel some machine is pinned to', async () => {
      const resolveTarget = vi.fn(async (_channel: 'edge' | 'stable') => target)
      const { svc } = build(resolveTarget as never, {
        fleetChannel: 'stable',
        machines: [m('a', { channel: 'edge' }), m('b')],
      })

      const results = await svc.checkNow()

      expect(resolveTarget.mock.calls.map(([channel]) => channel)).toEqual(['edge', 'stable'])
      expect(results.map((record) => record.channel)).toEqual(['edge', 'stable'])
      expect(results.every((record) => record.outcome.status === 'ok')).toBe(true)
    })

    it('returns the recorded outcome instead of re-resolving inside the rate window', async () => {
      const resolveTarget = vi.fn(async (_channel: 'edge' | 'stable') => target)
      const { svc, advance } = build(resolveTarget as never)

      const first = await svc.checkNow()
      advance(29_999)
      const second = await svc.checkNow()

      expect(resolveTarget).toHaveBeenCalledTimes(1)
      expect(second).toEqual(first)
      expect(second[0]?.checkedAt).toBe(1_000)
    })

    it('coalesces concurrent checks into one release-feed resolve', async () => {
      let finishResolve!: (resolved: typeof target) => void
      const resolving = new Promise<typeof target>((resolve) => {
        finishResolve = resolve
      })
      const resolveTarget = vi.fn(() => resolving)
      const { svc } = build(resolveTarget as never)

      const first = svc.checkNow()
      const second = svc.checkNow()

      expect(resolveTarget).toHaveBeenCalledTimes(1)
      finishResolve(target)
      const [firstResult, secondResult] = await Promise.all([first, second])
      expect(secondResult).toEqual(firstResult)
    })

    it('re-resolves once the rate window has passed', async () => {
      const resolveTarget = vi.fn(async (_channel: 'edge' | 'stable') => target)
      const { svc, advance } = build(resolveTarget as never)

      await svc.checkNow()
      advance(30_000)
      const second = await svc.checkNow()

      expect(resolveTarget).toHaveBeenCalledTimes(2)
      expect(second[0]?.checkedAt).toBe(31_000)
    })
  })

  /**
   * The scheduled refresh asks this before it re-resolves. `setTarget` clears the
   * channel's pending grants on a version change, so refreshing under a live wave
   * would strand the machine mid-download against a descriptor nobody publishes.
   */
  describe('operationActive', () => {
    it('is false with no wave in flight', () => {
      const { svc } = make([m('a')])
      expect(svc.operationActive('dev')).toBe(false)
    })

    it('is true while a grant is outstanding on that channel, and only that channel', () => {
      const { svc } = make([m('a')])
      svc.setTarget('dev', { version: '0.4.2', critical: false, artifacts: {} } as never)
      svc.authorize('dev')

      expect(svc.operationActive('dev')).toBe(true)
      expect(svc.operationActive('stable')).toBe(false)
    })

    it('is false again once the machine reports it reached the target', () => {
      const { svc } = make([m('a')])
      svc.setTarget('dev', { version: '0.4.2', critical: false, artifacts: {} } as never)
      svc.authorize('dev')
      svc.onStatus(asMachineId('a'), { type: 'updateStatus', state: 'current', version: '0.4.2' })

      expect(svc.operationActive('dev')).toBe(false)
    })
  })
})
