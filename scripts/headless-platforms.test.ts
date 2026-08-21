import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// scripts/ already depends on apps/ (build-bun compiles the CLI and daemon entries), so
// this import runs with the grain. It is here to hold the server's own copy of the
// platform → bun-target mapping to this one: the server may not import the build scripts,
// so the arithmetic exists twice, and a test is the only thing that can stop the two
// drifting silently.
import { bunTargetForPlatform as serverBunTargetForPlatform } from '../apps/server/src/modules/updates/dev-bundle'
import {
  ABDUCO_TARGETS,
  abducoCachePath,
  abducoCompileFlags,
  HEADLESS_PLATFORMS,
  isHeadlessPlatform,
} from './abduco-cross'
import { BUN_TARGETS, bunTargetForPlatform, parseBuildTarget, targetOutputRoot } from './build-bun'
import { headlessAsset, loadPreparedHeadless, RELEASE_PLATFORMS } from './release'

/**
 * The four platform names are spoken by five things — the abduco cache, the bun
 * --compile target table, the release asset names, the manifest keys and the CLI's own
 * host derivation. These tests exist because a mismatch between any two of them is
 * invisible until a machine asks for an update and is told its platform was never
 * published.
 */
describe('the headless platform set', () => {
  it('ships exactly the four platforms a release publishes', () => {
    expect([...RELEASE_PLATFORMS].sort()).toEqual([
      'darwin-aarch64',
      'darwin-x86_64',
      'linux-aarch64',
      'linux-x86_64',
    ])
  })

  it('gives every platform a bun --compile target and an abduco target', () => {
    for (const platform of HEADLESS_PLATFORMS) {
      const target = bunTargetForPlatform(platform)
      expect(BUN_TARGETS[target].platform).toBe(platform)
      expect(ABDUCO_TARGETS[platform].zigTarget).toBeTruthy()
    }
  })

  it('names each platform its own release asset', () => {
    const assets = HEADLESS_PLATFORMS.map(headlessAsset)
    expect(assets).toEqual([
      'podium-headless-linux-x64.tar.gz',
      'podium-headless-linux-arm64.tar.gz',
      'podium-headless-darwin-arm64.tar.gz',
      'podium-headless-darwin-x64.tar.gz',
    ])
    expect(new Set(assets).size).toBe(assets.length)
  })

  it('marks exactly the Darwin platforms as needing a code signature', () => {
    const signed = HEADLESS_PLATFORMS.filter((p) => ABDUCO_TARGETS[p].darwin)
    expect([...signed].sort()).toEqual(['darwin-aarch64', 'darwin-x86_64'])
  })

  it('has the server derive the same bun target the build table names', () => {
    // The dev publisher passes `--target` to the same script a release does. If its
    // three lines of arithmetic ever disagreed with this table, the dev host would
    // quietly compile a bundle for the wrong machine.
    for (const platform of HEADLESS_PLATFORMS) {
      expect(serverBunTargetForPlatform(platform)).toBe(bunTargetForPlatform(platform))
    }
  })

  it('rejects a platform name it does not publish', () => {
    expect(isHeadlessPlatform('windows-x86_64')).toBe(false)
    expect(isHeadlessPlatform('linux-x86_64')).toBe(true)
  })
})

describe('abduco cross-build inputs', () => {
  it('keys the cache on the source hash, so an edited abduco.c invalidates every platform', () => {
    const a = abducoCachePath('linux-aarch64', 'a'.repeat(64), '/repo/')
    const b = abducoCachePath('linux-aarch64', 'b'.repeat(64), '/repo/')
    expect(a).not.toBe(b)
    expect(a).toContain('linux-aarch64-')
  })

  it('reserves Mach-O header room and the util.h shim only for Darwin targets', () => {
    // Without -headerpad the x86_64 link leaves no room for the code-signature load
    // command and rcodesign fails; without the include dir zig cannot see forkpty.
    const darwin = abducoCompileFlags(ABDUCO_TARGETS['darwin-x86_64'], '/inc')
    expect(darwin).toContain('-Wl,-headerpad,0x8000')
    expect(darwin).toContain('/inc')
    const linux = abducoCompileFlags(ABDUCO_TARGETS['linux-x86_64'], '/inc')
    expect(linux).not.toContain('-Wl,-headerpad,0x8000')
    expect(linux).not.toContain('/inc')
  })

  it('links Linux helpers against musl, so the bundle carries no glibc floor', () => {
    expect(ABDUCO_TARGETS['linux-x86_64'].zigTarget).toContain('musl')
    expect(ABDUCO_TARGETS['linux-aarch64'].zigTarget).toContain('musl')
  })
})

describe('build-bun --target', () => {
  it('leaves a plain host build writing where it always did', () => {
    expect(parseBuildTarget([])).toBeUndefined()
    expect(targetOutputRoot('/x/dist-bun', undefined)).toBe('/x/dist-bun')
  })

  it('gives each cross target its own bundle root, so four builds can coexist', () => {
    const roots = Object.keys(BUN_TARGETS).map((t) =>
      targetOutputRoot('/x/dist-bun', t as keyof typeof BUN_TARGETS),
    )
    expect(new Set(roots).size).toBe(roots.length)
    expect(targetOutputRoot('/x/dist-bun', 'bun-darwin-arm64')).toBe(
      '/x/dist-bun/targets/darwin-aarch64',
    )
  })

  it('refuses a target it cannot build rather than silently building the host', () => {
    expect(() => parseBuildTarget(['--target=bun-windows-x64'])).toThrow(/unknown --target/)
  })
})

describe('loadPreparedHeadless', () => {
  const write = (dir: string, target: string, asset: string, extra: object = {}) => {
    const descriptor = {
      version: '9.9.9',
      target,
      asset,
      signature: 'SIG',
      webDigest: 'abc1234',
      ...extra,
    }
    writeFileSync(join(dir, asset), 'tarball')
    writeFileSync(join(dir, `${asset}.sig`), 'SIG\n')
    writeFileSync(join(dir, `${asset}.json`), JSON.stringify(descriptor))
  }
  const stage = (platforms: readonly string[]): string => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-prepared-'))
    for (const platform of platforms) {
      write(dir, platform, headlessAsset(platform as (typeof RELEASE_PLATFORMS)[number]))
    }
    return dir
  }

  it('accepts a complete four-platform release', () => {
    const dir = stage(RELEASE_PLATFORMS)
    try {
      const { version, prepared } = loadPreparedHeadless(dir)
      expect(version).toBe('9.9.9')
      expect(prepared.map((p) => p.target).sort()).toEqual([...RELEASE_PLATFORMS].sort())
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('REFUSES to publish a release that is missing a platform', () => {
    // The failure this prevents: a Mac asks for an update and is told, forever, that its
    // platform was never published.
    const dir = stage(RELEASE_PLATFORMS.filter((p) => p !== 'darwin-aarch64'))
    try {
      expect(() => loadPreparedHeadless(dir)).toThrow(/missing darwin-aarch64/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('REFUSES two descriptors claiming one platform (the A/B legs colliding)', () => {
    const dir = stage(RELEASE_PLATFORMS)
    try {
      // A second descriptor for linux-aarch64 under a different file name — what merging
      // the cross and native A/B artifacts into one directory would produce.
      writeFileSync(join(dir, 'native-arm64.tar.gz'), 'tarball')
      writeFileSync(join(dir, 'native-arm64.tar.gz.sig'), 'SIG\n')
      writeFileSync(
        join(dir, 'native-arm64.tar.gz.json'),
        JSON.stringify({
          version: '9.9.9',
          target: 'linux-aarch64',
          asset: 'native-arm64.tar.gz',
          signature: 'SIG',
          webDigest: 'abc1234',
          mode: 'native',
        }),
      )
      expect(() => loadPreparedHeadless(dir)).toThrow(/duplicate platform target/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('REFUSES a set whose bundles pack different web builds', () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-prepared-'))
    try {
      write(dir, 'linux-x86_64', headlessAsset('linux-x86_64'))
      write(dir, 'darwin-aarch64', headlessAsset('darwin-aarch64'), { webDigest: 'different' })
      expect(() => loadPreparedHeadless(dir, ['linux-x86_64', 'darwin-aarch64'])).toThrow(
        /different or missing web digests/,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the checked-in repository stays binary-free', () => {
  it('keeps no prebuilt abduco under scripts/', () => {
    // The helpers are built from the vendored source into a gitignored cache. If one is
    // ever committed instead, the shipped helper can drift from the source under review.
    for (const platform of HEADLESS_PLATFORMS) {
      expect(existsSync(join('scripts/prebuilt/abduco', platform, 'abduco'))).toBe(false)
    }
  })
})
