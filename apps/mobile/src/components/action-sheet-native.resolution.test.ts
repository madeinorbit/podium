import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const componentDir = dirname(fileURLToPath(import.meta.url))
const expoRequire = createRequire(require.resolve('expo/metro-config'))
const { resolve } = expoRequire('@expo/metro/metro-resolver') as {
  resolve: (
    context: Record<string, unknown>,
    moduleName: string,
    platform: string,
  ) => { type: string; filePath: string }
}
const { resolver } = require('../../metro.config.js')

// Use Metro and the app's actual sourceExts. Vitest's web extension order
// cannot catch a .ts fallback shadowing an .ios.tsx entry.
function resolvePicker(platform: string) {
  return resolve(
    {
      ...resolver,
      resolveRequest: resolve,
      assetExts: new Set(resolver.assetExts),
      originModulePath: join(componentDir, 'LaunchConfigurationFields.tsx'),
      preferNativePlatform: true,
      getPackageForModule: () => null,
      doesFileExist: existsSync,
      fileSystemLookup: (path: string) =>
        existsSync(path)
          ? {
              exists: true,
              type: statSync(path).isDirectory() ? 'd' : 'f',
              realPath: realpathSync(path),
            }
          : { exists: false },
    },
    './action-sheet-native',
    platform,
  )
}

describe('native picker Metro resolution', () => {
  it('resolves iOS to the SwiftUI NativePicker with the real ts-before-tsx order', () => {
    expect(resolver.sourceExts.indexOf('ts')).toBeLessThan(resolver.sourceExts.indexOf('tsx'))
    const result = resolvePicker('ios')
    expect(result).toEqual({
      type: 'sourceFile',
      filePath: join(componentDir, 'action-sheet-native.ios.tsx'),
    })
    expect(readFileSync(result.filePath, 'utf8')).toContain('export function NativePicker')
    expect(readFileSync(result.filePath, 'utf8')).toContain('@expo/ui/swift-ui')
  })

  it.each(['android', 'web'])('keeps the %s fallback free of SwiftUI imports', (platform) => {
    const result = resolvePicker(platform)
    expect(result).toEqual({
      type: 'sourceFile',
      filePath: join(componentDir, 'action-sheet-native.tsx'),
    })
    expect(readFileSync(result.filePath, 'utf8')).not.toContain('@expo/ui')
  })
})
