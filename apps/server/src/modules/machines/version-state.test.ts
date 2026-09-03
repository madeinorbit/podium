import { asUserId, asMachineId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { SessionRegistry } from '../../relay'
import { deriveVersionState, MachinesService } from './service'
import { openTestStore } from '../../test-support/open-test-store'

describe('deriveVersionState', () => {
  it('is unreported when the machine has not said', () => {
    expect(deriveVersionState(null, '0.4.2')).toBe('unreported')
  })

  it('is unreported when this server has no target of its own', () => {
    expect(deriveVersionState('0.4.2', undefined)).toBe('unreported')
  })

  it('is current on an exact match', () => {
    expect(deriveVersionState('0.4.2', '0.4.2')).toBe('current')
  })

  it('is behind on any mismatch, without parsing either side as a semver', () => {
    expect(deriveVersionState('0.4.1', '0.4.2')).toBe('behind')
  })

  it('treats a development identity as a plain label', () => {
    expect(deriveVersionState('dev+aaa', 'dev+bbb')).toBe('behind')
    expect(deriveVersionState('dev+aaa', 'dev+aaa')).toBe('current')
  })

  it('projects the persisted report and recomputes state when the target moves', () => {
    const store = openTestStore(':memory:')
    store.machines.upsertMachine({
      id: 'm1',
      name: 'box',
      hostname: 'box.local',
      tokenHash: 'token-hash',
      ownerUserId: asUserId('user:sole'),
    })
    store.machines.setMachineBuild(
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
      targetVersion: () => target,
      clients: () => [],
      machinesForPrincipal: () => [],
    })

    expect(service.listMachines()[0]).toMatchObject({
      appVersion: '0.4.2',
      wireSchemaDigest: 'abc',
      installKind: 'installed',
      deliveryCaps: ['update.delivery.feed'],
      versionState: 'current',
    })

    target = '0.4.3'
    expect(service.listMachines()[0]?.versionState).toBe('behind')
  })

  it('composes the server target into the machine read model', () => {
    const store = openTestStore(':memory:')
    const registry = SessionRegistry.create(store, undefined, {
      instanceId: 'default',
      targetVersion: () => '0.4.2',
    })
    const machine = store.machines.listMachines()[0]
    if (!machine) throw new Error('expected the registry host machine')

    registry.modules.machines.setMachineBuild(
      machine.id,
      { appVersion: '0.4.2' },
      [],
      '2026-08-04T00:00:00.000Z',
    )
    registry.modules.updates.setTarget('stable', {
      version: '0.4.2',
      critical: false,
      artifacts: {},
    } as never)

    expect(registry.modules.machines.listMachines()[0]?.versionState).toBe('current')
    registry.dispose()
  })
})
