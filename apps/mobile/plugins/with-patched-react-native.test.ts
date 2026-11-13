import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import plugin from './with-patched-react-native.js'

const { usePatchedReactNative } = plugin as unknown as {
  usePatchedReactNative: (podfile: string) => string
}

describe('patched React Native iOS build', () => {
  it('forces source compilation before pod preparation, even with prebuilt environment overrides', () => {
    const require = createRequire(import.meta.url)
    const expo = dirname(require.resolve('expo/package.json'))
    const template = execFileSync(
      'tar',
      ['-xOf', join(expo, 'template.tgz'), 'package/ios/Podfile'],
      {
        encoding: 'utf8',
      },
    )
    const podfile = usePatchedReactNative(template)
    const preparation = podfile.indexOf('prepare_react_native_project!')
    for (const key of ['RCT_USE_PREBUILT_RNCORE', 'RCT_USE_RN_DEP']) {
      const sourceOverride = podfile.indexOf(`ENV['${key}'] = '0'`)
      expect(sourceOverride).toBeGreaterThan(podfile.indexOf(`ENV['${key}'] ||=`))
      expect(sourceOverride).toBeLessThan(preparation)
    }
    expect(usePatchedReactNative(podfile)).toBe(podfile)
  })

  it('refuses an unrecognized Podfile instead of shipping unpatched React core', () => {
    expect(() => usePatchedReactNative('target "Podium" do\nend')).toThrow(/preparation anchor/)
  })

  it('registers the source-build plugin in the shipped app config', () => {
    const config = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../app.json'), 'utf8'),
    )
    expect(config.expo.plugins).toContain('./plugins/with-patched-react-native')
  })
})
