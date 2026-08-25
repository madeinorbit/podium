import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildHeadlessManifest,
  buildHeadlessManifestForPlatforms,
  packagedWebDigest,
  parseReleaseArgs,
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

describe('parseReleaseArgs', () => {
  it('reads an option value written either way round', () => {
    // POD-2800: the equals form used to be dropped on the floor, and the run
    // built edge while the operator believed they had asked for stable.
    expect(parseReleaseArgs(['--channel', 'stable']).value('--channel')).toBe('stable')
    expect(parseReleaseArgs(['--channel=stable']).value('--channel')).toBe('stable')
  })

  it('reports an option nobody passed as absent rather than empty', () => {
    const args = parseReleaseArgs([])
    expect(args.value('--channel')).toBeUndefined()
    expect(args.flag('--critical')).toBe(false)
    expect(args.repeated('--platform')).toEqual([])
  })

  it('refuses an option it does not understand, and says which one', () => {
    // The whole point: a release that builds the wrong channel costs a wrong
    // release on a feed real installs read. Refusing only costs a retry.
    expect(() => parseReleaseArgs(['--chanel=stable'])).toThrow(/unknown option '--chanel'/)
    expect(() => parseReleaseArgs(['--channel', 'stable', '--dry-run'])).toThrow(
      /unknown option '--dry-run'/,
    )
  })

  it('names the understood options when it refuses one', () => {
    expect(() => parseReleaseArgs(['--chanel=stable'])).toThrow(/--channel/)
  })

  it('refuses a value option left without a value', () => {
    expect(() => parseReleaseArgs(['--channel'])).toThrow(/'--channel' needs a value/)
    expect(() => parseReleaseArgs(['--channel', '--critical'])).toThrow(/'--channel' needs a value/)
    expect(() => parseReleaseArgs(['--channel='])).toThrow(/'--channel' needs a value/)
  })

  it('takes a value that looks like an option when it is spelled with equals', () => {
    // `--channel --tag` is a mistake; `--channel=--tag` is someone being explicit.
    expect(parseReleaseArgs(['--tag=--weird']).value('--tag')).toBe('--weird')
  })

  it('refuses a value handed to an option that takes none', () => {
    expect(() => parseReleaseArgs(['--critical=true'])).toThrow(/'--critical' takes no value/)
  })

  it('refuses one value option given twice rather than picking a winner', () => {
    expect(() => parseReleaseArgs(['--channel', 'edge', '--channel=stable'])).toThrow(
      /'--channel' was given more than once/,
    )
  })

  it('collects a repeatable option in the order it was written', () => {
    const args = parseReleaseArgs(['--platform=linux-x86_64', '--platform', 'darwin-aarch64'])
    expect(args.repeated('--platform')).toEqual(['linux-x86_64', 'darwin-aarch64'])
  })

  it('refuses a bare argument, which this script has no use for', () => {
    expect(() => parseReleaseArgs(['stable'])).toThrow(/unexpected argument 'stable'/)
  })

  it('accepts the command lines the release workflow actually runs', () => {
    // A regression pin on .github/workflows/release.yml: if this parser ever
    // stops understanding CI's spelling, it fails here rather than in a release.
    expect(() => parseReleaseArgs(['--channel', 'edge', '--prepare-arch', 'x64'])).not.toThrow()
    expect(() =>
      parseReleaseArgs([
        '--channel',
        'stable',
        '--tag',
        'v0.4.2',
        '--publish-dir',
        'dist-bun/release',
      ]),
    ).not.toThrow()
  })
})
