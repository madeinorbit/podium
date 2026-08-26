import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildHeadlessManifest,
  buildHeadlessManifestForPlatforms,
  packagedWebDigest,
  readDefinedMigrations,
} from './release'

describe('buildHeadlessManifest', () => {
  it('produces the Tauri-shaped headless manifest', () => {
    const json = buildHeadlessManifest({
      version: '0.2.0',
      url: 'https://github.com/madeinorbit/podium/releases/download/v0.2.0/podium-headless-linux-x64.tar.gz',
      signature: 'BASE64SIG',
    })
    const m = JSON.parse(json)
    expect(m.version).toBe('0.2.0')
    expect(m.platforms['linux-x86_64'].url).toMatch(/podium-headless-linux-x64\.tar\.gz$/)
    expect(m.platforms['linux-x86_64'].signature).toBe('BASE64SIG')
  })
  it('keys the platform entry by an explicit target when given', () => {
    const json = buildHeadlessManifest({
      version: '0.2.0',
      url: 'https://example.com/podium-headless-darwin-arm64.tar.gz',
      signature: 'SIG',
      target: 'darwin-aarch64',
    })
    const m = JSON.parse(json)
    expect(m.platforms['darwin-aarch64'].url).toMatch(/darwin-arm64\.tar\.gz$/)
    expect(m.platforms['linux-x86_64']).toBeUndefined()
  })

  it('publishes x64 and arm64 in one updater manifest', () => {
    const json = buildHeadlessManifestForPlatforms({
      version: '0.2.0',
      platforms: [
        {
          target: 'linux-x86_64',
          url: 'https://example.com/podium-headless-linux-x64.tar.gz',
          signature: 'SIG-X64',
        },
        {
          target: 'linux-aarch64',
          url: 'https://example.com/podium-headless-linux-arm64.tar.gz',
          signature: 'SIG-ARM64',
        },
      ],
    })
    const m = JSON.parse(json)
    expect(m.platforms['linux-x86_64'].signature).toBe('SIG-X64')
    expect(m.platforms['linux-aarch64']).toEqual({
      url: 'https://example.com/podium-headless-linux-arm64.tar.gz',
      signature: 'SIG-ARM64',
    })
  })
})

describe('readDefinedMigrations', () => {
  it('lists the migration folder names this build defines', () => {
    // Read from the tree being released, so the manifest's claim is a fact
    // about the artifact rather than about whatever ran the release (POD-2213).
    const dir = mkdtempSync(join(tmpdir(), 'podium-release-migrations-'))
    try {
      mkdirSync(join(dir, '20260816092917_operations-table'))
      mkdirSync(join(dir, '20260715135845_baseline'))
      writeFileSync(join(dir, 'meta.json'), '{}')
      expect(readDefinedMigrations(dir)).toEqual([
        '20260715135845_baseline',
        '20260816092917_operations-table',
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses to publish a release that cannot say what schema it opens', () => {
    // Silence here is not free: a release with no declaration is a release no
    // machine can ever safely roll back to.
    expect(() => readDefinedMigrations(join(tmpdir(), 'podium-no-such-migrations-dir'))).toThrow(
      /cannot declare the schema/,
    )
  })
})

describe('packagedWebDigest', () => {
  it('requires the operator and Expo sites to name the same source build', () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-release-sites-'))
    try {
      for (const site of ['web', 'mobile']) {
        mkdirSync(join(dir, site))
        writeFileSync(
          join(dir, site, 'podium-build.json'),
          '{"sourceSha":"abc1234","appVersion":"0.4.2"}\n',
        )
      }
      writeFileSync(join(dir, 'VERSION'), '0.4.2\n')
      expect(packagedWebDigest(dir)).toBe('abc1234')
      writeFileSync(
        join(dir, 'mobile', 'podium-build.json'),
        '{"sourceSha":"def5678","appVersion":"0.4.2"}\n',
      )
      expect(() => packagedWebDigest(dir)).toThrow(/web and mobile sites disagree/)
      writeFileSync(
        join(dir, 'mobile', 'podium-build.json'),
        '{"sourceSha":"abc1234","appVersion":"0.4.3"}\n',
      )
      expect(() => packagedWebDigest(dir)).toThrow(/web and mobile sites disagree/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
