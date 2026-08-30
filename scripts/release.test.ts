import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildHeadlessManifest,
  buildHeadlessManifestForPlatforms,
  legacyPairingNotice,
  packagedWebDigest,
  parseArtifactOverrides,
  parseReleaseArgs,
  readDefinedMigrations,
  writeClientBuildRecord,
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

/**
 * WHY THIS LIVES IN THE PUBLISHER AND NOT IN THE RESOLVER (POD-2794).
 *
 * v0.1.0's rule is exact version equality between `podium-update.json` and
 * `latest.json`, on every channel, with no override — POD-2769 measured it by
 * executing the v0.1.0 resolver source against real published manifests. Those
 * binaries are already in the field and cannot be patched, so the only lever is
 * what we put on the feed they read.
 */
describe('legacyPairingNotice', () => {
  it('says nothing when the desktop manifest carries the headless version', () => {
    expect(
      legacyPairingNotice({ channel: 'stable', headlessVersion: '0.2.0', desktopVersion: '0.2.0' }),
    ).toBeUndefined()
  })

  it('refuses a headless version the staged desktop manifest does not name', () => {
    const refusal = legacyPairingNotice({
      channel: 'stable',
      headlessVersion: '0.2.0',
      desktopVersion: '0.1.1',
    })
    // The sentence has to carry the consequence, because the failure it prevents
    // is one nobody can see: the old install reports no update and says nothing.
    expect(refusal).toContain('0.2.0')
    expect(refusal).toContain('0.1.1')
    expect(refusal).toContain('no update available')
    // No waiver to mention: the notice is unconditional. A refusal here would be
    // waived on essentially every release (spec 5 has an unchanged shell carry
    // its own older version forward), and a refusal waived by default is the
    // ceremony the next real refusal hides behind.
    expect(refusal).not.toContain('--accept-legacy-stranding')
  })

  it('refuses an edge release that staged no desktop manifest, naming what persists', () => {
    // THE DEFAULT-BREAKS CASE. `gh release upload --clobber` only replaces assets
    // this run staged, so an unbuilt desktop leaves the PREVIOUS latest.json on
    // the rolling release at its own older version. An absent staged manifest is
    // not "no claim", it is "the old claim stands".
    const refusal = legacyPairingNotice({ channel: 'edge', headlessVersion: '0.2.0' })
    expect(refusal).toContain('previous release')
    expect(refusal).toContain('older version')
  })

  it('refuses a stable release that staged no desktop manifest, naming the 404', () => {
    // Stable differs: each cut is its own tag, so there is nothing to persist and
    // `releases/latest/download/latest.json` simply 404s. Same stranding, and the
    // old resolver reports it as the channel having nothing.
    const refusal = legacyPairingNotice({ channel: 'stable', headlessVersion: '0.2.0' })
    expect(refusal).toContain('404')
    expect(refusal).not.toContain('previous release')
  })

  it('never suggests restamping the manifest as the way out', () => {
    // The rejected repair, kept rejected. latest.json is also the Tauri updater
    // endpoint baked into every shipped shell, so restamping it at the headless
    // version would offer shells bytes that still report the old version after
    // installing -- a silent headless stranding traded for a desktop update loop.
    const refusal = legacyPairingNotice({ channel: 'edge', headlessVersion: '0.2.0' }) ?? ''
    expect(refusal).toMatch(/must carry a desktop build at its own version/)
    expect(refusal).not.toMatch(/restamp|rewrite|edit latest\.json/i)
  })
})

describe('the legacy pairing notice is actually wired into publishing', () => {
  // A notice nothing prints is not a notice. Driving `publishPreparedHeadless`
  // for real would need a full staged bundle set AND a GH_TOKEN, and would then
  // be one edit away from shelling out to `gh`, so the wiring is pinned
  // structurally -- but on the two properties that carry the behaviour, both of
  // which can fire.
  const source = readFileSync(join(import.meta.dirname, 'release.ts'), 'utf8')

  it('prints the notice from the publish path', () => {
    expect(source).toContain('const notice = legacyPairingNotice({')
    expect(source).toContain('if (notice) console.log(notice)')
  })

  it('prints it AFTER the local-build exit, so staging a release stays quiet', () => {
    // A developer building on their own machine is not stranding anybody.
    const localExit = source.indexOf('set GH_TOKEN to publish.')
    const notice = source.indexOf('const notice = legacyPairingNotice({')
    expect(localExit).toBeGreaterThan(-1)
    expect(notice).toBeGreaterThan(localExit)
  })

  it('carries no waiver, so it cannot decay into ceremony', () => {
    // POD-2796 measured the cost of the refusal this replaced: the mismatch is
    // the normal state of every release that did not rebuild the shell, so the
    // waiver would have been passed routinely and stopped meaning anything.
    expect(source).not.toContain('acceptLegacyStranding')
    expect(source).not.toContain('--accept-legacy-stranding')
  })
})

describe('the accepted candidate seal is before every GitHub mutation', () => {
  const source = readFileSync(join(import.meta.dirname, 'release.ts'), 'utf8')

  it('checks the proof snapshot after preparation and before any gh command', () => {
    const seal = source.indexOf('verifyCandidateSnapshot(p.dir, acceptedSnapshot)')
    expect(seal).toBeGreaterThan(source.indexOf('set GH_TOKEN to publish.'))
    expect(seal).toBeLessThan(source.indexOf("spawnSync('gh'"))
    expect(seal).toBeLessThan(source.indexOf("execFileSync('gh'"))
  })
})

describe('parseArtifactOverrides', () => {
  it('maps a platform to the absolute path its tarball must be written to', () => {
    expect(parseArtifactOverrides(['linux-x86_64=/tmp/a.tar.gz'])).toEqual(
      new Map([['linux-x86_64', '/tmp/a.tar.gz']]),
    )
    expect(parseArtifactOverrides([])).toEqual(new Map())
  })

  it('keeps a path containing an = sign, splitting on the FIRST separator only', () => {
    expect(parseArtifactOverrides(['darwin-aarch64=/tmp/a=b.tar.gz'])).toEqual(
      new Map([['darwin-aarch64', '/tmp/a=b.tar.gz']]),
    )
  })

  it('refuses an unknown platform, a missing separator, a relative path and a duplicate', () => {
    expect(() => parseArtifactOverrides(['plan9-mips=/tmp/a'])).toThrow(
      /unknown headless platform 'plan9-mips'/,
    )
    expect(() => parseArtifactOverrides(['linux-x86_64'])).toThrow(/<platform>=<absolute path>/)
    expect(() => parseArtifactOverrides(['linux-x86_64=rel/a'])).toThrow(/must be absolute/)
    expect(() => parseArtifactOverrides(['linux-x86_64='])).toThrow(/must be absolute/)
    expect(() => parseArtifactOverrides(['linux-x86_64=/a', 'linux-x86_64=/b'])).toThrow(
      /given twice/,
    )
  })

  it('is reachable from the command line: --artifact is a repeated option', () => {
    const args = parseReleaseArgs([
      '--prepare-cross',
      '--platform',
      'linux-x86_64',
      '--artifact',
      'linux-x86_64=/tmp/a.tar.gz',
      '--artifact=darwin-aarch64=/tmp/b.tar.gz',
    ])
    expect(parseArtifactOverrides(args.repeated('--artifact'))).toEqual(
      new Map([
        ['linux-x86_64', '/tmp/a.tar.gz'],
        ['darwin-aarch64', '/tmp/b.tar.gz'],
      ]),
    )
  })
})

describe('the client half of the build ledger', () => {
  const evidence = {
    clientRootDigest: 'a'.repeat(64),
    sourceCommit: 'dc0a8cf',
    version: '0.1.1-dev.15+dc0a8cf',
    sites: { web: 'w', mobile: 'm' },
    taskHashes: { '@podium/web#build': 'h1', '@podium/mobile#build': 'h2' },
    cache: { '@podium/web#build': 'HIT', '@podium/mobile#build': 'MISS' },
  } as const

  it('states the digest, the commit, the version and each task hit or miss', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'podium-record-')), 'nested')
    writeClientBuildRecord(dir, evidence)
    expect(JSON.parse(readFileSync(join(dir, 'client.json'), 'utf8'))).toEqual({
      rootDigest: 'a'.repeat(64),
      sourceCommit: 'dc0a8cf',
      version: '0.1.1-dev.15+dc0a8cf',
      tasks: {
        '@podium/web#build': { hash: 'h1', cache: 'HIT' },
        '@podium/mobile#build': { hash: 'h2', cache: 'MISS' },
      },
    })
  })

  it('records no tasks when the dist was verified without a lane run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-record-'))
    writeClientBuildRecord(dir, {
      clientRootDigest: 'a'.repeat(64),
      sourceCommit: 'dc0a8cf',
      version: '0.1.1',
      sites: { web: 'w', mobile: 'm' },
    })
    expect(
      (JSON.parse(readFileSync(join(dir, 'client.json'), 'utf8')) as { tasks: unknown }).tasks,
    ).toEqual({})
  })

  it('is reachable from the command line: --record takes the record directory', () => {
    const args = parseReleaseArgs(['--prepare-cross', '--record', '/var/state/builds/b1'])
    expect(args.value('--record')).toBe('/var/state/builds/b1')
    expect(parseReleaseArgs(['--prepare-cross']).value('--record')).toBeUndefined()
  })
})
