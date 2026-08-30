import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const projectRoot = resolve(import.meta.dirname, '../..')
const app = JSON.parse(readFileSync(resolve(projectRoot, 'app.json'), 'utf8'))
const source = readFileSync(resolve(import.meta.dirname, 'root-layout-shell.tsx'), 'utf8')
const packageRequire = createRequire(resolve(projectRoot, 'package.json'))

const fontPaths = {
  Geist_400Regular: '@expo-google-fonts/geist/400Regular/Geist_400Regular.ttf',
  Geist_600SemiBold: '@expo-google-fonts/geist/600SemiBold/Geist_600SemiBold.ttf',
  GeistMono_400Regular:
    '@expo-google-fonts/geist-mono/400Regular/GeistMono_400Regular.ttf',
  GeistMono_600SemiBold:
    '@expo-google-fonts/geist-mono/600SemiBold/GeistMono_600SemiBold.ttf',
} as const

describe('native font startup', () => {
  it('embeds the four package font files with the existing Android family and weight mapping', () => {
    const plugin = app.expo.plugins.find(
      (entry: unknown) => Array.isArray(entry) && entry[0] === 'expo-font',
    )
    expect(plugin).toBeTruthy()

    const options = plugin[1]
    expect(options.ios.fonts).toEqual(Object.values(fontPaths))
    expect(options.android.fonts).toEqual([
      {
        fontFamily: 'Geist_400Regular',
        fontDefinitions: [{ path: fontPaths.Geist_400Regular, weight: 400 }],
      },
      {
        fontFamily: 'Geist_600SemiBold',
        fontDefinitions: [{ path: fontPaths.Geist_600SemiBold, weight: 600 }],
      },
      {
        fontFamily: 'GeistMono_400Regular',
        fontDefinitions: [{ path: fontPaths.GeistMono_400Regular, weight: 400 }],
      },
      {
        fontFamily: 'GeistMono_600SemiBold',
        fontDefinitions: [{ path: fontPaths.GeistMono_600SemiBold, weight: 600 }],
      },
    ])
    for (const path of Object.values(fontPaths)) {
      expect(existsSync(packageRequire.resolve(path))).toBe(true)
    }
  })

  it('waits for runtime font registration on web but not in native launch', () => {
    expect(source).toContain(
      "const fontsReady = Platform.OS !== 'web' || fontsLoaded || fontsError != null",
    )
    for (const family of Object.keys(fontPaths)) {
      expect(source).toMatch(new RegExp(`\\b${family},`))
    }
  })
})
