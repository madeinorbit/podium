import { type AgentInventory, asMachineId, type Inventory } from '@podium/model'
import { autorun, observableRef, runInAction } from 'mobx'
import { describe, expect, it } from 'vitest'
import { MachineHarness } from './machine-harness'
import type { MachineModel } from './synced-models'

class Machine {
  readonly id = asMachineId('test-machine')
  online = true
  use = 'granted' as const
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
  it('shows the daemon’s vendor update disclosure only for its managed side', () => {
    const own = agent(true, false)
    const { row, machine } = fixture({
      ...own,
      management: { ...own.management!, updateNotice: 'Vendor updates its own server.' },
    })
    expect(row.updateNotice).toBeUndefined()
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
})
