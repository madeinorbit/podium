import { describe, expect, it } from 'vitest'
import { Inventory } from './machine'

const base = { os: 'linux', arch: 'x64', agents: [] }
const driver = { harness: 'codex', id: 'generic-pty', family: 'terminal' }

describe('runtime driver context compatibility', () => {
  it('reads inventories predating drivers and context support', () => {
    expect(Inventory.parse(base).runtimeDrivers).toBeUndefined()
    expect(Inventory.parse(base).contextCapabilities).toBeUndefined()
    expect(Inventory.parse({ ...base, runtimeDrivers: [driver] }).runtimeDrivers).toEqual([driver])
  })
  it('retains the single normalized capability and native availability contracts', () => {
    const context = {
      harness: 'codex',
      driverId: 'generic-pty',
      capability: { summary: 'passive', detail: 'on-demand' },
      availability: {
        status: 'unavailable',
        reason: { code: 'not-probed', message: 'No native transport' },
      },
    }
    expect(
      Inventory.parse({ ...base, runtimeDrivers: [driver], contextCapabilities: [context] })
        .contextCapabilities?.[0],
    ).toEqual(context)
    expect(
      Inventory.safeParse({
        ...base,
        contextCapabilities: [
          { ...context, capability: { summary: 'invented', detail: 'on-demand' } },
        ],
      }).success,
    ).toBe(false)
  })

  it('accepts a future nonempty harness only in the new open context identity field', () => {
    const context = {
      harness: 'future-context-harness',
      driverId: 'future-context-driver',
      capability: { summary: 'passive', detail: 'on-demand' },
      availability: { status: 'available' },
    }
    const inventory = Inventory.parse({
      ...base,
      runtimeDrivers: [driver],
      contextCapabilities: [context],
    })
    expect(inventory.contextCapabilities?.[0]).toEqual(context)
    expect(inventory.runtimeDrivers).toEqual([driver])
    expect(
      Inventory.safeParse({ ...base, contextCapabilities: [{ ...context, harness: '' }] }).success,
    ).toBe(false)
  })
})
