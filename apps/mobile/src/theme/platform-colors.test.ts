import { ISSUE_COLOR_HEX } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  Platform: { OS: 'ios' },
  DynamicColorIOS: vi.fn((dynamic) => ({ dynamic })),
  PlatformColor: vi.fn((name) => name),
}))
vi.mock('react-native', () => native)
vi.mock('./platform-colors', () => import('./platform-colors.native'))

import { FLOW_HEX, flow } from './issueColors'
import { adaptiveColor, fadeDynamicColor } from './platform-colors.native'
import { STAGE_COLOR } from './stage'
import { proseColor, syntaxColor, syntaxPalette, syntaxScopeToken } from './syntax'
import { color } from './theme'

type Slots = { light: string; dark: string; highContrastLight: string; highContrastDark: string }
const slots = (value: string) => (value as unknown as { dynamic: Slots }).dynamic
function luminance(hex: string) {
  const channels = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722
}
function contrast(a: string, b: string) {
  const [lo, hi] = [luminance(a), luminance(b)].sort((x, y) => x - y)
  return (hi! + 0.05) / (lo! + 0.05)
}
const inks = {
  ...Object.fromEntries(
    Object.entries(syntaxScopeToken)
      .filter(([, t]) => t)
      .map(([s]) => [s, syntaxColor(s)]),
  ),
  inline: proseColor('code-inline'),
  ...Object.fromEntries(
    ['accentTint', 'needsYouText', 'workingText', 'successText', 'dangerText', 'claudeText'].map(
      (k) => [k, color[k as keyof typeof color] as string],
    ),
  ),
  ...Object.fromEntries(Object.entries(STAGE_COLOR).filter(([, v]) => typeof v === 'object')),
}

describe('native Increase Contrast values (no device verification)', () => {
  it('forwards all four required slots to DynamicColorIOS', () => {
    const values = ['#123456', '#abcdef', '#012345', '#fedcba'] as const
    expect(slots(adaptiveColor(...values))).toEqual({
      light: values[0],
      dark: values[1],
      highContrastLight: values[2],
      highContrastDark: values[3],
    })
    expect(native.DynamicColorIOS).toHaveBeenLastCalledWith(slots(adaptiveColor(...values)))
  })
  it.each(Object.entries(inks))('%s strengthens both inks and clears 7:1', (_name, value) => {
    const s = slots(value)
    for (const [normal, high, grounds] of [
      [s.light, s.highContrastLight, ['#e5e5ea', '#f0efe9', '#f2f1ed', '#ffffff']],
      [s.dark, s.highContrastDark, ['#2c2c2e', '#23262d', '#1e2024', '#16171a', '#0e0e12']],
    ] as const) {
      expect(high).not.toBe(normal)
      for (const bg of grounds) {
        expect(contrast(high, bg)).toBeGreaterThanOrEqual(7)
        expect(contrast(high, bg)).toBeGreaterThan(contrast(normal, bg))
      }
    }
  })
  it('also measures the exported fallback syntax ink', () => {
    for (const [ink, ground] of [
      [syntaxPalette.highContrastLight.ink, '#e5e5ea'],
      [syntaxPalette.highContrastDark.ink, '#2c2c2e'],
    ])
      expect(contrast(ink!, ground!)).toBeGreaterThanOrEqual(7)
  })
  it.each([
    FLOW_HEX,
    ...Object.values(ISSUE_COLOR_HEX),
  ])('keeps flow inks readable on every flow ground for %s', (tint) => {
    const grounds = [
      flow.paneBg,
      flow.headerBg,
      flow.paneHeaderBg,
      flow.rowBg,
      flow.rowSelectedBg,
      flow.rowActiveBg,
    ].map((f) => slots(f(tint)))
    const text = [flow.text, flow.body, flow.muted].map((f) => slots(f(tint)))
    for (const s of [...grounds, ...text]) {
      expect(s.highContrastLight).not.toBe(s.light)
      expect(s.highContrastDark).not.toBe(s.dark)
    }
    for (const ink of text)
      for (const bg of grounds)
        for (const mode of ['highContrastLight', 'highContrastDark'] as const)
          expect(contrast(ink[mode], bg[mode])).toBeGreaterThanOrEqual(7)
  })
  it('preserves accessibility slots through fading', () => {
    const value = adaptiveColor('#123456', '#abcdef', '#012345', '#fedcba')
    const fade = (c: string) => `${c}80`
    expect(slots(fadeDynamicColor(value, 0.5, fade)!)).toEqual(
      Object.fromEntries(Object.entries(slots(value)).map(([k, v]) => [k, fade(v)])),
    )
  })
  it('keeps the native non-iOS fallback dark', () => {
    native.Platform.OS = 'android'
    try {
      expect(adaptiveColor('#123456', '#abcdef', '#012345', '#fedcba')).toBe('#abcdef')
    } finally {
      native.Platform.OS = 'ios'
    }
  })
})
