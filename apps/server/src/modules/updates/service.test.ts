import { addSink, resetLogging, setLogLevel } from '@podium/logger'
import {
  asMachineId,
  DEFAULT_FLEET_UPDATE_CHANNEL,
  resolveMachineChannel,
  type UpdateChannel,
} from '@podium/model'
import { resolveUpdateChannel } from '@podium/runtime/config'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GrantCause } from './grant-cause'
import { classifyMachineFailure } from './operation'
import { UpdatesService, type UpdatesDeps } from './service'
import type { UpdateRecoverySnapshot } from './recovery-store'

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
function make(machines: unknown[], overrides: Partial<UpdatesDeps> = {}) {
  const send = vi.fn()
  let n = 0
  const svc = new UpdatesService({
    machines: () => machines as never,
    send,
    now: () => 1_000,
    nextGrantId: () => `g${++n}`,
    concurrency: 3,
    fleetChannel: () => 'dev',
    ...overrides,
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
  it('resolves a machine target without re-entering the enriched machine projection', async () => {
    const machines = vi.fn(() => {
      throw new Error('wire projection re-entered')
    })
    const target = { version: '0.4.2', critical: false, artifacts: {} } as never
    const svc = new UpdatesService({
      machines,
      channelFor: async (machineId) => (machineId === 'a' ? 'edge' : undefined),
      send: vi.fn(),
      now: () => 1_000,
      nextGrantId: () => 'g1',
      concurrency: 3,
    })

    svc.setTarget('edge', target)

    expect(await svc.targetFor(asMachineId('a'))).toBe(target)
    expect(await svc.targetUnavailableReasonFor(asMachineId('a'))).toBeUndefined()
    expect(machines).not.toHaveBeenCalled()
  })

  it('issues no grants until a target is set', async () => {
    const { svc, send } = make([m('a')])
    await svc.tick()
    expect(send).not.toHaveBeenCalled()
  })

  it('grants one canary on the first tick', async () => {
    const { svc, send } = make([m('a'), m('b')])
    svc.setTarget({ version: '0.4.2', critical: false, artifacts: {} } as never)
    await svc.tick()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('does not widen until the canary reports current AT the target', async () => {
    const { svc, send } = make([m('a'), m('b'), m('c')])
    svc.setTarget({ version: '0.4.2', critical: false, artifacts: {} } as never)
    await svc.tick()
    await svc.onStatus(asMachineId('a'), { type: 'updateStatus', state: 'current', version: '0.4.1' })
    await svc.tick()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('does not widen when the canary only reports target before reconnecting', async () => {
    const { svc, send } = make([m('a'), m('b'), m('c')])
    svc.setTarget({ version: '0.4.2', critical: false, artifacts: {} } as never)
    await svc.tick()
    await svc.onStatus(asMachineId('a'), { type: 'updateStatus', state: 'current', version: '0.4.2' })
    await svc.tick()
    expect(send).toHaveBeenCalledTimes(1)
    expect((await svc.fleet())[0]).toMatchObject({ state: 'restarting' })
  })

  it('carries one authorization from the canary into the wider wave', async () => {
    const machines = [m('a'), m('b'), m('c')]
    const { svc, send } = make(machines)
    svc.setTarget({ version: '0.4.2', critical: false, artifacts: {} } as never)

    expect(await svc.authorize()).toEqual(['a'])
    expect(send).toHaveBeenCalledTimes(1)

    const canary = machines[0]
    if (canary) canary.version = '0.4.2'
    await svc.fleet()
    expect(send).toHaveBeenCalledTimes(3)
  })

  describe('supervisor canary execution confirmation', () => {
    const start = (overrides: Partial<UpdatesDeps> = {}) => {
      const machines = [
        m('a', { presenceSource: 'supervisor', deliveryCaps: ['update.delivery.feed'] }),
        m('b'),
      ]
      const { svc, send } = make(machines, overrides)
      svc.setTarget({
        version: '0.4.2',
        critical: false,
        artifacts: { headless: { delivery: 'feed', platforms: {} } },
      })
      expect(svc.authorize()).toEqual(['a'])
      machines[0]!.version = '0.4.2' // Production hello precedes child startup.
      return { svc, send, machines }
    }
    const confirmed = {
      type: 'updateStatus' as const,
      state: 'current' as const,
      grantId: 'g1',
      targetVersion: '0.4.2',
      version: '0.4.2',
      phaseDetail: 'current',
    }

    const memoryRecovery = () => {
      let saved: UpdateRecoverySnapshot | undefined
      return {
        read: () => saved && structuredClone(saved),
        write: (value: UpdateRecoverySnapshot) => {
          saved = structuredClone(value)
        },
      }
    }

    it('restores exact pending authority before any target publication or fleet read', async () => {
      const recovery = memoryRecovery()
      const { machines } = start({ recovery })
      machines[0]!.online = false
      const { svc, send } = make(machines, { recovery })
      expect((await svc.fleet())[0]?.state).toBe('granted')
      expect(await svc.machineBootedAtTarget(asMachineId('a'), '0.4.2')).toBe(false)
      svc.authorize()
      expect(send).not.toHaveBeenCalled()
      machines[0]!.online = true
      svc.onStatus(asMachineId('a'), { ...confirmed, grantId: 'wrong' })
      svc.tick()
      expect(send).not.toHaveBeenCalled()
      svc.onStatus(asMachineId('a'), confirmed)
      svc.fleet()
      expect(send).toHaveBeenCalledTimes(1)
      expect(send.mock.calls[0]?.[0]).toBe('b')
    })

    it('checkpoints confirmation before widening and restores its exact terminal replay', async () => {
      const recovery = memoryRecovery()
      const { svc, machines } = start({ recovery })
      svc.onStatus(asMachineId('a'), confirmed)
      expect(recovery.read()?.machines[0]?.[1]).toMatchObject({ state: 'current', grantId: 'g1' })
      const boot = make(machines, { recovery })
      expect(await boot.svc.machineBootedAtTarget(asMachineId('a'), '0.4.2')).toBe(true)
      boot.svc.fleet()
      expect(boot.send).not.toHaveBeenCalled() // restoration is not authorization
      boot.svc.onStatus(asMachineId('a'), confirmed)
      boot.svc.authorize()
      expect(boot.send).toHaveBeenCalledTimes(1)
      expect(boot.svc.waveRounds('dev')[0]?.gate).toBe('widen')
    })

    it.each([
      'publication',
      'approval',
    ] as const)('keeps the restored fence after same-version %s replacement, even after confirmed projection', async (replacement) => {
      const recovery = memoryRecovery()
      const { svc, machines } = start({ recovery })
      svc.onStatus(asMachineId('a'), confirmed)
      svc.withdrawAuthorization()
      svc.fleet()
      const changed = { ...svc.target()!, critical: true }
      const boot = make(machines, {
        recovery,
        ...(replacement === 'approval' ? { approvedTarget: () => changed } : {}),
      })
      if (replacement === 'publication') boot.svc.setTarget(changed)
      boot.svc.onStatus(asMachineId('a'), confirmed)
      boot.svc.authorize()
      expect((await boot.svc.fleet())[0]?.state).toBe('restarting')
      expect(boot.send).not.toHaveBeenCalled()
    })

    it.each([
      'rejected',
      'stuck',
      'cancel',
    ] as const)('restores %s without accepting hello as success', async (verdict) => {
      const recovery = memoryRecovery()
      const { svc, machines } = start({ recovery })
      if (verdict === 'cancel') {
        svc.withdrawAuthorization()
        svc.releaseInFlightGrants('Canceled')
      } else svc.onStatus(asMachineId('a'), { ...confirmed, state: verdict })
      const boot = make(machines, { recovery })
      boot.svc.onStatus(asMachineId('a'), { ...confirmed, grantId: undefined })
      expect((await boot.svc.fleet())[0]?.state).toBe(verdict === 'cancel' ? 'stuck' : verdict)
      boot.svc.onStatus(asMachineId('a'), confirmed)
      expect((await boot.svc.fleet())[0]?.state).toBe('current')
      // Cancellation withdraws read-driven continuation; tick is an explicit
      // planning entry point and deliberately does not require authorization.
      if (verdict !== 'cancel') boot.svc.tick()
      boot.svc.fleet()
      expect(boot.send).not.toHaveBeenCalled()
    })

    describe('retired supervised grants', () => {
      it.each(['abandon', 'release', 'stuck', 'rejected'] as const)(
        'records late exact completion after %s, live and after reconstruction, without widening',
        async (retirement) => {
          for (const reboot of [false, true]) {
            const recovery = memoryRecovery()
            const h = start({ recovery })
            if (retirement === 'abandon') h.svc.abandonWait(['a'], 'Deadline expired')
            else if (retirement === 'release') {
              h.svc.withdrawAuthorization()
              h.svc.releaseInFlightGrants('Canceled')
            } else h.svc.onStatus(asMachineId('a'), { ...confirmed, state: retirement })
            expect(recovery.read()?.grants).toEqual([])
            expect(recovery.read()?.retiredGrants?.[0]?.[1].grantId).toBe('g1')
            const { svc, send } = reboot ? make(h.machines, { recovery }) : h
            const sentBefore = send.mock.calls.length
            expect(svc.operationActive('dev')).toBe(false)
            expect(await svc.machineBootedAtTarget(asMachineId('a'), '0.4.2')).toBe(false)
            svc.onStatus(asMachineId('a'), confirmed)
            expect(recovery.read()?.machines[0]?.[1]).toMatchObject({
              state: 'current', grantId: 'g1', projectedCurrent: true,
            })
            for (let replay = 0; replay < 3; replay++) {
              svc.onStatus(asMachineId('a'), confirmed)
              expect(svc.fleet()[0]?.state).toBe('current')
              expect(await svc.machineBootedAtTarget(asMachineId('a'), '0.4.2')).toBe(true)
              expect(svc.operationActive('dev')).toBe(false)
            }
            expect(send).toHaveBeenCalledTimes(sentBefore)
            const boot = make(h.machines, { recovery })
            expect(boot.svc.fleet()[0]?.state).toBe('current')
            expect(await boot.svc.machineBootedAtTarget(asMachineId('a'), '0.4.2')).toBe(true)
            expect(boot.send).not.toHaveBeenCalled()
          }
        },
      )

      it.each([
        { grantId: undefined },
        { grantId: 'unrelated' },
        { targetVersion: undefined },
        { targetVersion: 'other-target' },
        { version: '0.4.1' },
        { phaseDetail: undefined },
        { phaseDetail: 'restarting' },
        { state: 'restarting' as const },
        { state: 'downloading' as const, grantId: undefined },
      ])('ignores incomplete or unrelated retired evidence: %j', async (override) => {
        const { svc, send } = start()
        svc.abandonWait(['a'], 'Deadline expired')
        svc.onStatus(asMachineId('a'), { ...confirmed, ...override })
        expect((await svc.fleet())[0]?.state).toBe('stuck')
        expect(svc.operationActive('dev')).toBe(false)
        expect(await svc.machineBootedAtTarget(asMachineId('a'), '0.4.2')).toBe(false)
        expect(send).toHaveBeenCalledTimes(1)
      })

      it.each(['publication', 'approval', 'approval-version', 'channel'] as const)(
        'fences retired proof when %s changes, before or after confirmation',
        async (replacement) => {
          for (const confirmFirst of [false, true]) {
            const recovery = memoryRecovery()
            const h = start({ recovery })
            h.svc.abandonWait(['a'], 'Deadline expired')
            if (confirmFirst) {
              h.svc.onStatus(asMachineId('a'), confirmed)
              h.svc.fleet()
            }
            const changed = {
              ...h.svc.target()!,
              ...(replacement === 'approval-version' ? { version: '0.4.3' } : {}),
              artifacts: { headless: { delivery: 'feed' as const, platforms: {
                'linux-x64': { url: 'https://example.test/replaced', digest: 'different-bytes', signature: 'signature' },
              } } },
            }
            const { svc, send } = make(h.machines, {
              recovery,
              ...(replacement.startsWith('approval') ? { approvedTarget: () => changed } : {}),
            })
            if (replacement === 'publication') svc.setTarget(changed)
            if (replacement === 'channel') {
              Object.assign(h.machines[0]!, { channel: 'edge' })
              svc.setTarget('edge', h.svc.target()!)
            }
            svc.onStatus(asMachineId('a'), confirmed)
            // A channel change must not consume dev proof, even if edge offers
            // the same version. Observe the durable execution record directly.
            if (replacement === 'channel') {
              expect(recovery.read()?.machines[0]?.[1].channel).toBe('dev')
            }
            expect(svc.fleet()[0]?.state).not.toBe('current')
            expect(await svc.machineBootedAtTarget(asMachineId('a'), '0.4.2')).toBe(false)
            expect(svc.operationActive('dev')).toBe(false)
            expect(send).not.toHaveBeenCalled()
          }
        },
      )

      it('supersedes retired correlation with a new repair grant', async () => {
        const recovery = memoryRecovery()
        const { svc, send } = start({ recovery })
        svc.abandonWait(['a'], 'Deadline expired')
        expect((await svc.repairMachine(asMachineId('a'), TEST_REPAIR)).result).toBe('granted')
        expect(recovery.read()?.retiredGrants).toEqual([])
        svc.onStatus(asMachineId('a'), confirmed)
        expect((await svc.fleet())[0]?.state).not.toBe('current')
        expect(send).toHaveBeenCalledTimes(2)
      })

      it.each(['retirement', 'confirmation'] as const)(
        'refuses observations after a retired %s checkpoint fails', (failure) => {
          const recovery = memoryRecovery()
          const { svc, send } = start({ recovery })
          if (failure === 'confirmation') svc.abandonWait(['a'], 'Deadline expired')
          recovery.write = () => { throw new Error('disk full') }
          expect(() => failure === 'retirement'
            ? svc.abandonWait(['a'], 'Deadline expired')
            : svc.onStatus(asMachineId('a'), confirmed)).toThrow('disk full')
          expect(() => svc.fleet()).toThrow('disk full')
          expect(() => svc.machineBootedAtTarget(asMachineId('a'), '0.4.2')).toThrow('disk full')
          expect(() => svc.tick()).toThrow('disk full')
          expect(recovery.read()?.machines[0]?.[1].state).toBe(
            failure === 'retirement' ? 'granted' : 'stuck',
          )
          expect(send).toHaveBeenCalledTimes(1)
        },
      )
    })

    it('refuses dispatch when the authority checkpoint fails, including subsequent calls', () => {
      const recovery = memoryRecovery()
      const { svc, send } = make(
        [m('a', { presenceSource: 'supervisor', deliveryCaps: ['update.delivery.feed'] })],
        { recovery },
      )
      svc.setTarget({
        version: '0.4.2',
        critical: false,
        artifacts: { headless: { delivery: 'feed', platforms: {} } },
      })
      recovery.write = () => {
        throw new Error('disk full')
      }
      expect(() => svc.authorize()).toThrow('disk full')
      expect(() => svc.tick()).toThrow('disk full')
      expect(() => svc.machineBootedAtTarget(asMachineId('a'), '0.4.2')).toThrow('disk full')
      expect(send).not.toHaveBeenCalled()
    })

    it('refuses healthy proof and widening when confirmation cannot be committed', () => {
      const recovery = memoryRecovery()
      const { svc, send } = start({ recovery })
      recovery.write = () => {
        throw new Error('disk full')
      }
      expect(() => svc.onStatus(asMachineId('a'), confirmed)).toThrow('disk full')
      expect(() => svc.fleet()).toThrow('disk full')
      expect(() => svc.tick()).toThrow('disk full')
      expect(() => svc.machineBootedAtTarget(asMachineId('a'), '0.4.2')).toThrow('disk full')
      expect(recovery.read()?.machines[0]?.[1].state).toBe('granted')
      expect(send).toHaveBeenCalledTimes(1)
    })

    it('persists the exact grant before synchronous transport can observe it', () => {
      const recovery = memoryRecovery()
      const machines = [
        m('a', { presenceSource: 'supervisor', deliveryCaps: ['update.delivery.feed'] }),
      ]
      const { svc } = make(machines, {
        recovery,
        send: (_id, grant) => {
          expect(recovery.read()?.grants[0]?.[1]).toMatchObject({
            grantId: grant.grantId,
            issuedAt: grant.issuedAt,
          })
          svc.onStatus(asMachineId('a'), { ...confirmed, grantId: grant.grantId })
          expect(recovery.read()?.machines[0]?.[1].state).toBe('current')
        },
      })
      svc.setTarget({
        version: '0.4.2',
        critical: false,
        artifacts: { headless: { delivery: 'feed', platforms: {} } },
      })
      svc.authorize()
      expect(recovery.read()?.machines[0]?.[1].state).toBe('current')
    })

    it('refills a later wave slot once when supervised confirmation records are retained', () => {
      const machines = ['a', 'b', 'c'].map((id) =>
        m(id, {
          presenceSource: 'supervisor',
          deliveryCaps: ['update.delivery.feed'],
        }),
      )
      const { svc, send } = make(machines, { concurrency: 1, recovery: memoryRecovery() })
      svc.setTarget({
        version: '0.4.2',
        critical: false,
        artifacts: { headless: { delivery: 'feed', platforms: {} } },
      })
      svc.authorize()
      for (const [index, id] of ['a', 'b'].entries()) {
        machines[index]!.version = '0.4.2'
        const grant = send.mock.calls[index]![1]
        svc.onStatus(asMachineId(id), { ...confirmed, grantId: grant.grantId })
        svc.fleet()
        expect(send).toHaveBeenCalledTimes(index + 2)
        svc.fleet()
        expect(send).toHaveBeenCalledTimes(index + 2)
      }
      expect(send.mock.calls.map(([id]) => id)).toEqual(['a', 'b', 'c'])
    })

    it('holds the pending grant through early hello and slow child startup', async () => {
      const { svc, send } = start()
      for (let i = 0; i < 3; i++) {
        expect(svc.fleet()[0]).toMatchObject({ state: 'granted', version: '0.4.1' })
        expect(await svc.machineBootedAtTarget(asMachineId('a'), '0.4.2')).toBe(false)
        svc.tick()
      }
      expect(send).toHaveBeenCalledTimes(1)
      svc.onStatus(asMachineId('a'), {
        ...confirmed,
        state: 'restarting',
        phaseDetail: 'restarting',
      })
      expect((await svc.fleet())[0]).toMatchObject({ state: 'restarting' })
      expect(send).toHaveBeenCalledTimes(1)
      // The original grant still correlates after any number of early reads.
      svc.onStatus(asMachineId('a'), confirmed)
      expect(await svc.machineBootedAtTarget(asMachineId('a'), '0.4.2')).toBe(true)
      expect((await svc.fleet())[0]).toMatchObject({ state: 'current', version: '0.4.2' })
      expect(await svc.machineBootedAtTarget(asMachineId('a'), '0.4.2')).toBe(true)
      expect(send).toHaveBeenCalledTimes(2)
      svc.fleet()
      svc.tick()
      expect(send).toHaveBeenCalledTimes(2)
    })

    it.each([
      { grantId: undefined },
      { grantId: 'stale-grant' },
      { targetVersion: undefined },
      { targetVersion: 'other-target' },
      { version: '0.4.1' },
      { phaseDetail: undefined },
      { phaseDetail: 'restarting' },
    ])('does not accept incomplete or stale execution evidence: %j', async (override) => {
      const { svc, send } = start()
      svc.onStatus(asMachineId('a'), { ...confirmed, ...override })
      expect((await svc.fleet())[0]?.state).not.toBe('current')
      expect(await svc.machineBootedAtTarget(asMachineId('a'), '0.4.2')).toBe(false)
      svc.tick()
      expect(send).toHaveBeenCalledTimes(1)
      svc.onStatus(asMachineId('a'), confirmed)
      svc.fleet()
      expect(send).toHaveBeenCalledTimes(2)
    })

    it.each([
      'stuck',
      'rejected',
    ] as const)('preserves %s after a target-version hello', async (state) => {
      const { svc, send } = start()
      svc.onStatus(asMachineId('a'), {
        ...confirmed,
        state,
        detail: 'Required child failed health',
      })
      expect((await svc.fleet())[0]).toMatchObject({ state, detail: 'Required child failed health' })
      expect(await svc.machineBootedAtTarget(asMachineId('a'), '0.4.2')).toBe(false)
      svc.tick()
      expect(send).toHaveBeenCalledTimes(1)
    })

    it('keeps the execution fence when supervisor presence falls back to a daemon', async () => {
      const { svc, send, machines } = start()
      Object.assign(machines[0]!, { presenceSource: 'legacy-daemon' })
      expect((await svc.fleet())[0]?.state).toBe('granted')
      expect(await svc.machineBootedAtTarget(asMachineId('a'), '0.4.2')).toBe(false)
      expect(send).toHaveBeenCalledTimes(1)
      svc.onStatus(asMachineId('a'), { ...confirmed, state: 'restarting' })
      expect((await svc.fleet())[0]?.state).toBe('restarting')
      expect(send).toHaveBeenCalledTimes(1)
      svc.onStatus(asMachineId('a'), { ...confirmed, state: 'stuck' })
      expect((await svc.fleet())[0]?.state).toBe('stuck')
      svc.onStatus(asMachineId('a'), { type: 'updateStatus', state: 'current', version: '0.4.2' })
      expect((await svc.fleet())[0]?.state).toBe('stuck')
      svc.tick()
      expect(send).toHaveBeenCalledTimes(1)
    })

    it.each(['publication', 'approval'] as const)(
      'does not use a grant to confirm a different same-version %s descriptor',
      async (replacement) => {
        const changed = {
          version: '0.4.2',
          critical: true,
          artifacts: { headless: { delivery: 'feed' as const, platforms: {} } },
        }
        let approved: ReturnType<UpdatesService['target']>
        const { svc, send } = start({ approvedTarget: () => approved })
        if (replacement === 'publication') svc.setTarget(changed)
        else approved = changed
        svc.onStatus(asMachineId('a'), confirmed)
        expect((await svc.fleet())[0]?.state).not.toBe('current')
        svc.tick()
        expect(send).toHaveBeenCalledTimes(1)
      },
    )

    it('rechecks the exact descriptor when projection follows accepted confirmation', async () => {
      const { svc, send } = start()
      svc.onStatus(asMachineId('a'), confirmed)
      svc.setTarget({
        version: '0.4.2',
        critical: true,
        artifacts: { headless: { delivery: 'feed', platforms: {} } },
      })
      expect((await svc.fleet())[0]?.state).toBe('restarting')
      svc.tick()
      expect(send).toHaveBeenCalledTimes(1)
    })

    it('accepts an equivalent descriptor and repeated exact terminal replay', async () => {
      const { svc, send } = start()
      svc.setTarget({
        artifacts: { headless: { platforms: {}, delivery: 'feed' } },
        critical: false,
        version: '0.4.2',
      })
      svc.onStatus(asMachineId('a'), confirmed)
      expect((await svc.fleet())[0]?.state).toBe('current')
      svc.onStatus(asMachineId('a'), confirmed)
      expect((await svc.fleet())[0]?.state).toBe('current')
      expect(send).toHaveBeenCalledTimes(2)
    })

    it('retains exact terminal replay while the directory temporarily lacks the machine', async () => {
      const { svc, send, machines } = start()
      const canary = machines.shift()!
      svc.onStatus(asMachineId('a'), confirmed)
      machines.unshift(canary)
      expect((await svc.fleet())[0]?.state).toBe('current')
      expect(send).toHaveBeenCalledTimes(2)
    })

    it('registers the grant before a synchronous participant replays success', async () => {
      const machines = [m('a', { presenceSource: 'supervisor', deliveryCaps: ['update.delivery.feed'] })]
      const { svc } = make(machines, {
        send: (_id, grant) => svc.onStatus(asMachineId('a'), { ...confirmed, grantId: grant.grantId }),
      })
      svc.setTarget({
        version: '0.4.2',
        critical: false,
        artifacts: { headless: { delivery: 'feed', platforms: {} } },
      })
      svc.authorize()
      machines[0]!.version = '0.4.2'
      expect((await svc.fleet())[0]?.state).toBe('current')
    })

    it('keeps already-current healthy machines current without inventing a grant', async () => {
      const { svc, send } = make([m('a', { presenceSource: 'supervisor', version: '0.4.2' })])
      svc.setTarget({ version: '0.4.2', critical: false, artifacts: {} })
      svc.onStatus(asMachineId('a'), { type: 'updateStatus', state: 'current', version: '0.4.2' })
      expect((await svc.fleet())[0]?.state).toBe('current')
      expect(svc.authorize()).toEqual([])
      expect(send).not.toHaveBeenCalled()
    })

    it('waits for the directory to corroborate the confirmed running version', async () => {
      const { svc, send, machines } = start()
      machines[0]!.version = '0.4.1'
      svc.onStatus(asMachineId('a'), confirmed)
      svc.onStatus(asMachineId('a'), { type: 'updateStatus', state: 'current', version: '0.4.1' })
      expect((await svc.fleet())[0]?.state).toBe('restarting')
      svc.tick()
      expect(send).toHaveBeenCalledTimes(1)
      machines[0]!.version = '0.4.2'
      svc.fleet()
      expect(send).toHaveBeenCalledTimes(2)
    })
  })

  it('a rejected canary halts the wave entirely', async () => {
    const { svc, send } = make([m('a'), m('b'), m('c')])
    svc.setTarget({ version: '0.4.2', critical: false, artifacts: {} } as never)
    await svc.tick()
    await svc.onStatus(asMachineId('a'), { type: 'updateStatus', state: 'rejected', version: '0.4.1' })
    await svc.tick()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('treats a second global Apply as authority to retry a failed canary', async () => {
    const { svc, send } = make([m('a'), m('b')])
    svc.setTarget({ version: '0.4.2', critical: false, artifacts: {} } as never)
    expect(await svc.authorize()).toEqual(['a'])
    await svc.onStatus(asMachineId('a'), { type: 'updateStatus', state: 'rejected', version: '0.4.1' })
    send.mockClear()

    expect(await svc.authorize()).toEqual(['a'])
    expect(send).toHaveBeenCalledTimes(1)
    expect((await svc.fleet())[0]).toMatchObject({ state: 'granted' })
  })

  it('issues no grants when authorization is only remembered', async () => {
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
  it('swaps a same-version descriptor in place without granting anything', async () => {
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
    expect(await svc.tick('dev')).toEqual(['a'])
  })

  it('does not auto-grant when a same-version tarball appears without authorization', async () => {
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

  it('resets canary health when the target changes', async () => {
    const machines = [m('a'), m('b'), m('c')]
    const { svc, send } = make(machines)
    svc.setTarget({ version: '0.4.2', critical: false, artifacts: {} } as never)
    await svc.tick()
    const canary = machines[0]
    if (canary) canary.version = '0.4.2'
    await svc.fleet()
    svc.setTarget({ version: '0.4.3', critical: false, artifacts: {} } as never)
    send.mockClear()
    await svc.tick()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('reconciles a restarted machine from its reported target version', async () => {
    const machines = [m('a'), m('b')]
    const { svc } = make(machines)
    svc.setTarget({ version: '0.4.2', critical: false, artifacts: {} } as never)
    await svc.tick()

    const first = machines[0]
    if (!first) throw new Error('test machine missing')
    first.version = '0.4.2'
    expect((await svc.fleet())[0]).toMatchObject({ state: 'current', version: '0.4.2' })
  })

  it('continues an authorized wave when the canary proves current by reconnecting', async () => {
    const machines = [m('a'), m('b'), m('c')]
    const { svc, send } = make(machines)
    svc.setTarget({ version: '0.4.2', critical: false, artifacts: {} } as never)

    expect(await svc.authorize()).toEqual(['a'])
    expect(send).toHaveBeenCalledTimes(1)

    const canary = machines[0]
    if (!canary) throw new Error('test canary missing')
    canary.version = '0.4.2'
    await svc.fleet()

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
  it('grants each widened machine exactly once', async () => {
    const machines = [m('a'), m('b'), m('c')]
    const { svc, send } = make(machines)
    svc.setTarget({ version: '0.4.2', critical: false, artifacts: {} } as never)

    expect(await svc.authorize()).toEqual(['a'])
    const canary = machines[0]
    if (!canary) throw new Error('test canary missing')
    // The canary proves the target by RECONNECTING: the directory, not a status
    // frame, is what makes the wave widen on the next tick.
    canary.version = '0.4.2'
    send.mockClear()

    expect(await svc.tick()).toEqual(['b', 'c'])
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
  it('reports the grants it issued from inside a fleet read', async () => {
    const machines = [m('a'), m('b'), m('c')]
    const { svc } = make(machines)
    svc.setTarget({ version: '0.4.2', critical: false, artifacts: {} } as never)
    await svc.authorize()

    const canary = machines[0]
    if (!canary) throw new Error('test canary missing')
    canary.version = '0.4.2'

    const seen = new Map((await svc.fleet()).map((machine) => [machine.id, machine.state]))
    expect(seen.get('a')).toBe('current')
    expect(seen.get('b')).toBe('granted')
    expect(seen.get('c')).toBe('granted')
  })

  it('requires the raw reconnect identity instead of optimistic current status', async () => {
    const machines = [m('a')]
    const { svc } = make(machines)
    svc.setTarget({ version: '0.4.2', critical: false, artifacts: {} } as never)
    await svc.authorize()
    await svc.onStatus(asMachineId('a'), { type: 'updateStatus', state: 'current', version: '0.4.2' })

    expect((await svc.fleet())[0]).toMatchObject({ state: 'restarting', version: '0.4.2' })
    expect(await svc.machineBootedAtTarget(asMachineId('a'), '0.4.2')).toBe(false)

    const machine = machines[0]
    if (!machine) throw new Error('test machine missing')
    machine.version = '0.4.2'
    expect(await svc.machineBootedAtTarget(asMachineId('a'), '0.4.2')).toBe(true)
  })

  it('proves a restart handoff only after a correlated restart report and disconnect', async () => {
    const machines = [m('a')]
    const { svc } = make(machines)
    svc.setTarget({ version: '0.4.2', critical: false, artifacts: {} } as never)
    await svc.authorize()

    await svc.onStatus(asMachineId('a'), {
      type: 'updateStatus',
      grantId: 'wrong-grant',
      state: 'restarting',
      version: '0.4.1',
    })
    machines[0] = m('a', { online: false })
    expect(await svc.machineCrossedRestartBoundary(asMachineId('a'), '0.4.2')).toBe(false)

    machines[0] = m('a')
    await svc.onStatus(asMachineId('a'), {
      type: 'updateStatus',
      grantId: 'g1',
      state: 'restarting',
      version: '0.4.1',
    })
    expect(await svc.machineCrossedRestartBoundary(asMachineId('a'), '0.4.2')).toBe(false)

    machines[0] = m('a', { online: false })
    expect(await svc.machineCrossedRestartBoundary(asMachineId('a'), '0.4.2')).toBe(true)
  })

  describe('per-machine apply outcomes', () => {
    const target = { version: '0.4.2', critical: false, artifacts: {} } as never

    it('names why no grant was issued instead of returning an empty list', async () => {
      const { svc } = make([
        m('current', { version: '0.4.2' }),
        m('offline', { online: false }),
        m('flying'),
      ])
      svc.setTarget(target)

      expect(await svc.authorizeMachine(asMachineId('current'), TEST_APPLY)).toEqual({
        result: 'already-current',
        version: '0.4.2',
      })
      expect(await svc.authorizeMachine(asMachineId('offline'), TEST_APPLY)).toEqual({ result: 'offline' })
      expect(await svc.authorizeMachine(asMachineId('missing'), TEST_APPLY)).toEqual({ result: 'unknown-machine' })

      expect(await svc.authorizeMachine(asMachineId('flying'), TEST_APPLY)).toMatchObject({ result: 'granted' })
      // A second apply while the first is still converging is not a failure.
      expect(await svc.authorizeMachine(asMachineId('flying'), TEST_APPLY)).toEqual({
        result: 'in-flight',
        state: 'granted',
      })
    })

    it('refuses a source checkout explicitly without issuing a grant', async () => {
      const { svc, send } = make([m('source', { installKind: 'source' })])
      svc.setTarget(target)

      expect(await svc.authorizeMachine(asMachineId('source'), TEST_APPLY)).toEqual({
        result: 'source-checkout',
      })
      expect(send).not.toHaveBeenCalled()
    })

    it('grants an equal-version payload when the operator requests repair', async () => {
      const { svc, send } = make([m('current', { version: '0.4.2' })])
      svc.setTarget(target)

      expect(await svc.repairMachine(asMachineId('current'), TEST_REPAIR)).toEqual({
        result: 'granted',
        version: '0.4.2',
      })
      expect(send).toHaveBeenCalledWith(
        asMachineId('current'),
        expect.objectContaining({ type: 'updateGrant', repair: true }),
      )
    })

    it('explains an unresolved authority rather than reporting a missing grant', async () => {
      const { svc } = make([m('a')])
      expect(await svc.authorizeMachine(asMachineId('a'), TEST_APPLY)).toMatchObject({ result: 'no-target' })
    })

    /** The regression behind repro 2: retry was permanently impossible. */
    it('lets a human retry a machine the planner had excluded forever', async () => {
      const { svc, send } = make([m('a')])
      svc.setTarget(target)
      await svc.authorize()
      await svc.onStatus(asMachineId('a'), {
        type: 'updateStatus',
        state: 'stuck',
        version: '0.4.1',
        detail: 'did not come back',
      })
      expect((await svc.fleet())[0]).toMatchObject({ state: 'stuck' })
      send.mockClear()

      expect(await svc.authorizeMachine(asMachineId('a'), TEST_APPLY)).toEqual({
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
    it('keeps widening after a human applies one refused machine', async () => {
      const machines = [m('a'), m('b'), m('c'), m('d'), m('e'), m('f')]
      const { svc } = make(machines)
      svc.setTarget(target)

      expect(await svc.tick()).toEqual(['a'])
      // The canary holds the target: the bundle is proven for this channel.
      const canary = machines[0]
      if (canary) canary.version = '0.4.2'
      expect(await svc.tick()).toEqual(['b', 'c', 'd'])
      const b = machines[1]
      const c = machines[2]
      if (b) b.version = '0.4.2'
      if (c) c.version = '0.4.2'
      await svc.fleet()
      await svc.onStatus(asMachineId('d'), {
        type: 'updateStatus',
        state: 'rejected',
        version: '0.4.1',
        detail: 'machine-dirty-checkout',
      })

      expect(await svc.authorizeMachine(asMachineId('d'), TEST_APPLY)).toEqual({
        result: 'granted',
        version: '0.4.2',
      })

      // `d` is the only machine in flight, and NOTHING has converged since the
      // Apply — so this is the whole window the regression lives in. The two
      // machines that have never been granted are still owed the rest of the
      // concurrency budget.
      expect(await svc.tick()).toEqual(['e', 'f'])
    })

    /**
     * The other half of POD-2220, so the fix cannot be read as "the canary is
     * never re-proved". A FLEET-wide retry is a new decision about the whole
     * channel, and §6.2 says a wave that re-opens starts by proving one machine
     * before it moves the rest.
     */
    it('still re-proves a canary when the retry is fleet-wide', async () => {
      const machines = [m('a'), m('b'), m('c'), m('d'), m('e'), m('f')]
      const { svc } = make(machines)
      svc.setTarget(target)

      expect(await svc.tick()).toEqual(['a'])
      const canary = machines[0]
      if (canary) canary.version = '0.4.2'
      expect(await svc.tick()).toEqual(['b', 'c', 'd'])
      const b = machines[1]
      const c = machines[2]
      if (b) b.version = '0.4.2'
      if (c) c.version = '0.4.2'
      await svc.fleet()
      await svc.onStatus(asMachineId('d'), {
        type: 'updateStatus',
        state: 'rejected',
        version: '0.4.1',
      })

      // Same fleet, same moment — but the human pressed the channel's Apply, not
      // one row's. Exactly one machine is granted.
      expect(await svc.authorize()).toEqual(['d'])
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

    it('does not age a grant from a fleet read, however long it is left silent', async () => {
      const { svc, tick } = makeClock([m('a')])
      svc.setTarget(target)
      await svc.authorize()
      expect((await svc.fleet())[0]).toMatchObject({ state: 'granted' })

      // An hour of wall clock and a dozen readers: reading is not the passage
      // of time, and this service no longer pretends otherwise.
      tick(60 * 60_000)
      for (let i = 0; i < 12; i++) expect((await svc.fleet())[0]).toMatchObject({ state: 'granted' })
    })

    it('records an abandoned wait so giving up is visible, not silent', async () => {
      const { svc } = makeClock([m('a'), m('b', { version: '0.4.2' })])
      svc.setTarget(target)
      await svc.authorize()

      expect(await svc.abandonWait(['a', 'b'], 'the server stopped waiting')).toEqual(['a'])
      expect((await svc.fleet())[0]).toMatchObject({ state: 'stuck', detail: 'the server stopped waiting' })
    })

    it('releases every grant still in flight when the operation that owned them ends', async () => {
      // Otherwise deleting the ageing would strand the row forever: excluded
      // from every future wave, and `operationActive` true for good.
      const { svc } = makeClock([m('a'), m('b')])
      svc.setTarget(target)
      // One canary first, so exactly one machine is mid-grant here.
      await svc.authorize()
      expect(svc.operationActive('dev')).toBe(true)

      expect(await svc.releaseInFlightGrants()).toEqual(['a'])
      expect((await svc.fleet())[0]).toMatchObject({
        state: 'stuck',
        detail: 'The machine stopped reporting progress while updating.',
      })
      expect(svc.operationActive('dev')).toBe(false)
    })

    it('re-issues the grant for a machine the planner would otherwise skip', async () => {
      // The one automatic retry. `tick()` cannot do this: the planner excludes
      // a machine it believes is mid-grant, so the retry would grant nobody.
      const { svc, send } = make([m('a')])
      svc.setTarget(target)
      await svc.authorize()
      await svc.onStatus(asMachineId('a'), {
        type: 'updateStatus',
        grantId: 'g1',
        state: 'downloading',
        version: '0.4.1',
      })
      send.mockClear()
      expect(await svc.tick('dev')).toEqual([])

      expect(await svc.reissueGrants('dev', undefined, TEST_RETRY)).toEqual(['a'])
      expect(send).toHaveBeenCalledTimes(1)
      expect(send.mock.calls[0]?.[1]).toMatchObject({ type: 'updateGrant', grantId: 'g2' })
    })

    it('does not replay a terminal boot report for a different target', async () => {
      const { svc } = makeClock([m('a')])
      await svc.onStatus(asMachineId('a'), {
        type: 'updateStatus',
        grantId: 'g1',
        targetVersion: '0.4.3',
        state: 'stuck',
        version: '0.4.1',
        detail: 'belongs to another release',
      })

      svc.setTarget(target)

      expect((await svc.fleet())[0]).toMatchObject({ state: 'current', version: '0.4.1' })
    })

    it('keeps a packaged crash report after the coordinator replaced its grant', async () => {
      const { svc } = make([m('a')])
      svc.setTarget(target)
      await svc.authorize()
      await svc.onStatus(asMachineId('a'), {
        type: 'updateStatus',
        grantId: 'g1',
        state: 'restarting',
        version: '0.4.1',
      })

      // The operation spends its bounded retry while the crashed packaged
      // process is down, so g2 is now the coordinator's correlation id. The
      // durable marker that survives the process crash still names g1.
      expect(await svc.reissueGrants('dev', undefined, TEST_RETRY)).toEqual(['a'])
      await svc.onStatus(asMachineId('a'), {
        type: 'updateStatus',
        grantId: 'g1',
        targetVersion: '0.4.2',
        state: 'rejected',
        version: '0.4.1',
        detail: 'attempt 2 of 2 did not reach 0.4.2 (running 0.4.1); applying again will retry it',
      })

      const failed = (await svc.fleet())[0]
      expect(failed).toMatchObject({
        state: 'rejected',
        version: '0.4.1',
        detail: expect.stringContaining('did not reach 0.4.2'),
      })
      expect(classifyMachineFailure(failed?.detail)).toBe('machine-update-not-confirmed')
      expect(svc.operationActive('dev')).toBe(false)
    })

    it('does not apply a recovered crash report to a different packaged target', async () => {
      const { svc } = make([m('a')])
      svc.setTarget(target)
      await svc.authorize()
      await svc.onStatus(asMachineId('a'), {
        type: 'updateStatus',
        grantId: 'g1',
        state: 'restarting',
        version: '0.4.1',
      })
      expect(await svc.reissueGrants('dev', undefined, TEST_RETRY)).toEqual(['a'])

      await svc.onStatus(asMachineId('a'), {
        type: 'updateStatus',
        grantId: 'g1',
        targetVersion: '0.4.3',
        state: 'rejected',
        version: '0.4.1',
        detail: 'belongs to another release',
      })

      expect((await svc.fleet())[0]).toMatchObject({
        state: 'granted',
        version: '0.4.1',
      })
      expect((await svc.fleet())[0]).not.toHaveProperty('detail')
      expect(svc.operationActive('dev')).toBe(true)
    })

    it('does not re-grant a source checkout from legacy in-flight state', async () => {
      const source = { ...m('a'), installKind: 'installed' }
      const { svc, send } = make([source])
      svc.setTarget(target)
      await svc.authorize()
      source.installKind = 'source'
      send.mockClear()

      expect(await svc.reissueGrants('dev', undefined, TEST_RETRY)).toEqual([])
      expect(send).not.toHaveBeenCalled()
    })

    it('does not re-grant a machine that is offline or already at the target', async () => {
      const { svc, send } = make([m('a', { online: false }), m('b', { version: '0.4.2' })])
      svc.setTarget(target)
      await svc.authorize()
      send.mockClear()

      expect(await svc.reissueGrants('dev', undefined, TEST_RETRY)).toEqual([])
      expect(send).not.toHaveBeenCalled()
    })
  })

  /** The frame that makes "downloading" mean something (POD-2101, spec §3.3). */
  describe('progress heartbeats', () => {
    const target = { version: '0.4.2', critical: false, artifacts: {} } as never

    it('carries a percentage from the daemon onto the fleet projection', async () => {
      const { svc } = make([m('a')])
      svc.setTarget(target)
      await svc.authorize()
      await svc.onStatus(asMachineId('a'), {
        type: 'updateStatus',
        grantId: 'g1',
        state: 'downloading',
        version: '0.4.1',
        percent: 62,
        phaseDetail: 'downloading',
      })

      expect((await svc.fleet())[0]).toMatchObject({
        state: 'downloading',
        percent: 62,
        phaseDetail: 'downloading',
      })
    })

    it('accepts a repeat of the same state as a new report', async () => {
      const { svc } = make([m('a')])
      svc.setTarget(target)
      await svc.authorize()
      for (const percent of [10, 35, 90]) {
        await svc.onStatus(asMachineId('a'), {
          type: 'updateStatus',
          grantId: 'g1',
          state: 'downloading',
          version: '0.4.1',
          percent,
        })
      }

      expect((await svc.fleet())[0]).toMatchObject({ state: 'downloading', percent: 90 })
    })

    it('drops the percentage when the phase moves on', async () => {
      // A stale 62% sitting under `restarting` is worse than no number at all.
      const { svc } = make([m('a')])
      svc.setTarget(target)
      await svc.authorize()
      await svc.onStatus(asMachineId('a'), {
        type: 'updateStatus',
        grantId: 'g1',
        state: 'downloading',
        version: '0.4.1',
        percent: 62,
      })
      await svc.onStatus(asMachineId('a'), {
        type: 'updateStatus',
        grantId: 'g1',
        state: 'restarting',
        version: '0.4.1',
      })

      expect((await svc.fleet())[0]).not.toHaveProperty('percent')
    })

    it('converges a daemon that reports no percentage at all', async () => {
      const machines = [m('a')]
      const { svc } = make(machines)
      svc.setTarget(target)
      await svc.authorize()
      await svc.onStatus(asMachineId('a'), {
        type: 'updateStatus',
        grantId: 'g1',
        state: 'downloading',
        version: '0.4.1',
      })
      expect((await svc.fleet())[0]).not.toHaveProperty('percent')

      await svc.onStatus(asMachineId('a'), {
        type: 'updateStatus',
        grantId: 'g1',
        state: 'current',
        version: '0.4.2',
      })
      expect((await svc.fleet())[0]).toMatchObject({ state: 'restarting', version: '0.4.2' })
      const machine = machines[0]
      if (machine) machine.version = '0.4.2'
      expect((await svc.fleet())[0]).toMatchObject({ state: 'current', version: '0.4.2' })
    })
  })

  it('is idempotent: a second tick with nothing changed grants nothing new', async () => {
    const { svc, send } = make([m('a'), m('b')])
    svc.setTarget({ version: '0.4.2', critical: false, artifacts: {} } as never)
    await svc.tick()
    await svc.tick()
    expect(send).toHaveBeenCalledTimes(1)
  })
})

describe('setTargetUnavailable', () => {
  it('withdraws the stale target and explains why the channel has none', async () => {
    const { svc } = make([m('a', { channel: 'dev' })])
    svc.setTarget('dev', { version: 'dev+aaaaaaa', critical: false, artifacts: {} } as never)
    expect(svc.target('dev')?.version).toBe('dev+aaaaaaa')

    await svc.setTargetUnavailable('dev', 'The source checkout has 2 uncommitted changes.')

    // Nothing may still be handed dev+aaaaaaa once HEAD has moved past it.
    expect(svc.target('dev')).toBeUndefined()
    expect(await svc.targetVersion()).toBeUndefined()
    expect(await svc.targetUnavailableReasonFor(asMachineId('a'))).toBe(
      'The source checkout has 2 uncommitted changes.',
    )
  })

  it('ends an in-flight rollout observably instead of stranding it', async () => {
    const machines = [m('a', { channel: 'dev' })]
    const { svc } = make(machines)
    svc.setTarget('dev', { version: 'dev+aaaaaaa', critical: false, artifacts: {} } as never)
    await svc.authorize('dev')
    expect((await svc.fleet()).find((machine) => machine.id === 'a')?.state).toBe('granted')

    await svc.setTargetUnavailable('dev', 'The source checkout has 2 uncommitted changes.')

    // Without this the row keeps saying "granted" forever: the pending record
    // is gone, so nothing can ever age it and no status report is accepted.
    const row = (await svc.fleet()).find((machine) => machine.id === 'a')
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
    expect(await svc.targetUnavailableReasonFor(asMachineId('a'))).toBe(
      'The source checkout has 2 uncommitted changes.',
    )
  })

  it('is cleared by the next successful publication', async () => {
    const { svc } = make([m('a', { channel: 'dev' })])
    await svc.setTargetUnavailable('dev', 'Building the development bundle for dev+bbbbbbb.')
    svc.setTarget('dev', { version: 'dev+bbbbbbb', critical: false, artifacts: {} } as never)

    expect(svc.target('dev')?.version).toBe('dev+bbbbbbb')
    expect(await svc.targetUnavailableReasonFor(asMachineId('a'))).toBeUndefined()
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
  it('the model fallback is the same channel runtime resolves with nothing configured', async () => {
    expect(resolveUpdateChannel({}, {})).toBe(DEFAULT_FLEET_UPDATE_CHANNEL)
  })

  it('the fleet default is the channel an unpinned machine lands on', async () => {
    expect(build({}, 'edge').fleetDefaultChannel()).toBe('edge')
    expect(build({}).fleetDefaultChannel()).toBe(DEFAULT_FLEET_UPDATE_CHANNEL)
  })

  /**
   * The acceptance criterion in prose: the handlers resolve through the same
   * helper the service does, so "which channel is machine a on" has ONE answer.
   * `resolveMachineChannel` is what both call; asserting the identity here is
   * cheaper and more honest than asserting a grep.
   */
  it('resolves an unpinned machine identically through the service and the shared helper', async () => {
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
    expect(await svc.targetUnavailableReasonFor(asMachineId('a'))).toBe(
      'stable target unavailable: fetch failed',
    )

    fail = false
    advance(24 * 60 * 60_000)
    await svc.refreshTarget('stable')

    expect(svc.target('stable')).toBe(target)
    expect(await svc.targetUnavailableReasonFor(asMachineId('a'))).toBeUndefined()
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
    expect(await svc.targetUnavailableReasonFor(asMachineId('a'))).toBeUndefined()
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

      // NOT AWAITED, DELIBERATELY. These calls have to be IN FLIGHT together —
      // that overlap is the entire subject. Awaiting the first one parks this
      // test on a promise only `finish` can settle, and `finish` is below, so
      // the test deadlocks instead of failing. A mechanical await pass did that
      // to all four of these (POD-3263); the promises are collected and awaited
      // together after the resolver is released.
      const first = svc.checkNow()
      const second = svc.checkNow()
      // …but the CALL COUNT is only observable once both have reached the
      // resolver. `checkNow` awaits `channelsInUse()` first now (the machine
      // directory is a durable read), so neither call has registered its
      // in-flight entry at the point this used to assert. Draining microtasks
      // moves the observation past that await without settling `resolving`,
      // which only `finishResolve` below can do — so the two calls are still
      // genuinely concurrent and the coalescing is still what is under test.
      for (let turn = 0; turn < 10; turn += 1) await Promise.resolve()

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

      // NOT AWAITED, DELIBERATELY. These calls have to be IN FLIGHT together —
      // that overlap is the entire subject. Awaiting the first one parks this
      // test on a promise only `finish` can settle, and `finish` is below, so
      // the test deadlocks instead of failing. A mechanical await pass did that
      // to all four of these (POD-3263); the promises are collected and awaited
      // together after the resolver is released.
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

      // NOT AWAITED, DELIBERATELY. These calls have to be IN FLIGHT together —
      // that overlap is the entire subject. Awaiting the first one parks this
      // test on a promise only `finish` can settle, and `finish` is below, so
      // the test deadlocks instead of failing. A mechanical await pass did that
      // to all four of these (POD-3263); the promises are collected and awaited
      // together after the resolver is released.
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

      // Same reason: `Promise.all([await a, await b])` runs them one after the
      // other, so it cannot show that two CHANNELS do not share an in-flight slot.
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
    it('is false with no wave in flight', async () => {
      const { svc } = make([m('a')])
      expect(svc.operationActive('dev')).toBe(false)
    })

    it('is true while a grant is outstanding on that channel, and only that channel', async () => {
      const { svc } = make([m('a')])
      svc.setTarget('dev', { version: '0.4.2', critical: false, artifacts: {} } as never)
      await svc.authorize('dev')

      expect(svc.operationActive('dev')).toBe(true)
      expect(svc.operationActive('stable')).toBe(false)
    })

    it('is false again once the machine reconnects at the target', async () => {
      const machines = [m('a')]
      const { svc } = make(machines)
      svc.setTarget('dev', { version: '0.4.2', critical: false, artifacts: {} } as never)
      await svc.authorize('dev')
      await svc.onStatus(asMachineId('a'), { type: 'updateStatus', state: 'current', version: '0.4.2' })

      expect(svc.operationActive('dev')).toBe(true)
      const machine = machines[0]
      if (machine) machine.version = '0.4.2'
      await svc.fleet()
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
  it('stops the wave continuing after a machine finishes a cancelled grant', async () => {
    const machines = [m('a'), m('b')]
    const { svc, send } = make(machines)
    svc.setTarget('dev', target)
    await svc.authorize('dev')
    expect(send).toHaveBeenCalledTimes(1)

    // The operation terminates. This is what `onChanged` does, in its order.
    svc.withdrawAuthorization()
    await svc.releaseInFlightGrants('The update was canceled while this machine was updating.')

    // `a`'s daemon swapped anyway and came back on the new version.
    machines[0] = m('a', { version: '0.4.2' })
    const granted = send.mock.calls.length
    await svc.fleet()
    await svc.fleet()

    expect(send).toHaveBeenCalledTimes(granted)
  })

  /** …and the cleanup itself must not be the thing that grants: it reads `fleet()`. */
  it('is safe to call before releaseInFlightGrants, which is a fleet read', async () => {
    const machines = [m('a', { version: '0.4.2', state: 'downloading' }), m('b')]
    const { svc, send } = make(machines)
    svc.setTarget('dev', target)
    await svc.authorize('dev')
    const granted = send.mock.calls.length

    svc.withdrawAuthorization()
    await svc.releaseInFlightGrants()

    expect(send).toHaveBeenCalledTimes(granted)
  })

  /**
   * A deliberate Apply is new authority, so the machinery must come back — the
   * withdrawal ends one operation's consent, it does not disable the channel.
   */
  it('is restored by the next deliberate authorization', async () => {
    const machines = [m('a'), m('b')]
    const { svc, send } = make(machines)
    svc.setTarget('dev', target)
    await svc.authorize('dev')
    svc.withdrawAuthorization()

    machines[0] = m('a', { version: '0.4.2' })
    await svc.authorize('dev')
    expect(send.mock.calls.length).toBeGreaterThan(1)
  })

  it('says nothing about a channel that has no rollout at all', async () => {
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
  it('is the shipped fleet default, not dev, when nothing is pinned', async () => {
    const svc = shipped([m('host'), m('vps')])
    expect(await svc.operationChannel('host')).toBe(DEFAULT_FLEET_UPDATE_CHANNEL)
    expect(await svc.operationChannel('host')).not.toBe('dev')
  })

  it("follows the host's own pin", async () => {
    const svc = shipped([m('host', { channel: 'edge' }), m('vps', { channel: 'stable' })])
    expect(await svc.operationChannel('host')).toBe('edge')
  })

  /** A development coordinator still gets a dev operation — the previous
   *  behaviour was not wrong, it was only ever right for one fleet. */
  it('still answers dev where dev is what this installation follows', async () => {
    const svc = shipped([m('host')], 'dev')
    expect(await svc.operationChannel('host')).toBe('dev')
  })

  /**
   * Before the host's own handshake there is no row to read, and the question
   * "what does an unpinned machine follow?" has the same answer either way. It
   * matters because one composition root is the ADOPTION path, which runs
   * before the daemon gateway listens.
   */
  it('falls back to the fleet default when the host is not in the directory yet', async () => {
    const svc = shipped([], 'edge')
    expect(await svc.operationChannel('host')).toBe('edge')
    expect(await svc.operationChannel(undefined)).toBe('edge')
  })

  /** One answer, not two (POD-2100): this must agree with the authority that
   *  will actually grant, which is `channelOf` on the same row. */
  it('agrees with channelOf for the host row', async () => {
    const host = m('host', { channel: 'stable' })
    const svc = shipped([host], 'dev')
    expect(await svc.operationChannel('host')).toBe(svc.channelOf(host as never))
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
  it("advertises the host's own stable authority to a stable-pinned host", async () => {
    const svc = shipped([m('host', { channel: 'stable' })])
    svc.setTarget('stable', t('0.1.3'))

    expect((await svc.advertisedTarget('host'))?.version).toBe('0.1.3')
  })

  it('does not let a development feed speak for a stable-pinned host', async () => {
    const svc = shipped([m('host', { channel: 'stable' })])
    svc.setTarget('stable', t('0.1.3'))
    svc.setTarget('dev', t('0.1.2-dev.3+03a2892'))

    expect((await svc.advertisedTarget('host'))?.version).toBe('0.1.3')
  })

  it('advertises only a feed-published development target on a dev-pinned host', async () => {
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
    const advertised = (await svc.advertisedTarget('host'))
    expect(advertised?.artifacts.headless).toBeDefined()
    expect(advertised?.version).toBe('0.1.2-dev.5+bbbbbbb')
  })

  it('advertises no update when HEAD has only a pre-release proposal', async () => {
    const svc = shipped([m('host', { channel: 'dev' })])
    expect(await svc.advertisedTarget('host')).toBeUndefined()
  })

  /**
   * `/version` is the unauthenticated pre-boot probe. The feed target carries
   * the artifact token in the query string so the daemon can fetch; that token
   * must not ride the probe. The standing channel target keeps it — grants
   * read that, not the advertisement.
   */
  it('does not put a tokenised artifact URL on the advertised target', async () => {
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

    const advertised = (await svc.advertisedTarget('host'))
    const advertisedUrl = advertised?.artifacts.headless?.platforms['linux-x86_64']?.url
    expect(advertisedUrl).toBeDefined()
    expect(advertisedUrl).not.toContain('token=')
    expect(advertisedUrl).not.toContain('secret')
    expect(svc.target('dev')?.artifacts.headless?.platforms['linux-x86_64']?.url).toContain(
      'token=secret',
    )
  })

  it('follows an edge-pinned host onto edge', async () => {
    const svc = shipped([m('host', { channel: 'edge' })])
    svc.setTarget('edge', t('0.2.0'))
    svc.setTarget('dev', t('dev+aaaaaaa'))

    expect((await svc.advertisedTarget('host'))?.version).toBe('0.2.0')
  })

  /**
   * A host that has not handshaked yet follows the fleet default — the same
   * fallback `operationChannel` makes, because this must never answer a
   * different authority than the action would grant.
   */
  it('agrees with operationChannel, including before the host is registered', async () => {
    const svc = shipped([], 'stable')
    svc.setTarget('stable', t('0.1.3'))

    expect(await svc.operationChannel('host')).toBe('stable')
    expect((await svc.advertisedTarget('host'))?.version).toBe('0.1.3')
    expect((await svc.advertisedTarget(undefined))?.version).toBe('0.1.3')
  })

  /** Nothing published on the host's authority is still nothing: an absent
   *  target must not fall back to some other channel's version. */
  it('advertises nothing rather than another channel when its own has none', async () => {
    const svc = shipped([m('host', { channel: 'stable' })])
    svc.setTarget('dev', t('dev+aaaaaaa'))

    expect(await svc.advertisedTarget('host')).toBeUndefined()
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
  it('does not let an identity overwrite a published feed target of the same version', async () => {
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

  it('is never granted to that machine by the standing wave', async () => {
    const { svc, send } = make([mac()])
    svc.setTarget(linuxOnly)
    await svc.tick()
    expect(send).not.toHaveBeenCalled()
  })

  it('still waves the machines it was built for', async () => {
    const { svc, send } = make([m('vps', { platform: 'linux-x86_64' }), mac()])
    svc.setTarget(linuxOnly)
    await svc.tick()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]?.[0]).toBe('vps')
  })

  /** The per-row Apply is a human asking directly, and it gets a direct answer
   *  rather than a grant the machine will refuse minutes later. */
  it('answers a per-row Apply with the platform fact instead of granting', async () => {
    const { svc, send } = make([mac()])
    svc.setTarget(linuxOnly)
    expect(await svc.authorizeMachine(asMachineId('mac'), TEST_APPLY)).toEqual({
      result: 'platform-not-in-release',
      platform: 'darwin-aarch64',
    })
    expect(send).not.toHaveBeenCalled()
  })

  it('answers a per-row Repair the same way, for the same reason', async () => {
    const { svc, send } = make([mac()])
    svc.setTarget(linuxOnly)
    expect(await svc.repairMachine(asMachineId('mac'), TEST_REPAIR)).toMatchObject({
      result: 'platform-not-in-release',
    })
    expect(send).not.toHaveBeenCalled()
  })

  it('leaves a machine that has reported no platform alone', async () => {
    const { svc, send } = make([m('mute', { deliveryCaps: ['update.delivery.feed'] })])
    svc.setTarget(linuxOnly)
    await svc.tick()
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

  it('is never granted the instance-trusted feed by the standing wave', async () => {
    const { svc, send } = make([flatblock()])
    svc.setTarget(instanceTarget)
    await svc.tick()
    expect(send).not.toHaveBeenCalled()
  })

  it('answers direct Apply with the verifier-generation fact', async () => {
    const { svc, send } = make([flatblock()])
    svc.setTarget(instanceTarget)
    expect(await svc.authorizeMachine(asMachineId('flatblock'), TEST_APPLY)).toEqual({
      result: 'legacy-instance-trust',
      version: '0.4.2',
    })
    expect(send).not.toHaveBeenCalled()
  })

  it('does not pretend an in-band Repair can bypass the same verifier', async () => {
    const { svc, send } = make([flatblock()])
    svc.setTarget(instanceTarget)
    expect(await svc.repairMachine(asMachineId('flatblock'), TEST_REPAIR)).toEqual({
      result: 'legacy-instance-trust',
      version: '0.4.2',
    })
    expect(send).not.toHaveBeenCalled()
  })

  it('continues to grant a current feed-only daemon', async () => {
    const { svc, send } = make([
      m('current', { platform: 'linux-x86_64', deliveryCaps: ['update.delivery.feed'] }),
    ])
    svc.setTarget(instanceTarget)
    expect(await svc.authorizeMachine(asMachineId('current'), TEST_APPLY)).toMatchObject({ result: 'granted' })
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

  it('is not the canary while a remote machine could prove the bundle instead', async () => {
    const { svc } = make([coordinator, m('b-flatblock', { name: 'flatblock' })])
    svc.setTarget('dev', target)
    svc.markAuthorized('dev')

    expect(await svc.tick('dev')).toEqual(['b-flatblock'])
  })

  /**
   * THE MEASURED FAILURE, at the seam that produced it. A widen round on the
   * live fleet selected `flatblock` and `ludovico` together, and `ludovico`
   * restarted 2.8 s later on top of flatblock's delivery.
   */
  it('is not granted in the same widen round as a machine still behind', async () => {
    const { svc } = make([
      coordinator,
      m('b-flatblock', { name: 'flatblock' }),
      // Already at the target, so the canary gate is proved and the round widens.
      m('c-mac', { version: '0.4.2' }),
    ])
    svc.setTarget('dev', target)
    svc.markAuthorized('dev')

    const granted = await svc.tick('dev')
    expect(granted).toEqual(['b-flatblock'])
    expect(granted).not.toContain('a-ludovico')
  })

  it('takes the update once the rest of the fleet is at the target', async () => {
    const { svc } = make([coordinator, m('b-flatblock', { version: '0.4.2' })])
    svc.setTarget('dev', target)
    svc.markAuthorized('dev')

    expect(await svc.tick('dev')).toEqual(['a-ludovico'])
  })
})

/**
 * DEFERRING IS NOT THE SAME AS DROPPING.
 *
 * Two call sites cannot await `onTargetChanged`, because their callers are
 * synchronous by contract: `setTarget` is the compatibility shim for fixtures
 * and the development publisher, and `publishNextTargets` answers with the
 * channels it published. Rule 51b lets a site that SCHEDULES rather than
 * answers defer — provided the deferral is deliberate AND the rejection is
 * handled. Before this, both sites floated the promise: the listener reads the
 * store, so it can reject, and the rejection went to the process's unhandled
 * handler where no operator would ever see it.
 *
 * These cases watch the LOG, because the log is the whole difference between a
 * handled deferral and a dropped one. Remove either `.catch` from
 * `notifyTargetChangedDeferred` and both go red by name.
 */
describe('deferred target-change notification', () => {
  const target = { version: '0.4.2', critical: false, artifacts: {} } as never

  /** A rejecting listener plus a sink over the module logger's `warn` output. */
  const withFailingListener = (over: Record<string, unknown> = {}) => {
    const warnings: Array<{ msg: string; fields: Record<string, unknown> }> = []
    resetLogging()
    setLogLevel('debug')
    addSink({
      name: 'deferred-target-change',
      write: (record) => {
        if (record.level === 'warn') {
          warnings.push({ msg: record.msg, fields: record as unknown as Record<string, unknown> })
        }
      },
    })
    const failure = new Error('target listener could not read the store')
    const onTargetChanged = vi.fn(async () => {
      throw failure
    })
    const svc = new UpdatesService({
      machines: () => [],
      send: vi.fn(),
      now: () => 1_000,
      nextGrantId: () => 'g1',
      concurrency: 3,
      fleetChannel: () => 'dev',
      onTargetChanged,
      ...over,
    } as never)
    return { svc, warnings, failure, onTargetChanged }
  }

  /** The rejection is delivered a microtask later; nothing here sleeps on it. */
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

  afterEach(() => {
    resetLogging()
  })

  it('logs the rejection the sync setTarget shim cannot await', async () => {
    const { svc, warnings, onTargetChanged } = withFailingListener()

    // Synchronous by contract: it returns before the listener has rejected.
    svc.setTarget('edge', target)
    expect(onTargetChanged).toHaveBeenCalledWith('edge')
    await settle()

    const logged = warnings.find((w) => w.msg === 'target change notification failed')
    expect(logged).toBeDefined()
    expect(logged?.fields.channel).toBe('edge')
    expect((logged?.fields.err as Error).message).toBe('target listener could not read the store')
  })

  it('logs the rejection publishNextTargets cannot await', async () => {
    // An operation holds the lifecycle group, so the publication is QUEUED
    // rather than applied — which is the only way to reach the second site.
    let active = true
    const { svc, warnings, onTargetChanged } = withFailingListener({
      exclusiveOperationActive: async () => active,
    })
    svc.setTarget('dev', target)
    await settle()
    onTargetChanged.mockClear()

    await svc.setTargetFromProducer('dev', {
      version: '0.4.3',
      critical: false,
      artifacts: {},
    } as never)
    expect(onTargetChanged).not.toHaveBeenCalled()
    expect(svc.nextTarget('dev')).toBeDefined()

    active = false
    warnings.length = 0
    expect(svc.publishNextTargets()).toEqual(['dev'])
    expect(onTargetChanged).toHaveBeenCalledWith('dev')
    await settle()

    const logged = warnings.find((w) => w.msg === 'target change notification failed')
    expect(logged).toBeDefined()
    expect(logged?.fields.channel).toBe('dev')
  })

  /**
   * THE OTHER HALF OF "HANDLED": a rejection that is logged must not ALSO be
   * unhandled. A `.catch` that re-threw, or a `.then`-shaped handler, would
   * satisfy the two cases above and still crash the process.
   */
  it('leaves no unhandled rejection behind', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      // A PLAIN async function, deliberately not a `vi.fn`: the spy wrapper
      // observes its own returned promise to record the call's outcome, which
      // marks the rejection handled and would make this case pass vacuously.
      let called = 0
      const svc = new UpdatesService({
        machines: () => [],
        send: vi.fn(),
        now: () => 1_000,
        nextGrantId: () => 'g1',
        concurrency: 3,
        fleetChannel: () => 'dev',
        onTargetChanged: async () => {
          called += 1
          throw new Error('target listener could not read the store')
        },
      } as never)

      svc.setTarget('edge', target)
      expect(called).toBe(1)
      await settle()
      await settle()
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
