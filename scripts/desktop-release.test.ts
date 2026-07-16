import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildDesktopManifest,
  desktopReleaseTag,
  prepareDesktopRelease,
  validateDesktopManifest,
} from './desktop-release'

const scratch: string[] = []

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('desktop release manifest', () => {
  it('uses the rolling edge release and exact detached signature contents', () => {
    const text = buildDesktopManifest({
      version: '0.2.0-edge.1',
      channel: 'edge',
      artifactName: 'Podium_0.2.0-edge.1_amd64.AppImage',
      signature: 'MINISIGNATURE',
      notes: 'CRITICAL: signing-key migration',
    })
    expect(JSON.parse(text)).toEqual({
      version: '0.2.0-edge.1',
      notes: 'CRITICAL: signing-key migration',
      platforms: {
        'linux-x86_64': {
          url: 'https://github.com/madeinorbit/podium/releases/download/edge/Podium_0.2.0-edge.1_amd64.AppImage',
          signature: 'MINISIGNATURE',
        },
      },
    })
  })

  it('validates release notes that drive the critical updater prompt', () => {
    const text = buildDesktopManifest({
      version: '0.2.0-edge.1',
      channel: 'edge',
      artifactName: 'Podium.AppImage',
      signature: 'SIGNATURE',
      notes: 'CRITICAL: required migration',
    })
    expect(() =>
      validateDesktopManifest(text, {
        version: '0.2.0-edge.1',
        channel: 'edge',
        artifactName: 'Podium.AppImage',
        signature: 'SIGNATURE',
        notes: 'CRITICAL: required migration',
      }),
    ).not.toThrow()
  })

  it('requires the stable release tag to match the built version', () => {
    expect(desktopReleaseTag('stable', '0.2.0', 'v0.2.0')).toBe('v0.2.0')
    expect(() => desktopReleaseTag('stable', '0.2.0', 'v0.2.1')).toThrow(
      'does not match desktop version',
    )
  })

  it('rejects a manifest whose signature differs from the .sig contents', () => {
    const text = buildDesktopManifest({
      version: '0.2.0-edge.1',
      channel: 'edge',
      artifactName: 'Podium.AppImage',
      signature: 'WRONG',
    })
    expect(() =>
      validateDesktopManifest(text, {
        version: '0.2.0-edge.1',
        channel: 'edge',
        artifactName: 'Podium.AppImage',
        signature: 'RIGHT',
      }),
    ).toThrow('does not match')
  })

  it('prepares exactly one signed AppImage and validates latest.json', () => {
    const root = mkdtempSync(join(tmpdir(), 'podium-desktop-release-'))
    scratch.push(root)
    const bundleDir = join(root, 'bundle')
    const outputDir = join(root, 'out')
    mkdirSync(bundleDir)
    writeFileSync(join(bundleDir, 'Podium_0.2.0_amd64.AppImage'), 'APPIMAGE')
    writeFileSync(join(bundleDir, 'Podium_0.2.0_amd64.AppImage.sig'), '  SIGNATURE\n')

    const result = prepareDesktopRelease({
      version: '0.2.0',
      channel: 'stable',
      stableTag: 'v0.2.0',
      bundleDir,
      outputDir,
    })

    expect(readFileSync(result.artifactPath, 'utf8')).toBe('APPIMAGE')
    expect(readFileSync(result.signaturePath, 'utf8')).toBe('  SIGNATURE\n')
    const manifestText = readFileSync(result.manifestPath, 'utf8')
    expect(JSON.parse(manifestText).platforms['linux-x86_64']).toEqual({
      url: 'https://github.com/madeinorbit/podium/releases/download/v0.2.0/Podium_0.2.0_amd64.AppImage',
      signature: 'SIGNATURE',
    })
  })

  it('refuses ambiguous AppImage output', () => {
    const root = mkdtempSync(join(tmpdir(), 'podium-desktop-release-'))
    scratch.push(root)
    const bundleDir = join(root, 'bundle')
    mkdirSync(bundleDir)
    writeFileSync(join(bundleDir, 'one.AppImage'), 'ONE')
    writeFileSync(join(bundleDir, 'two.AppImage'), 'TWO')
    expect(() =>
      prepareDesktopRelease({
        version: '0.2.0-edge.1',
        channel: 'edge',
        bundleDir,
        outputDir: join(root, 'out'),
      }),
    ).toThrow('expected exactly one AppImage')
  })
})
