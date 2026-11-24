import { expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({
  Platform: {
    OS: 'ios',
    select: (values: Record<string, unknown>) => values.ios ?? values.default,
  },
  DynamicColorIOS: (dynamic: unknown) => ({ dynamic }),
  PlatformColor: (name: string) => name,
}))
vi.mock('../theme/platform-colors', () => import('../theme/platform-colors.native'))

import { deckColor } from './deck-colors'

type Slots = { light: string; dark: string; highContrastLight: string; highContrastDark: string }
const slots = (ink: string) => (ink as unknown as { dynamic: Slots }).dynamic
function luminance(hex: string) {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return r * 0.2126 + g * 0.7152 + b * 0.0722
}
function contrast(a: string, b: string) {
  const [lo = 0, hi = 0] = [luminance(a), luminance(b)].sort((x, y) => x - y)
  return (hi + 0.05) / (lo + 0.05)
}

it.each([
  'working',
  'needsYou',
  'error',
  'done',
  'proposalText',
] as const)('%s stays readable on light and dark native cards', (key) => {
  const ink = slots(deckColor[key])
  expect(contrast(ink.light, '#ffffff')).toBeGreaterThanOrEqual(4.5)
  expect(contrast(ink.dark, '#1c1c1e')).toBeGreaterThanOrEqual(4.5)
  expect(contrast(ink.highContrastLight, '#f2f2f7')).toBeGreaterThanOrEqual(7)
  expect(contrast(ink.highContrastDark, '#2c2c2e')).toBeGreaterThanOrEqual(7)
})

it('uses neutral grouped paper for light proposal rows', () => {
  expect(slots(deckColor.proposalFill).light).toBe('#ffffff')
  expect(slots(deckColor.proposalFill).highContrastLight).toBe('#ffffff')
})
