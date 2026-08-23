import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildDesktopManifest,
  desktopReleaseTag,
  prepareDesktopRelease,
  resolveNotes,
  staleDesktopAssets,
  validateDesktopManifest,
} from './desktop-release'

const scratch: string[] = []

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true })
})

const linuxArtifact = {
  target: 'linux-x86_64' as const,
  artifactName: 'Podium_0.2.0-edge.1_amd64.AppImage',
  signature: 'LINUX-SIGNATURE',
}
const windowsArtifact = {
  target: 'windows-x86_64' as const,
  artifactName: 'Podium_0.2.0-edge.1_x64-setup.exe',
  signature: 'WINDOWS-SIGNATURE',
}
const macArtifact = {
  target: 'darwin-aarch64' as const,
  artifactName: 'Podium_0.2.0-edge.1_aarch64.app.tar.gz',
  signature: 'MAC-SIGNATURE',
}
const macIntelArtifact = {
  target: 'darwin-x86_64' as const,
  artifactName: 'Podium_0.2.0-edge.1_x64.app.tar.gz',
  signature: 'MAC-INTEL-SIGNATURE',
}
const releaseArtifacts = [linuxArtifact, windowsArtifact, macArtifact, macIntelArtifact]

describe('desktop release manifest', () => {
  it('publishes Windows, Linux, and both macOS updater architectures to the rolling edge release', () => {
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
        'windows-x86_64': {
          url: 'https://github.com/madeinorbit/podium/releases/download/edge/Podium_0.2.0-edge.1_x64-setup.exe',
          signature: 'WINDOWS-SIGNATURE',
        },
        'darwin-aarch64': {
          url: 'https://github.com/madeinorbit/podium/releases/download/edge/Podium_0.2.0-edge.1_aarch64.app.tar.gz',
          signature: 'MAC-SIGNATURE',
        },
        'darwin-x86_64': {
          url: 'https://github.com/madeinorbit/podium/releases/download/edge/Podium_0.2.0-edge.1_x64.app.tar.gz',
          signature: 'MAC-INTEL-SIGNATURE',
        },
      },
    })
  })

  // Note text is round-tripped verbatim — including a "CRITICAL:" prefix, which is ordinary prose
  // and forces nothing (updater.rs reads a boolean `critical` field this script never writes).
  it('round-trips release notes through validation unchanged', () => {
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
          linuxArtifact,
          { ...macArtifact, signature: 'DIFFERENT-MAC-SIGNATURE' },
          macIntelArtifact,
        ],
      }),
    ).toThrow('darwin-aarch64 does not match')
  })

  it('rejects a manifest that omits a promoted platform', () => {
    const text = buildDesktopManifest({
      version: '0.2.0-edge.1',
      channel: 'edge',
      artifacts: [linuxArtifact],
    })
    expect(() =>
      validateDesktopManifest(text, {
        version: '0.2.0-edge.1',
        channel: 'edge',
        artifacts: releaseArtifacts,
      }),
    ).toThrow('manifest platform mismatch')
  })

  it('prepares signed Windows, Linux, and macOS updater artifacts plus the macOS DMGs', () => {
    const root = mkdtempSync(join(tmpdir(), 'podium-desktop-release-'))
    scratch.push(root)
    const bundleDir = join(root, 'bundle')
    const linuxDir = join(bundleDir, 'linux')
    const windowsDir = join(bundleDir, 'windows', 'nsis')
    const macUpdaterDir = join(bundleDir, 'aarch64-apple-darwin', 'macos')
    const macDmgDir = join(bundleDir, 'aarch64-apple-darwin', 'dmg')
    // The Intel bundle mirrors the CI artifact layout: the rust target triple in the path is
    // what disambiguates two otherwise identically named .app.tar.gz updater archives.
    const macIntelUpdaterDir = join(bundleDir, 'x86_64-apple-darwin', 'macos')
    const macIntelDmgDir = join(bundleDir, 'x86_64-apple-darwin', 'dmg')
    const outputDir = join(root, 'out')
    mkdirSync(linuxDir, { recursive: true })
    mkdirSync(windowsDir, { recursive: true })
    mkdirSync(macUpdaterDir, { recursive: true })
    mkdirSync(macDmgDir, { recursive: true })
    mkdirSync(macIntelUpdaterDir, { recursive: true })
    mkdirSync(macIntelDmgDir, { recursive: true })
    writeFileSync(join(linuxDir, 'Podium_0.2.0_amd64.AppImage'), 'APPIMAGE')
    writeFileSync(join(linuxDir, 'Podium_0.2.0_amd64.AppImage.sig'), '  LINUX-SIGNATURE\n')
    writeFileSync(join(windowsDir, 'Podium_0.2.0_x64-setup.exe'), 'WINDOWS-INSTALLER')
    writeFileSync(
      join(windowsDir, 'Podium_0.2.0_x64-setup.exe.sig'),
      '  WINDOWS-SIGNATURE\n',
    )
    writeFileSync(join(macUpdaterDir, 'Podium.app.tar.gz'), 'MAC-UPDATER')
    writeFileSync(join(macUpdaterDir, 'Podium.app.tar.gz.sig'), '  MAC-SIGNATURE\n')
    writeFileSync(join(macDmgDir, 'Podium_0.2.0_aarch64.dmg'), 'DMG')
    writeFileSync(join(macIntelUpdaterDir, 'Podium.app.tar.gz'), 'MAC-INTEL-UPDATER')
    writeFileSync(join(macIntelUpdaterDir, 'Podium.app.tar.gz.sig'), '  MAC-INTEL-SIGNATURE\n')
    writeFileSync(join(macIntelDmgDir, 'Podium_0.2.0_x64.dmg'), 'INTEL-DMG')

    const result = prepareDesktopRelease({
      version: '0.2.0',
      channel: 'stable',
      stableTag: 'v0.2.0',
      bundleDir,
      outputDir,
    })

    expect(result.artifactPaths.map((path) => basename(path))).toEqual([
      'Podium_0.2.0_amd64.AppImage',
      'Podium_0.2.0_x64-setup.exe',
      'Podium_0.2.0_aarch64.app.tar.gz',
      'Podium_0.2.0_x64.app.tar.gz',
    ])
    expect(result.signaturePaths.map((path) => basename(path))).toEqual([
      'Podium_0.2.0_amd64.AppImage.sig',
      'Podium_0.2.0_x64-setup.exe.sig',
      'Podium_0.2.0_aarch64.app.tar.gz.sig',
      'Podium_0.2.0_x64.app.tar.gz.sig',
    ])
    expect(result.downloadPaths.map((path) => basename(path))).toEqual([
      'Podium_0.2.0_aarch64.dmg',
      'Podium_0.2.0_x64.dmg',
    ])
    expect(readFileSync(result.downloadPaths[0] ?? '', 'utf8')).toBe('DMG')
    expect(readFileSync(result.downloadPaths[1] ?? '', 'utf8')).toBe('INTEL-DMG')
    const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8'))
    expect(manifest.platforms['linux-x86_64']).toEqual({
      url: 'https://github.com/madeinorbit/podium/releases/download/v0.2.0/Podium_0.2.0_amd64.AppImage',
      signature: 'LINUX-SIGNATURE',
    })
    expect(manifest.platforms['windows-x86_64']).toEqual({
      url: 'https://github.com/madeinorbit/podium/releases/download/v0.2.0/Podium_0.2.0_x64-setup.exe',
      signature: 'WINDOWS-SIGNATURE',
    })
    expect(manifest.platforms['darwin-aarch64']).toEqual({
      url: 'https://github.com/madeinorbit/podium/releases/download/v0.2.0/Podium_0.2.0_aarch64.app.tar.gz',
      signature: 'MAC-SIGNATURE',
    })
    expect(manifest.platforms['darwin-x86_64']).toEqual({
      url: 'https://github.com/madeinorbit/podium/releases/download/v0.2.0/Podium_0.2.0_x64.app.tar.gz',
      signature: 'MAC-INTEL-SIGNATURE',
    })
  })

  it('lists desktop assets from earlier edge builds as stale', () => {
    // Version-named desktop pairs are never clobbered, so each edge publish leaves the previous
    // build's installers and updater archives behind — including pre-notarization installers.
    const existing = [
      'Podium_0.1.2-edge.1_aarch64.dmg',
      'Podium_0.1.4-edge.3_amd64.AppImage',
      'Podium_0.1.4-edge.3_amd64.AppImage.sig',
      'Podium_0.1.4-edge.3_x64-setup.exe',
      'Podium_0.1.4-edge.3_x64-setup.exe.sig',
      'Podium_0.1.4-edge.3_aarch64.app.tar.gz',
      'Podium_0.1.4-edge.3_aarch64.app.tar.gz.sig',
      'Podium_0.1.4-edge.4_aarch64.dmg',
      'Podium_0.1.4-edge.4_amd64.AppImage',
      'Podium_0.1.4-edge.4_amd64.AppImage.sig',
      'Podium_0.1.4-edge.4_x64-setup.exe',
      'Podium_0.1.4-edge.4_x64-setup.exe.sig',
      'Podium_0.1.4-edge.4_aarch64.app.tar.gz',
      'Podium_0.1.4-edge.4_aarch64.app.tar.gz.sig',
      'latest.json',
    ]
    const current = [
      'Podium_0.1.4-edge.4_aarch64.dmg',
      'Podium_0.1.4-edge.4_amd64.AppImage',
      'Podium_0.1.4-edge.4_amd64.AppImage.sig',
      'Podium_0.1.4-edge.4_x64-setup.exe',
      'Podium_0.1.4-edge.4_x64-setup.exe.sig',
      'Podium_0.1.4-edge.4_aarch64.app.tar.gz',
      'Podium_0.1.4-edge.4_aarch64.app.tar.gz.sig',
      'latest.json',
    ]
    expect(staleDesktopAssets(existing, current)).toEqual([
      'Podium_0.1.2-edge.1_aarch64.dmg',
      'Podium_0.1.4-edge.3_amd64.AppImage',
      'Podium_0.1.4-edge.3_amd64.AppImage.sig',
      'Podium_0.1.4-edge.3_x64-setup.exe',
      'Podium_0.1.4-edge.3_x64-setup.exe.sig',
      'Podium_0.1.4-edge.3_aarch64.app.tar.gz',
      'Podium_0.1.4-edge.3_aarch64.app.tar.gz.sig',
    ])
  })

  it('never lists the headless assets sharing the rolling edge release', () => {
    // The edge release is shared with the headless workflow; pruning desktop leftovers must
    // not delete its assets even though none of them appear in the desktop output directory.
    const headlessAssets = [
      'podium-headless-linux-x64.tar.gz',
      'podium-headless-linux-x64.tar.gz.sig',
      'podium-headless-linux-arm64.tar.gz',
      'podium-headless-linux-arm64.tar.gz.sig',
      'podium-update.json',
      'SHA256SUMS',
      'VERSION',
      'install.sh',
    ]
    expect(staleDesktopAssets(headlessAssets, [])).toEqual([])
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

describe('resolveNotes', () => {
  const changelog = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-notes-'))
    scratch.push(dir)
    const path = join(dir, 'CHANGELOG.md')
    writeFileSync(
      path,
      '# Changelog\n\n## [Unreleased]\n\n## [0.2.0] - 2026-08-13\n\n- The published thing.\n\n## [0.1.9] - 2026-07-01\n\n- Older.\n',
    )
    return path
  }

  it('takes the notes for the version from the repository changelog', () => {
    // Notes live in the repo so a tag push carries them without anyone opening the Actions UI,
    // and so both halves of one release quote the same text.
    expect(resolveNotes('0.2.0', undefined, changelog())).toContain('The published thing.')
  })

  it('reads only that version section, never a neighbour', () => {
    expect(resolveNotes('0.2.0', undefined, changelog())).not.toContain('Older.')
  })

  it('prefers an explicit --notes for a re-promotion that needs different wording', () => {
    expect(resolveNotes('0.2.0', 'hand written', changelog())).toBe('hand written')
  })

  it('ships no notes rather than failing when the version has no section', () => {
    expect(resolveNotes('9.9.9', undefined, changelog())).toBeUndefined()
  })

  it('ships no notes rather than failing when the changelog is missing entirely', () => {
    expect(resolveNotes('0.2.0', undefined, '/nonexistent/CHANGELOG.md')).toBeUndefined()
  })
})
