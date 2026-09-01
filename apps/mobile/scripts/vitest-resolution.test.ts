import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { mobileVitestResolution } from '../vitest-resolution'

describe('mobile Vitest dependency resolution', () => {
  it('resolves every aliased entry inside the isolated mobile graph', () => {
    for (const path of [
      mobileVitestResolution.assetsRegistry,
      mobileVitestResolution.expoFetch,
      mobileVitestResolution.react,
      mobileVitestResolution.reactDom,
      mobileVitestResolution.reactNativeSafeAreaContext,
      mobileVitestResolution.reactNativeSvg,
      mobileVitestResolution.reactNativeWeb,
    ]) {
      expect(existsSync(path), path).toBe(true)
    }
  })

  it('keeps native ESM packages inside Vite for web resolution', () => {
    expect(mobileVitestResolution.inlineDependencies).toEqual([
      'react-native-gesture-handler',
      'react-native-reanimated',
      'react-native-safe-area-context',
      'react-native-worklets',
      'react-native-svg',
    ])
  })
})
