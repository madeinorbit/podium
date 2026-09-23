import { asMachineId, asUserId, firstAdminMemberId } from '@podium/model'
import { wireSchemaDigest } from '@podium/protocol'
import { DaemonMessage } from '@podium/protocol/daemon'
import { describe, expect, it } from 'vitest'
import { DaemonMux } from '../../gateway/daemon-mux'
import type { DaemonFeaturePorts } from '../../gateway/daemon-ports'
import { SessionRegistry } from '../../relay'

import { SessionStore } from '../../store'
import { assignHostMachine } from '../../test-support/host-daemon'
import { openTestStore } from '../../test-support/open-test-store'
import { deriveServerMoveEligibility, deriveVersionState, MachinesService } from './service'

describe('deriveServerMoveEligibility', () => {
  it.each([
    [
      {
        currentServer: true,
        online: true,
        reportedWireSchemaDigest: wireSchemaDigest(),
        deliveryCaps: ['server-move.v1'],
      },
      { eligible: false, reason: 'current-server' },
    ],
    [
      {
        currentServer: false,
        online: false,
        reportedWireSchemaDigest: wireSchemaDigest(),
        deliveryCaps: ['server-move.v1'],
      },
      { eligible: false, reason: 'offline' },
    ],
    [
      {
        currentServer: false,
        online: true,
        reportedWireSchemaDigest: wireSchemaDigest(),
        deliveryCaps: [],
      },
      { eligible: false, reason: 'unsupported' },
    ],
    [
      {
        currentServer: false,
        online: true,
        reportedWireSchemaDigest: 'other',
        deliveryCaps: ['server-move.v1'],
      },
      { eligible: false, reason: 'unsupported' },
    ],
    [
      {
        currentServer: false,
        online: true,
        reportedWireSchemaDigest: wireSchemaDigest(),
        deliveryCaps: ['server-move.v1'],
      },
      { eligible: true },
    ],
  ] as const)('projects eligibility from server-owned facts', (input, expected) => {
    expect(deriveServerMoveEligibility(input)).toEqual(expected)
  })
})

describe('deriveVersionState', () => {
  it('is unreported when the machine has not said', async () => {
    expect(deriveVersionState(null, '0.4.2')).toBe('unreported')
  })

  it('is unreported when this server has no target of its own', async () => {
    expect(deriveVersionState('0.4.2', undefined)).toBe('unreported')
  })

  it('is current on an exact match', async () => {
    expect(deriveVersionState('0.4.2', '0.4.2')).toBe('current')
  })

  it('is behind on any mismatch, without parsing either side as a semver', async () => {
    expect(deriveVersionState('0.4.1', '0.4.2')).toBe('behind')
  })

  it('treats a development identity as a plain label', async () => {
    expect(deriveVersionState('dev+aaa', 'dev+bbb')).toBe('behind')
    expect(deriveVersionState('dev+aaa', 'dev+aaa')).toBe('current')
  })

  it('projects the persisted report and recomputes state when the target moves', async () => {
    const store = await openTestStore(':memory:')
    await store.machines.upsertMachine({
      id: 'm1',
      name: 'box',
      hostname: 'box.local',
      tokenHash: 'token-hash',
      ownerUserId: firstAdminMemberId(),
    })
    await store.machines.setMachineBuild(
      'm1',
      { appVersion: '0.4.2', wireSchemaDigest: 'abc', installKind: 'installed' },
      ['update.delivery.feed'],
      '2026-08-04T00:00:00.000Z',
    )
    let target: string | undefined = '0.4.2'
    const service = new MachinesService({
      instanceId: 'default',
      store,
      hostMachineId: asMachineId('host'),
      channelTarget: () => (target === undefined ? {} : { version: target }),
      clients: () => [],
      machinesForPrincipal: async () => [],
    })

    expect((await service.listMachines())[0]).toMatchObject({
      appVersion: '0.4.2',
      wireSchemaDigest: 'abc',
      installKind: 'installed',
      deliveryCaps: ['update.delivery.feed'],
      versionState: 'current',
    })

    target = '0.4.3'
    expect((await service.listMachines())[0]?.versionState).toBe('behind')
  })

  it('composes the server target into the machine read model', async () => {
    const store = await openTestStore(':memory:')
    // The host row setup enrollment writes; boot no longer provisions it (6fd4f7221).
    await assignHostMachine(store)
    const registry = await SessionRegistry.create(store, undefined, {
      instanceId: 'default',
      targetVersion: () => '0.4.2',
    })
    const machine = (await store.machines.listMachines())[0]
    if (!machine) throw new Error('expected the host machine')

    await registry.modules.machines.setMachineBuild(
      machine.id,
      { appVersion: '0.4.2' },
      [],
      '2026-08-04T00:00:00.000Z',
    )
    await registry.modules.updates.setTarget('stable', {
      version: '0.4.2',
      critical: false,
      artifacts: {},
    } as never)

    expect((await registry.modules.machines.listMachines())[0]?.versionState).toBe('current')
    await registry.dispose()
  })
})

describe('per-machine harness versions', () => {
  it('stores authenticated reports, preserves firstSeen, replaces versions, and derives quiet verification', async () => {
    const store = await openTestStore(':memory:')
    const id = asMachineId('probe-machine')
    await store.machines.upsertMachine({
      id,
      name: 'box',
      hostname: 'box',
      tokenHash: 'token',
      ownerUserId: null,
    })
    await store.machines.upsertMachine({
      id: 'other-machine',
      name: 'other',
      hostname: 'other',
      tokenHash: 'other',
      ownerUserId: null,
    })
    const service = new MachinesService({
      instanceId: 'default',
      store,
      hostMachineId: id,
      clients: () => [],
      machinesForPrincipal: async () => [],
    })
    const mux = new DaemonMux({
      ports: { machines: service } as unknown as DaemonFeaturePorts,
      bus: { emit: () => {} } as never,
    })
    const first = '2026-09-16T10:00:00.000Z'
    const second = '2026-09-16T11:00:00.000Z'
    const third = '2026-09-16T12:00:00.000Z'
    const report = (version: string, probedAt: string) =>
      mux.routeDaemonFrame(
        id,
        DaemonMessage.parse({
          type: 'machineHarnessVersion',
          harness: 'codex',
          version,
          probedAt,
          machineId: 'other-machine', // Payload identity cannot redirect the authenticated observation.
        }),
      )
    try {
      await report('0.154.0', first)
      expect((await store.machines.getMachine(id))?.harnessVersions).toEqual([
        { harness: 'codex', version: '0.154.0', firstSeen: first, lastSeen: first },
      ])
      await report('0.154.0', second)
      expect((await store.machines.getMachine(id))?.harnessVersions).toEqual([
        { harness: 'codex', version: '0.154.0', firstSeen: first, lastSeen: second },
      ])
      await report('0.155.0', third)
      // A delayed cached report cannot replace the newer observation.
      await report('0.154.0', second)
      const row = (await service.listMachines()).find((machine) => machine.id === id)
      expect(row?.harnessVersions).toEqual([
        {
          harness: 'codex',
          version: '0.155.0',
          firstSeen: first,
          lastSeen: third,
          verifiedThrough: '0.151.0',
          unverified: true,
        },
      ])
      expect((await store.machines.getMachine('other-machine'))?.harnessVersions).toEqual([])
      // Reading through a fresh service proves this is durable data, not service memory.
      const fresh = new MachinesService({
        instanceId: 'default',
        store,
        hostMachineId: id,
        clients: () => [],
        machinesForPrincipal: async () => [],
      })
      expect(
        (await fresh.listMachines()).find((machine) => machine.id === id)?.harnessVersions,
      ).toEqual(row?.harnessVersions)
      fresh.dispose()
    } finally {
      service.dispose()
      await store.close()
    }
  })
})
