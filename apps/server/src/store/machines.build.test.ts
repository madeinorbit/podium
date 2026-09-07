import { asUserId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { SessionStore } from '../store'
import { openTestStore } from '../test-support/open-test-store'

async function seedMachine(store: SessionStore): Promise<void> {
  await store.machines.upsertMachine({
    id: 'm1',
    name: 'box',
    hostname: 'box.local',
    tokenHash: 'token-hash',
    ownerUserId: asUserId('user:sole'),
  })
}

describe('machine build report', () => {
  it('reads as unreported for a machine that never sent one', async () => {
    const store = await openTestStore()
    await seedMachine(store)
    const m = await store.machines.getMachine('m1')
    expect(m?.appVersion).toBeNull()
    expect(m?.installKind).toBeNull()
    expect(m?.deliveryCaps).toEqual([])
    await store.close()
  })

  it('records a reported build', async () => {
    const store = await openTestStore()
    await seedMachine(store)
    await store.machines.setMachineBuild(
      'm1',
      { appVersion: '0.4.2', wireSchemaDigest: 'abc', installKind: 'installed' },
      ['update.delivery.feed', 'podium.shipping-train'],
      '2026-08-04T00:00:00.000Z',
    )
    const m = await store.machines.getMachine('m1')
    expect(m?.appVersion).toBe('0.4.2')
    expect(m?.wireSchemaDigest).toBe('abc')
    expect(m?.installKind).toBe('installed')
    expect(m?.deliveryCaps).toEqual(['update.delivery.feed', 'podium.shipping-train'])
    await store.close()
  })

  it('overwrites a previous report on reconnect', async () => {
    const store = await openTestStore()
    await seedMachine(store)
    await store.machines.setMachineBuild(
      'm1',
      { appVersion: '0.4.1' },
      [],
      '2026-08-04T00:00:00.000Z',
    )
    await store.machines.setMachineBuild(
      'm1',
      { appVersion: '0.4.2' },
      [],
      '2026-08-04T01:00:00.000Z',
    )
    expect((await store.machines.getMachine('m1'))?.appVersion).toBe('0.4.2')
    await store.close()
  })

  it('records a partial report from an older daemon', async () => {
    const store = await openTestStore()
    await seedMachine(store)
    await store.machines.setMachineBuild(
      'm1',
      { appVersion: '0.4.2' },
      [],
      '2026-08-04T00:00:00.000Z',
    )
    const m = await store.machines.getMachine('m1')
    expect(m?.appVersion).toBe('0.4.2')
    expect(m?.installKind).toBeNull()
    await store.close()
  })

  describe('supervisor-owned presence', () => {
    it('starts with the enrollment assignment and no presence source', async () => {
      const store = await openTestStore()
      await seedMachine(store)
      expect(await store.machines.getMachine('m1')).toMatchObject({
        presenceSource: null,
        serviceAssignment: { server: false, agentExecution: true },
        serviceReport: null,
      })
      await store.close()
    })

    it('atomically records supervisor build, caps, services, and last seen', async () => {
      const store = await openTestStore()
      await seedMachine(store)
      const observedAt = '2026-08-04T00:00:00.000Z'
      await store.machines.setSupervisorPresence(
        'm1',
        { appVersion: '0.4.2', installKind: 'installed' },
        [],
        {
          server: { policy: 'disabled', state: 'stopped', observedAt },
          agentExecution: {
            policy: 'enabled',
            state: 'refused',
            reason: 'refused by local policy',
            observedAt,
          },
          agentExecutionLockout: true,
          crashOwner: 'desktop',
        },
        observedAt,
      )
      expect(await store.machines.getMachine('m1')).toMatchObject({
        appVersion: '0.4.2',
        deliveryCaps: [],
        presenceSource: 'supervisor',
        lastSeenAt: observedAt,
        serviceReport: {
          agentExecutionLockout: true,
          crashOwner: 'desktop',
          agentExecution: { state: 'refused', reason: 'refused by local policy' },
        },
      })
      await store.close()
    })
  })
})
