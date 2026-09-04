import { createContext } from 'react'
import { describe, expect, it, vi } from 'vitest'

// The module under test drags in the real navigator context and safe-area
// hook; both ship Flow-typed sources vitest cannot parse, and the pure rule is
// what these tests exercise.
vi.mock('expo-router/build/react-navigation/bottom-tabs', () => ({
  BottomTabBarHeightContext: createContext<number | undefined>(undefined),
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}))

const { combineBottomInsets } = await import('./useContentBottomInset')

describe('combineBottomInsets', () => {
  it('lets a measured JS tab bar replace the safe-area inset, not stack on it', () => {
    // The custom TabBar pays the home-indicator inset inside its own measured
    // height (76 here = bar + 34 indicator). Summing would pad 110 and leave a
    // dead band above the bar.
    expect(combineBottomInsets(76, 34)).toBe(76)
  })

  it('falls back to the safe area when no JS bar reported a height', () => {
    // iOS NativeTabs: the per-tab SafeAreaProvider's bottom inset already
    // includes the system bar, and it is the only number the JS has.
    expect(combineBottomInsets(undefined, 83)).toBe(83)
  })

  it('is zero when neither chrome nor inset exists (desktop web, pushed on button-nav devices)', () => {
    expect(combineBottomInsets(undefined, 0)).toBe(0)
  })
})
