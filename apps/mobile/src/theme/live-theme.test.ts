import { expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  Platform: {
    OS: 'ios',
    select: (values: Record<string, unknown>) => values.ios ?? values.default,
  },
  PlatformColor: (name: string) => ({ semantic: [name] }),
  DynamicColorIOS: (dynamic: unknown) => ({ dynamic }),
  Appearance: { getColorScheme: vi.fn(() => 'light') },
}))
vi.mock('react-native', () => native)
vi.mock('./platform-colors', () => import('./platform-colors.native'))

import { alpha } from './mix'
import { color } from './theme'

it('keeps semantic inks and surfaces dynamic even in module-level styles', () => {
  for (const [token, name] of [
    [color.text, 'label'],
    [color.textDim, 'secondaryLabel'],
    [color.bg, 'systemBackground'],
    [color.surface, 'secondarySystemBackground'],
    [color.border, 'separator'],
  ] as const) {
    expect(token).toEqual({ semantic: [name] })
    expect(alpha(token, 0.5)).toBe(token)
  }
  expect(native.Appearance.getColorScheme).not.toHaveBeenCalled()
})

it('preserves both appearances and contrast variants when fading signal text', () => {
  const faded = alpha(color.accentTint, 0.5) as unknown as { dynamic: Record<string, string> }
  expect(Object.keys(faded.dynamic)).toEqual([
    'light',
    'dark',
    'highContrastLight',
    'highContrastDark',
  ])
  expect(faded.dynamic.light).not.toBe(faded.dynamic.dark)
  for (const value of Object.values(faded.dynamic)) expect(value).toMatch(/^rgba\(/)
})
