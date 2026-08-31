import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fontFacesForPlatform } from '../theme/font-family'
import { useLaunchFontsReady as useNativeLaunchFontsReady } from './font-startup.native'
import { useLaunchFontsReady as useWebLaunchFontsReady } from './font-startup.web'

const useFonts = vi.hoisted(() => vi.fn())

vi.mock('expo-font', () => ({ useFonts }))
vi.mock('@expo-google-fonts/geist/400Regular', () => ({ Geist_400Regular: 401 }))
vi.mock('@expo-google-fonts/geist/600SemiBold', () => ({ Geist_600SemiBold: 601 }))
vi.mock('@expo-google-fonts/geist-mono/400Regular', () => ({ GeistMono_400Regular: 402 }))
vi.mock('@expo-google-fonts/geist-mono/600SemiBold', () => ({ GeistMono_600SemiBold: 602 }))

const projectRoot = resolve(import.meta.dirname, '../..')
const app = JSON.parse(readFileSync(resolve(projectRoot, 'app.json'), 'utf8'))
const rootSource = readFileSync(resolve(import.meta.dirname, 'root-layout-shell.tsx'), 'utf8')
const nativeSource = readFileSync(resolve(import.meta.dirname, 'font-startup.native.ts'), 'utf8')
const packageRequire = createRequire(resolve(projectRoot, 'package.json'))

const fontPaths = {
  Geist_400Regular: '@expo-google-fonts/geist/400Regular/Geist_400Regular.ttf',
  Geist_600SemiBold: '@expo-google-fonts/geist/600SemiBold/Geist_600SemiBold.ttf',
  GeistMono_400Regular:
    '@expo-google-fonts/geist-mono/400Regular/GeistMono_400Regular.ttf',
  GeistMono_600SemiBold:
    '@expo-google-fonts/geist-mono/600SemiBold/GeistMono_600SemiBold.ttf',
} as const

beforeEach(() => {
  useFonts.mockReset()
})

describe('native font startup', () => {
  it('embeds the four package files with the exact Android aliases and weights', () => {
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

  it('uses embedded iOS PostScript names and existing aliases elsewhere', () => {
    expect(fontFacesForPlatform('ios')).toEqual({
      sansRegular: 'Geist-Regular',
      sansSemiBold: 'Geist-SemiBold',
      monoRegular: 'GeistMono-Regular',
      monoSemiBold: 'GeistMono-SemiBold',
    })
    const aliases = {
      sansRegular: 'Geist_400Regular',
      sansSemiBold: 'Geist_600SemiBold',
      monoRegular: 'GeistMono_400Regular',
      monoSemiBold: 'GeistMono_600SemiBold',
    }
    expect(fontFacesForPlatform('android')).toEqual(aliases)
    expect(fontFacesForPlatform('web')).toEqual(aliases)
  })

  it('does not import or call the runtime font loader on native', () => {
    expect(useNativeLaunchFontsReady()).toBe(true)
    expect(useFonts).not.toHaveBeenCalled()
    expect(nativeSource).not.toMatch(/expo-font|@expo-google-fonts/)
    expect(rootSource).not.toMatch(/expo-font|@expo-google-fonts/)
    expect(rootSource).toContain("from './font-startup'")
  })

  it('loads all four aliases on web and keeps them in its launch gate', () => {
    useFonts.mockReturnValueOnce([false, null])
    expect(useWebLaunchFontsReady()).toBe(false)
    expect(useFonts).toHaveBeenLastCalledWith({
      Geist_400Regular: 401,
      Geist_600SemiBold: 601,
      GeistMono_400Regular: 402,
      GeistMono_600SemiBold: 602,
    })

    useFonts.mockReturnValueOnce([true, null])
    expect(useWebLaunchFontsReady()).toBe(true)
    useFonts.mockReturnValueOnce([false, new Error('font failed')])
    expect(useWebLaunchFontsReady()).toBe(true)
  })
})
