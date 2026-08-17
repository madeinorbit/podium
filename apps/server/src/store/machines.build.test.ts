import { asUserId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { SessionStore } from '../store'

const openTestStore = () => new SessionStore(':memory:')

function seedMachine(store: SessionStore): void {
  store.machines.upsertMachine({
    id: 'm1',
    name: 'box',
    hostname: 'box.local',
    tokenHash: 'token-hash',
    ownerUserId: asUserId('user:sole'),
  })
}

describe('machine build report', () => {
  it('reads as unreported for a machine that never sent one', () => {
    const store = openTestStore()
    seedMachine(store)
    const m = store.machines.getMachine('m1')
    expect(m?.appVersion).toBeNull()
    expect(m?.installKind).toBeNull()
    expect(m?.deliveryCaps).toEqual([])
    store.close()
  })

  it('records a reported build', () => {
    const store = openTestStore()
    seedMachine(store)
    store.machines.setMachineBuild(
      'm1',
      { appVersion: '0.4.2', wireSchemaDigest: 'abc', installKind: 'installed' },
      ['update.delivery.feed', 'update.delivery.bundle'],
      '2026-08-04T00:00:00.000Z',
    )
    const m = store.machines.getMachine('m1')
    expect(m?.appVersion).toBe('0.4.2')
    expect(m?.wireSchemaDigest).toBe('abc')
    expect(m?.installKind).toBe('installed')
    expect(m?.deliveryCaps).toEqual(['update.delivery.feed', 'update.delivery.bundle'])
    store.close()
  })

  it('overwrites a previous report on reconnect', () => {
    const store = openTestStore()
    seedMachine(store)
    store.machines.setMachineBuild('m1', { appVersion: '0.4.1' }, [], '2026-08-04T00:00:00.000Z')
    store.machines.setMachineBuild('m1', { appVersion: '0.4.2' }, [], '2026-08-04T01:00:00.000Z')
    expect(store.machines.getMachine('m1')?.appVersion).toBe('0.4.2')
    store.close()
  })

  it('records a partial report from an older daemon', () => {
    const store = openTestStore()
    seedMachine(store)
    store.machines.setMachineBuild('m1', { appVersion: '0.4.2' }, [], '2026-08-04T00:00:00.000Z')
    const m = store.machines.getMachine('m1')
    expect(m?.appVersion).toBe('0.4.2')
    expect(m?.installKind).toBeNull()
    store.close()
  })

  /** POD-2099: the flag the wave planner refuses on has to survive the row. */
  describe('desktop supervision', () => {
    it('is false for a machine that never reported and for one that reported without it', () => {
      const store = openTestStore()
      seedMachine(store)
      expect(store.machines.getMachine('m1')?.supervised).toBe(false)
      store.machines.setMachineBuild(
        'm1',
        { appVersion: '0.4.2', installKind: 'installed' },
        ['update.delivery.feed'],
        '2026-08-04T00:00:00.000Z',
      )
      expect(store.machines.getMachine('m1')?.supervised).toBe(false)
      store.close()
    })

    it('records a daemon that reports a desktop shell owns it', () => {
      const store = openTestStore()
      seedMachine(store)
      store.machines.setMachineBuild(
        'm1',
        { appVersion: '0.4.2', installKind: 'installed', supervised: true },
        [],
        '2026-08-04T00:00:00.000Z',
      )
      expect(store.machines.getMachine('m1')?.supervised).toBe(true)
      store.close()
    })

    it('clears when a standalone daemon takes the machine over', () => {
      // The desktop app is uninstalled and a standalone daemon paired in its
      // place: the row must stop excluding it, or that machine never updates
      // again and nothing says why.
      const store = openTestStore()
      seedMachine(store)
      store.machines.setMachineBuild(
        'm1',
        { appVersion: '0.4.2', supervised: true },
        [],
        '2026-08-04T00:00:00.000Z',
      )
      store.machines.setMachineBuild(
        'm1',
        { appVersion: '0.4.2', installKind: 'installed' },
        ['update.delivery.feed'],
        '2026-08-04T01:00:00.000Z',
      )
      expect(store.machines.getMachine('m1')?.supervised).toBe(false)
      store.close()
    })
  })
})
