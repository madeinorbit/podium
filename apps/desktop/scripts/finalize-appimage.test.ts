import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  incompatibleAppImageLibraries,
  removeIncompatibleAppImageLibraries,
} from './finalize-appimage'

const scratch: string[] = []

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('portable AppImage platform libraries', () => {
  it('removes the incompatible display, GLib, media and network platform layer', () => {
    const root = mkdtempSync(join(tmpdir(), 'podium-appimage-libs-'))
    scratch.push(root)
    const libraryDir = join(root, 'usr/lib')
    mkdirSync(libraryDir, { recursive: true })
    const incompatible = [
      'libwayland-client.so.0',
      'libglib-2.0.so.0',
      'libgstreamer-1.0.so.0',
      'libmount.so.1',
      'libnghttp2.so.14',
      'libkrb5.so.3',
    ]
    for (const name of incompatible) writeFileSync(join(libraryDir, name), name)
    writeFileSync(join(libraryDir, 'libwebkit2gtk-4.1.so.0'), 'application dependency')
    writeFileSync(join(libraryDir, 'libayatana-appindicator3.so.1'), 'application dependency')

    expect(incompatibleAppImageLibraries(libraryDir)).toEqual(incompatible.sort())
    expect(removeIncompatibleAppImageLibraries(libraryDir)).toEqual(incompatible.sort())
    expect(incompatibleAppImageLibraries(libraryDir)).toEqual([])
    for (const name of incompatible) expect(existsSync(join(libraryDir, name))).toBe(false)
    expect(existsSync(join(libraryDir, 'libwebkit2gtk-4.1.so.0'))).toBe(true)
    expect(existsSync(join(libraryDir, 'libayatana-appindicator3.so.1'))).toBe(true)
  })

  it('does not confuse similarly named application libraries with platform infrastructure', () => {
    const root = mkdtempSync(join(tmpdir(), 'podium-appimage-safe-'))
    scratch.push(root)
    const libraryDir = join(root, 'usr/lib')
    mkdirSync(libraryDir, { recursive: true })
    writeFileSync(join(libraryDir, 'libglimmer.so.1'), 'safe')
    writeFileSync(join(libraryDir, 'libgesture.so.1'), 'safe')

    expect(removeIncompatibleAppImageLibraries(libraryDir)).toEqual([])
    expect(existsSync(join(libraryDir, 'libglimmer.so.1'))).toBe(true)
    expect(existsSync(join(libraryDir, 'libgesture.so.1'))).toBe(true)
  })
})
