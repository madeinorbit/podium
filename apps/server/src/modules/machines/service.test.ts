import { mintSigningKeyPair, publicKeyWire } from '@podium/runtime/signing'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Inventory, UserId } from '@podium/model'
import { firstAdminMemberId, asAccountId, asMachineId, asSessionId, asUserId } from '@podium/model'
import type { DaemonPtyInputBatch, MachineSupervisorControlMessage } from '@podium/protocol'
import type { ControlMessage } from '@podium/protocol/daemon'
import { TRPCError } from '@trpc/server'
import { describe, expect, test, vi } from 'vitest'
import { openEnrollmentLedger } from '../../enrollment-ledger'
import { SessionStore } from '../../store'
import { testClientPrincipal } from '../../test-support/client-principal'
import { openTestStore } from '../../test-support/open-test-store'
import type { Send } from '../sessions/session'
import { machinesForPrincipal } from '../sessions/command-ctx'
import type { CommandPrincipal } from '../../command-principal'
import type { MachineOwnershipIndex } from '../../machine-access'
import { sha256 } from './enrollment'
import { type MachinesDeps, MachinesService, type PairingGrant } from './service'

/** Only the socket bookkeeping is exercised here — none of these paths touch the store. */
function makeService(): MachinesService {
  const deps = {
    instanceId: 'default',
    // POD-2700: `attach` records the durable `daemon` component, so the store
    // stub has to answer that write. `false` = "nothing changed", which is the
    // truthful answer for a fixture with no rows and keeps these socket-identity
    // tests about sockets.
    store: {
      machines: {
        getMachine: async () => ({ revokedAt: null }),
        addMachineComponent: () => false,
        setAvailability: async () => {},
        setPresenceSource: () => {},
        // No durable rows in this socket-only fake, so no commit events fire.
        committed: { subscribe: () => () => {} },
      },
    } as unknown as MachinesDeps['store'],
    hostMachineId: asMachineId('host-under-test'),
    sessionsChangedForMachine: () => {},
    clients: () => [],
    machinesForPrincipal: async () => [],
  } satisfies MachinesDeps
  return new MachinesService(deps)
}

const MACHINE = asMachineId('vmi')
/** A keystroke — the message class that silently queued into the void during the outage. */
const keystroke: ControlMessage = { type: 'input', sessionId: asSessionId('s1'), data: 'ls\r' }

function recorder(): { send: Send<ControlMessage>; got: ControlMessage[] } {
  const got: ControlMessage[] = []
  return { send: (m) => got.push(m), got }
}

async function storedService(
  recoveryOnly = false,
): Promise<{ svc: MachinesService; store: SessionStore }> {
  const store = await SessionStore.open(':memory:')
  await store.machines.upsertMachine({
    assignment: { server: false, agentExecution: true },
    id: MACHINE,
    name: 'vmi',
    hostname: 'vmi.local',
    tokenHash: 'token-hash',
    ownerUserId: firstAdminMemberId(),
  })
  const svc = new MachinesService({
    instanceId: 'default',
    store,
    recoveryOnly,
    hostMachineId: store.hostMachineId,
    sessionsChangedForMachine: () => {},
    clients: () => [],
    machinesForPrincipal: async () => [],
  } satisfies MachinesDeps)
  return { svc, store }
}

describe('MachinesService daemon socket identity', () => {
  test('a superseded socket’s late close does not evict the reconnected daemon', async () => {
    // Reproduces the 2026-07-09 vmi outage: the daemon reconnects while its previous
    // socket is wedged; the keepalive sweep terminates the old socket a beat later and
    // its `close` fires. Keyed only by machineId, that close deleted the FRESH send —
    // leaving the machine unroutable while its daemon sat happily connected.
    const svc = makeService()
    const old = recorder()
    const fresh = recorder()

    await svc.attach(MACHINE, old.send)
    await svc.attach(MACHINE, fresh.send) // daemon reconnects, replacing the registration

    const detached = svc.detach(MACHINE, old.send) // the dead socket's late close

    expect(detached).toBe(false)
    expect(svc.hasDaemon(MACHINE)).toBe(true)

    // and control messages still reach the live socket rather than queueing forever
    svc.toMachine(MACHINE, keystroke)
    expect(fresh.got).toEqual([keystroke])
    expect(old.got).toEqual([])
  })

  test('the current socket’s close detaches the machine', async () => {
    const svc = makeService()
    const only = recorder()

    await svc.attach(MACHINE, only.send)
    const detached = svc.detach(MACHINE, only.send)

    expect(detached).toBe(true)
    expect(svc.hasDaemon(MACHINE)).toBe(false)
  })

  test('an unidentified detach still drops the socket (legacy callers)', async () => {
    const svc = makeService()
    await svc.attach(MACHINE, recorder().send)

    expect(svc.detach(MACHINE)).toBe(true)
    expect(svc.hasDaemon(MACHINE)).toBe(false)
  })

  test('one local participant owns update grants while the daemon keeps session traffic', async () => {
    const svc = makeService()
    const daemon = recorder()
    const local: ControlMessage[] = []
    const participant = (message: Extract<ControlMessage, { type: 'updateGrant' }>) =>
      local.push(message)
    const grant = {
      type: 'updateGrant',
      grantId: 'g1',
      target: {
        version: '0.4.2',
        critical: false,
        artifacts: {
          headless: {
            delivery: 'feed',
            platforms: {
              'linux-x86_64': { url: 'https://x.test/a', digest: 'd', signature: 's' },
            },
          },
        },
      },
    } as ControlMessage

    await svc.attach(MACHINE, daemon.send)
    svc.attachUpdateParticipant(MACHINE, participant)
    svc.toMachine(MACHINE, keystroke)
    svc.toMachine(MACHINE, grant)

    expect(daemon.got).toEqual([keystroke])
    expect(local).toEqual([grant])
    expect(() => svc.attachUpdateParticipant(MACHINE, () => {})).toThrow(/already has/i)
  })

  test('flushes queued control and canonical input in FIFO order without re-encoding', async () => {
    const svc = makeService()
    const events: string[] = []
    const input: DaemonPtyInputBatch = {
      sessionId: asSessionId('s1'),
      inputOrigin: 'human',
      bytes: Uint8Array.of(0, 0xff, 0x1b),
    }
    svc.toMachine(MACHINE, keystroke)
    svc.toPtyInput(MACHINE, input)
    await svc.attach(MACHINE, {
      send: () => events.push('control'),
      sendInput: (received) => {
        expect(received.bytes).toEqual(input.bytes)
        events.push('input')
      },
    })
    await svc.flushQueued(MACHINE)
    expect(events).toEqual(['control', 'input'])
  })

  test('adapts canonical input to legacy base64 only at a function transport', async () => {
    const svc = makeService()
    const sent: ControlMessage[] = []
    const input: DaemonPtyInputBatch = {
      sessionId: asSessionId('s1'),
      inputOrigin: 'human',
      bytes: Uint8Array.of(0, 0xff, 0x1b),
    }
    await svc.attach(MACHINE, (message) => sent.push(message))
    svc.toPtyInput(MACHINE, input)
    expect(sent).toEqual([
      {
        type: 'input',
        sessionId: asSessionId('s1'),
        inputOrigin: 'human',
        data: Buffer.from(input.bytes).toString('base64'),
      },
    ])
  })
})

describe('MachinesService supervisor presence', () => {
  const build = {
    appVersion: '0.5.0',
    wireSchemaDigest: 'new-schema',
    installKind: 'installed',
  } as const
  const grant = {
    type: 'updateGrant',
    grantId: 'g-supervisor',
    target: {
      version: '0.5.1',
      critical: false,
      artifacts: {},
    },
  } as ControlMessage

  test('keeps a daemon failure online and degraded, then routes the grant only to the supervisor', async () => {
    const { svc } = await storedService()
    const daemon = recorder()
    const participant: ControlMessage[] = []
    const supervisor: MachineSupervisorControlMessage[] = []
    const observedAt = '2026-08-26T12:00:00.000Z'
    await svc.attach(MACHINE, daemon.send)
    svc.attachUpdateParticipant(MACHINE, (message) => participant.push(message))
    await svc.attachSupervisor(MACHINE, (message) => supervisor.push(message), build, [
      'update.delivery.feed',
    ])
    await svc.recordSupervisorReport(
      MACHINE,
      {
        server: { policy: 'enabled', state: 'available', observedAt },
        agentExecution: { policy: 'enabled', state: 'available', observedAt },
      },
      observedAt,
    )
    expect(supervisor[0]).toEqual({
      type: 'serviceAssignment',
      assignment: { server: false, agentExecution: true },
    })

    svc.detach(MACHINE, daemon.send)
    expect((await svc.listMachines())[0]).toMatchObject({
      online: true,
      presenceSource: 'supervisor',
      appVersion: '0.5.0',
      services: {
        agentExecution: {
          policy: 'enabled',
          state: 'stopped',
          reason: 'agent execution plane is disconnected',
        },
      },
    })

    svc.toMachine(MACHINE, grant)
    expect(supervisor.at(-1)).toEqual(grant)
    expect(participant).toEqual([])
    expect(daemon.got).toEqual([])
  })

  test.each([
    false,
    true,
  ])('retains recovery transport without writes while sealed (boot=%s)', async (recoveryOnly) => {
    const { svc, store } = await storedService(recoveryOnly)
    const daemon = recorder()
    const old = (_message: MachineSupervisorControlMessage) => {}
    const fresh = (_message: MachineSupervisorControlMessage) => {}
    await store.beginTransferFence()
    // Explicit recovery mode also protects callers that do not expose a live fence.
    const bootFence = recoveryOnly
      ? vi.spyOn(store, 'transferFenceActive', 'get').mockReturnValue(false)
      : undefined
    const before = await store.machines.getMachine(MACHINE)
    try {
      await svc.attach(MACHINE, daemon.send, ['recovery-cap'])
      await svc.attachSupervisor(MACHINE, old, build, ['update.delivery.feed'])
      await svc.attachSupervisor(MACHINE, fresh, build, ['update.delivery.feed'])
      expect(await svc.detachSupervisor(MACHINE, old)).toBe(false)
      expect(await svc.detachSupervisor(MACHINE, fresh)).toBe(true)
      await svc.recordComponent(MACHINE, 'daemon')
      await svc.recordLegacyBuild(MACHINE, build, [], new Date().toISOString())
      await svc.attachSupervisor(MACHINE, fresh, build, ['update.delivery.feed'])
      const status = {
        policy: 'enabled' as const,
        state: 'available' as const,
        observedAt: new Date().toISOString(),
      }
      await svc.recordSupervisorReport(
        MACHINE,
        { server: status, agentExecution: status },
        status.observedAt,
      )
      await svc.resumeAfterTransferFence()
      expect(await store.machines.getMachine(MACHINE)).toEqual(before)
      expect(svc.daemonSupports(MACHINE, 'recovery-cap')).toBe(true)
      svc.toMachine(MACHINE, keystroke)
      expect(daemon.got).toEqual([keystroke])
      if (!recoveryOnly) {
        await store.endTransferFence()
        await svc.resumeAfterTransferFence()
        expect((await store.machines.getMachine(MACHINE))?.components).toContain('daemon')
      }
    } finally {
      bootFence?.mockRestore()
      await store.close()
    }
  })

  test('fences a replaced supervisor and keeps the successor authoritative', async () => {
    const { svc } = await storedService()
    const old: MachineSupervisorControlMessage[] = []
    const successor: MachineSupervisorControlMessage[] = []
    const oldSend = (message: MachineSupervisorControlMessage) => old.push(message)
    const successorSend = (message: MachineSupervisorControlMessage) => successor.push(message)

    await svc.attachSupervisor(MACHINE, oldSend, build, ['update.delivery.feed'])
    await svc.attachSupervisor(MACHINE, successorSend, build, ['update.delivery.feed'])
    expect(await svc.detachSupervisor(MACHINE, oldSend)).toBe(false)
    svc.toMachine(MACHINE, grant)

    expect(successor.at(-1)).toEqual(grant)
    expect(old).toHaveLength(1)
  })

  /**
   * POD-3752. The observed coordinator handover: the successor parent attaches,
   * and 15 ms later the OUTGOING parent's own reconnect lands on the successor's
   * server carrying the version it is about to stop running. Arrival order is not
   * identity — the incarnation number is, and an older one may not write the row
   * or take the map slot the successor holds.
   */
  test('refuses a superseded parent hello and leaves the successor owning the row', async () => {
    const { svc } = await storedService()
    const outgoing: MachineSupervisorControlMessage[] = []
    const successor: MachineSupervisorControlMessage[] = []
    const outgoingSend = (message: MachineSupervisorControlMessage) => outgoing.push(message)
    const successorSend = (message: MachineSupervisorControlMessage) => successor.push(message)
    const oldBuild = { ...build, appVersion: '0.5.0', supervisorGeneration: 7 }
    const newBuild = { ...build, appVersion: '0.5.1', supervisorGeneration: 8 }

    expect(await svc.attachSupervisor(MACHINE, outgoingSend, oldBuild, [])).toBe('attached')
    expect(await svc.attachSupervisor(MACHINE, successorSend, newBuild, [])).toBe('attached')
    // The late reconnect of the parent that is on its way out.
    expect(await svc.attachSupervisor(MACHINE, outgoingSend, oldBuild, [])).toBe('superseded')

    expect((await svc.listMachines())[0]).toMatchObject({
      appVersion: '0.5.1',
      presenceSource: 'supervisor',
    })
    // No map displacement either: the grant still reaches the successor.
    svc.toMachine(MACHINE, grant)
    expect(successor.at(-1)).toEqual(grant)
    // ...and the outgoing parent's close cannot detach the successor.
    expect(await svc.detachSupervisor(MACHINE, outgoingSend)).toBe(false)
    expect((await svc.listMachines())[0]).toMatchObject({ appVersion: '0.5.1' })
  })

  /** Rollback: once the newer incarnation's socket is gone, an older one may serve again. */
  test('lets an older incarnation attach again after the newer socket closes', async () => {
    const { svc } = await storedService()
    const outgoingSend = (_message: MachineSupervisorControlMessage) => {}
    const successorSend = (_message: MachineSupervisorControlMessage) => {}
    const oldBuild = { ...build, appVersion: '0.5.0', supervisorGeneration: 7 }
    const newBuild = { ...build, appVersion: '0.5.1', supervisorGeneration: 8 }

    await svc.attachSupervisor(MACHINE, successorSend, newBuild, [])
    expect(await svc.detachSupervisor(MACHINE, successorSend)).toBe(true)
    expect(await svc.attachSupervisor(MACHINE, outgoingSend, oldBuild, [])).toBe('attached')
    expect((await svc.listMachines())[0]).toMatchObject({ appVersion: '0.5.0' })
  })

  /**
   * Mixed fleet: a parent from a build that predates the fence sends no number at
   * all. It reads as incarnation 0 — it can serve when nothing newer is attached,
   * and can never displace one that is.
   */
  test('treats a hello without an incarnation number as the oldest one', async () => {
    const { svc } = await storedService()
    const unstamped = (_message: MachineSupervisorControlMessage) => {}
    const stamped = (_message: MachineSupervisorControlMessage) => {}

    const legacy = { ...build, appVersion: '0.5.0' }
    const fenced = { ...build, appVersion: '0.5.1', supervisorGeneration: 1 }

    expect(await svc.attachSupervisor(MACHINE, unstamped, legacy, [])).toBe('attached')
    expect(await svc.attachSupervisor(MACHINE, stamped, fenced, [])).toBe('attached')
    expect(await svc.attachSupervisor(MACHINE, unstamped, legacy, [])).toBe('superseded')
    expect((await svc.listMachines())[0]).toMatchObject({ appVersion: '0.5.1' })
  })

  /** An ordinary reconnect of the SAME incarnation is not a supersession. */
  test('lets the attached incarnation reconnect on a new socket', async () => {
    const { svc } = await storedService()
    const first = (_message: MachineSupervisorControlMessage) => {}
    const second = (_message: MachineSupervisorControlMessage) => {}
    const stamped = { ...build, supervisorGeneration: 3 }

    await svc.attachSupervisor(MACHINE, first, stamped, [])
    expect(await svc.attachSupervisor(MACHINE, second, stamped, [])).toBe('attached')
    expect(await svc.detachSupervisor(MACHINE, first)).toBe(false)
  })

  test('uses the same thirty-second grace before a detached supervisor becomes offline', async () => {
    vi.useFakeTimers()
    try {
      const { svc } = await storedService()
      const send = (_message: MachineSupervisorControlMessage) => {}
      await svc.attachSupervisor(MACHINE, send, build, ['update.delivery.feed'])
      expect(await svc.detachSupervisor(MACHINE, send)).toBe(true)
      expect((await svc.listMachines())[0]?.online).toBe(true)

      vi.advanceTimersByTime(30_001)
      expect((await svc.listMachines())[0]?.online).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('promoted server host identity', () => {
  test('a server-only promoted host reuses its target row without minting another machine', async () => {
    const source = asMachineId('former-host')
    const target = asMachineId('promoted-host')
    const store = await SessionStore.open(':memory:', target)
    for (const id of [source, target]) {
      await store.machines.upsertMachine({
    assignment: { server: false, agentExecution: true },
        id,
        name: id,
        hostname: id,
        tokenHash: sha256(`${id}-secret`),
        ownerUserId: firstAdminMemberId(),
      })
    }
    const svc = new MachinesService({
      instanceId: 'default',
      store,
      hostMachineId: target,
      sessionsChangedForMachine: () => {},
      clients: () => [],
      machinesForPrincipal: async () => [],
    } satisfies MachinesDeps)
    const before = (await store.machines.listMachines()).map(({ id }) => id)

    expect(svc.onlineMachineIds()).toEqual([])
    expect(await svc.ensureHostMachine('promoted-hostname', 'promoted-secret')).toBe(target)
    expect((await store.machines.listMachines()).map(({ id }) => id)).toEqual(before)
    expect(await store.machines.getMachine(target)).toMatchObject({
      id: target,
      hostname: 'promoted-hostname',
    })
    await store.close()
  })
})

describe('MachinesService.requireAgent refuses rather than falling through (POD-303)', () => {
  /** A service whose machine list is stubbed, so the gate can be driven with a
   *  `use` decision Phase 4 (POD-1079) will eventually put on the projection. */
  function serviceListing(machines: unknown[]): MachinesService {
    const svc = makeService()
    ;(svc as unknown as { listMachines: () => unknown[] }).listMachines = () => machines.map((machine) => ({ serviceAssignment: { server: false, agentExecution: true }, availability: { daemon: true }, ...(machine as object) }))
    return svc
  }
  async function refusal(machines: unknown[]): Promise<TRPCError> {
    try {
      await serviceListing(machines).requireAgent(MACHINE, 'codex')
    } catch (error) {
      expect(error).toBeInstanceOf(TRPCError)
      return error as TRPCError
    }
    throw new Error('expected requireAgent to refuse the machine')
  }

  const runnable = {
    id: MACHINE,
    name: 'vmi',
    inventory: { agents: [{ kind: 'codex', installed: true, login: { state: 'in' as const } }] },
  }

  test('a denied machine throws about access, not about being offline', async () => {
    // The counterfactual is the SAME machine without the denial: it is accepted,
    // so the throw is caused by `use`, not by the fixture being unrunnable. And
    // the offline machine is here too, proving the two refusals are different
    // messages rather than one generic "unavailable".
    await expect(
      serviceListing([{ ...runnable, online: true }]).requireAgent(MACHINE, 'codex'),
    ).resolves.not.toThrow()
    expect(await refusal([{ ...runnable, online: true, use: 'denied' }])).toMatchObject({
      code: 'FORBIDDEN',
      message: "you do not have access to run agents on machine 'vmi'",
    })
    expect(await refusal([{ ...runnable, online: false }])).toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: "machine 'vmi' is offline",
    })
  })

  test('distinguishes unknown inventory as retryable 4xx preconditions', async () => {
    expect(await refusal([{ id: MACHINE, name: 'vmi', online: true }])).toMatchObject({
      code: 'PRECONDITION_FAILED',
      message:
        "machine 'vmi' is still probing whether codex is installed; wait for the probe or run `podium machine reprobe vmi`",
    })
    const timedOut = {
      id: MACHINE,
      name: 'vmi',
      online: true,
      inventory: {
        agents: [
          {
            kind: 'codex',
            installed: null,
            probeError: { reason: 'timed-out', timeoutMs: 60_000 },
            login: { state: 'in' },
          },
        ],
      },
    }
    expect(await refusal([timedOut])).toMatchObject({
      code: 'PRECONDITION_FAILED',
      message:
        "could not determine whether codex is installed on machine 'vmi' (probe timed out after 60s); retry",
    })
  })

  test('a shell on a denied machine is refused too — spawning is `use`', async () => {
    // Shells skip the harness checks, and that shortcut must not skip the access
    // gate. Counterfactual: the same shell request on an undenied machine passes.
    await expect(
      serviceListing([{ id: MACHINE, name: 'vmi', online: true }]).requireAgent(MACHINE, 'shell'),
    ).resolves.not.toThrow()
    await expect(
      serviceListing([{ id: MACHINE, name: 'vmi', online: true, use: 'denied' }]).requireAgent(
        MACHINE,
        'shell',
      ),
    ).rejects.toThrow(/do not have access/)
  })
})

describe('the machine caches are dropped by pair/hello (POD-1479)', () => {
  // The row caches (machineRecordsCache / machineNameCache) are derived state:
  // every write to the machines table must invalidate them or a client keeps
  // reading the pre-write fleet. The credential lifecycle writes that table on
  // BOTH handshake arms, and reaches the caches only through EnrollmentHost —
  // so these tests drive `authenticateDaemon` and read the public projections
  // with NO manual invalidate in between. They also never `attach()`, because
  // attach invalidates defensively and would mask the loss.
  //
  // The cache is WARMED first in each case: an unwarmed read is a cache MISS
  // that rebuilds anyway, and would pass with invalidation removed entirely.

  async function pairingService(): Promise<{ svc: MachinesService; store: SessionStore }> {
    const store = await openTestStore(':memory:')
    if (!await store.users.get(firstAdminMemberId())) await store.users.create({ id: firstAdminMemberId(), displayName: 'Pairer', role: 'admin', createdAt: new Date().toISOString(), disabledAt: null }, 'hash')
    const codes = new Map<string, PairingGrant>()
    const svc = new MachinesService({
      instanceId: 'default', installationId: 'installation-test',
      store,
      hostMachineId: store.hostMachineId,
      pairing: {
        mint: (grant = {}) => {
          codes.set('code-1', { ...grant, installationId: 'installation-test' })
          return 'code-1'
        },
        peek: (code) => codes.get(code),
        redeem: (code) => {
          const grant = codes.get(code)
          codes.delete(code)
          return grant
        },
      },
      sessionsChangedForMachine: () => {},
      clients: () => [],
      machinesForPrincipal: async () => [],
    } satisfies MachinesDeps)
    return { svc, store }
  }

  test('a paired machine is named and listed without a manual invalidate', async () => {
    const { svc } = await pairingService()
    // Warm both caches on the pre-pair fleet: machineName populates the name map,
    // listMachines the record list. Everything after this is served from them
    // until something drops them.
    await svc.machineName(MACHINE)
    const before = (await svc.listMachines()).map((m) => m.id)
    expect(before).not.toContain(MACHINE)

    const code = svc.mintPairingCode({ ownerUserId: firstAdminMemberId() })
    const result = await svc.authenticateDaemon({
      type: 'pair',
      publicKey: publicKeyWire(mintSigningKeyPair()),
      code,
      machineId: MACHINE,
      hostname: 'vmi.local',
      name: 'Builder',
    })
    expect(result.ok).toBe(true)

    expect(await svc.machineName(MACHINE)).toBe('Builder')
    expect((await svc.listMachines()).find((m) => m.id === MACHINE)?.name).toBe('Builder')
    // Ownership reads the same cache, and it is the authorization input.
    expect((await svc.ownershipRows()).find((m) => m.id === MACHINE)?.ownerUserId).toBe(
      firstAdminMemberId(),
    )
  })

  test('an inventory lookup failure leaves the one-use pairing code retryable', async () => {
    const { svc, store } = await pairingService()
    const code = svc.mintPairingCode({ ownerUserId: firstAdminMemberId() })
    const lookup = vi.spyOn(store.sessions, 'bindingConfirmations')
      .mockRejectedValueOnce(new Error('lookup unavailable'))
    const frame = { type: 'pair' as const, publicKey: publicKeyWire(mintSigningKeyPair()), code, machineId: MACHINE, hostname: 'vmi.local' }
    await expect(svc.authenticateDaemon(frame, { bindingSessionIds: ['missing'] })).rejects.toThrow('lookup unavailable')
    const retried = await svc.authenticateDaemon(frame, { bindingSessionIds: ['missing'] })
    expect(retried).toMatchObject({ ok: true, bindingConfirmations: {
      missing: { owner: null, machineId: null, closed: false },
    } })
    expect(lookup).toHaveBeenCalledTimes(2)
    lookup.mockRestore()
  })

  test('a hello’s restamped hostname is visible without a manual invalidate', async () => {
    const { svc, store } = await pairingService()
    const token = 'tok-vmi'
    await store.machines.upsertMachine({
    assignment: { server: false, agentExecution: true },
      id: MACHINE,
      name: 'Builder',
      hostname: 'old.local',
      tokenHash: sha256(token),
      ownerUserId: firstAdminMemberId(),
    })

    // Warm on the pre-hello row — the upsert went straight to the store, so this
    // read is what puts the stale hostname in the cache.
    expect((await svc.listMachines()).find((m) => m.id === MACHINE)?.hostname).toBe('old.local')

    const result = await svc.authenticateDaemon({
      type: 'hello',
      machineId: MACHINE,
      token,
      hostname: 'new.local',
    })
    expect(result.ok).toBe(true)

    expect((await svc.listMachines()).find((m) => m.id === MACHINE)?.hostname).toBe('new.local')
  })
})

describe('MachinesService inventory persistence (#222)', () => {
  const INV: Inventory = {
    os: 'linux',
    arch: 'arm64',
    podiumVersion: '9.9.9',
    agents: [
      {
        kind: 'claude-code',
        installed: true,
        version: '2.1.0',
        login: { state: 'in', account: 'a@b.c' },
      },
      { kind: 'opencode', installed: false, login: { state: 'unknown' } },
    ],
    tools: [{ name: 'gh', installed: true, version: 'gh version 2.40.0' }],
  }

  async function makeStoreService(): Promise<{ svc: MachinesService; store: SessionStore }> {
    const store = await openTestStore(':memory:')
    const svc = new MachinesService({
      instanceId: 'default',
      store,
      hostMachineId: store.hostMachineId,
      sessionsChangedForMachine: () => {},
      clients: () => [],
      machinesForPrincipal: async () => [],
    } satisfies MachinesDeps)
    return { svc, store }
  }

  test('async predicate regression: repo placement skips the first foreign cwd', async () => {
    const { svc, store } = await makeStoreService()
    const other = asMachineId('repo-owner')
    await svc.attach(MACHINE, recorder().send)
    await svc.attach(other, recorder().send)
    await store.repos.addRepo('/foreign', MACHINE)
    await store.repos.addRepo('/wanted', other)
    expect(await svc.pickMachineForRepo(undefined, '/wanted/subdir')).toBe(other)
  })

  test('async predicate regression: agent placement rejects every incapable repo owner', async () => {
    const { svc, store } = await makeStoreService()
    await store.machines.upsertMachine({
    assignment: { server: false, agentExecution: true },
      id: MACHINE, name: 'Missing', hostname: 'a', tokenHash: 'x',
      ownerUserId: firstAdminMemberId(),
    })
    await store.repos.addRepo('/repo', MACHINE)
    await svc.attach(MACHINE, recorder().send)
    await svc.recordInventory(MACHINE, INV)
    await expect(svc.resolveMachineForAgent(undefined, '/repo', 'codex')).rejects.toThrow(
      "codex is not installed on machine 'Missing'",
    )
  })

  test('recordInventory persists the report and it survives a hello reconnect', async () => {
    const { svc, store } = await makeStoreService()
    await store.machines.upsertMachine({
    assignment: { server: false, agentExecution: true },
      id: MACHINE,
      name: 'vmi',
      hostname: 'vmi',
      tokenHash: 'x',
      ownerUserId: firstAdminMemberId(),
    })

    await svc.recordInventory(MACHINE, INV)
    expect((await store.machines.getMachine(MACHINE))?.inventory).toEqual(INV)

    // A hello only restamps last_seen_at/hostname — the inventory must remain.
    await store.machines.touchMachine(MACHINE, 'vmi-renamed')
    expect((await store.machines.getMachine(MACHINE))?.inventory).toEqual(INV)
    expect((await store.machines.getMachine(MACHINE))?.hostname).toBe('vmi-renamed')
  })

  test('coalesces inventory while the transfer fence is read-only and resumes after abort', async () => {
    const { svc, store } = await makeStoreService()
    await store.machines.upsertMachine({
    assignment: { server: false, agentExecution: true },
      id: MACHINE,
      name: 'vmi',
      hostname: 'vmi',
      tokenHash: 'x',
      ownerUserId: firstAdminMemberId(),
    })
    const latest: Inventory = {
      ...INV,
      podiumVersion: '10.0.1',
    }

    await store.beginTransferFence()
    expect(() => svc.recordInventory(MACHINE, INV)).not.toThrow()
    expect(() => svc.recordInventory(MACHINE, latest)).not.toThrow()
    expect((await store.machines.getMachine(MACHINE))?.inventory).toBeUndefined()
    // Reconciliation cannot weaken or bypass the physical fence.
    await svc.resumeAfterTransferFence()
    expect((await store.machines.getMachine(MACHINE))?.inventory).toBeUndefined()

    await store.endTransferFence()
    await svc.resumeAfterTransferFence()
    expect((await store.machines.getMachine(MACHINE))?.inventory).toEqual(latest)
  })

  test('records the native identity fingerprint selected on the target machine', async () => {
    const { svc, store } = await makeStoreService()
    await store.machines.upsertMachine({
    assignment: { server: false, agentExecution: true },
      id: MACHINE,
      name: 'Builder',
      hostname: 'vmi',
      tokenHash: 'x',
      ownerUserId: firstAdminMemberId(),
    })
    await svc.recordInventory(MACHINE, {
      ...INV,
      agents: [
        {
          kind: 'codex',
          installed: true,
          login: { state: 'in', identity: { fingerprint: 'fp-a' } },
        },
      ],
    })

    expect(await svc.nativeAccountIdForMachine(MACHINE, 'codex', asAccountId('native:codex'))).toBe(
      'native:codex:fp-a',
    )
    expect(await svc.nativeAccountIdForMachine(MACHINE, 'codex', asAccountId('native:codex:fp-b'))).toBe(
      'native:codex:fp-b',
    )
  })

  test('a reconnect treats persisted absence as probing and a spawn wait joins the report', async () => {
    const { svc, store } = await makeStoreService()
    await store.machines.upsertMachine({
    assignment: { server: false, agentExecution: true },
      id: MACHINE,
      name: 'Builder',
      hostname: 'vmi',
      tokenHash: 'x',
      ownerUserId: firstAdminMemberId(),
    })
    await svc.recordInventory(MACHINE, {
      ...INV,
      agents: [{ kind: 'claude-code', installed: false, login: { state: 'unknown' } }],
    })
    const daemon = recorder()
    await svc.attach(MACHINE, daemon.send)

    expect((await svc.listMachines()).find((machine) => machine.id === MACHINE)?.inventory).toBeUndefined()
    await expect(svc.requireAgent(MACHINE, 'claude-code')).rejects.toThrow(
      "machine 'Builder' is still probing whether claude-code is installed",
    )

    const waiting = svc.waitForInventory(MACHINE)
    expect(daemon.got).toEqual([{ type: 'inventoryRequest' }])
    await svc.recordInventory(MACHINE, {
      ...INV,
      agents: [
        {
          kind: 'claude-code',
          installed: true,
          version: '2.1.231 (Claude Code)',
          login: { state: 'in' },
        },
      ],
    })
    await waiting

    expect(await svc.resolveMachineForAgent(MACHINE, '/repo', 'claude-code')).toBe(MACHINE)
  })

  test('explicit session placement rejects a missing harness but starts logged out', async () => {
    const { svc, store } = await makeStoreService()
    await store.machines.upsertMachine({
    assignment: { server: false, agentExecution: true },
      id: MACHINE,
      name: 'Builder',
      hostname: 'vmi',
      tokenHash: 'x',
      ownerUserId: firstAdminMemberId(),
    })
    await svc.attach(MACHINE, recorder().send)

    await svc.recordInventory(MACHINE, INV)
    await expect(svc.resolveMachineForAgent(MACHINE, '/repo', 'codex')).rejects.toThrow(
      "codex is not installed on machine 'Builder'",
    )

    await svc.recordInventory(MACHINE, {
      ...INV,
      agents: [{ kind: 'codex', installed: true, login: { state: 'out' } }],
    })
    expect(await svc.resolveMachineForAgent(MACHINE, '/repo', 'codex')).toBe(MACHINE)
    expect(await svc.agentLoginCondition(MACHINE, 'codex')).toBe('logged-out')
  })

  test('implicit placement moves to a capable machine that owns the cwd', async () => {
    const { svc, store } = await makeStoreService()
    const other = 'capable'
    await store.machines.upsertMachine({
    assignment: { server: false, agentExecution: true },
      id: MACHINE,
      name: 'Missing',
      hostname: 'a',
      tokenHash: 'x',
      ownerUserId: firstAdminMemberId(),
    })
    await store.machines.upsertMachine({
    assignment: { server: false, agentExecution: true },
      id: other,
      name: 'Capable',
      hostname: 'b',
      tokenHash: 'y',
      ownerUserId: firstAdminMemberId(),
    })
    await store.repos.addRepo('/repo', MACHINE)
    await store.repos.addRepo('/repo', asMachineId(other))
    await svc.attach(MACHINE, recorder().send)
    await svc.attach(asMachineId(other), recorder().send)
    await svc.recordInventory(MACHINE, {
      ...INV,
      agents: [{ kind: 'codex', installed: true, login: { state: 'out' } }],
    })
    await svc.recordInventory(asMachineId(other), {
      ...INV,
      agents: [{ kind: 'codex', installed: true, login: { state: 'in' } }],
    })

    expect(await svc.resolveMachineForAgent(undefined, '/repo/subdir', 'codex')).toBe(other)
  })
})

// ---------------------------------------------------------------------------
// OWNERSHIP TRANSFER — THE PROJECTION TAIL (POD-1480)
// ---------------------------------------------------------------------------
//
// `transferOwnership` appends to the enrollment ledger (the commit point,
// D19.4d) and then projects: row write → invalidateMachineCache →
// broadcastMachines. Until this suite the ONLY caller anywhere passed
// `skipRowUpdate: true` and returned before that tail, so none of those three
// steps had ever executed — POD-1467 confirmed it by replacing
// `broadcastMachines` with a THROW and watching the whole lane stay green.
//
// So these tests do not assert that the tail is CALLED — a call spy is satisfied
// by a no-op that still calls. They read the PROJECTION BACK through the public
// surface, with the caches deliberately warmed on the pre-transfer fleet first,
// and they snapshot what the fleet looked like AT BROADCAST TIME so the
// invalidate-before-broadcast ordering is asserted rather than assumed.
describe('ownership transfer projects onto the fleet (POD-1480)', () => {
  const OWNER_A = 'user:alice'
  const OWNER_B = 'user:bob'

  async function transferWorld(): Promise<{
    svc: MachinesService
    store: SessionStore
    dir: string
    /** One entry per broadcast, holding the OWNER the fleet read back at the
     *  moment the broadcast went out. */
    broadcasts: (string | null | undefined)[]
  }> {
    const dir = mkdtempSync(join(tmpdir(), 'podium-transfer-'))
    const store = await openTestStore(':memory:')
    const broadcasts: (string | null | undefined)[] = []
    const known = new Set([OWNER_A, OWNER_B, firstAdminMemberId()])
    let svc!: MachinesService
    svc = new MachinesService({
      instanceId: 'default',
      store,
      hostMachineId: store.hostMachineId,
      userExists: (id) => known.has(id),
      sessionsChangedForMachine: () => {},
      clients: () => [{ principal: testClientPrincipal('c1'), send: () => {} }],
      // Called once per client on every broadcast. Reading `ownershipRows()`
      // here is the load-bearing part: it goes through the SAME record cache the
      // transfer must have dropped, so a stale entry lands in this array.
      machinesForPrincipal: async () => {
        broadcasts.push((await svc.ownershipRows()).find((r) => r.id === MACHINE)?.ownerUserId)
        return []
      },
    } satisfies MachinesDeps)
    await store.machines.upsertMachine({
    assignment: { server: false, agentExecution: true },
      id: MACHINE,
      name: 'Builder',
      hostname: 'vmi.local',
      tokenHash: sha256('tok'),
      ownerUserId: asUserId(OWNER_A),
    })
    return { svc, store, dir, broadcasts }
  }

  // A NOTE ON THE CACHE, measured rather than assumed. `transferOwnership` calls
  // `invalidateMachineCache` between the row write and the broadcast, and
  // REMOVING that call does not redden anything here — deliberately reported
  // rather than papered over. It is not "never entered" (replacing the very next
  // statement, `broadcastMachines`, with a throw DOES redden three of these) and
  // it is not an assertion gap that a better probe would close: it is
  // EQUIVALENT for this write, because the record cache has exactly two readers
  // and neither exposes a stale owner. `ownershipRows` overlays `effectiveOwner`,
  // which reads the ledger live (D19.4d rule 4, ledger-wins); and `listMachines`
  // carries no owner FACT of its own — POD-1495's `owned` is a viewer-relative
  // answer supplied by the command layer, which computes it from that same
  // ledger-live index rather than from the cached row. The invalidate is defensive — correct to
  // keep, since a future reader of the raw cached row would need it — but no
  // public read can currently distinguish its presence.
  test('the row is written, the fleet serves the NEW owner, and one broadcast goes out', async () => {
    const { svc, store, dir, broadcasts } = await transferWorld()
    try {
      // Warm on the pre-transfer fleet. Without this the read-back below is a
      // cache MISS that rebuilds anyway and would pass with the invalidate gone.
      expect((await svc.ownershipRows()).find((r) => r.id === MACHINE)?.ownerUserId).toBe(OWNER_A)
      expect(broadcasts).toHaveLength(0)

      await svc.transferMachineOwnership(MACHINE, asUserId(OWNER_B), asUserId(OWNER_A))

      // 1 — THE ROW. Read straight from the store, past every cache.
      expect((await store.machines.getMachine(MACHINE))?.ownerUserId).toBe(OWNER_B)
      // 2 — THE FLEET. The same public read that was warmed above, with no
      // manual invalidate in between.
      expect((await svc.ownershipRows()).find((r) => r.id === MACHINE)?.ownerUserId).toBe(OWNER_B)
      // 3 — THE BROADCAST, and its ORDERING: exactly one went out, and the fleet
      // it was built from already showed the new owner — so it was emitted
      // AFTER the transition committed, not before.
      expect(broadcasts).toEqual([OWNER_B])
      // 4 — THE LEDGER, which is the commit point the row merely projects.
      expect(await svc.effectiveOwner(MACHINE)).toBe(OWNER_B)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('admin sharing and takeover use live role, keep attribution, and honor narrowing', async () => {
    const { svc, store, dir } = await transferWorld()
    const admin = firstAdminMemberId()
    try {
      await svc.shareMachine(MACHINE, OWNER_B, 'use', { actor: admin, onBehalfOf: admin })
      expect(await svc.grantsForMachine(MACHINE)).toHaveLength(1)
      await expect(svc.shareMachine(MACHINE, OWNER_B, 'manage', { actor: OWNER_B, onBehalfOf: OWNER_B })).rejects.toThrow('only the machine owner or an admin')
      await expect(svc.transferMachineOwnership(MACHINE, admin, admin, { manage: () => false })).rejects.toThrow('only the machine owner or an admin')
      expect((await store.machines.getMachine(MACHINE))?.ownerUserId).toBe(OWNER_A)
      await svc.transferMachineOwnership(MACHINE, admin, admin, {
        manage: () => true,
        attribution: { actorKind: 'agent', actorId: 'session:admin-agent', onBehalfOf: admin },
      })
      expect((await store.machines.getMachine(MACHINE))?.ownerUserId).toBe(admin)
      expect(await svc.grantsForMachine(MACHINE)).toEqual([])
      expect(await store.settingsAudit.list()).toEqual([expect.objectContaining({
        command: 'takeover', actorKind: 'agent', actorId: 'session:admin-agent', onBehalfOf: admin,
        detail: { machineId: MACHINE, previousOwnerUserId: OWNER_A, newOwnerUserId: admin },
      })])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('admin SEE discloses management and health but no USE detail; agent scope only narrows', async () => {
    const { svc, dir } = await transferWorld()
    try {
      const inventory: Inventory = { os: 'linux', arch: 'x64', agents: [{ kind: 'claude-code', installed: true, path: '/private/bin/claude', login: { state: 'in', account: 'private@example.com' } }], tools: [] }
      await svc.recordInventory(MACHINE, inventory)
      const principal: CommandPrincipal = { kind: 'user', user: firstAdminMemberId(), capability: { role: 'admin', scope: { kind: 'all' } } }
      const ownership: MachineOwnershipIndex = { rowFor: (id) => id === MACHINE ? { machine: id, owner: asUserId(OWNER_A), grants: [], daemonAssigned: true, daemonAvailable: true } : undefined }
      const raw = (await svc.listMachines()).find((m) => m.id === MACHINE)!
      const projected = (await machinesForPrincipal({ machines: svc }, principal, ownership))[0]!
      expect(projected).toMatchObject({ id: MACHINE, hostname: 'vmi.local', owned: false, transferable: true, adoptable: false, use: 'denied' })
      expect(projected).not.toHaveProperty('inventory')
      expect(projected).not.toHaveProperty('harnessVersions')
      expect(Object.keys(projected).sort()).toEqual([...Object.keys(raw).filter((key) => !['inventory', 'harnessVersions'].includes(key)), 'use', 'owned', 'transferable', 'unowned', 'adoptable', 'supersedable'].sort())
      const granted: MachineOwnershipIndex = { rowFor: (id) => { const row = ownership.rowFor(id); return row && { ...row, grants: [{ subject: firstAdminMemberId(), verb: 'use' }] } } }
      expect((await machinesForPrincipal({ machines: svc }, principal, granted))[0]?.inventory).toEqual(inventory)
      const agent: CommandPrincipal = { kind: 'agent', agentSessionId: asSessionId('leaf'), chain: [asSessionId('parent')], onBehalfOf: firstAdminMemberId(), capability: { role: 'admin', scope: { kind: 'all' }, actorSessionId: asSessionId('leaf') } }
      const narrowed = { ...granted, delegatedMachines: (id: string) => new Set(id === 'parent' ? [] : [MACHINE]) }
      const limited = (await machinesForPrincipal({ machines: svc }, agent, narrowed))[0]!
      expect(limited).toMatchObject({ use: 'denied', transferable: false })
      expect(limited).not.toHaveProperty('inventory')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('an audit failure rolls back takeover and its grant removal', async () => {
    const { svc, store, dir } = await transferWorld()
    try {
      await svc.shareMachine(MACHINE, OWNER_B, 'use', { actor: OWNER_A, onBehalfOf: OWNER_A })
      const append = vi.spyOn(store.settingsAudit, 'append').mockRejectedValueOnce(new Error('audit unavailable'))
      await expect(svc.transferMachineOwnership(MACHINE, firstAdminMemberId(), firstAdminMemberId())).rejects.toThrow('audit unavailable')
      append.mockRestore()
      expect((await store.machines.getMachine(MACHINE))?.ownerUserId).toBe(OWNER_A)
      expect(await svc.grantsForMachine(MACHINE)).toHaveLength(1)
      expect(await store.settingsAudit.list()).toEqual([])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('admin transfer to another member is not a takeover', async () => {
    const { svc, store, dir } = await transferWorld()
    try {
      await svc.transferMachineOwnership(MACHINE, asUserId(OWNER_B), firstAdminMemberId())
      expect((await store.settingsAudit.list()).at(-1)?.command).toBe('machines.transferOwnership')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('the outgoing owner’s audience does not travel with the machine', async () => {
    const { svc, store, dir } = await transferWorld()
    try {
      await store.grants.upsert({
        resourceKind: 'machine',
        resourceId: MACHINE,
        grantee: 'user:carol',
        verb: 'use',
        owner: OWNER_A,
        visibility: 'owned-compute',
        createdAt: new Date().toISOString(),
        actorKind: 'user',
        actorId: 'alice',
        onBehalfOf: OWNER_A,
      })
      expect(await svc.grantsForMachine(MACHINE)).toHaveLength(1)

      await svc.transferMachineOwnership(MACHINE, asUserId(OWNER_B), asUserId(OWNER_A))

      // Carol's `use` was Alice's deliberate act on Alice's hardware. It is not
      // Bob's, and `use` is a code-execution boundary (readiness M2).
      expect(await svc.grantsForMachine(MACHINE)).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a non-owner is refused at the service too, and the fleet is untouched', async () => {
    const { svc, store, dir, broadcasts } = await transferWorld()
    try {
      // SECOND PRINCIPAL. The gate refuses this in `fleetAuthzFailure`; the
      // service refuses it again, because a service reachable from more than one
      // transport must not depend on every one of them remembering.
      await expect(
        svc.transferMachineOwnership(MACHINE, asUserId(OWNER_A), asUserId(OWNER_B)),
      ).rejects.toThrow('only the machine owner or an admin may transfer ownership')
      expect((await store.machines.getMachine(MACHINE))?.ownerUserId).toBe(OWNER_A)
      // A refused transfer is SILENT — no ledger append, no broadcast.
      expect(broadcasts).toEqual([])
      expect(await svc.effectiveOwner(MACHINE)).toBe(OWNER_A)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('an unknown recipient is refused rather than quarantining the machine', async () => {
    const { svc, store, dir, broadcasts } = await transferWorld()
    try {
      await expect(
        svc.transferMachineOwnership(MACHINE, asUserId('user:typo'), asUserId(OWNER_A)),
      ).rejects.toThrow('unknown user: user:typo')
      // The hazard this closes: an owner the ledger records but `userExists`
      // cannot resolve is quarantined by the next reconcile — owner null, usable
      // by nobody. Nothing was appended, so nothing to reconcile.
      expect((await store.machines.getMachine(MACHINE))?.ownerUserId).toBe(OWNER_A)
      expect(await svc.effectiveOwner(MACHINE)).toBe(OWNER_A)
      expect(broadcasts).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('transferring to the current owner is refused, not a silent no-op broadcast', async () => {
    const { svc, dir, broadcasts } = await transferWorld()
    try {
      await expect(
        svc.transferMachineOwnership(MACHINE, asUserId(OWNER_A), asUserId(OWNER_A)),
      ).rejects.toThrow('machine is already owned by that user')
      expect(broadcasts).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/**
 * ADOPTION (POD-1494) — giving an owner to a machine that has none.
 *
 * The suite above proves transfer moves ownership BETWEEN two people. This one
 * covers the case transfer refuses by construction, and its whole subject is
 * WHICH machines qualify: the database owner is authoritative. A legacy ledger
 * or a changed member directory must not silently rewrite that ownership.
 */
describe('adoption of an unowned machine (POD-1494)', () => {
  const ALICE = asUserId('user:alice')
  const BOB = asUserId('user:bob')

  async function adoptWorld(opts: { rowOwner?: UserId | null; known?: UserId[] } = {}): Promise<{
    svc: MachinesService
    store: SessionStore
    dir: string
    /** Mutable, so a test can make a recorded owner STOP resolving — which is
     *  the only way to produce the quarantine state (D19.4b) honestly. */
    known: Set<string>
    /** Rebuild over the same database without boot-time reconciliation. */
    reboot: () => Promise<MachinesService>
  }> {
    const dir = mkdtempSync(join(tmpdir(), 'podium-adopt-'))
    const store = await openTestStore(':memory:')
    const known = new Set(opts.known ?? [ALICE, BOB])
    const build = (): MachinesService =>
      new MachinesService({
        instanceId: 'default',
        store,
        hostMachineId: store.hostMachineId,
        userExists: (id) => known.has(id),
        sessionsChangedForMachine: () => {},
        clients: () => [],
        machinesForPrincipal: async () => [],
      } satisfies MachinesDeps)
    const svc = build()
    await store.machines.upsertMachine({
    assignment: { server: false, agentExecution: true },
      id: MACHINE,
      name: 'Builder',
      hostname: 'vmi.local',
      tokenHash: sha256('tok'),
      ownerUserId: opts.rowOwner ?? null,
    })
    await store.machines.setMachineOwner(MACHINE, opts.rowOwner ?? null)
    return {
      svc, store, dir, known,
      reboot: async () => {
        return build()
      },
    }
  }

  // -------------------------------------------------------------------------
  // THE THREE UNOWNED STATES, each produced the way production produces it
  // -------------------------------------------------------------------------

  test('adoption requires a live admin and respects narrowed agent scope', async () => {
    const { svc, store, dir } = await adoptWorld()
    try {
      await expect(svc.adoptMachine(MACHINE, ALICE, BOB)).rejects.toThrow('only an admin')
      await expect(svc.adoptMachine(MACHINE, ALICE, firstAdminMemberId(), { manage: () => false })).rejects.toThrow('only an admin')
      expect((await store.machines.getMachine(MACHINE))?.ownerUserId).toBeNull()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('state 1 — NEVER RECORDED: no owner event was ever appended', async () => {
    const { svc, store, dir } = await adoptWorld()
    try {
      // The ledger holds nothing about this machine's ownership at all.
      expect(await svc.effectiveOwner(MACHINE)).toBeNull()

      await svc.adoptMachine(MACHINE, asUserId(ALICE), firstAdminMemberId())

      expect(await svc.effectiveOwner(MACHINE)).toBe(ALICE)
      expect((await store.machines.getMachine(MACHINE))?.ownerUserId).toBe(ALICE)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('state 2 — RECORDED AS UNOWNED: the pairing code carried no owner', async () => {
    const { svc, store, dir } = await adoptWorld()
    try {
      // What `authenticateDaemon` writes for a code with no `ownerUserId`: an
      // owner event whose owner is explicitly null, not a missing event.
      await svc.transferOwnership(MACHINE, asUserId(null as unknown as string))
      expect(await svc.effectiveOwner(MACHINE)).toBeNull()

      await svc.adoptMachine(MACHINE, asUserId(BOB), firstAdminMemberId())

      expect(await svc.effectiveOwner(MACHINE)).toBe(BOB)
      expect((await store.machines.getMachine(MACHINE))?.ownerUserId).toBe(BOB)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a missing member does not make boot rewrite database ownership', async () => {
    const { store, dir, known, reboot } = await adoptWorld({ rowOwner: ALICE })
    try {
      known.delete(ALICE)
      const rebooted = await reboot()
      expect((await store.machines.getMachine(MACHINE))?.ownerUserId).toBe(ALICE)
      expect(await rebooted.effectiveOwner(MACHINE)).toBe(ALICE)
      await expect(rebooted.adoptMachine(MACHINE, BOB, firstAdminMemberId())).rejects.toThrow('machine already has an owner')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })


  test('a machine with a LIVE owner is refused — that is transfer’s act, not this one', async () => {
    const { svc, store, dir } = await adoptWorld({ rowOwner: ALICE })
    try {
      await svc.transferOwnership(MACHINE, asUserId(ALICE))

      // TWO PRINCIPALS' WORTH OF ROUTE, at the service seam: adoption refuses
      // Alice's machine whether the adopter meant to take it themselves or hand
      // it to someone else. Neither recipient makes the machine unowned.
      await expect(svc.adoptMachine(MACHINE, asUserId(BOB), firstAdminMemberId())).rejects.toThrow('machine already has an owner')
      await expect(svc.adoptMachine(MACHINE, asUserId(ALICE), firstAdminMemberId())).rejects.toThrow(
        'machine already has an owner',
      )

      // Refused means SILENT: the ledger was not appended and the row is intact.
      expect(await svc.effectiveOwner(MACHINE)).toBe(ALICE)
      expect((await store.machines.getMachine(MACHINE))?.ownerUserId).toBe(ALICE)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('adoption reads database ownership even when legacy enrollment disagrees', async () => {
    const { svc, store, dir } = await adoptWorld({ rowOwner: ALICE })
    try {
      openEnrollmentLedger(dir).appendEnroll({ id: 'legacy-alice', machineId: MACHINE, serial: 1, ownerUserId: ALICE, at: '2026-09-01T00:00:00Z' })
      await store.machines.setMachineOwner(MACHINE, null)
      expect(await svc.effectiveOwner(MACHINE)).toBeNull()
      await svc.adoptMachine(MACHINE, BOB, firstAdminMemberId())
      expect(await svc.effectiveOwner(MACHINE)).toBe(BOB)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })


  test('an unknown recipient is refused rather than re-quarantining the machine', async () => {
    const { svc, store, dir } = await adoptWorld()
    try {
      await expect(svc.adoptMachine(MACHINE, asUserId('user:typo'), firstAdminMemberId())).rejects.toThrow(
        'unknown user: user:typo',
      )
      // The hazard: adopting to an unresolvable id appends an owner the next
      // reconcile cannot resolve, so the machine comes out of adoption in
      // exactly the quarantine it went in with. Nothing was appended.
      expect(await svc.effectiveOwner(MACHINE)).toBeNull()
      expect((await store.machines.getMachine(MACHINE))?.ownerUserId).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('setup records the host grantee only on an UNOWNED host row (POD-4179)', async () => {
    const { svc, store, dir } = await adoptWorld()
    try {
      await store.machines.upsertMachine({
    assignment: { server: false, agentExecution: true },
        id: store.hostMachineId,
        name: 'host',
        hostname: 'host.local',
        tokenHash: sha256('host-tok'),
        ownerUserId: null,
      })
      expect(await svc.grantHostMachineIfUnowned(asUserId(ALICE))).toBe(true)
      expect((await store.machines.getMachine(store.hostMachineId))?.ownerUserId).toBe(ALICE)
      // Idempotent and never a takeover: an owned row is left exactly as it is.
      expect(await svc.grantHostMachineIfUnowned(asUserId(BOB))).toBe(false)
      expect((await store.machines.getMachine(store.hostMachineId))?.ownerUserId).toBe(ALICE)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('an unknown machine is refused before anything is read', async () => {
    const { svc, dir } = await adoptWorld()
    try {
      await expect(svc.adoptMachine(asMachineId('ghost'), asUserId(ALICE), firstAdminMemberId())).rejects.toThrow(
        "unknown machine 'ghost'",
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // -------------------------------------------------------------------------
  // THE COMMIT POINT
  // -------------------------------------------------------------------------

  test('boot preserves a committed database ownership change', async () => {
    const { svc, store, dir, reboot } = await adoptWorld()
    try {
      await svc.adoptMachine(MACHINE, ALICE, firstAdminMemberId())
      await store.machines.setMachineOwner(MACHINE, null)
      const rebooted = await reboot()
      expect((await store.machines.getMachine(MACHINE))?.ownerUserId).toBeNull()
      expect(await rebooted.effectiveOwner(MACHINE)).toBeNull()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })


  test('a restored member cannot displace the database adopter', async () => {
    const { svc, store, dir, known, reboot } = await adoptWorld({ rowOwner: ALICE })
    try {
      known.delete(ALICE)
      // Ownership is explicitly released in the database; boot never invents it.
      await store.machines.setMachineOwner(MACHINE, null)
      await svc.adoptMachine(MACHINE, BOB, firstAdminMemberId())
      known.add(ALICE)
      expect(await (await reboot()).effectiveOwner(MACHINE)).toBe(BOB)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })


  test('grant edges surviving on the unowned row do not reach the adopter', async () => {
    const { svc, store, dir } = await adoptWorld()
    try {
      // An edge from before the machine lost its owner. While the owner is null
      // `machineVerbsFor` grants nobody anything, so this edge is INVISIBLE —
      // and would come back to life the instant an owner exists.
      await store.grants.upsert({
        resourceKind: 'machine',
        resourceId: MACHINE,
        grantee: 'user:carol',
        verb: 'use',
        owner: ALICE,
        visibility: 'owned-compute',
        createdAt: new Date().toISOString(),
        actorKind: 'user',
        actorId: 'alice',
        onBehalfOf: ALICE,
      })
      expect(await svc.grantsForMachine(MACHINE)).toHaveLength(1)

      await svc.adoptMachine(MACHINE, asUserId(BOB), firstAdminMemberId())

      // Carol's `use` was approved under a regime that is gone, on hardware that
      // is now Bob's. `use` is a code-execution boundary (readiness M2).
      expect(await svc.grantsForMachine(MACHINE)).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('listMachines resolves the fleet channel once per call (POD-3840)', () => {
  test('a fleet of machines asks the config for its default channel once', async () => {
    const store = await openTestStore(':memory:')
    let resolved = 0
    const svc = new MachinesService({
      instanceId: 'default',
      store,
      hostMachineId: store.hostMachineId,
      fleetUpdateChannel: () => {
        resolved++
        return 'stable'
      },
      sessionsChangedForMachine: () => {},
      clients: () => [],
      machinesForPrincipal: async () => [],
    } satisfies MachinesDeps)
    for (const id of ['m-1', 'm-2', 'm-3']) {
      await store.machines.upsertMachine({
    assignment: { server: false, agentExecution: true },
        id,
        name: id,
        hostname: `${id}.local`,
        tokenHash: sha256(id),
        ownerUserId: null,
      })
    }

    const listed = await svc.listMachines()

    // Every listing carries the fleet default, and the fleet default is ONE
    // answer for the whole call: resolving it per machine is what put a config
    // read — file, parse, migrate, validate, plus a second read of
    // instance.json — on the wire path for each row.
    expect(listed.length).toBeGreaterThanOrEqual(3)
    expect(listed.every((machine) => machine.updateChannel === 'stable')).toBe(true)
    expect(resolved).toBe(1)
  })
})

describe('retained revocation and explicit replacement', () => {
  async function fixture() {
    const store = await openTestStore(':memory:')
    const codes = new Map<string, PairingGrant>()
    let serial = 0
    const svc = new MachinesService({
      instanceId: 'revocation-test', installationId: 'installation-test', store, hostMachineId: store.hostMachineId,
      pairing: {
        mint: (grant = {}) => { const code = `code-${++serial}`; codes.set(code, { ...grant, installationId: 'installation-test' }); return code },
        peek: (code) => codes.get(code),
        redeem: (code) => { const grant = codes.get(code); codes.delete(code); return grant },
      },
      sessionsChangedForMachine: () => {}, clients: () => [], machinesForPrincipal: async () => [],
    })
    if (!await store.users.get(firstAdminMemberId())) await store.users.create({ id: firstAdminMemberId(), displayName: 'Pairer', role: 'admin', createdAt: new Date().toISOString(), disabledAt: null }, 'hash')
    const frame = { type: 'pair' as const, publicKey: publicKeyWire(mintSigningKeyPair()), machineId: MACHINE, hostname: 'revocation.test' }
    // Explicit stage-1 fixture: replacement moves this old bearer row to a keypair.
    const token = 'stage-1-token'
    await store.machines.upsertMachine({ id: MACHINE, hostname: frame.hostname, name: 'old machine', tokenHash: sha256(token), ownerUserId: firstAdminMemberId() })
    return { svc, store, frame, token, codes }
  }

  test('revoke retains the audit identity, closes connections, cancels queued control and refuses hello', async () => {
    const { svc, store, frame, token } = await fixture()
    try {
      const close = vi.fn()
      svc.registerCredentialConnection(MACHINE, close)
      svc.toMachine(MACHINE, keystroke)
      await svc.revokeMachine(MACHINE, { by: firstAdminMemberId() })
      expect(close).toHaveBeenCalledOnce()
      const row = await store.machines.getMachine(MACHINE)
      expect(row?.revokedAt).toEqual(expect.any(String))
      expect(row?.ownerUserId).toBe(firstAdminMemberId())
      expect(await svc.authenticateDaemon({ type: 'hello', machineId: MACHINE, hostname: frame.hostname, token })).toMatchObject({ ok: false })
      expect(await store.machines.getMachineByToken(MACHINE, token)).toBe(false)
      expect((await svc.listMachines()).find(m => m.id === MACHINE)).toMatchObject({ revokedAt: row?.revokedAt, online: false })
      expect((await store.settingsAudit.list()).some(e => e.command === 'machines.revoke')).toBe(true)
      const replacement = await svc.authenticateDaemon({ ...frame, code: await svc.mintReplacementPairingCode(MACHINE, { ownerUserId: firstAdminMemberId() }) })
      expect(replacement.ok).toBe(true)
      const got: ControlMessage[] = []
      await svc.attach(MACHINE, (message) => got.push(message), [])
      await svc.flushQueued(MACHINE)
      expect(got).not.toContainEqual(keystroke)
      expect(await store.machines.getMachineByToken(MACHINE, token)).toBe(false)
    } finally { await store.close() }
  })

  test('ordinary pairing cannot replace a revoked row; concurrent explicit replacements have one winner', async () => {
    const { svc, store, frame, token, codes } = await fixture()
    try {
      await svc.revokeMachine(MACHINE)
      const ordinary = svc.mintPairingCode({ ownerUserId: firstAdminMemberId() })
      expect(await svc.authenticateDaemon({ ...frame, code: ordinary })).toMatchObject({ ok: false })
      expect(codes.has(ordinary)).toBe(true)
      const replacementCodes = await Promise.all([0, 1].map(() => svc.mintReplacementPairingCode(MACHINE, { ownerUserId: firstAdminMemberId() })))
      const results = await Promise.all(replacementCodes.map(code => svc.authenticateDaemon({ ...frame, code })))
      expect(results.filter(r => r.ok)).toHaveLength(1)
      expect(replacementCodes.filter(code => codes.has(code))).toHaveLength(1)
      const winner = results.find(r => r.ok)
      if (!winner?.ok || !winner.enrolledPublicKey) throw new Error('no replacement credential')
      expect(await store.machines.credentialIncarnation(MACHINE)).toBe(winner.enrolledPublicKey)
      expect(await store.machines.getMachineByToken(MACHINE, token)).toBe(false)
      expect((await store.machines.getMachine(MACHINE))?.revokedAt).toBeNull()
      await svc.revokeMachine(MACHINE)
      const unused = replacementCodes.find(code => codes.has(code))!
      expect(await svc.authenticateDaemon({ ...frame, code: unused })).toMatchObject({ ok: false, reason: 'replacement credential has changed' })
      expect(codes.has(unused)).toBe(true)
    } finally { await store.close() }
  })
})

describe('current daemon recovery projection', () => {
  test('attachment is not readiness, reports reasons, and forgets old connections', async () => {
    const { svc, store } = await storedService()
    const first = recorder()
    const second = recorder()
    try {
      await svc.attach(MACHINE, first.send)
      const row = async () => (await svc.listMachines()).find((m) => m.id === MACHINE)!
      expect((await row()).daemonReadiness).toEqual({ state: 'attached', reason: 'inventory pending', quarantinedBindings: 0 })
      svc.recordDaemonReadiness(MACHINE, { state: 'recovering', reason: '2 quarantined', quarantinedBindings: 2 })
      expect((await row()).daemonReadiness).toEqual({ state: 'recovering', reason: '2 quarantined', quarantinedBindings: 2 })
      // The observation must not withdraw execution from confirmed bindings.
      expect((await row()).availability?.daemon).toBe(true)
      svc.recordDaemonReadiness(MACHINE, { state: 'ready', reason: '', quarantinedBindings: 0 })
      expect((await row()).daemonReadiness?.state).toBe('ready')
      await svc.attach(MACHINE, second.send)
      expect((await row()).daemonReadiness?.state).toBe('attached')
      expect(svc.detach(MACHINE, first.send)).toBe(false)
      expect((await row()).daemonReadiness?.state).toBe('attached')
      svc.detach(MACHINE, second.send)
      svc.recordDaemonReadiness(MACHINE, { state: 'ready', reason: '', quarantinedBindings: 0 })
      expect((await row()).daemonReadiness).toBeUndefined()
      await svc.attach(MACHINE, second.send)
      svc.recordDaemonReadiness(MACHINE, { state: 'ready', reason: '', quarantinedBindings: 0 })
      svc.retireIncarnation(MACHINE)
      expect((await row()).daemonReadiness).toBeUndefined()
    } finally {
      svc.dispose()
      await store.close()
    }
  })
})
