import {
  type AgentInventory,
  asMachineId,
  type HarnessInstallProgress,
  type Inventory,
} from '@podium/model'
import { CAP_HARNESS_INSTALL_CANCEL } from '@podium/protocol'
import { autorun, observableRef, runInAction } from 'mobx'
import { describe, expect, it } from 'vitest'
import { MachineHarness } from './machine-harness'
import type { MachineModel } from './synced-models'

class Machine {
  readonly id = asMachineId('test-machine')
  online = true
  use = 'granted' as const
  deliveryCaps: string[] | undefined = undefined
  @observableRef accessor inventory: Inventory = { os: 'linux', arch: 'x64', agents: [], tools: [] }
}
function agent(own: boolean, managed: boolean): AgentInventory {
  return {
    kind: 'codex',
    installed: own || managed,
    version: '0.171.0',
    login: { state: 'out' },
    management: { installable: true, homeVariable: 'CODEX_HOME' },
    ...(managed
      ? {
          install: {
            ...(own ? { external: { path: '/personal/codex', version: '0.170.0' } } : {}),
            managed: {
              active: { path: '/state/codex', version: '0.171.0', release: 2 },
              previousVersion: '0.169.0',
              paused: false,
            },
          },
        }
      : {}),
  }
}
function fixture(value: AgentInventory) {
  const machine = new Machine()
  machine.inventory = { ...machine.inventory, agents: [value] }
  return { machine, row: new MachineHarness(machine as unknown as MachineModel, 'codex') }
}
describe('machine harness state', () => {
  it('shows vendor update ownership and offers no Podium update controls', () => {
    const inventory = agent(false, true)
    const managed = inventory.install?.managed
    if (!managed) throw new Error('fixture has no managed install')
    const { row, machine } = fixture(inventory)
    runInAction(() => {
      machine.inventory = {
        ...machine.inventory,
        agents: [
          {
            ...inventory,
            install: {
              managed: { ...managed, vendorUpdated: true, paused: true },
            },
            management: {
              installable: true,
              homeVariable: 'CODEX_HOME',
              updateNotice: 'Vendor owns updates.',
            },
          },
        ],
      }
    })
    expect(row.managedLabel).toBe('0.171.0 · installed by Podium · vendor updates')
    expect(row.updateNotice).toBe('Vendor owns updates.')
    expect(row.actions).toEqual(['back', 'take-settings', 'remove', 'home-info'])
  })
  it('shows the daemon’s vendor update disclosure only for its managed side', () => {
    const own = agent(true, false)
    const { row, machine } = fixture({
      ...own,
      management: { installable: true, updateNotice: 'Vendor updates its own server.' },
    })
    expect(row.updateNotice).toBeUndefined()
    runInAction(() => {
      machine.inventory = {
        ...machine.inventory,
        agents: [
          {
            ...agent(true, true),
            management: {
              installable: true,
              homeVariable: 'CODEX_HOME',
              updateNotice: 'Vendor updates its own server.',
            },
          },
        ],
      }
    })
    expect(row.updateNotice).toBe('Vendor updates its own server.')
  })
  it.each([
    ['not-installed', agent(false, false)],
    ['own', agent(true, false)],
    ['own-too-old', { ...agent(true, false), version: '0.100.0' }],
    ['managed', agent(false, true)],
    ['both', agent(true, true)],
    ['shared', { ...agent(true, true), management: { installable: false } }],
    [
      'installing',
      {
        ...agent(false, true),
        install: { managed: { paused: false, installing: { version: '0.172.0' } } },
      },
    ],
  ] as const)('derives %s from machine inventory', (state, inventory) => {
    const { row } = fixture(inventory)
    expect(row.state).toBe(state)
    if (state === 'shared') expect(row.actions).toEqual(['remove'])
    if (state === 'installing') expect(row.actions).toEqual([])
  })
  it('keeps the same row live across inventory reports and changes pause into resume', () => {
    const { row, machine } = fixture(agent(true, false))
    const seen: string[] = []
    const stop = autorun(() => seen.push(row.state))
    try {
      runInAction(() => {
        machine.inventory = { ...machine.inventory, agents: [agent(true, true)] }
      })
      expect(seen).toEqual(['own', 'both'])
      expect(row.actions).toContain('pause')
      runInAction(() => {
        machine.inventory = {
          ...machine.inventory,
          agents: [{ ...agent(true, true), install: { managed: { paused: true } } }],
        }
      })
      expect(row.actions).toContain('resume')
    } finally {
      stop()
    }
  })

  describe('install progress, cancel and retry (POD-7471)', () => {
    const installing = (progress?: HarnessInstallProgress): AgentInventory => ({
      ...agent(false, false),
      install: {
        managed: {
          paused: false,
          installing: { version: '0.172.0', ...(progress ? { progress } : {}) },
        },
      },
    })

    it('shows no progress for a machine that reports none', () => {
      const { row } = fixture(installing())
      expect(row.state).toBe('installing')
      expect(row.progress).toBeUndefined()
      expect(row.managedLabel).toBe('Installing 0.172.0…')
    })

    it.each([
      [
        { phase: 'download', receivedBytes: 512, totalBytes: 4096 },
        { phase: 'download', receivedBytes: 512, totalBytes: 4096, percent: 12 },
      ],
      [
        { phase: 'download', receivedBytes: 512 },
        { phase: 'download', receivedBytes: 512 },
      ],
      [{ phase: 'download' }, { phase: 'download' }],
      [{ phase: 'verify' }, { phase: 'verify' }],
      [{ phase: 'setup' }, { phase: 'setup' }],
    ] as const)('reads progress %o as %o', (reported, expected) => {
      expect(fixture(installing(reported)).row.progress).toEqual(expected)
    })

    it('never reads past 100 percent when the body outgrows the named size', () => {
      const { row } = fixture(
        installing({ phase: 'download', receivedBytes: 5000, totalBytes: 4096 }),
      )
      expect(row.progress?.percent).toBe(100)
    })

    it('follows progress across reports', () => {
      const { row, machine } = fixture(
        installing({ phase: 'download', receivedBytes: 0, totalBytes: 100 }),
      )
      const seen: (number | string | undefined)[] = []
      const stop = autorun(() => seen.push(row.progress?.percent ?? row.progress?.phase))
      try {
        runInAction(() => {
          machine.inventory = {
            ...machine.inventory,
            agents: [installing({ phase: 'download', receivedBytes: 50, totalBytes: 100 })],
          }
        })
        runInAction(() => {
          machine.inventory = { ...machine.inventory, agents: [installing({ phase: 'verify' })] }
        })
        runInAction(() => {
          machine.inventory = { ...machine.inventory, agents: [agent(false, true)] }
        })
      } finally {
        stop()
      }
      expect(seen).toEqual([0, 50, 'verify', undefined])
    })

    it('offers the cancel while installing only on a machine that supports it', () => {
      const old = fixture(installing({ phase: 'download' }))
      expect(old.row.canCancel).toBe(false)
      expect(old.row.actions).toEqual([])

      const current = fixture(installing({ phase: 'download' }))
      current.machine.deliveryCaps = [CAP_HARNESS_INSTALL_CANCEL]
      expect(current.row.canCancel).toBe(true)
      expect(current.row.actions).toEqual(['cancel-install'])
      expect(current.row.actionLabel('cancel-install')).toBe('Cancel install')
      // The other actions stay closed until the install ends.
      expect(current.row.canAct).toBe(false)
    })

    it('offers Try again after a failed first install, with the error as a getter', () => {
      const lastError = {
        at: '2026-11-23T10:00:00.000Z',
        message: 'codex 0.172.0 does not run (exit): exited 3',
        version: '0.172.0',
      }
      const { row } = fixture({
        ...agent(false, false),
        install: { managed: { paused: false, lastError } },
      })
      expect(row.state).toBe('managed')
      expect(row.managedLabel).toBe('No usable release · managed by Podium')
      expect(row.lastError).toEqual(lastError)
      expect(row.actions[0]).toBe('install')
      expect(row.actions).toContain('remove')
      expect(row.actionLabel('install')).toBe('Try again')
    })

    it('offers no install on a working release and has no error to show', () => {
      const { row } = fixture(agent(false, true))
      expect(row.actions).not.toContain('install')
      expect(row.lastError).toBeUndefined()
    })
  })
})
