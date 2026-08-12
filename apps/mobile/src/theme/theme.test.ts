import { ISSUE_COLOR_HEX } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { FLOW_HEX, flow } from './issueColors'
import { color, leading, spring, tracking } from './theme'

/** Relative luminance, good enough to order two surfaces on the same ramp. */
function luma(hex: string): number {
  const n = Number.parseInt(hex.replace('#', ''), 16)
  return 0.2126 * ((n >> 16) & 0xff) + 0.7152 * ((n >> 8) & 0xff) + 0.0722 * (n & 0xff)
}

const TINTS = [FLOW_HEX, ...Object.values(ISSUE_COLOR_HEX)]

describe('Dark Ink surface ramp', () => {
  it('steps up from the ground — nothing is darker than the app background', () => {
    const ground = luma(color.bg)
    for (const tier of [color.engraved, color.bar, color.rail, color.surface, color.elevated]) {
      expect(luma(tier)).toBeGreaterThan(ground)
    }
  })

  /**
   * The trap POD-748 named and POD-784 walked into: a mix always walks toward a
   * lighter colour, so a tint on the surface UNDER the cards can carry it past
   * the card tier and the cards vanish. Dark Ink leaves ~10 L-points for eight
   * tiers, so every issue colour has to be checked, not just the neutral flow.
   *
   * Merely ORDERING the two is not the assertion — at the handoff's 10% the
   * pane landed 1.8 luma under the card, which is the correct side of the line
   * and still invisible. Each surface is held to the tier it belongs under.
   */
  it('keeps the pane under the cards it carries, with the gap still visible', () => {
    for (const tint of TINTS) {
      // The pane is ground: it may not climb past the icon-rail tier.
      expect(luma(flow.paneBg(tint))).toBeLessThan(luma(color.rail))
      // Its chrome bar may reach the tab-strip tier but not the sheet.
      expect(luma(flow.paneHeaderBg(tint))).toBeLessThan(luma(color.card) - 3)
    }
  })

  it('keeps a tinted header bar within the raised-surface tiers', () => {
    for (const tint of TINTS) {
      expect(luma(flow.headerBg(tint))).toBeGreaterThan(luma(color.card))
      expect(luma(flow.headerBg(tint))).toBeLessThan(luma(color.borderStrong))
    }
  })
})

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
