import { describe, expect, it } from 'vitest'
import { driverContextFor, Inventory } from './machine'

const base = { os: 'linux', arch: 'x64', agents: [] }
const driver = { harness: 'codex', id: 'generic-pty', family: 'terminal' }
const terminalContext = {
  capability: { summary: 'passive', detail: 'on-demand' },
  availability: {
    status: 'unavailable',
    reason: { code: 'not-probed', message: 'No native transport' },
  },
}
const declinedContext = {
  availability: {
    status: 'unsupported',
    reason: { code: 'unsupported-implementation', message: 'No context channel' },
  },
}

describe('runtime driver context compatibility', () => {
  it('reads inventories predating drivers and driver capabilities', () => {
    expect(Inventory.parse(base).runtimeDrivers).toBeUndefined()
    expect(Inventory.parse(base).driverCapabilities).toBeUndefined()
    expect(driverContextFor(Inventory.parse(base).driverCapabilities, 'generic-pty', 'codex')).toBe(
      undefined,
    )
    expect(Inventory.parse({ ...base, runtimeDrivers: [driver] }).runtimeDrivers).toEqual([driver])
  })

  it('nests the single normalized capability and availability by driver, then harness', () => {
    const driverCapabilities = {
      'generic-pty': { context: { codex: terminalContext, cursor: declinedContext } },
      headless: {
        context: { codex: { ...terminalContext, availability: { status: 'available' } } },
      },
    }
    const inventory = Inventory.parse({ ...base, runtimeDrivers: [driver], driverCapabilities })
    expect(inventory.driverCapabilities).toEqual(driverCapabilities)
    expect(inventory.runtimeDrivers).toEqual([driver])
    // Two harnesses on one shared driver id keep their own entries.
    expect(driverContextFor(inventory.driverCapabilities, 'generic-pty', 'codex')).toEqual(
      terminalContext,
    )
    expect(driverContextFor(inventory.driverCapabilities, 'generic-pty', 'cursor')).toEqual(
      declinedContext,
    )
    expect(
      driverContextFor(inventory.driverCapabilities, 'headless', 'codex')?.availability,
    ).toEqual({ status: 'available' })
    expect(driverContextFor(inventory.driverCapabilities, 'headless', 'cursor')).toBeUndefined()
    expect(driverContextFor(inventory.driverCapabilities, 'codex-app-server', 'codex')).toBe(
      undefined,
    )
    expect(
      Inventory.safeParse({
        ...base,
        driverCapabilities: {
          'generic-pty': {
            context: {
              codex: {
                ...terminalContext,
                capability: { summary: 'invented', detail: 'on-demand' },
              },
            },
          },
        },
      }).success,
    ).toBe(false)
  })

  it('accepts a future nonempty harness and driver through the same open keys', () => {
    const context = {
      capability: { summary: 'passive', detail: 'on-demand' },
      availability: { status: 'available' },
    }
    const inventory = Inventory.parse({
      ...base,
      runtimeDrivers: [driver],
      driverCapabilities: {
        'future-context-driver': { context: { 'future-context-harness': context } },
      },
    })
    expect(
      driverContextFor(
        inventory.driverCapabilities,
        'future-context-driver',
        'future-context-harness',
      ),
    ).toEqual(context)
    expect(inventory.runtimeDrivers).toEqual([driver])
    expect(
      Inventory.safeParse({
        ...base,
        driverCapabilities: { 'future-context-driver': { context: { '': context } } },
      }).success,
    ).toBe(false)
    expect(
      Inventory.safeParse({
        ...base,
        driverCapabilities: { '': { context: { 'future-context-harness': context } } },
      }).success,
    ).toBe(false)
  })

  it('never resolves a lookup through an inherited member', () => {
    const inventory = Inventory.parse({
      ...base,
      driverCapabilities: { 'generic-pty': { context: { codex: terminalContext } } },
    })
    expect(driverContextFor(inventory.driverCapabilities, 'constructor', 'codex')).toBeUndefined()
    expect(driverContextFor(inventory.driverCapabilities, 'generic-pty', 'toString')).toBe(
      undefined,
    )
    expect(driverContextFor(inventory.driverCapabilities, undefined, 'codex')).toBeUndefined()
    expect(driverContextFor(inventory.driverCapabilities, 'generic-pty', undefined)).toBe(undefined)
  })
})
