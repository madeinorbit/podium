import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { mobileVitestResolution } from '../vitest-resolution'

describe('mobile Vitest dependency resolution', () => {
  it('resolves every aliased entry inside the isolated mobile graph', () => {
    for (const path of [
      mobileVitestResolution.assetsRegistry,
      mobileVitestResolution.expoFetch,
      mobileVitestResolution.expoModulesCore,
      mobileVitestResolution.mobxReactLite,
      mobileVitestResolution.react,
      mobileVitestResolution.reactDom,
      mobileVitestResolution.reactNativeSafeAreaContext,
      mobileVitestResolution.reactNativeSvg,
      mobileVitestResolution.reactNativeWeb,
    ]) {
      expect(existsSync(path), path).toBe(true)
    }
  })

  it('loads Expo haptics through the app-declared modules-core dependency', async () => {
    const haptics = await import('expo-haptics')
    expect(haptics.ImpactFeedbackStyle.Light).toBe('light')
  })

  it('loads navigation leaf exports without the native CJS barrel', async () => {
    const { getFocusedRouteNameFromRoute, HeaderHeightContext } = await import(
      'expo-router/react-navigation'
    )
    expect(
      getFocusedRouteNameFromRoute({
        key: 'tabs',
        name: '(tabs)',
        state: { routes: [{ key: 'work', name: 'work' }], index: 0 },
      }),
    ).toBe('work')
    expect(HeaderHeightContext).toBeDefined()
  })

  it('keeps observers and native ESM inside Vite for the mobile React dispatcher', () => {
    expect(mobileVitestResolution.inlineDependencies).toEqual([
      'mobx-react-lite',
      'react-native-gesture-handler',
      'react-native-reanimated',
      'react-native-safe-area-context',
      'react-native-worklets',
      'react-native-svg',
    ])
  })
})
