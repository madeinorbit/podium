import { describe, expect, it } from 'vitest'
import { encode, parseControlMessage, parseDaemonMessage } from './codec'
import { Inventory } from './inventory'

describe('inventory messages (#222)', () => {
  const inventory: Inventory = {
    os: 'linux',
    arch: 'x64',
    agents: [
      {
        kind: 'claude-code',
        installed: true,
        version: '2.1.0',
        path: '/home/u/.local/bin/claude',
        login: { state: 'in', account: 'mike@example.com' },
      },
      { kind: 'codex', installed: false, login: { state: 'out' } },
      { kind: 'grok', installed: false, login: { state: 'out' } },
      { kind: 'opencode', installed: true, version: '0.9.1', path: 'opencode', login: { state: 'unknown' } },
      { kind: 'cursor', installed: false, login: { state: 'unknown' } },
    ],
    // gh presence for #214's credential-propagation form.
    tools: [{ name: 'gh', installed: true, version: 'gh version 2.40.0', path: '/usr/bin/gh' }],
  }

  it('round-trips inventoryReport through the DaemonMessage union', () => {
    const msg = { type: 'inventoryReport' as const, machineId: 'm1', inventory }
    expect(parseDaemonMessage(encode(msg))).toEqual(msg)
  })

  it('round-trips inventoryReport with podiumVersion set (post-#221)', () => {
    const msg = {
      type: 'inventoryReport' as const,
      machineId: 'm1',
      inventory: { ...inventory, podiumVersion: '1.2.3' },
    }
    expect(parseDaemonMessage(encode(msg))).toEqual(msg)
  })

  it('round-trips inventoryRequest through the ControlMessage union', () => {
    const msg = { type: 'inventoryRequest' as const }
    expect(parseControlMessage(encode(msg))).toEqual(msg)
  })

  it('rejects an inventory with an unknown os/arch', () => {
    const bad = { type: 'inventoryReport', machineId: 'm1', inventory: { ...inventory, os: 'win32' } }
    expect(() => parseDaemonMessage(encode(bad as never))).toThrow()
  })

  it('defaults tools to [] for a blob persisted before the field existed (#214 back-compat)', () => {
    const { tools: _omit, ...legacy } = inventory
    expect('tools' in legacy).toBe(false)
    expect(Inventory.parse(legacy).tools).toEqual([])
  })
})
