import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
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

const releaseArtifacts = [
  {
    target: 'linux-x86_64' as const,
    artifactName: 'Podium_0.2.0-edge.1_amd64.AppImage',
    signature: 'LINUX-SIGNATURE',
  },
  {
    target: 'darwin-aarch64' as const,
    artifactName: 'Podium.app.tar.gz',
    signature: 'MAC-SIGNATURE',
  },
]

describe('desktop release manifest', () => {
  it('publishes Linux and Apple Silicon updater artifacts to the rolling edge release', () => {
    const text = buildDesktopManifest({
      version: '0.2.0-edge.1',
      channel: 'edge',
      artifacts: releaseArtifacts,
      notes: 'CRITICAL: signing-key migration',
    })
    expect(JSON.parse(text)).toEqual({
      version: '0.2.0-edge.1',
      notes: 'CRITICAL: signing-key migration',
      platforms: {
        'linux-x86_64': {
          url: 'https://github.com/madeinorbit/podium/releases/download/edge/Podium_0.2.0-edge.1_amd64.AppImage',
          signature: 'LINUX-SIGNATURE',
        },
        'darwin-aarch64': {
          url: 'https://github.com/madeinorbit/podium/releases/download/edge/Podium.app.tar.gz',
          signature: 'MAC-SIGNATURE',
        },
      },
    })
  })

  it('validates release notes that drive the critical updater prompt', () => {
    const text = buildDesktopManifest({
      version: '0.2.0-edge.1',
      channel: 'edge',
      artifacts: releaseArtifacts,
      notes: 'CRITICAL: required migration',
    })
    expect(() =>
      validateDesktopManifest(text, {
        version: '0.2.0-edge.1',
        channel: 'edge',
        artifacts: releaseArtifacts,
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

  it('rejects a manifest whose signature differs from a detached .sig', () => {
    const text = buildDesktopManifest({
      version: '0.2.0-edge.1',
      channel: 'edge',
      artifacts: releaseArtifacts,
    })
    expect(() =>
      validateDesktopManifest(text, {
        version: '0.2.0-edge.1',
        channel: 'edge',
        artifacts: [
          releaseArtifacts[0],
          { ...releaseArtifacts[1], signature: 'DIFFERENT-MAC-SIGNATURE' },
        ],
      }),
    ).toThrow('darwin-aarch64 does not match')
  })

  it('rejects a manifest that omits a promoted platform', () => {
    const text = buildDesktopManifest({
      version: '0.2.0-edge.1',
      channel: 'edge',
      artifacts: [releaseArtifacts[0]],
    })
    expect(() =>
      validateDesktopManifest(text, {
        version: '0.2.0-edge.1',
        channel: 'edge',
        artifacts: releaseArtifacts,
      }),
    ).toThrow('manifest platform mismatch')
  })

  it('prepares signed Linux and macOS updater artifacts plus the macOS DMG', () => {
    const root = mkdtempSync(join(tmpdir(), 'podium-desktop-release-'))
    scratch.push(root)
    const bundleDir = join(root, 'bundle')
    const linuxDir = join(bundleDir, 'linux')
    const macUpdaterDir = join(bundleDir, 'macos')
    const macDmgDir = join(bundleDir, 'dmg')
    const outputDir = join(root, 'out')
    mkdirSync(linuxDir, { recursive: true })
    mkdirSync(macUpdaterDir, { recursive: true })
    mkdirSync(macDmgDir, { recursive: true })
    writeFileSync(join(linuxDir, 'Podium_0.2.0_amd64.AppImage'), 'APPIMAGE')
    writeFileSync(join(linuxDir, 'Podium_0.2.0_amd64.AppImage.sig'), '  LINUX-SIGNATURE\n')
    writeFileSync(join(macUpdaterDir, 'Podium.app.tar.gz'), 'MAC-UPDATER')
    writeFileSync(join(macUpdaterDir, 'Podium.app.tar.gz.sig'), '  MAC-SIGNATURE\n')
    writeFileSync(join(macDmgDir, 'Podium_0.2.0_aarch64.dmg'), 'DMG')

    const result = prepareDesktopRelease({
      version: '0.2.0',
      channel: 'stable',
      stableTag: 'v0.2.0',
      bundleDir,
      outputDir,
    })

    expect(result.artifactPaths.map((path) => basename(path))).toEqual([
      'Podium_0.2.0_amd64.AppImage',
      'Podium.app.tar.gz',
    ])
    expect(result.signaturePaths.map((path) => basename(path))).toEqual([
      'Podium_0.2.0_amd64.AppImage.sig',
      'Podium.app.tar.gz.sig',
    ])
    expect(result.downloadPaths.map((path) => basename(path))).toEqual(['Podium_0.2.0_aarch64.dmg'])
    expect(readFileSync(result.downloadPaths[0] ?? '', 'utf8')).toBe('DMG')
    const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8'))
    expect(manifest.platforms['linux-x86_64']).toEqual({
      url: 'https://github.com/madeinorbit/podium/releases/download/v0.2.0/Podium_0.2.0_amd64.AppImage',
      signature: 'LINUX-SIGNATURE',
    })
    expect(manifest.platforms['darwin-aarch64']).toEqual({
      url: 'https://github.com/madeinorbit/podium/releases/download/v0.2.0/Podium.app.tar.gz',
      signature: 'MAC-SIGNATURE',
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
    ).toThrow('expected exactly one linux-x86_64 updater artifact')
  })

  it('requires a macOS DMG alongside the signed updater archive', () => {
    const root = mkdtempSync(join(tmpdir(), 'podium-desktop-release-'))
    scratch.push(root)
    const bundleDir = join(root, 'bundle')
    mkdirSync(bundleDir)
    writeFileSync(join(bundleDir, 'Podium.AppImage'), 'LINUX')
    writeFileSync(join(bundleDir, 'Podium.AppImage.sig'), 'LINUX-SIGNATURE')
    writeFileSync(join(bundleDir, 'Podium.app.tar.gz'), 'MAC')
    writeFileSync(join(bundleDir, 'Podium.app.tar.gz.sig'), 'MAC-SIGNATURE')
    expect(() =>
      prepareDesktopRelease({
        version: '0.2.0-edge.1',
        channel: 'edge',
        bundleDir,
        outputDir: join(root, 'out'),
      }),
    ).toThrow('expected exactly one darwin-aarch64 download ending in .dmg')
  })
})
