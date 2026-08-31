import {
  asMachineId,
  DEFAULT_FLEET_UPDATE_CHANNEL,
  resolveMachineChannel,
  type UpdateChannel,
} from '@podium/model'
import { resolveUpdateChannel } from '@podium/runtime/config'
import { describe, expect, it, vi } from 'vitest'
import type { GrantCause } from './grant-cause'
import { classifyMachineFailure } from './operation'
import { UpdatesService } from './service'

/**
 * The causes these cases state. Every granting method REQUIRES one (POD-2907),
 * so a test cannot exercise a grant without saying who it is standing in for —
 * which is the same discipline the production call sites are under.
 */
const TEST_APPLY: GrantCause = {
  initiator: { kind: 'operator-apply' },
  eligibility: 'a person pressed Apply on this fleet row',
}
const TEST_REPAIR: GrantCause = {
  initiator: { kind: 'operator-repair' },
  eligibility: 'a person asked for a payload repair',
}
const TEST_RETRY: GrantCause = {
  initiator: { kind: 'operation-retry', operationId: 'op_test', step: 'machines' },
  eligibility: 'a grant went silent and the step stalled',
}

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

  it('does not widen when the canary only reports target before reconnecting', () => {
    const { svc, send } = make([m('a'), m('b'), m('c')])
    svc.setTarget({ version: '0.4.2', critical: false, artifacts: {} } as never)
    svc.tick()
    svc.onStatus(asMachineId('a'), { type: 'updateStatus', state: 'current', version: '0.4.2' })
    svc.tick()
    expect(send).toHaveBeenCalledTimes(1)
    expect(svc.fleet()[0]).toMatchObject({ state: 'restarting' })
  })

  it('carries one authorization from the canary into the wider wave', () => {
    const machines = [m('a'), m('b'), m('c')]
    const { svc, send } = make(machines)
    svc.setTarget({ version: '0.4.2', critical: false, artifacts: {} } as never)

    expect(svc.authorize()).toEqual(['a'])
    expect(send).toHaveBeenCalledTimes(1)

    const canary = machines[0]
    if (canary) canary.version = '0.4.2'
    svc.fleet()
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
    svc.setTarget({
      version: 'dev+47a01e3',
      critical: false,
      artifacts: { web: { digest: '47a01e3' } },
    } as never)
    svc.markAuthorized()
    expect(send).not.toHaveBeenCalled()
  })

  /**
   * REPLACES "ticks an authorized wave when the same version gains a headless
   * artifact" (POD-2098).
   *
   * Re-publishing a descriptor used to also start granting, which made
   * publishing a way to run a wave and made a mid-update publication mutate one
   * (spec §3.2, §10.2). Sequencing belongs to the durable operation now: the
   * `machines` step ticks explicitly, once, after `prepare`. What setTarget must
   * still do — and this is the half that would silently strand an update if it
   * were lost — is REPLACE the descriptor without resetting the proof already
   * made for that version.
   */
  it('swaps a same-version descriptor in place without granting anything', () => {
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
        headless: {
          delivery: 'feed',
          platforms: { 'linux-x64': { url: 'http://x', digest: 'd', signature: 's' } },
        },
      },
    } as never)
    // The bytes the wave is about to deliver are now published…
    expect(svc.target('dev')?.artifacts.headless).toBeDefined()
    // …and the authorization survived the swap, so the operation's own tick
    // will grant against the packed descriptor.
    expect(send).not.toHaveBeenCalled()
    expect(svc.tick('dev')).toEqual(['a'])
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
        headless: {
          delivery: 'feed',
          platforms: { 'linux-x64': { url: 'http://x', digest: 'd', signature: 's' } },
        },
      },
    } as never)
    expect(send).not.toHaveBeenCalled()
  })

  it('resets canary health when the target changes', () => {
    const machines = [m('a'), m('b'), m('c')]
    const { svc, send } = make(machines)
    svc.setTarget({ version: '0.4.2', critical: false, artifacts: {} } as never)
    svc.tick()
    const canary = machines[0]
    if (canary) canary.version = '0.4.2'
    svc.fleet()
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

  /**
   * ONE GRANT PER MACHINE, PER WIDENING STEP (POD-2180).
   *
   * The two ways a wave continues used to be able to run INSIDE each other.
   * `tick()` read the fleet; `fleet()`, finding the canary proven at the target
   * in the machine directory, ticked the channel back from inside that read. The
   * inner tick granted b and c and returned the projection it had built BEFORE
   * those grants — so the outer tick planned against a fleet in which nobody was
   * in flight, and granted b and c a second time with fresh grant ids.
   *
   * It is not a cosmetic duplicate. The daemon's grant runner cancels the
   * delivery in flight when a NEWER grant id arrives, so the second grant
   * restarts every download the first one had already begun.
   */
  it('grants each widened machine exactly once', () => {
    const machines = [m('a'), m('b'), m('c')]
    const { svc, send } = make(machines)
    svc.setTarget({ version: '0.4.2', critical: false, artifacts: {} } as never)

    expect(svc.authorize()).toEqual(['a'])
    const canary = machines[0]
    if (!canary) throw new Error('test canary missing')
    // The canary proves the target by RECONNECTING: the directory, not a status
    // frame, is what makes the wave widen on the next tick.
    canary.version = '0.4.2'
    send.mockClear()

    expect(svc.tick()).toEqual(['b', 'c'])
    expect(send.mock.calls.map(([machineId]) => machineId)).toEqual(['b', 'c'])
  })

  /**
   * A READ THAT CONTINUES A WAVE MUST DESCRIBE THE WAVE IT CONTINUED (POD-2180).
   *
   * `fleet()` may still widen — that is what stops the panel reaching "1 of N"
   * and waiting for a second Apply. What it must not do is answer with the
   * projection it took before granting: a caller told that b is idle a
   * microsecond after b was handed an update will plan against that, which is
   * how the duplicate above was issued in the first place.
   */
  it('reports the grants it issued from inside a fleet read', () => {
    const machines = [m('a'), m('b'), m('c')]
    const { svc } = make(machines)
    svc.setTarget({ version: '0.4.2', critical: false, artifacts: {} } as never)
    svc.authorize()

    const canary = machines[0]
    if (!canary) throw new Error('test canary missing')
    canary.version = '0.4.2'

    const seen = new Map(svc.fleet().map((machine) => [machine.id, machine.state]))
    expect(seen.get('a')).toBe('current')
    expect(seen.get('b')).toBe('granted')
    expect(seen.get('c')).toBe('granted')
  })

  it('requires the raw reconnect identity instead of optimistic current status', () => {
    const machines = [m('a')]
    const { svc } = make(machines)
    svc.setTarget({ version: '0.4.2', critical: false, artifacts: {} } as never)
    svc.authorize()
    svc.onStatus(asMachineId('a'), { type: 'updateStatus', state: 'current', version: '0.4.2' })

    expect(svc.fleet()[0]).toMatchObject({ state: 'restarting', version: '0.4.2' })
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

      expect(svc.authorizeMachine(asMachineId('current'), TEST_APPLY)).toEqual({
        result: 'already-current',
        version: '0.4.2',
      })
      expect(svc.authorizeMachine(asMachineId('offline'), TEST_APPLY)).toEqual({ result: 'offline' })
      expect(svc.authorizeMachine(asMachineId('missing'), TEST_APPLY)).toEqual({ result: 'unknown-machine' })

      expect(svc.authorizeMachine(asMachineId('flying'), TEST_APPLY)).toMatchObject({ result: 'granted' })
      // A second apply while the first is still converging is not a failure.
      expect(svc.authorizeMachine(asMachineId('flying'), TEST_APPLY)).toEqual({
        result: 'in-flight',
        state: 'granted',
      })
    })

    it('refuses a source checkout explicitly without issuing a grant', () => {
      const { svc, send } = make([m('source', { installKind: 'source' })])
      svc.setTarget(target)

      expect(svc.authorizeMachine(asMachineId('source'), TEST_APPLY)).toEqual({
        result: 'source-checkout',
      })
      expect(send).not.toHaveBeenCalled()
    })

    it('grants an equal-version payload when the operator requests repair', () => {
      const { svc, send } = make([m('current', { version: '0.4.2' })])
      svc.setTarget(target)

      expect(svc.repairMachine(asMachineId('current'), TEST_REPAIR)).toEqual({
        result: 'granted',
        version: '0.4.2',
      })
      expect(send).toHaveBeenCalledWith(
        asMachineId('current'),
        expect.objectContaining({ type: 'updateGrant', repair: true }),
      )
    })

    it('explains an unresolved authority rather than reporting a missing grant', () => {
      const { svc } = make([m('a')])
      expect(svc.authorizeMachine(asMachineId('a'), TEST_APPLY)).toMatchObject({ result: 'no-target' })
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

      expect(svc.authorizeMachine(asMachineId('a'), TEST_APPLY)).toEqual({
        result: 'granted',
        version: '0.4.2',
      })
      expect(send).toHaveBeenCalledTimes(1)
    })

    /**
     * A WAVE ALREADY WIDE STAYS WIDE WHEN A HUMAN APPLIES ONE ROW (POD-2220).
     *
     * The canary proof is a statement about the BUNDLE, not about the machine
     * that carried it: §6.2's soak is what makes a fleet-wide automatic update
     * safe, and it is earned once, by some machine holding the target through a
     * healthy handshake. A human clicking Apply on one refused row has decided
     * about that row. It has not made the bundle unproven, and treating it as if
     * it had costs every OTHER machine on the channel a soak it already paid
     * for — the wave drops back to one machine at a time, and grants nothing at
     * all while the applied row is still in flight.
     *
     * The scenario is the operator's ordinary one: canary proves, wave widens,
     * one machine refuses on something local (a dirty checkout), the operator
     * fixes it and clicks Apply on that row.
     */
    it('keeps widening after a human applies one refused machine', () => {
      const machines = [m('a'), m('b'), m('c'), m('d'), m('e'), m('f')]
      const { svc } = make(machines)
      svc.setTarget(target)

      expect(svc.tick()).toEqual(['a'])
      // The canary holds the target: the bundle is proven for this channel.
      const canary = machines[0]
      if (canary) canary.version = '0.4.2'
      expect(svc.tick()).toEqual(['b', 'c', 'd'])
      const b = machines[1]
      const c = machines[2]
      if (b) b.version = '0.4.2'
      if (c) c.version = '0.4.2'
      svc.fleet()
      svc.onStatus(asMachineId('d'), {
        type: 'updateStatus',
        state: 'rejected',
        version: '0.4.1',
        detail: 'machine-dirty-checkout',
      })

      expect(svc.authorizeMachine(asMachineId('d'), TEST_APPLY)).toEqual({
        result: 'granted',
        version: '0.4.2',
      })

      // `d` is the only machine in flight, and NOTHING has converged since the
      // Apply — so this is the whole window the regression lives in. The two
      // machines that have never been granted are still owed the rest of the
      // concurrency budget.
      expect(svc.tick()).toEqual(['e', 'f'])
    })

    /**
     * The other half of POD-2220, so the fix cannot be read as "the canary is
     * never re-proved". A FLEET-wide retry is a new decision about the whole
     * channel, and §6.2 says a wave that re-opens starts by proving one machine
     * before it moves the rest.
     */
    it('still re-proves a canary when the retry is fleet-wide', () => {
      const machines = [m('a'), m('b'), m('c'), m('d'), m('e'), m('f')]
      const { svc } = make(machines)
      svc.setTarget(target)

      expect(svc.tick()).toEqual(['a'])
      const canary = machines[0]
      if (canary) canary.version = '0.4.2'
      expect(svc.tick()).toEqual(['b', 'c', 'd'])
      const b = machines[1]
      const c = machines[2]
      if (b) b.version = '0.4.2'
      if (c) c.version = '0.4.2'
      svc.fleet()
      svc.onStatus(asMachineId('d'), {
        type: 'updateStatus',
        state: 'rejected',
        version: '0.4.1',
      })

      // Same fleet, same moment — but the human pressed the channel's Apply, not
      // one row's. Exactly one machine is granted.
      expect(svc.authorize()).toEqual(['d'])
    })
  })

  /**
   * WHERE THE DEADLINE WENT (POD-2101). This service used to age a silent grant
   * into `stuck` from inside `fleet()` — which meant an update nobody was
   * reading was an update nothing was timing. The operation's `machines` step
   * owns that authority now, on a timer; what stays here is ENDING a grant when
   * something with authority says so.
   */
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
        fleetChannel: () => 'dev',
      })
      return { svc, send, tick: (ms: number) => (clock += ms) }
    }

    it('does not age a grant from a fleet read, however long it is left silent', () => {
      const { svc, tick } = makeClock([m('a')])
      svc.setTarget(target)
      svc.authorize()
      expect(svc.fleet()[0]).toMatchObject({ state: 'granted' })

      // An hour of wall clock and a dozen readers: reading is not the passage
      // of time, and this service no longer pretends otherwise.
      tick(60 * 60_000)
      for (let i = 0; i < 12; i++) expect(svc.fleet()[0]).toMatchObject({ state: 'granted' })
    })

    it('records an abandoned wait so giving up is visible, not silent', () => {
      const { svc } = makeClock([m('a'), m('b', { version: '0.4.2' })])
      svc.setTarget(target)
      svc.authorize()

      expect(svc.abandonWait(['a', 'b'], 'the server stopped waiting')).toEqual(['a'])
      expect(svc.fleet()[0]).toMatchObject({ state: 'stuck', detail: 'the server stopped waiting' })
    })

    it('releases every grant still in flight when the operation that owned them ends', () => {
      // Otherwise deleting the ageing would strand the row forever: excluded
      // from every future wave, and `operationActive` true for good.
      const { svc } = makeClock([m('a'), m('b')])
      svc.setTarget(target)
      // One canary first, so exactly one machine is mid-grant here.
      svc.authorize()
      expect(svc.operationActive('dev')).toBe(true)

      expect(svc.releaseInFlightGrants()).toEqual(['a'])
      expect(svc.fleet()[0]).toMatchObject({
        state: 'stuck',
        detail: 'The machine stopped reporting progress while updating.',
      })
      expect(svc.operationActive('dev')).toBe(false)
    })

    it('re-issues the grant for a machine the planner would otherwise skip', () => {
      // The one automatic retry. `tick()` cannot do this: the planner excludes
      // a machine it believes is mid-grant, so the retry would grant nobody.
      const { svc, send } = make([m('a')])
      svc.setTarget(target)
      svc.authorize()
      svc.onStatus(asMachineId('a'), {
        type: 'updateStatus',
        grantId: 'g1',
        state: 'downloading',
        version: '0.4.1',
      })
      send.mockClear()
      expect(svc.tick('dev')).toEqual([])

      expect(svc.reissueGrants('dev', undefined, TEST_RETRY)).toEqual(['a'])
      expect(send).toHaveBeenCalledTimes(1)
      expect(send.mock.calls[0]?.[1]).toMatchObject({ type: 'updateGrant', grantId: 'g2' })
    })

    it('does not replay a terminal boot report for a different target', () => {
      const { svc } = makeClock([m('a')])
      svc.onStatus(asMachineId('a'), {
        type: 'updateStatus',
        grantId: 'g1',
        targetVersion: '0.4.3',
        state: 'stuck',
        version: '0.4.1',
        detail: 'belongs to another release',
      })

      svc.setTarget(target)

      expect(svc.fleet()[0]).toMatchObject({ state: 'current', version: '0.4.1' })
    })

    it('keeps a packaged crash report after the coordinator replaced its grant', () => {
      const { svc } = make([m('a')])
      svc.setTarget(target)
      svc.authorize()
      svc.onStatus(asMachineId('a'), {
        type: 'updateStatus',
        grantId: 'g1',
        state: 'restarting',
        version: '0.4.1',
      })

      // The operation spends its bounded retry while the crashed packaged
      // process is down, so g2 is now the coordinator's correlation id. The
      // durable marker that survives the process crash still names g1.
      expect(svc.reissueGrants('dev', undefined, TEST_RETRY)).toEqual(['a'])
      svc.onStatus(asMachineId('a'), {
        type: 'updateStatus',
        grantId: 'g1',
        targetVersion: '0.4.2',
        state: 'rejected',
        version: '0.4.1',
        detail: 'attempt 2 of 2 did not reach 0.4.2 (running 0.4.1); applying again will retry it',
      })

      const failed = svc.fleet()[0]
      expect(failed).toMatchObject({
        state: 'rejected',
        version: '0.4.1',
        detail: expect.stringContaining('did not reach 0.4.2'),
      })
      expect(classifyMachineFailure(failed?.detail)).toBe('machine-update-not-confirmed')
      expect(svc.operationActive('dev')).toBe(false)
    })

    it('does not apply a recovered crash report to a different packaged target', () => {
      const { svc } = make([m('a')])
      svc.setTarget(target)
      svc.authorize()
      svc.onStatus(asMachineId('a'), {
        type: 'updateStatus',
        grantId: 'g1',
        state: 'restarting',
        version: '0.4.1',
      })
      expect(svc.reissueGrants('dev', undefined, TEST_RETRY)).toEqual(['a'])

      svc.onStatus(asMachineId('a'), {
        type: 'updateStatus',
        grantId: 'g1',
        targetVersion: '0.4.3',
        state: 'rejected',
        version: '0.4.1',
        detail: 'belongs to another release',
      })

      expect(svc.fleet()[0]).toMatchObject({
        state: 'granted',
        version: '0.4.1',
      })
      expect(svc.fleet()[0]).not.toHaveProperty('detail')
      expect(svc.operationActive('dev')).toBe(true)
    })

    it('does not re-grant a source checkout from legacy in-flight state', () => {
      const source = { ...m('a'), installKind: 'installed' }
      const { svc, send } = make([source])
      svc.setTarget(target)
      svc.authorize()
      source.installKind = 'source'
      send.mockClear()

      expect(svc.reissueGrants('dev', undefined, TEST_RETRY)).toEqual([])
      expect(send).not.toHaveBeenCalled()
    })

    it('does not re-grant a machine that is offline or already at the target', () => {
      const { svc, send } = make([m('a', { online: false }), m('b', { version: '0.4.2' })])
      svc.setTarget(target)
      svc.authorize()
      send.mockClear()

      expect(svc.reissueGrants('dev', undefined, TEST_RETRY)).toEqual([])
      expect(send).not.toHaveBeenCalled()
    })
  })

  /** The frame that makes "downloading" mean something (POD-2101, spec §3.3). */
  describe('progress heartbeats', () => {
    const target = { version: '0.4.2', critical: false, artifacts: {} } as never

    it('carries a percentage from the daemon onto the fleet projection', () => {
      const { svc } = make([m('a')])
      svc.setTarget(target)
      svc.authorize()
      svc.onStatus(asMachineId('a'), {
        type: 'updateStatus',
        grantId: 'g1',
        state: 'downloading',
        version: '0.4.1',
        percent: 62,
        phaseDetail: 'downloading',
      })

      expect(svc.fleet()[0]).toMatchObject({
        state: 'downloading',
        percent: 62,
        phaseDetail: 'downloading',
      })
    })

    it('accepts a repeat of the same state as a new report', () => {
      const { svc } = make([m('a')])
      svc.setTarget(target)
      svc.authorize()
      for (const percent of [10, 35, 90]) {
        svc.onStatus(asMachineId('a'), {
          type: 'updateStatus',
          grantId: 'g1',
          state: 'downloading',
          version: '0.4.1',
          percent,
        })
      }

      expect(svc.fleet()[0]).toMatchObject({ state: 'downloading', percent: 90 })
    })

    it('drops the percentage when the phase moves on', () => {
      // A stale 62% sitting under `restarting` is worse than no number at all.
      const { svc } = make([m('a')])
      svc.setTarget(target)
      svc.authorize()
      svc.onStatus(asMachineId('a'), {
        type: 'updateStatus',
        grantId: 'g1',
        state: 'downloading',
        version: '0.4.1',
        percent: 62,
      })
      svc.onStatus(asMachineId('a'), {
        type: 'updateStatus',
        grantId: 'g1',
        state: 'restarting',
        version: '0.4.1',
      })

      expect(svc.fleet()[0]).not.toHaveProperty('percent')
    })

    it('converges a daemon that reports no percentage at all', () => {
      const machines = [m('a')]
      const { svc } = make(machines)
      svc.setTarget(target)
      svc.authorize()
      svc.onStatus(asMachineId('a'), {
        type: 'updateStatus',
        grantId: 'g1',
        state: 'downloading',
        version: '0.4.1',
      })
      expect(svc.fleet()[0]).not.toHaveProperty('percent')

      svc.onStatus(asMachineId('a'), {
        type: 'updateStatus',
        grantId: 'g1',
        state: 'current',
        version: '0.4.2',
      })
      expect(svc.fleet()[0]).toMatchObject({ state: 'restarting', version: '0.4.2' })
      const machine = machines[0]
      if (machine) machine.version = '0.4.2'
      expect(svc.fleet()[0]).toMatchObject({ state: 'current', version: '0.4.2' })
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
    /**
     * TOKENIZED, AND THIS FIXTURE IS WHY (POD-2241). The reason is free prose
     * from the development publisher, and this real one says "uncommitted" —
     * about the SERVER's checkout. Untokenized, both readers matched their
     * dirty-working-tree pattern and told the operator to go and commit files
     * on a machine that had none. The prefix is what makes the withdrawal
     * classifiable before anyone's sentence can claim a token.
     */
    expect(row?.detail).toBe('update-withdrawn: The source checkout has 2 uncommitted changes.')
    expect(classifyMachineFailure(row?.detail)).toBe('update-withdrawn')
    // The CHANNEL's reason stays bare: there it is the whole answer, not one
    // machine's verdict.
    expect(svc.targetUnavailableReasonFor(asMachineId('a'))).toBe(
      'The source checkout has 2 uncommitted changes.',
    )
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

  const cases: {
    name: string
    pin?: UpdateChannel
    fleetDefault?: UpdateChannel
    expected: UpdateChannel
  }[] = [
    {
      name: 'an explicit pin wins over the fleet default',
      pin: 'edge',
      fleetDefault: 'stable',
      expected: 'edge',
    },
    {
      name: 'a pin is honoured even when it matches nothing else',
      pin: 'dev',
      fleetDefault: 'stable',
      expected: 'dev',
    },
    { name: 'no pin follows a stable fleet default', fleetDefault: 'stable', expected: 'stable' },
    { name: 'no pin follows an edge fleet default', fleetDefault: 'edge', expected: 'edge' },
    { name: 'no pin follows a dev fleet default', fleetDefault: 'dev', expected: 'dev' },
    {
      name: 'no pin and no stated fleet default falls back to the one shared constant',
      expected: DEFAULT_FLEET_UPDATE_CHANNEL,
    },
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
    resolveTarget: (channel: UpdateChannel) => Promise<never>,
    opts: {
      fleetChannel?: UpdateChannel
      machines?: unknown[]
      locallyPublished?: (channel: UpdateChannel) => boolean
    } = {},
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
      ...(opts.locallyPublished ? { locallyPublished: opts.locallyPublished } : {}),
      fleetChannel: () => opts.fleetChannel ?? 'stable',
    })
    return { svc, advance: (ms: number) => (clock += ms) }
  }

  it('records when a channel was checked and that it succeeded', async () => {
    const { svc } = build(async () => target)
    expect(await svc.refreshTarget('stable')).toBe(true)
    expect(svc.channelChecks()).toEqual([
      { channel: 'stable', checkedAt: 1_000, outcome: { status: 'ok' } },
    ])
  })

  it('records the reason a check failed, carrying the resolver message', async () => {
    const { svc } = build(async () => {
      throw new Error('stable target unavailable: fetch failed')
    })
    expect(await svc.refreshTarget('stable')).toBe(false)
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

  /**
   * DEV IS RESOLVED, NOT REPORTED ON (spec §1).
   *
   * This used to assert the opposite: `refreshTarget('dev')` polled nothing and
   * only reported on whatever the publisher had already pushed, because there
   * was no dev feed to ask. There is one now, so dev takes the same three lines
   * every other channel takes — including recording the feed's own reason when
   * it cannot answer, which is what makes "nothing is published" distinguishable
   * from "we have not looked".
   */
  it('resolves dev through the same resolver as every other channel', async () => {
    const resolveTarget = vi.fn(async (_channel: UpdateChannel) => target)
    const { svc } = build(resolveTarget as never, { fleetChannel: 'dev' })

    await svc.refreshTarget('dev')

    expect(resolveTarget.mock.calls.map(([channel]) => channel)).toEqual(['dev'])
    expect(svc.target('dev')).toBe(target)
    expect(svc.channelChecks()).toEqual([
      { channel: 'dev', checkedAt: 1_000, outcome: { status: 'ok' } },
    ])
  })

  it('records the dev feed’s own reason when it cannot answer', async () => {
    const { svc } = build(
      async () => {
        throw new Error('dev target unavailable: release manifest returned HTTP 404')
      },
      { fleetChannel: 'dev' },
    )

    await svc.refreshTarget('dev')

    expect(svc.target('dev')).toBeUndefined()
    expect(svc.channelChecks()[0]?.outcome).toEqual({
      status: 'unavailable',
      reason: 'dev target unavailable: release manifest returned HTTP 404',
    })
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
   * POD-2153: the in-flight map used to sit on `checkNow` alone, so it only ever
   * guarded that one caller against itself. Six production sites reach
   * `refreshTarget` directly — the two boot resolves and the periodic tick in
   * `server.ts`, `onFleetChannelChanged` in `modules/instance/trpc.ts`, and both
   * fleet handlers — and every one of them opened a second concurrent request to
   * the release feed.
   *
   * The duplicate request is the small half. The large half is that both resolves
   * end in `setTarget`, which is LAST-WRITER-WINS BY COMPLETION ORDER: a slow
   * resolve that started first can land after a fresh one and overwrite a newer
   * target with a staler one. Sharing the in-flight promise removes the overlap
   * that makes the ordering question exist at all.
   */
  describe('refresh coalescing across callers', () => {
    /** A resolver that hangs until released, so two callers are genuinely concurrent. */
    const suspended = () => {
      let finish!: (resolved: typeof target) => void
      const resolving = new Promise<typeof target>((resolve) => {
        finish = resolve
      })
      return { resolveTarget: vi.fn(() => resolving), finish: () => finish(target) }
    }

    it('a forced check joins a refresh already in flight from another caller', async () => {
      const { resolveTarget, finish } = suspended()
      const { svc } = build(resolveTarget as never)

      // The periodic tick (server.ts:440) — also the shape of boot and both fleet handlers.
      const tick = svc.refreshTarget('stable')
      // …and the user hits "Check now" while it is mid-flight.
      const forced = svc.checkNow()

      expect(resolveTarget).toHaveBeenCalledTimes(1)
      finish()
      const [, forcedResult] = await Promise.all([tick, forced])
      expect(resolveTarget).toHaveBeenCalledTimes(1)
      // The joined caller still gets a real answer, not a silent no-op.
      expect(forcedResult).toEqual([
        { channel: 'stable', checkedAt: 1_000, outcome: { status: 'ok' } },
      ])
    })

    it('a fleet-handler refresh joins a forced check already in flight', async () => {
      const { resolveTarget, finish } = suspended()
      const { svc } = build(resolveTarget as never)

      const forced = svc.checkNow()
      // machineApplyUpdateHandler / machineSetUpdateChannelHandler / onFleetChannelChanged.
      const handler = svc.refreshTarget('stable')

      expect(resolveTarget).toHaveBeenCalledTimes(1)
      finish()
      await Promise.all([forced, handler])
      expect(resolveTarget).toHaveBeenCalledTimes(1)
    })

    it('coalesces per channel, not globally', async () => {
      const resolveTarget = vi.fn(async (_channel: 'edge' | 'stable') => target)
      const { svc } = build(resolveTarget as never)

      await Promise.all([svc.refreshTarget('stable'), svc.refreshTarget('edge')])

      expect(resolveTarget.mock.calls.map(([channel]) => channel)).toEqual(['stable', 'edge'])
    })

    it('releases the in-flight slot so a later caller resolves again', async () => {
      const resolveTarget = vi.fn(async (_channel: 'edge' | 'stable') => target)
      const { svc, advance } = build(resolveTarget as never)

      await svc.refreshTarget('stable')
      advance(60_000)
      await svc.refreshTarget('stable')

      expect(resolveTarget).toHaveBeenCalledTimes(2)
    })

    /**
     * A rejected resolve must not pin the channel's slot forever — that would be a
     * permanent outage manufactured out of one unreachable second.
     */
    it('releases the in-flight slot after a failed resolve', async () => {
      let fail = true
      const resolveTarget = vi.fn(async (_channel: 'edge' | 'stable') => {
        if (fail) throw new Error('stable target unavailable: fetch failed')
        return target
      })
      const { svc, advance } = build(resolveTarget as never)

      await svc.refreshTarget('stable')
      fail = false
      advance(60_000)
      await svc.refreshTarget('stable')

      expect(resolveTarget).toHaveBeenCalledTimes(2)
      expect(svc.target('stable')).toBe(target)
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

    it('is false again once the machine reconnects at the target', () => {
      const machines = [m('a')]
      const { svc } = make(machines)
      svc.setTarget('dev', { version: '0.4.2', critical: false, artifacts: {} } as never)
      svc.authorize('dev')
      svc.onStatus(asMachineId('a'), { type: 'updateStatus', state: 'current', version: '0.4.2' })

      expect(svc.operationActive('dev')).toBe(true)
      const machine = machines[0]
      if (machine) machine.version = '0.4.2'
      svc.fleet()
      expect(svc.operationActive('dev')).toBe(false)
    })
  })
})

/**
 * THE CONSENT DIES WITH THE OPERATION THAT HELD IT (POD-2169, spec §3.2).
 *
 * `fleet()` is a read that ACTS: a machine whose directory version proves the
 * target makes the canary healthy and continues an authorized wave from inside
 * the projection. That is what stops a running update reaching "1 of N" and
 * waiting for a second Apply. Nothing took the consent back when the operation
 * ended, so the same mechanism went on granting afterwards.
 */
describe('withdrawAuthorization', () => {
  const target = { version: '0.4.2', critical: false, artifacts: {} } as never

  /**
   * The failure exactly as reported. The user cancels; the coordinator marks the
   * in-flight machines stuck. But a grant already sent is never recalled and the
   * daemon's swap is crash-safe, so `a` finishes anyway and reconnects at the
   * target — and the next read of the fleet, from anywhere, granted `b`.
   */
  it('stops the wave continuing after a machine finishes a cancelled grant', () => {
    const machines = [m('a'), m('b')]
    const { svc, send } = make(machines)
    svc.setTarget('dev', target)
    svc.authorize('dev')
    expect(send).toHaveBeenCalledTimes(1)

    // The operation terminates. This is what `onChanged` does, in its order.
    svc.withdrawAuthorization()
    svc.releaseInFlightGrants('The update was canceled while this machine was updating.')

    // `a`'s daemon swapped anyway and came back on the new version.
    machines[0] = m('a', { version: '0.4.2' })
    const granted = send.mock.calls.length
    svc.fleet()
    svc.fleet()

    expect(send).toHaveBeenCalledTimes(granted)
  })

  /** …and the cleanup itself must not be the thing that grants: it reads `fleet()`. */
  it('is safe to call before releaseInFlightGrants, which is a fleet read', () => {
    const machines = [m('a', { version: '0.4.2', state: 'downloading' }), m('b')]
    const { svc, send } = make(machines)
    svc.setTarget('dev', target)
    svc.authorize('dev')
    const granted = send.mock.calls.length

    svc.withdrawAuthorization()
    svc.releaseInFlightGrants()

    expect(send).toHaveBeenCalledTimes(granted)
  })

  /**
   * A deliberate Apply is new authority, so the machinery must come back — the
   * withdrawal ends one operation's consent, it does not disable the channel.
   */
  it('is restored by the next deliberate authorization', () => {
    const machines = [m('a'), m('b')]
    const { svc, send } = make(machines)
    svc.setTarget('dev', target)
    svc.authorize('dev')
    svc.withdrawAuthorization()

    machines[0] = m('a', { version: '0.4.2' })
    svc.authorize('dev')
    expect(send.mock.calls.length).toBeGreaterThan(1)
  })

  it('says nothing about a channel that has no rollout at all', () => {
    const { svc } = make([m('a')])
    expect(() => svc.withdrawAuthorization()).not.toThrow()
    expect(() => svc.withdrawAuthorization('stable')).not.toThrow()
  })
})

/**
 * WHICH CHANNEL AN OPERATION IS ABOUT (POD-2189).
 *
 * Both composition roots wrote `channel: 'dev'` as a literal. `make()` above
 * states a `dev` fleet default because its cases are about the development
 * wave; these deliberately do not, because the bug was exactly the difference
 * between what a development coordinator sees and what a shipped one does.
 */
describe('UpdatesService.operationChannel', () => {
  const shipped = (machines: unknown[], fleetChannel?: UpdateChannel) =>
    new UpdatesService({
      machines: () => machines as never,
      send: vi.fn(),
      now: () => 1_000,
      nextGrantId: () => 'g1',
      concurrency: 3,
      ...(fleetChannel ? { fleetChannel: () => fleetChannel } : {}),
    })

  /**
   * THE DEFECT, stated as the fleet it broke. Nothing here is pinned and no
   * fleet default is configured, which is every shipped installation — and
   * `DEFAULT_FLEET_UPDATE_CHANNEL` is `stable`, so the hardcoded `'dev'` sent
   * `planInputFrom` looking for a target that by construction was not there.
   */
  it('is the shipped fleet default, not dev, when nothing is pinned', () => {
    const svc = shipped([m('host'), m('vps')])
    expect(svc.operationChannel('host')).toBe(DEFAULT_FLEET_UPDATE_CHANNEL)
    expect(svc.operationChannel('host')).not.toBe('dev')
  })

  it("follows the host's own pin", () => {
    const svc = shipped([m('host', { channel: 'edge' }), m('vps', { channel: 'stable' })])
    expect(svc.operationChannel('host')).toBe('edge')
  })

  /** A development coordinator still gets a dev operation — the previous
   *  behaviour was not wrong, it was only ever right for one fleet. */
  it('still answers dev where dev is what this installation follows', () => {
    const svc = shipped([m('host')], 'dev')
    expect(svc.operationChannel('host')).toBe('dev')
  })

  /**
   * Before the host's own handshake there is no row to read, and the question
   * "what does an unpinned machine follow?" has the same answer either way. It
   * matters because one composition root is the ADOPTION path, which runs
   * before the daemon gateway listens.
   */
  it('falls back to the fleet default when the host is not in the directory yet', () => {
    const svc = shipped([], 'edge')
    expect(svc.operationChannel('host')).toBe('edge')
    expect(svc.operationChannel(undefined)).toBe('edge')
  })

  /** One answer, not two (POD-2100): this must agree with the authority that
   *  will actually grant, which is `channelOf` on the same row. */
  it('agrees with channelOf for the host row', () => {
    const host = m('host', { channel: 'stable' })
    const svc = shipped([host], 'dev')
    expect(svc.operationChannel('host')).toBe(svc.channelOf(host as never))
  })
})

/**
 * WHAT `/version` ADVERTISES, AND WHY IT IS NOT ALWAYS DEV (POD-2222/POD-2212).
 *
 * The panel's whole OFFER is derived from `server.target` — `use-update-state`
 * reads `/version` and `describeUpdate` has nothing to show without it. That
 * target used to be assembled from publisher identity or `updates.target()`, and
 * `target()` defaults to `dev`: both halves asked the development authority. On
 * a stable installation the publisher is disabled and the dev authority has
 * nothing, so `/version` carried no target at all and a machine that was
 * genuinely behind a published stable release looked permanently up to date.
 *
 * The live drive measured the disagreement in one second: the operation
 * resolved stable `0.1.3` while `/version` advertised `dev+03a2892`. So this is
 * the same question `operationChannel` already answers — asked by the READ path
 * as well, so the offer and the action cannot name different versions.
 */
describe('UpdatesService.advertisedTarget', () => {
  const shipped = (machines: unknown[], fleetChannel?: UpdateChannel) =>
    new UpdatesService({
      machines: () => machines as never,
      send: vi.fn(),
      now: () => 1_000,
      nextGrantId: () => 'g1',
      concurrency: 3,
      ...(fleetChannel ? { fleetChannel: () => fleetChannel } : {}),
    })

  const t = (version: string) => ({ version, critical: false, artifacts: {} }) as never

  /** THE DEFECT: a stable-pinned host, a published stable release, no offer. */
  it("advertises the host's own stable authority to a stable-pinned host", () => {
    const svc = shipped([m('host', { channel: 'stable' })])
    svc.setTarget('stable', t('0.1.3'))

    expect(svc.advertisedTarget('host')?.version).toBe('0.1.3')
  })

  it('does not let a development feed speak for a stable-pinned host', () => {
    const svc = shipped([m('host', { channel: 'stable' })])
    svc.setTarget('stable', t('0.1.3'))
    svc.setTarget('dev', t('0.1.2-dev.3+03a2892'))

    expect(svc.advertisedTarget('host')?.version).toBe('0.1.3')
  })

  it('advertises only a feed-published development target on a dev-pinned host', () => {
    const svc = shipped([m('host', { channel: 'dev' })])
    const packed = {
      version: '0.1.2-dev.5+bbbbbbb',
      critical: false,
      artifacts: {
        web: { digest: 'bbbbbbb' },
        headless: {
          delivery: 'feed',
          platforms: {
            'linux-x86_64': {
              url: 'https://podium.example.test/updates/feed/dev/x.tar.gz?token=secret',
              digest: 'd',
              signature: 's',
            },
          },
        },
      },
    } as unknown as never
    svc.setTarget('dev', packed)
    const advertised = svc.advertisedTarget('host')
    expect(advertised?.artifacts.headless).toBeDefined()
    expect(advertised?.version).toBe('0.1.2-dev.5+bbbbbbb')
  })

  it('advertises no update when HEAD has only a pre-release proposal', () => {
    const svc = shipped([m('host', { channel: 'dev' })])
    expect(svc.advertisedTarget('host')).toBeUndefined()
  })

  /**
   * `/version` is the unauthenticated pre-boot probe. The feed target carries
   * the artifact token in the query string so the daemon can fetch; that token
   * must not ride the probe. The standing channel target keeps it — grants
   * read that, not the advertisement.
   */
  it('does not put a tokenised artifact URL on the advertised target', () => {
    const packed = {
      version: '0.1.2-dev.5+bbbbbbb',
      critical: false,
      artifacts: {
        headless: {
          delivery: 'feed',
          platforms: {
            'linux-x86_64': {
              url: 'http://127.0.0.1:18787/updates/feed/dev/x.tar.gz?token=secret',
              digest: 'd',
              signature: 's',
            },
          },
        },
      },
    } as unknown as never
    const svc = shipped([m('host', { channel: 'dev' })])
    svc.setTarget('dev', packed)

    const advertised = svc.advertisedTarget('host')
    const advertisedUrl = advertised?.artifacts.headless?.platforms['linux-x86_64']?.url
    expect(advertisedUrl).toBeDefined()
    expect(advertisedUrl).not.toContain('token=')
    expect(advertisedUrl).not.toContain('secret')
    expect(svc.target('dev')?.artifacts.headless?.platforms['linux-x86_64']?.url).toContain(
      'token=secret',
    )
  })

  it('follows an edge-pinned host onto edge', () => {
    const svc = shipped([m('host', { channel: 'edge' })])
    svc.setTarget('edge', t('0.2.0'))
    svc.setTarget('dev', t('dev+aaaaaaa'))

    expect(svc.advertisedTarget('host')?.version).toBe('0.2.0')
  })

  /**
   * A host that has not handshaked yet follows the fleet default — the same
   * fallback `operationChannel` makes, because this must never answer a
   * different authority than the action would grant.
   */
  it('agrees with operationChannel, including before the host is registered', () => {
    const svc = shipped([], 'stable')
    svc.setTarget('stable', t('0.1.3'))

    expect(svc.operationChannel('host')).toBe('stable')
    expect(svc.advertisedTarget('host')?.version).toBe('0.1.3')
    expect(svc.advertisedTarget(undefined)?.version).toBe('0.1.3')
  })

  /** Nothing published on the host's authority is still nothing: an absent
   *  target must not fall back to some other channel's version. */
  it('advertises nothing rather than another channel when its own has none', () => {
    const svc = shipped([m('host', { channel: 'stable' })])
    svc.setTarget('dev', t('dev+aaaaaaa'))

    expect(svc.advertisedTarget('host')).toBeUndefined()
  })
})

/**
 * A CHANNEL THIS SERVER ALSO PUBLISHES INTO MUST NOT BE WALKED BACKWARDS.
 *
 * `dev` on a source host has two producers for the length of the transition to
 * the release-proposal flow: the FEED (what has been released) and the local
 * publisher's identity (what this checkout IS). When HEAD moves without a
 * release they disagree, and the daily refresh would otherwise pull the last
 * release over a newer identity — walking the read model back to a previous
 * commit every time the tick fired.
 *
 * The exception is narrow on purpose. Every other channel must still be able to
 * move BACKWARDS, because the server is authority and a bad release has to be
 * withdrawable; a resolver that only went forward would make rollback
 * structurally impossible.
 */
describe('a channel this server also publishes into', () => {
  const versioned = (version: string) =>
    ({ version, critical: false, artifacts: {} }) as unknown as never

  const publisherHost = (resolveTarget: (channel: UpdateChannel) => Promise<never>) =>
    new UpdatesService({
      machines: () => [m('a', { channel: 'dev' })] as never,
      send: vi.fn(),
      now: () => 1_000,
      nextGrantId: () => 'g1',
      concurrency: 3,
      resolveTarget,
      locallyPublished: (channel) => channel === 'dev',
      fleetChannel: () => 'dev',
    })

  it('holds its own newer identity against an older release from the feed', async () => {
    const svc = publisherHost(async () => versioned('0.1.2-dev.4+aaaaaaa'))
    svc.setTarget('dev', versioned('0.1.2-dev.5+bbbbbbb'))

    expect(await svc.refreshTarget('dev')).toBe(true)

    expect(svc.target('dev')?.version).toBe('0.1.2-dev.5+bbbbbbb')
    // The CHECK still succeeded — the feed answered, and saying otherwise would
    // make Settings read "we have not looked" when we had.
    expect(svc.channelChecks()[0]?.outcome).toEqual({ status: 'ok' })
  })

  it('takes a NEWER release from the feed, which is the whole point of pulling', async () => {
    const svc = publisherHost(async () => versioned('0.1.2-dev.6+ccccccc'))
    svc.setTarget('dev', versioned('0.1.2-dev.5+bbbbbbb'))

    await svc.refreshTarget('dev')

    expect(svc.target('dev')?.version).toBe('0.1.2-dev.6+ccccccc')
  })

  it('takes the same version again, so an identity gains its artifacts', async () => {
    // The ordinary publish: the identity for this HEAD is already standing, and
    // the feed answers with the same version now carrying real bytes.
    const packed = {
      version: '0.1.2-dev.5+bbbbbbb',
      critical: false,
      artifacts: {
        headless: {
          delivery: 'feed',
          platforms: { 'linux-x86_64': { url: 'https://x/a', digest: 'd', signature: 's' } },
        },
      },
    } as unknown as never
    const svc = publisherHost(async () => packed)
    svc.setTarget('dev', versioned('0.1.2-dev.5+bbbbbbb'))

    await svc.refreshTarget('dev')

    expect(svc.target('dev')?.artifacts.headless).toBeDefined()
  })

  /**
   * THE PRODUCTION ORDER, which is the reverse of the case above. The publisher
   * writes the manifest, the resolver pulls a deliverable, THEN every `/version`
   * poll (and the tail of `requestBuild`) publishes the identity for the same
   * HEAD. Same version, no bytes. Replacing the standing target with that
   * descriptor is how an already-published package sat on "Waiting for the
   * update package" until the machines step timed out.
   */
  it('does not let an identity overwrite a published feed target of the same version', () => {
    const packed = {
      version: '0.1.2-dev.5+bbbbbbb',
      critical: false,
      artifacts: {
        headless: {
          delivery: 'feed',
          platforms: { 'linux-x86_64': { url: 'https://x/a', digest: 'd', signature: 's' } },
        },
      },
    } as unknown as never
    const identity = {
      version: '0.1.2-dev.5+bbbbbbb',
      critical: false,
      artifacts: { web: { digest: 'bbbbbbb' } },
    } as unknown as never
    const { svc } = make([m('a', { channel: 'dev' })])

    svc.setTarget('dev', packed)
    svc.setTarget('dev', identity)

    expect(svc.target('dev')?.artifacts.headless).toBeDefined()
    expect(svc.target('dev')?.artifacts.headless?.platforms['linux-x86_64']?.url).toBe(
      'https://x/a',
    )
  })

  it('holds against an UNORDERABLE answer too, rather than guessing', async () => {
    const svc = publisherHost(async () => versioned('not-a-version'))
    svc.setTarget('dev', versioned('0.1.2-dev.5+bbbbbbb'))

    await svc.refreshTarget('dev')

    expect(svc.target('dev')?.version).toBe('0.1.2-dev.5+bbbbbbb')
  })

  it('still lets a channel it does NOT publish into roll backwards', async () => {
    // A withdrawn release. The server is authority and rollback must work.
    const svc = new UpdatesService({
      machines: () => [m('a', { channel: 'stable' })] as never,
      send: vi.fn(),
      now: () => 1_000,
      nextGrantId: () => 'g1',
      concurrency: 3,
      resolveTarget: async () => versioned('0.4.1'),
      locallyPublished: (channel) => channel === 'dev',
      fleetChannel: () => 'stable',
    })
    svc.setTarget('stable', versioned('0.4.2'))

    await svc.refreshTarget('stable')

    expect(svc.target('stable')?.version).toBe('0.4.1')
  })
})

/**
 * THE GRANT SIDE OF THE OFFER (POD-2783).
 *
 * Not counting a machine as behind removes the BUTTON. These are the two paths
 * that can still reach a grant with the button gone — the standing wave, and a
 * human pressing Apply on that machine's own Settings row — and both have to
 * answer the same way, or the fix is only cosmetic.
 */
describe('a release that predates a machine', () => {
  const linuxOnly = {
    version: '0.4.2',
    critical: false,
    artifacts: {
      headless: {
        delivery: 'feed',
        platforms: {
          'linux-x86_64': { url: 'https://x.test/a.tgz', digest: 'd', signature: 's' },
        },
      },
    },
  } as never

  const mac = (over: Record<string, unknown> = {}) =>
    m('mac', {
      platform: 'darwin-aarch64',
      deliveryCaps: ['update.delivery.feed'],
      ...over,
    })

  it('is never granted to that machine by the standing wave', () => {
    const { svc, send } = make([mac()])
    svc.setTarget(linuxOnly)
    svc.tick()
    expect(send).not.toHaveBeenCalled()
  })

  it('still waves the machines it was built for', () => {
    const { svc, send } = make([m('vps', { platform: 'linux-x86_64' }), mac()])
    svc.setTarget(linuxOnly)
    svc.tick()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]?.[0]).toBe('vps')
  })

  /** The per-row Apply is a human asking directly, and it gets a direct answer
   *  rather than a grant the machine will refuse minutes later. */
  it('answers a per-row Apply with the platform fact instead of granting', () => {
    const { svc, send } = make([mac()])
    svc.setTarget(linuxOnly)
    expect(svc.authorizeMachine(asMachineId('mac'), TEST_APPLY)).toEqual({
      result: 'platform-not-in-release',
      platform: 'darwin-aarch64',
    })
    expect(send).not.toHaveBeenCalled()
  })

  it('answers a per-row Repair the same way, for the same reason', () => {
    const { svc, send } = make([mac()])
    svc.setTarget(linuxOnly)
    expect(svc.repairMachine(asMachineId('mac'), TEST_REPAIR)).toMatchObject({
      result: 'platform-not-in-release',
    })
    expect(send).not.toHaveBeenCalled()
  })

  it('leaves a machine that has reported no platform alone', () => {
    const { svc, send } = make([m('mute', { deliveryCaps: ['update.delivery.feed'] })])
    svc.setTarget(linuxOnly)
    svc.tick()
    expect(send).toHaveBeenCalledTimes(1)
  })
})

describe('a machine that predates channel-keyed trust', () => {
  const instanceTarget = {
    version: '0.4.2',
    critical: false,
    trust: 'instance',
    artifacts: {
      headless: {
        delivery: 'feed',
        platforms: {
          'linux-x86_64': { url: 'https://x.test/a.tgz', digest: 'd', signature: 's' },
        },
      },
    },
  } as never

  const flatblock = () =>
    m('flatblock', {
      platform: 'linux-x86_64',
      deliveryCaps: ['update.delivery.feed', 'update.delivery.bundle'],
    })

  it('is never granted the instance-trusted feed by the standing wave', () => {
    const { svc, send } = make([flatblock()])
    svc.setTarget(instanceTarget)
    svc.tick()
    expect(send).not.toHaveBeenCalled()
  })

  it('answers direct Apply with the verifier-generation fact', () => {
    const { svc, send } = make([flatblock()])
    svc.setTarget(instanceTarget)
    expect(svc.authorizeMachine(asMachineId('flatblock'), TEST_APPLY)).toEqual({
      result: 'legacy-instance-trust',
      version: '0.4.2',
    })
    expect(send).not.toHaveBeenCalled()
  })

  it('does not pretend an in-band Repair can bypass the same verifier', () => {
    const { svc, send } = make([flatblock()])
    svc.setTarget(instanceTarget)
    expect(svc.repairMachine(asMachineId('flatblock'), TEST_REPAIR)).toEqual({
      result: 'legacy-instance-trust',
      version: '0.4.2',
    })
    expect(send).not.toHaveBeenCalled()
  })

  it('continues to grant a current feed-only daemon', () => {
    const { svc, send } = make([
      m('current', { platform: 'linux-x86_64', deliveryCaps: ['update.delivery.feed'] }),
    ])
    svc.setTarget(instanceTarget)
    expect(svc.authorizeMachine(asMachineId('current'), TEST_APPLY)).toMatchObject({ result: 'granted' })
    expect(send).toHaveBeenCalledOnce()
  })
})

/**
 * POD-3170. The wave planner's `coordinator-last` rule is only worth anything
 * if the fact reaches it, and the fact is stated in a composition root
 * (`relay.ts`) that no unit test constructs. So this asks the SERVICE — the
 * projection the planner actually reads — rather than the pure planner again.
 */
describe('the machine this coordinator runs on', () => {
  const target = {
    version: '0.4.2',
    critical: false,
    artifacts: { headless: { delivery: 'feed', platforms: {} } },
  } as never

  /**
   * IDS CHOSEN SO THE OLD BEHAVIOUR WOULD FAIL THESE. Both rounds sort by id,
   * so a coordinator named `a-…` is the one the previous planner picked first —
   * as the canary below, and alongside the remote machine in the widen round.
   */
  const coordinator = m('a-ludovico', { name: 'ludovico', coordinator: true })

  it('is not the canary while a remote machine could prove the bundle instead', () => {
    const { svc } = make([coordinator, m('b-flatblock', { name: 'flatblock' })])
    svc.setTarget('dev', target)
    svc.markAuthorized('dev')

    expect(svc.tick('dev')).toEqual(['b-flatblock'])
  })

  /**
   * THE MEASURED FAILURE, at the seam that produced it. A widen round on the
   * live fleet selected `flatblock` and `ludovico` together, and `ludovico`
   * restarted 2.8 s later on top of flatblock's delivery.
   */
  it('is not granted in the same widen round as a machine still behind', () => {
    const { svc } = make([
      coordinator,
      m('b-flatblock', { name: 'flatblock' }),
      // Already at the target, so the canary gate is proved and the round widens.
      m('c-mac', { version: '0.4.2' }),
    ])
    svc.setTarget('dev', target)
    svc.markAuthorized('dev')

    const granted = svc.tick('dev')
    expect(granted).toEqual(['b-flatblock'])
    expect(granted).not.toContain('a-ludovico')
  })

  it('takes the update once the rest of the fleet is at the target', () => {
    const { svc } = make([coordinator, m('b-flatblock', { version: '0.4.2' })])
    svc.setTarget('dev', target)
    svc.markAuthorized('dev')

    expect(svc.tick('dev')).toEqual(['a-ludovico'])
  })
})
