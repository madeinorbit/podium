import { describe, expect, it } from 'vitest'
import { leading, spring, tracking } from './theme'

describe('native iOS feel tokens', () => {
  it('uses the non-linear iOS leading table for UI text', () => {
    const sizes = [34, 28, 22, 20, 17, 16, 15, 13, 12, 11] as const
    expect(sizes.map((size) => leading(size))).toEqual([41, 34, 28, 25, 22, 21, 20, 18, 16, 13])
  })

  it('keeps the intentionally roomier prose leading', () => {
    expect(leading(17, 'prose')).toBe(25)
    expect(leading(15, 'prose')).toBe(22)
  })

  it('tracks tightly at text sizes and loosely at display sizes', () => {
    expect(tracking[12]).toBe(0)
    expect(tracking[17]).toBeLessThan(0)
    expect(tracking[28]).toBeGreaterThan(0)
  })

  it('publishes physical spring constants instead of legacy tuning knobs', () => {
    expect(spring.smooth).toEqual({ stiffness: 158, damping: 25, mass: 1 })
    expect(spring.snappy).toEqual({ stiffness: 158, damping: 21.4, mass: 1 })
    expect(spring.press).toEqual({ stiffness: 322, damping: 36, mass: 1 })
  })
})
