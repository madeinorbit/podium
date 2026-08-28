import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { matchUpdateFailureToken, UpdateTarget } from '@podium/protocol'
import { fetchArtifact } from '@podium/runtime/update-delivery'
import type {
  ReleaseBuildTimingDeps,
  ReleaseBuildTimingRecord,
} from '@podium/runtime/release-build-timing'
import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'
import { registerDevFeedRoutes } from './artifact-route'
import { withDevBuildSnapshot } from './dev-build-snapshot'
import {
  assertSourceMatchesHead,
  buildDevBundle,
  classifyIgnoredSourceInputs,
  classifySourceIdentity,
  createDevBundlePublisher,
  DEV_BUNDLE_RETAINED,
  type DevBundleFs,
  type DevBundleLock,
  decideDevBuild,
  devBuildPlatforms,
  devReleaseBuildArgs,
  devBundleFileName,
  devBundleKeyFingerprint,
  devBundleStamp,
  developmentPlatformTarget,
  devIdentityTarget,
  devTarget,
  fleetHeadlessPlatforms,
  listDevBundles,
  parseDevBundleName,
  requireDefinedMigrations,
  selectDevBundleSweep,
  sweepDevBundles,
} from './dev-bundle'
import { createServerDevBundleLock } from './dev-bundle-lock'
import { classifyMachineFailure, describeUpdateOperationFailure } from './operation'
import { type DesktopFeedChannel, desktopManifestFeedChannel } from './release-target'

const CHECKOUT_BASE = '0.1.0-edge.20'
const publisherDirs: string[] = []

function publisherDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'podium-dev-publisher-'))
  publisherDirs.push(dir)
  return dir
}

afterEach(() => {
  while (publisherDirs.length > 0) {
    const dir = publisherDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

/** Publisher seams every build/publish test needs after POD-2502. */
function publisherSeams(): {
  publisherStateDir: string
  checkoutReleaseBase: string
  migrationsAt: (sha: string) => Promise<string[]>
} {
  return {
    publisherStateDir: publisherDir(),
    checkoutReleaseBase: CHECKOUT_BASE,
    migrationsAt: async () => ['20260715135845_baseline'],
  }
}

const base = {
  sourceCheckoutAvailable: true,
  headSha: 'aaa',
  builtSha: null as string | null,
  lastAttemptAt: null as number | null,
  now: 100_000,
  inFlight: false,
  debounceMs: 60_000,
  explicit: false,
}

describe('decideDevBuild', () => {
  it('builds when nothing has been built yet', () => {
    expect(decideDevBuild(base)).toEqual({ build: true })
  })

  it('does not build when the built bundle already matches HEAD', () => {
    expect(decideDevBuild({ ...base, builtSha: 'aaa' })).toEqual({
      build: false,
      reason: 'up-to-date',
    })
  })

  it('does not build a second time while one is in flight', () => {
    // Two concurrent bun compiles on the machine that is also running the server
    // and every agent session is exactly the starvation this guards against.
    expect(decideDevBuild({ ...base, inFlight: true })).toEqual({
      build: false,
      reason: 'in-flight',
    })
  })

  it('debounces a rapid series of merges', () => {
    expect(decideDevBuild({ ...base, builtSha: 'old', lastAttemptAt: 90_000 })).toEqual({
      build: false,
      reason: 'debounced',
    })
  })

  it('builds once the debounce window has passed', () => {
    expect(decideDevBuild({ ...base, builtSha: 'old', lastAttemptAt: 30_000 })).toEqual({
      build: true,
    })
  })

  it('an explicit request bypasses the debounce', () => {
    // A human asking for it now is not a merge storm.
    expect(
      decideDevBuild({
        ...base,
        builtSha: 'old',
        lastAttemptAt: 99_999,
        explicit: true,
      }),
    ).toEqual({ build: true })
  })

  it('an explicit request still does not stack on an in-flight build', () => {
    expect(
      decideDevBuild({
        ...base,
        builtSha: 'old',
        explicit: true,
        inFlight: true,
      }),
    ).toEqual({
      build: false,
      reason: 'in-flight',
    })
  })

  it('an explicit request still does nothing when already up to date', () => {
    expect(decideDevBuild({ ...base, builtSha: 'aaa', explicit: true })).toEqual({
      build: false,
      reason: 'up-to-date',
    })
  })

  it('never builds without a source checkout', () => {
    // Publisher capability follows checkout availability, not whether this server is packaged.
    expect(decideDevBuild({ ...base, sourceCheckoutAvailable: false, explicit: true })).toEqual({
      build: false,
      reason: 'no-source-checkout',
    })
  })
})

/** `git status --porcelain=v1 -z` output: NUL-terminated, never quoted. */
function nul(...fields: string[]): string {
  return fields.map((field) => field + '\0').join('')
}

describe('classifySourceIdentity', () => {
  it('accepts a checkout that is exactly HEAD', () => {
    expect(classifySourceIdentity('')).toEqual({ clean: true, offending: [] })
  })

  it('rejects modified, staged, deleted and renamed tracked source', () => {
    // A rename is `XY <destination>` followed by `<source>` as its own field.
    const porcelain = nul(
      ' M apps/server/src/server.ts',
      'M  packages/protocol/src/index.ts',
      ' D apps/cli/src/gone.ts',
      'R  apps/cli/src/new.ts',
      'apps/cli/src/old.ts',
    )
    expect(classifySourceIdentity(porcelain)).toEqual({
      clean: false,
      offending: [
        'apps/server/src/server.ts',
        'packages/protocol/src/index.ts',
        'apps/cli/src/gone.ts',
        'apps/cli/src/new.ts',
        'apps/cli/src/old.ts',
      ],
    })
  })

  it('reports both ends of a rename, so an allowed destination cannot hide it', () => {
    // Renaming source INTO dist-bun still removes it from where HEAD has it.
    expect(
      classifySourceIdentity(nul('R  dist-bun/old.ts', 'apps/cli/src/old.ts')).offending,
    ).toEqual(['apps/cli/src/old.ts'])
  })

  it('reports only the destination of a copy, whose source is unchanged', () => {
    expect(
      classifySourceIdentity(nul('C  apps/cli/src/copy.ts', 'apps/cli/src/keep.ts')).offending,
    ).toEqual(['apps/cli/src/copy.ts'])
  })

  it('rejects untracked source, which bun build would compile in', () => {
    expect(classifySourceIdentity(nul('?? apps/server/src/modules/updates/scratch.ts'))).toEqual({
      clean: false,
      offending: ['apps/server/src/modules/updates/scratch.ts'],
    })
  })

  it('allows the build to write its own dist-bun outputs', () => {
    const porcelain = nul(
      '?? dist-bun/podium-headless-dev+aaaaaaa.tar.gz',
      '?? dist-bun/podium-headless-dev+aaaaaaa.tar.gz.sig',
    )
    expect(classifySourceIdentity(porcelain)).toEqual({
      clean: true,
      offending: [],
    })
  })

  it('takes paths raw, with no quoting or escaping to undo', () => {
    // The newline format would render these quoted and C-escaped.
    expect(
      classifySourceIdentity(nul('?? apps/web/a b.ts', '?? apps/web/tab\ta.ts')).offending,
    ).toEqual(['apps/web/a b.ts', 'apps/web/tab\ta.ts'])
  })

  it('is not fooled by a path containing the newline format rename delimiter', () => {
    // ` -> ` is a legal substring of a filename. With `-z` there is nothing to
    // split on, so neither of these can be mistaken for the other shape.
    expect(classifySourceIdentity(nul('?? apps/web/a -> b.ts')).offending).toEqual([
      'apps/web/a -> b.ts',
    ])
    expect(
      classifySourceIdentity(nul('R  apps/web/x -> y.ts', 'apps/web/old -> name.ts')).offending,
    ).toEqual(['apps/web/x -> y.ts', 'apps/web/old -> name.ts'])
  })
})

describe('classifyIgnoredSourceInputs', () => {
  it('catches an ignored module that a bundler would still resolve', () => {
    // The whole point: git status never mentions this file, but an import of
    // `./local-override` compiles it straight into the bundle.
    expect(classifyIgnoredSourceInputs(nul('apps/server/src/local-override.ts'))).toEqual([
      'apps/server/src/local-override.ts',
    ])
  })

  it('ignores non-source evidence living in the same trees', () => {
    expect(
      classifyIgnoredSourceInputs(
        nul(
          'apps/web/screenshot.png',
          'packages/harness/notes.md',
          'scripts/.podium-update-dev.key',
        ),
      ),
    ).toEqual([])
  })

  it('does not enumerate dependency or output trees as source', () => {
    expect(
      classifyIgnoredSourceInputs(
        nul(
          'apps/server/node_modules/left-pad/index.js',
          'packages/model/dist/index.js',
          'dist-bun/podium-headless-dev+aaaaaaa.tar.gz',
          'apps/web/.turbo/log.json',
        ),
      ),
    ).toEqual([])
  })

  it('allows generated desktop outputs that cannot affect the headless bundle', () => {
    expect(
      classifyIgnoredSourceInputs(
        nul(
          'apps/desktop/src-tauri/gen/schemas/acl-manifests.json',
          'apps/desktop/src-tauri/resources/web/assets/index.js',
        ),
      ),
    ).toEqual([])

    expect(classifyIgnoredSourceInputs(nul('apps/desktop/src/local-override.ts'))).toEqual([
      'apps/desktop/src/local-override.ts',
    ])
  })

  it('allows the generated website sourcemap archive index', () => {
    expect(classifyIgnoredSourceInputs(nul('apps/web/.sourcemaps/builds.json'))).toEqual([])
    expect(classifyIgnoredSourceInputs(nul('apps/web/src/local-override.ts'))).toEqual([
      'apps/web/src/local-override.ts',
    ])
  })

  it('catches every resolvable extension, once each', () => {
    expect(
      classifyIgnoredSourceInputs(
        nul('packages/pty/native.node', 'scripts/gen.mjs', 'tooling/data.json', 'scripts/gen.mjs'),
      ),
    ).toEqual(['packages/pty/native.node', 'scripts/gen.mjs', 'tooling/data.json'])
  })
})

function signedFixture() {
  const bytes = new Uint8Array([1, 2, 3, 4])
  const { privateKey } = generateKeyPairSync('ed25519')
  const signingKey = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
  const signature = sign(null, bytes, privateKey).toString('base64')
  return { bytes, signature, signingKey }
}

function digestOf(bytes: Uint8Array): string {
  return 'sha256-' + createHash('sha256').update(bytes).digest('base64')
}

/**
 * A filesystem the tests can inspect. It has no "read the whole file" verb for
 * the tarball — only a streaming digest — which is the same shape the real one
 * has, and the reason a bundle cannot end up in the server's heap by accident.
 */
function memoryFs(
  seed: { text?: Record<string, string>; blobs?: Record<string, Uint8Array> } = {},
) {
  const text = new Map(Object.entries(seed.text ?? {}))
  const blobs = new Map(Object.entries(seed.blobs ?? {}))
  const dirOf = (path: string) => path.slice(0, path.lastIndexOf('/'))
  const fs: DevBundleFs = {
    list: async (dir) =>
      [...text.keys(), ...blobs.keys()]
        .filter((path) => dirOf(path) === dir)
        .map((path) => path.slice(path.lastIndexOf('/') + 1)),
    digest: async (path) => {
      const blob = blobs.get(path)
      if (!blob) throw new Error('no such file: ' + path)
      return { digest: digestOf(blob), size: blob.length }
    },
    readText: async (path) => {
      const value = text.get(path)
      if (value === undefined) throw new Error('no such file: ' + path)
      return value
    },
    writeText: async (path, contents) => {
      text.set(path, contents)
    },
    remove: async (path) => {
      text.delete(path)
      blobs.delete(path)
    },
  }
  return {
    fs,
    text,
    blobs,
    names: () =>
      [...text.keys(), ...blobs.keys()].map((path) => path.slice(path.lastIndexOf('/') + 1)).sort(),
  }
}

/** A dist-bun holding one bundle published exactly the way the server does it. */
function published(input: {
  sha: string
  stamp: string
  bytes: Uint8Array
  signature: string
  signingKey?: string
  root?: string
  /** Override the minted version; defaults to a publisher mint on CHECKOUT_BASE. */
  version?: string
  counter?: number
  /** Defaults to this host's own — the platform a restore requires to be present. */
  platform?: string
}) {
  const version = input.version ?? `0.1.0-dev.${input.counter ?? 1}+${input.sha}`
  const platform = input.platform ?? developmentPlatformTarget()
  const path =
    (input.root ?? '/repo/podium') +
    '/dist-bun/' +
    devBundleFileName(version, input.stamp, platform)
  return memoryFs({
    blobs: { [path]: input.bytes },
    text: {
      [path + '.sig']: input.signature + '\n',
      [path + '.meta.json']: JSON.stringify({
        version,
        platform,
        digest: digestOf(input.bytes),
        size: input.bytes.length,
        keyFingerprint: devBundleKeyFingerprint(input.signingKey),
      }),
    },
  })
}

/** For publisher tests that care about lifecycle, not about what is on disk. */
function stubFs(): DevBundleFs {
  const text = new Map<string, string>()
  return {
    list: async () => [],
    digest: async () => ({
      digest: digestOf(new Uint8Array([1, 2, 3, 4])),
      size: 4,
    }),
    readText: async (path) => {
      const value = text.get(path)
      if (value === undefined) throw new Error('no such file: ' + path)
      return value
    },
    writeText: async (path, contents) => {
      text.set(path, contents)
    },
    remove: async () => {},
  }
}

describe('createServerDevBundleLock', () => {
  it('uses one in-process system identity scoped to the bundle lock', async () => {
    const calls: Array<{
      operation: string
      caller: { sessionId: string | null; label: string }
      input: unknown
    }> = []
    const lock = createServerDevBundleLock('/repo/podium', {
      acquire(caller, input) {
        calls.push({ operation: 'acquire', caller, input })
        return { granted: true, alreadyHeld: false, lock: {} as never }
      },
      cancel(caller, input) {
        calls.push({ operation: 'cancel', caller, input })
        return { cancelled: true }
      },
      renew(caller, input) {
        calls.push({ operation: 'renew', caller, input })
        return {} as never
      },
      release(caller, input) {
        calls.push({ operation: 'release', caller, input })
        return { released: true, next: null }
      },
    })

    await lock.acquire()
    await lock.renew()
    await lock.release()

    expect(
      calls.map(({ operation, caller, input }) => ({
        operation,
        sessionId: caller.sessionId,
        label: caller.label,
        input,
      })),
    ).toEqual([
      {
        operation: 'acquire',
        sessionId: 'system:dev-bundle',
        label: 'system:dev-bundle',
        input: {
          repoPath: '/repo/podium',
          name: 'podium:dev-bundle',
          ttlSeconds: 900,
          note: 'server-owned development bundle build',
        },
      },
      {
        operation: 'renew',
        sessionId: 'system:dev-bundle',
        label: 'system:dev-bundle',
        input: {
          repoPath: '/repo/podium',
          name: 'podium:dev-bundle',
          ttlSeconds: 900,
        },
      },
      {
        operation: 'release',
        sessionId: 'system:dev-bundle',
        label: 'system:dev-bundle',
        input: { repoPath: '/repo/podium', name: 'podium:dev-bundle' },
      },
    ])
  })
})

function lockFixture(events: string[]): DevBundleLock {
  return {
    acquire: async () => {
      events.push('acquire')
      return true
    },
    renew: async () => {
      events.push('renew')
    },
    release: async () => {
      events.push('release')
    },
  }
}

describe('development bundle names', () => {
  it('stamps a build at fixed width, so string order is build order', () => {
    expect(devBundleStamp(Date.UTC(2026, 7, 12, 18, 20, 15, 903))).toBe('20260812T182015Z')
    expect(devBundleStamp(Date.UTC(2026, 0, 1, 0, 0, 0))).toBe('20260101T000000Z')
    expect(devBundleFileName('0.1.0-dev.5+abc1234', '20260812T182015Z')).toBe(
      'podium-headless-0.1.0-dev.5+abc1234-20260812T182015Z.tar.gz',
    )
  })

  it('recognises legacy and publisher-minted artifacts, on any platform', () => {
    // Today's shape: a publisher mint, one file per platform.
    expect(
      parseDevBundleName(
        'podium-headless-0.1.0-dev.5+656f49b-darwin-aarch64-20260812T182015Z.tar.gz',
      ),
    ).toEqual({
      name: 'podium-headless-0.1.0-dev.5+656f49b-darwin-aarch64-20260812T182015Z.tar.gz',
      sha: '656f49b',
      platform: 'darwin-aarch64',
      stamp: '20260812T182015Z',
      version: '0.1.0-dev.5+656f49b',
    })
    // The platform must not be swallowed into the version: a greedy parse would read
    // the version as `…dev.5+656f49b-darwin-aarch64`, which names no mint anyone can
    // look up.
    expect(
      parseDevBundleName(
        'podium-headless-0.1.0-dev.5+656f49b-darwin-aarch64-20260812T182015Z.tar.gz',
      )?.version,
    ).toBe('0.1.0-dev.5+656f49b')
    // A publisher mint with no platform — the shape before one build minted several.
    expect(
      parseDevBundleName('podium-headless-0.1.0-dev.5+656f49b-20260812T182015Z.tar.gz'),
    ).toEqual({
      name: 'podium-headless-0.1.0-dev.5+656f49b-20260812T182015Z.tar.gz',
      sha: '656f49b',
      platform: '',
      stamp: '20260812T182015Z',
      version: '0.1.0-dev.5+656f49b',
    })
    // EVERY older shape is still OURS, and that matters: a name this stops recognising
    // does not become safe, it becomes invisible — a file the retention sweep no longer
    // knows to delete.
    expect(
      parseDevBundleName('podium-headless-dev+abc1234-darwin-aarch64-20260812T182015Z.tar.gz'),
    ).toEqual({
      name: 'podium-headless-dev+abc1234-darwin-aarch64-20260812T182015Z.tar.gz',
      sha: 'abc1234',
      platform: 'darwin-aarch64',
      stamp: '20260812T182015Z',
      version: 'dev+abc1234',
    })
    expect(parseDevBundleName('podium-headless-dev+abc1234-20260812T182015Z.tar.gz')).toEqual({
      name: 'podium-headless-dev+abc1234-20260812T182015Z.tar.gz',
      sha: 'abc1234',
      platform: '',
      stamp: '20260812T182015Z',
      version: 'dev+abc1234',
    })
    expect(parseDevBundleName('podium-headless-dev+abc1234.tar.gz')).toMatchObject({
      sha: 'abc1234',
      platform: '',
      stamp: '',
    })
  })

  it('names a file per platform, so one build does not overwrite itself', () => {
    const names = ['linux-x86_64', 'darwin-aarch64'].map((platform) =>
      devBundleFileName('dev+abc1234', '20260812T182015Z', platform),
    )
    expect(names).toEqual([
      'podium-headless-dev+abc1234-linux-x86_64-20260812T182015Z.tar.gz',
      'podium-headless-dev+abc1234-darwin-aarch64-20260812T182015Z.tar.gz',
    ])
    expect(new Set(names).size).toBe(2)
  })

  it('never claims a release artifact, a sidecar, or a stranger', () => {
    // scripts/release.ts reads dist-bun/podium-headless-<semver>.tar.gz by name.
    for (const name of [
      'podium-headless-0.2.0.tar.gz',
      'podium-headless-linux-x64.tar.gz',
      'podium-headless-dev+abc1234-20260812T182015Z.tar.gz.sig',
      'podium-headless-dev+abc1234-20260812T182015Z.tar.gz.meta.json',
      'podium-headless-dev+NOTHEX.tar.gz',
      'podium-headless-dev+abc1234-yesterday.tar.gz',
      'podium',
      'abduco.bin',
    ]) {
      expect(parseDevBundleName(name), name).toBeNull()
    }
  })

  it('orders newest first, with an unstamped artifact oldest', () => {
    const names = [
      'podium-headless-dev+bbbbbbb-20260812T182015Z.tar.gz',
      'podium-headless-dev+ccccccc.tar.gz',
      'podium-headless-dev+aaaaaaa-20260812T193045Z.tar.gz',
    ]
    expect(listDevBundles(names).map((entry) => entry.sha)).toEqual([
      'aaaaaaa',
      'bbbbbbb',
      'ccccccc',
    ])
  })
})

describe('selectDevBundleSweep', () => {
  const stamped = (sha: string, stamp: string) => `podium-headless-dev+${sha}-${stamp}.tar.gz`
  const newest = stamped('ddddddd', '20260812T190000Z')
  const previous = stamped('ccccccc', '20260812T180000Z')
  const older = stamped('bbbbbbb', '20260812T170000Z')
  const oldest = stamped('aaaaaaa', '20260812T160000Z')

  it('keeps the new bundle and the one before it, and takes the rest with their sidecars', () => {
    const listing = [
      oldest,
      oldest + '.sig',
      oldest + '.meta.json',
      older,
      older + '.sig',
      previous,
      newest,
    ]
    expect(selectDevBundleSweep(listing).sort()).toEqual(
      [oldest, oldest + '.sig', oldest + '.meta.json', older, older + '.sig'].sort(),
    )
    expect(DEV_BUNDLE_RETAINED).toBe(2)
  })

  it('sweeps nothing when the directory is already within the window', () => {
    expect(selectDevBundleSweep([newest, previous, newest + '.sig'])).toEqual([])
  })

  it('never names a file the listing does not have', () => {
    // Only sidecars that actually exist — the result is files, not guesses.
    expect(selectDevBundleSweep([newest, previous, older])).toEqual([older])
  })

  it('leaves release artifacts and everything else alone', () => {
    const listing = [
      'podium-headless-0.2.0.tar.gz',
      'podium-headless-0.2.0.tar.gz.sig',
      'podium',
      'abduco.bin',
      'headless',
      oldest,
    ]
    expect(selectDevBundleSweep(listing, { keep: 0 })).toEqual([oldest])
  })

  it('reclaims the unstamped bundles that accumulated before this existed', () => {
    const legacy = ['podium-headless-dev+1111111.tar.gz', 'podium-headless-dev+2222222.tar.gz']
    expect(selectDevBundleSweep([newest, previous, ...legacy]).sort()).toEqual([...legacy].sort())
  })

  it('will not delete the artifact being served, whatever the ordering says', () => {
    expect(
      selectDevBundleSweep([newest, previous, older], {
        keep: 1,
        protect: [older],
      }),
    ).toEqual([previous])
  })

  it('counts BUILDS per platform, not files, when it has no allowlist to go on', () => {
    // `keep` means "the last N builds", and a build is now up to four files. Counting
    // them in one list keeps two and deletes the rest of the build just published — a
    // Mac in the fleet would be offered a target whose tarball the sweep had removed.
    //
    // Production reaches this through the allowlist (`referenced`) instead, which
    // POD-2502 added; this counting fallback is what an `selectDevBundleSweep(names)`
    // with no options still does, so it has to be right on its own terms.
    const build = (counter: number, sha: string, stamp: string, platform: string) =>
      `podium-headless-0.1.0-dev.${counter}+${sha}-${platform}-${stamp}.tar.gz`
    const newestBuild = ['linux-x86_64', 'darwin-aarch64', 'linux-aarch64', 'darwin-x86_64'].map(
      (platform) => build(3, '3333333', '20260812T190000Z', platform),
    )
    const previousBuild = ['linux-x86_64', 'darwin-aarch64'].map((platform) =>
      build(2, '2222222', '20260812T180000Z', platform),
    )
    const oldestBuild = ['linux-x86_64', 'darwin-aarch64'].map((platform) =>
      build(1, '1111111', '20260812T170000Z', platform),
    )

    const doomed = selectDevBundleSweep([...newestBuild, ...previousBuild, ...oldestBuild], {
      hostPlatform: 'linux-x86_64',
    })

    // Every file of the two newest builds survives; only the third build goes.
    expect(doomed.sort()).toEqual([...oldestBuild].sort())
    for (const name of [...newestBuild, ...previousBuild]) expect(doomed).not.toContain(name)
  })

  it('drains legacy platform-less names through the host group rather than hoarding them', () => {
    // A name with no platform predates multi-platform builds, and the only bundle such
    // a build produced was this host's. Give it a group of its own and its survivors are
    // retained forever, because nothing new is ever added to push them out.
    const legacy = [
      'podium-headless-dev+1111111-20260812T170000Z.tar.gz',
      'podium-headless-dev+2222222-20260812T180000Z.tar.gz',
    ]
    const fresh = ['linux-x86_64', 'darwin-aarch64'].map(
      (platform) => `podium-headless-0.1.0-dev.9+9999999-${platform}-20260812T190000Z.tar.gz`,
    )
    const doomed = selectDevBundleSweep([...fresh, ...legacy], {
      keep: 1,
      hostPlatform: 'linux-x86_64',
    })
    // keep:1 — the host group holds the fresh linux bundle, so BOTH legacy names go.
    expect(doomed.sort()).toEqual([...legacy].sort())
  })

  it('never deletes an artifact referenced by current manifests, even if stamp-newest', () => {
    const current = `podium-headless-0.1.0-dev.2+ddddddd-20260812T190000Z.tar.gz`
    const retained = `podium-headless-0.1.0-dev.1+ccccccc-20260812T180000Z.tar.gz`
    const orphan = `podium-headless-0.1.0-dev.3+bbbbbbb-20260812T200000Z.tar.gz`
    const listing = [current, retained, orphan, orphan + '.sig', 'podium-headless-0.2.0.tar.gz']
    expect(
      selectDevBundleSweep(listing, {
        referenced: [current, retained],
        protect: [current],
      }).sort(),
    ).toEqual([orphan, orphan + '.sig'].sort())
  })
})

describe('sweepDevBundles', () => {
  it('removes what it can and survives what it cannot', async () => {
    const store = memoryFs({
      blobs: {
        '/repo/podium/dist-bun/podium-headless-dev+aaaaaaa-20260812T160000Z.tar.gz': new Uint8Array(
          [1],
        ),
        '/repo/podium/dist-bun/podium-headless-dev+bbbbbbb-20260812T170000Z.tar.gz': new Uint8Array(
          [2],
        ),
        '/repo/podium/dist-bun/podium-headless-dev+ccccccc-20260812T180000Z.tar.gz': new Uint8Array(
          [3],
        ),
        '/repo/podium/dist-bun/podium-headless-0.2.0.tar.gz': new Uint8Array([4]),
      },
      text: {
        '/repo/podium/dist-bun/podium-headless-dev+aaaaaaa-20260812T160000Z.tar.gz.sig': 'x',
      },
    })
    const failing: DevBundleFs = {
      ...store.fs,
      remove: async (path) => {
        if (path.endsWith('.sig')) throw new Error('permission denied')
        await store.fs.remove(path)
      },
    }

    // A sidecar that refuses to go is disk to reclaim next time, not a failure.
    await sweepDevBundles(failing, '/repo/podium/dist-bun')

    expect(store.names()).toEqual([
      'podium-headless-0.2.0.tar.gz',
      'podium-headless-dev+aaaaaaa-20260812T160000Z.tar.gz.sig',
      'podium-headless-dev+bbbbbbb-20260812T170000Z.tar.gz',
      'podium-headless-dev+ccccccc-20260812T180000Z.tar.gz',
    ])
  })
})

describe('fleetHeadlessPlatforms', () => {
  const host = 'linux-x86_64'

  it('always includes this host, which is a consumer of its own feed', () => {
    expect(fleetHeadlessPlatforms([], host)).toEqual([host])
  })

  it('adds a platform the moment a machine of that kind has enrolled', () => {
    expect(
      fleetHeadlessPlatforms(
        [
          { inventory: { os: 'darwin', arch: 'arm64' } },
          { inventory: { os: 'linux', arch: 'arm64' } },
        ],
        host,
      ),
    ).toEqual([host, 'darwin-aarch64', 'linux-aarch64'])
  })

  it('does not mint for a platform nobody runs', () => {
    // The whole point of fleet-scoping: a dev feed serves a fleet whose members have
    // all enrolled, so a fourth platform would be two minutes of the live host's CPU
    // spent on a file that will never be fetched.
    expect(fleetHeadlessPlatforms([{ inventory: { os: 'darwin', arch: 'arm64' } }], host)).toEqual([
      host,
      'darwin-aarch64',
    ])
  })

  it('counts each platform once, however many machines run it', () => {
    expect(
      fleetHeadlessPlatforms(
        [
          { inventory: { os: 'darwin', arch: 'arm64' } },
          { inventory: { os: 'darwin', arch: 'arm64' } },
          { inventory: { os: 'linux', arch: 'x64' } },
        ],
        host,
      ),
    ).toEqual([host, 'darwin-aarch64'])
  })

  it('contributes nothing for a machine that has not said what it is yet', () => {
    // Absent inventory is "we do not know", and a guess here mints the wrong bundle.
    // It will contribute the moment its daemon connects and reports.
    expect(fleetHeadlessPlatforms([{ inventory: undefined }, {}], host)).toEqual([host])
  })

  it('skips a platform no bundle is published for', () => {
    // A key in the manifest with no artifact behind it is a machine that downloads a
    // 404 forever; saying nothing is the honest answer.
    expect(fleetHeadlessPlatforms([{ inventory: { os: 'win32', arch: 'x64' } }], host)).toEqual([
      host,
    ])
  })
})

describe('devBuildPlatforms', () => {
  it('puts this host first, so a later platform’s failure cannot cost this machine its bundle', () => {
    expect(devBuildPlatforms(['darwin-aarch64', 'linux-x86_64'], 'linux-x86_64')).toEqual([
      'linux-x86_64',
      'darwin-aarch64',
    ])
  })

  it('builds each platform once', () => {
    expect(devBuildPlatforms(['darwin-aarch64', 'darwin-aarch64'], 'linux-x86_64')).toEqual([
      'linux-x86_64',
      'darwin-aarch64',
    ])
  })
})

describe('buildDevBundle', () => {
  it('refuses the retired caller-supplied digest seam', async () => {
    await expect(
      buildDevBundle({
        clientRootDigest: 'a'.repeat(64),
      } as unknown as Parameters<typeof buildDevBundle>[0]),
    ).rejects.toThrow(/caller-supplied clientRootDigest is forbidden/)
  })

  it('gives ONE release child the whole publish, naming every platform and its output', () => {
    // The coordinator both this publisher and the CI release job run. One command line
    // for every platform is what makes the clients build once: a child per platform is
    // a client build per platform.
    expect(
      devReleaseBuildArgs([
        {
          platform: 'linux-x86_64',
          bunTarget: 'bun-linux-x64',
          artifactPath: '/repo/dist-bun/a.tar.gz',
        },
        {
          platform: 'darwin-aarch64',
          bunTarget: 'bun-darwin-arm64',
          artifactPath: '/repo/dist-bun/b.tar.gz',
        },
      ]),
    ).toEqual([
      'scripts/release.ts',
      '--prepare-cross',
      '--platform',
      'linux-x86_64',
      '--artifact',
      'linux-x86_64=/repo/dist-bun/a.tar.gz',
      '--platform',
      'darwin-aarch64',
      '--artifact',
      'darwin-aarch64=/repo/dist-bun/b.tar.gz',
    ])
  })

  it('never spawns build-bun directly, which would package whatever dist was lying about', () => {
    const source = readFileSync(new URL('./dev-bundle.ts', import.meta.url), 'utf8')
    expect(source).not.toContain("'scripts/build-bun.ts'")
  })

  it('builds a signed dev target and releases the lease after describing the artifact', async () => {
    const { bytes, signature } = signedFixture()
    const store = memoryFs()
    const events: string[] = []
    const built = await buildDevBundle({
      ...publisherSeams(),
      root: '/repo/podium',
      headSha: '123456789abcdef',
      fs: store.fs,
      lock: lockFixture(events),
      renewIntervalMs: 60_000,
      now: () => Date.UTC(2026, 7, 12, 18, 20, 15),
      spawnBuild: async ({ version, artifacts }) => {
        events.push('build:' + version)
        for (const { artifactPath } of artifacts) {
          store.blobs.set(artifactPath, bytes)
          store.text.set(artifactPath + '.sig', signature + '\n')
        }
      },
    })

    expect(built.version).toBe('0.1.0-dev.1+1234567')
    // The version a daemon sees is the publisher mint; the FILE also names the build.
    expect(built.path).toBe(
      '/repo/podium/dist-bun/podium-headless-0.1.0-dev.1+1234567-linux-x86_64-20260812T182015Z.tar.gz',
    )
    expect(built.size).toBe(bytes.length)
    expect(built.digest).toBe(digestOf(bytes))
    expect(events).toEqual(['acquire', 'build:0.1.0-dev.1+1234567', 'release'])
    const target = devTarget(built, {
      platform: 'linux-x86_64',
      artifactUrl: (platform) =>
        'http://server.test/updates/feed/dev/artifact/' +
        encodeURIComponent(built.version) +
        '/' +
        encodeURIComponent(platform),
      sourceRoot: '/repo/podium',
      schemaMigrations: ['20260715135845_baseline'],
    })
    expect(target.schema).toEqual({ migrations: ['20260715135845_baseline'] })
    // `feed`, like edge and stable: the manifest this publisher writes is
    // read by the same resolver, with the same parser (spec §1, §6 step 3).
    expect(target.artifacts.headless).toEqual({
      delivery: 'feed',
      platforms: {
        'linux-x86_64': {
          url:
            'http://server.test/updates/feed/dev/artifact/' +
            encodeURIComponent(built.version) +
            '/linux-x86_64',
          digest: built.digest,
          signature,
        },
      },
    })
    expect(target.artifacts.headlessAlternatives).toBeUndefined()
    expect(target.artifacts.web).toEqual({ digest: '1234567' })
    // NEVER its own trust root: the resolver stamps that from the channel and
    // refuses a manifest that names one, so writing it here would make every
    // dev release unresolvable.
    expect(target.trust).toBeUndefined()
  })

  it('advertises an orderable identity with a web digest when there is no tarball yet', () => {
    const identity = devIdentityTarget('0.1.0-dev.1+f9485d3', 'f9485d31b', {
      sourceRoot: '/repo/podium',
      schemaMigrations: ['20260715135845_baseline'],
    })
    expect(identity.version).toBe('0.1.0-dev.1+f9485d3')
    expect(identity.schema).toEqual({
      migrations: ['20260715135845_baseline'],
    })
    expect(identity.artifacts.web).toEqual({ digest: 'f9485d3' })
    // NOTHING to deliver. The git alternative that used to sit here named a
    // repo and a sha for a machine that owned the checkout; that delivery kind
    // is retired, so an identity target is now an identity and nothing else —
    // a machine cannot converge to it and the planner says `no-artifact`.
    expect(identity.artifacts.headless).toBeUndefined()
    expect(identity.artifacts.headlessAlternatives).toBeUndefined()
  })

  it('never holds the bundle, and says how big the one on disk is', async () => {
    const big = new Uint8Array(4096).fill(7)
    const store = memoryFs()
    const built = await buildDevBundle({
      ...publisherSeams(),
      root: '/repo/podium',
      headSha: '123456789abcdef',
      fs: store.fs,
      lock: lockFixture([]),
      spawnBuild: async ({ artifacts }) =>
        artifacts.map(({ platform, artifactPath }) => {
          store.blobs.set(artifactPath, big)
          return { platform, signature: 'signed' }
        }),
    })

    // The descriptor is metadata; there is nowhere for a payload to hide in it.
    expect(Object.keys(built).sort()).toEqual([
      'artifacts',
      'digest',
      'path',
      'signature',
      'size',
      'version',
    ])
    // `artifacts` describes the per-platform files; it is metadata too, with no room
    // for a payload either.
    expect(built.artifacts.map((artifact) => Object.keys(artifact).sort())).toEqual([
      ['digest', 'path', 'platform', 'signature', 'size', 'version'],
    ])
    expect(built.size).toBe(4096)
    expect(built.digest).toBe(digestOf(big))
  })

  it('rebuilding one commit writes a new file instead of overwriting the published one', async () => {
    const store = memoryFs()
    const seams = publisherSeams()
    const built: string[] = []
    for (const at of [Date.UTC(2026, 7, 12, 18, 20, 15), Date.UTC(2026, 7, 12, 19, 30, 45)]) {
      const bundle = await buildDevBundle({
        ...seams,
        root: '/repo/podium',
        headSha: 'aaaaaaa',
        fs: store.fs,
        lock: lockFixture([]),
        now: () => at,
        spawnBuild: async ({ artifacts }) =>
          artifacts.map(({ platform, artifactPath }) => {
            store.blobs.set(artifactPath, new Uint8Array([1, 2, 3, 4]))
            return { platform, signature: 'signed' }
          }),
      })
      built.push(bundle.path)
    }

    expect(built[0]).not.toBe(built[1])
    // Same HEAD reuses the mint (F6); the FILE still gets a new stamp so a
    // streaming download of the previous artifact is not overwritten — and both
    // survive, so a request already streaming the first keeps its file.
    expect(built[0]).toContain('dev.1+aaaaaaa-linux-x86_64-20260812T182015Z')
    expect(built[1]).toContain('dev.1+aaaaaaa-linux-x86_64-20260812T193045Z')
    expect(store.names()).toContain(
      'podium-headless-0.1.0-dev.1+aaaaaaa-linux-x86_64-20260812T182015Z.tar.gz',
    )
    expect(store.names()).toContain(
      'podium-headless-0.1.0-dev.1+aaaaaaa-linux-x86_64-20260812T193045Z.tar.gz',
    )
  })

  it('records how it published, so a later restore can check it without the bytes', async () => {
    const { bytes, signature, signingKey } = signedFixture()
    const store = memoryFs()
    const built = await buildDevBundle({
      ...publisherSeams(),
      root: '/repo/podium',
      headSha: 'aaaaaaa',
      signingKey,
      fs: store.fs,
      lock: lockFixture([]),
      now: () => Date.UTC(2026, 7, 12, 18, 20, 15),
      spawnBuild: async ({ artifacts }) => {
        for (const { artifactPath } of artifacts) {
          store.blobs.set(artifactPath, bytes)
          store.text.set(artifactPath + '.sig', signature + '\n')
        }
      },
    })

    expect(JSON.parse(store.text.get(built.path + '.meta.json') as string)).toEqual({
      version: '0.1.0-dev.1+aaaaaaa',
      // WHICH platform, so a restore can tell one build's files apart without
      // re-deriving it from the file name.
      platform: 'linux-x86_64',
      digest: digestOf(bytes),
      size: bytes.length,
      keyFingerprint: devBundleKeyFingerprint(signingKey),
    })
  })

  it('a run of merges leaves two bundles on disk, not a run of them', async () => {
    // The whole point: this is the shape that filled the development host's
    // disk — one ~264 MB artifact per commit, nothing ever removed.
    const { bytes, signature, signingKey } = signedFixture()
    const store = memoryFs()
    const shas = ['1111111', '2222222', '3333333', '4444444', '5555555', '6666666']
    let head = shas[0] as string
    let minute = 0
    const publisher = createDevBundlePublisher({
      ...publisherSeams(),
      sourceCheckoutAvailable: true,
      readSourceStatus: () => '',
      readIgnoredSourceInputs: () => '',
      root: '/repo/podium',
      headSha: () => head,
      signingKey,
      fs: store.fs,
      lock: lockFixture([]),
      now: () => Date.UTC(2026, 7, 12, 18, minute, 0),
      spawnBuild: async ({ artifacts }) => {
        for (const { artifactPath } of artifacts) {
          store.blobs.set(artifactPath, bytes)
          store.text.set(artifactPath + '.sig', signature + '\n')
        }
      },
    })

    for (const sha of shas) {
      head = sha
      minute += 10
      await publisher.requestBuild(true)
    }

    const tarNames = store.names().filter((n) => n.endsWith('.tar.gz'))
    expect(tarNames).toHaveLength(2)
    expect(tarNames.some((n) => n.includes('dev.5+5555555-linux-x86_64'))).toBe(true)
    expect(tarNames.some((n) => n.includes('dev.6+6666666-linux-x86_64'))).toBe(true)
    expect((await publisher.target())?.version).toBe('0.1.0-dev.6+6666666')
  })

  it('mints a bundle per fleet platform, each from the platform’s own compile', async () => {
    const { bytes, signature, signingKey } = signedFixture()
    const store = memoryFs()
    const targets: string[] = []
    let spawns = 0
    const built = await buildDevBundle({
      ...publisherSeams(),
      root: '/repo/podium',
      headSha: 'aaaaaaa',
      signingKey,
      fs: store.fs,
      lock: lockFixture([]),
      now: () => Date.UTC(2026, 7, 12, 18, 20, 15),
      platforms: ['linux-x86_64', 'darwin-aarch64'],
      spawnBuild: async ({ artifacts }) => {
        spawns++
        for (const { artifactPath, bunTarget } of artifacts) {
          targets.push(bunTarget)
          store.blobs.set(artifactPath, bytes)
          store.text.set(artifactPath + '.sig', signature + '\n')
        }
      },
    })

    // ONE build for the whole publish, not one per platform. That is the M3 claim:
    // the clients are built or restored once inside the coordinator and every platform
    // is packaged from that single output. A second spawn here would be the publisher
    // paying for the client build again.
    expect(spawns).toBe(1)
    // Host first, then whatever else the fleet needs — the order the coordinator
    // packages in, so a later platform's failure still leaves this machine its bundle.
    // Each platform is still a SEPARATE compile with its own bun target — the same flag
    // scripts/release.ts passes, which is what makes the dev host exercise the release
    // path rather than one that merely resembles it.
    expect(targets).toEqual(['bun-linux-x64', 'bun-darwin-arm64'])
    expect(built.artifacts.map((artifact) => artifact.platform)).toEqual([
      'linux-x86_64',
      'darwin-aarch64',
    ])
    // Distinct files: one build that overwrote itself would leave the second platform
    // holding the first platform's bytes.
    expect(new Set(built.artifacts.map((artifact) => artifact.path)).size).toBe(2)
    // The flat fields keep describing THIS host's bundle.
    expect(built.path).toBe(built.artifacts[0]?.path)

    const target = devTarget(built, {
      sourceRoot: '/repo/podium',
      // POD-2502: a dev target must declare the schema it can open, or nothing may
      // converge to it. Not what this test is about, but it cannot be formed without.
      schemaMigrations: ['20260715135845_baseline'],
    })
    const headless = target.artifacts.headless
    // `bundle` delivery is the shape the dev feed publishes; anything else has no
    // per-platform artifacts to enumerate.
    expect(headless?.delivery).toBe('feed')
    const platforms = headless?.delivery === 'feed' ? headless.platforms : {}
    expect(Object.keys(platforms)).toEqual(['linux-x86_64', 'darwin-aarch64'])
    // Each platform gets its OWN address; one URL for all of them would hand every
    // machine the same bytes.
    expect(new Set(Object.values(platforms).map((artifact) => artifact.url)).size).toBe(2)
  })

  it('keeps the whole of the last two builds, not the last two files', async () => {
    // The failure this prevents: a four-platform build publishes, the sweep counts the
    // newest two files across every platform, and three quarters of the build it just
    // published are deleted — so a Mac is offered a target whose tarball is gone.
    const { bytes, signature, signingKey } = signedFixture()
    const store = memoryFs()
    const seams = publisherSeams()
    let minute = 0
    for (const sha of ['1111111', '2222222', '3333333']) {
      minute += 10
      await buildDevBundle({
        ...seams,
        root: '/repo/podium',
        headSha: sha,
        signingKey,
        fs: store.fs,
        lock: lockFixture([]),
        now: () => Date.UTC(2026, 7, 12, 18, minute, 0),
        platforms: ['linux-x86_64', 'darwin-aarch64'],
        spawnBuild: async ({ artifacts }) => {
          for (const { artifactPath } of artifacts) {
            store.blobs.set(artifactPath, bytes)
            store.text.set(artifactPath + '.sig', signature + '\n')
          }
        },
      })
    }

    const tarballs = store.names().filter((name) => name.endsWith('.tar.gz'))
    // BOTH intents, in one assertion: publisher-minted, orderable versions (POD-2502)
    // and every platform of the retained builds surviving (POD-2504). Two builds, two
    // platforms each — not "the newest two files", which would have kept only the last
    // build and left a Mac pointed at a tarball the sweep had removed.
    expect(tarballs.sort()).toEqual([
      'podium-headless-0.1.0-dev.2+2222222-darwin-aarch64-20260812T182000Z.tar.gz',
      'podium-headless-0.1.0-dev.2+2222222-linux-x86_64-20260812T182000Z.tar.gz',
      'podium-headless-0.1.0-dev.3+3333333-darwin-aarch64-20260812T183000Z.tar.gz',
      'podium-headless-0.1.0-dev.3+3333333-linux-x86_64-20260812T183000Z.tar.gz',
    ])
  })

  it('refuses the whole build when one platform comes back unsigned', async () => {
    // An unsigned bundle is one every machine would reject AFTER downloading it. The
    // refusal has to name the platform, or the operator is left guessing which compile
    // to look at.
    const { bytes, signature, signingKey } = signedFixture()
    const store = memoryFs()
    await expect(
      buildDevBundle({
        ...publisherSeams(),
        root: '/repo/podium',
        headSha: 'aaaaaaa',
        signingKey,
        fs: store.fs,
        lock: lockFixture([]),
        now: () => Date.UTC(2026, 7, 12, 18, 20, 15),
        platforms: ['linux-x86_64', 'darwin-aarch64'],
        spawnBuild: async ({ artifacts }) => {
          for (const { artifactPath, bunTarget } of artifacts) {
            store.blobs.set(artifactPath, bytes)
            if (bunTarget !== 'bun-darwin-arm64') {
              store.text.set(artifactPath + '.sig', signature + '\n')
            }
          }
        },
      }),
    ).rejects.toThrow(/darwin-aarch64 is unsigned/)
  })

  it('reclaims a bundle that no longer covers the fleet, so the next build mints it', async () => {
    // A Mac enrolled since the last build. The bundle on disk is perfectly valid and
    // perfectly short: publishing it would offer that Mac a manifest with no entry for
    // it, so recovery must decline and let the build run.
    const { bytes, signature, signingKey } = signedFixture()
    const store = published({
      sha: 'aaaaaaa',
      stamp: '20260812T182015Z',
      bytes,
      signature,
      signingKey,
    })
    let builds = 0
    const publisher = createDevBundlePublisher({
      ...publisherSeams(),
      sourceCheckoutAvailable: true,
      readSourceStatus: () => '',
      readIgnoredSourceInputs: () => '',
      root: '/repo/podium',
      headSha: () => 'aaaaaaa',
      signingKey,
      fs: store.fs,
      lock: lockFixture([]),
      now: () => Date.UTC(2026, 7, 12, 19, 0, 0),
      fleetPlatforms: () => ['linux-x86_64', 'darwin-aarch64'],
      spawnBuild: async ({ artifacts }) => {
        builds++
        for (const { artifactPath } of artifacts) {
          store.blobs.set(artifactPath, bytes)
          store.text.set(artifactPath + '.sig', signature + '\n')
        }
      },
    })

    const built = await publisher.requestBuild(true)

    // The build ran rather than the short bundle being restored — ONCE, for both
    // platforms. It used to be one spawn per platform, and so one client build per
    // platform; the coordinator now builds the clients once and packages both from it.
    expect(builds).toBe(1)
    expect(built?.artifacts.map((artifact) => artifact.platform)).toEqual([
      'linux-x86_64',
      'darwin-aarch64',
    ])
  })

  it('reclaims a backlog on restart, from the restore path, without compiling', async () => {
    // Retention that only ran after a successful build would never reach what a
    // crash, a failed compile or a plain shutdown left behind.
    const { bytes, signature, signingKey } = signedFixture()
    const store = published({
      sha: 'aaaaaaa',
      stamp: '20260812T190000Z',
      bytes,
      signature,
      signingKey,
    })
    for (const [sha, stamp] of [
      ['1111111', '20260812T160000Z'],
      ['2222222', '20260812T170000Z'],
      ['3333333', '20260812T180000Z'],
    ] as const) {
      const path = '/repo/podium/dist-bun/' + devBundleFileName('dev+' + sha, stamp)
      store.blobs.set(path, bytes)
      store.text.set(path + '.sig', signature + '\n')
    }
    let builds = 0
    const publisher = createDevBundlePublisher({
      ...publisherSeams(),
      sourceCheckoutAvailable: true,
      readSourceStatus: () => '',
      readIgnoredSourceInputs: () => '',
      root: '/repo/podium',
      headSha: () => 'aaaaaaa',
      signingKey,
      fs: store.fs,
      lock: lockFixture([]),
      spawnBuild: async ({ artifacts }) => {
        builds++
        return artifacts.map(({ platform }) => ({ platform, signature }))
      },
    })

    await publisher.requestBuild(true)

    expect(builds).toBe(0)
    // Reference-based retention keeps the restored artifact and the previous
    // recognised publisher bundle (DEV_BUNDLE_RETAINED=2), even after state loss —
    // and the legacy names (no platform in them) drain through the same group as
    // today's host bundles rather than being retained forever in a group nothing new
    // is ever added to.
    expect(store.names().sort()).toEqual(
      [
        'podium-headless-dev+3333333-20260812T180000Z.tar.gz',
        'podium-headless-dev+3333333-20260812T180000Z.tar.gz.sig',
        'podium-headless-0.1.0-dev.1+aaaaaaa-linux-x86_64-20260812T190000Z.tar.gz',
        'podium-headless-0.1.0-dev.1+aaaaaaa-linux-x86_64-20260812T190000Z.tar.gz.meta.json',
        'podium-headless-0.1.0-dev.1+aaaaaaa-linux-x86_64-20260812T190000Z.tar.gz.sig',
      ].sort(),
    )
  })

  it('releases the lease and keeps a failed build unpublished', async () => {
    const events: string[] = []
    await expect(
      buildDevBundle({
        ...publisherSeams(),
        headSha: '123456789abcdef',
        fs: stubFs(),
        lock: lockFixture(events),
        spawnBuild: async () => {
          events.push('build')
          throw new Error('compile failed')
        },
      }),
    ).rejects.toThrow('compile failed')
    expect(events).toEqual(['acquire', 'build', 'release'])
  })

  it('restores the published HEAD artifact after a publisher restart without rebuilding', async () => {
    const { bytes, signature, signingKey } = signedFixture()
    const store = published({
      sha: 'aaaaaaa',
      stamp: '20260812T182015Z',
      bytes,
      signature,
      signingKey,
    })
    let builds = 0
    const publisher = createDevBundlePublisher({
      ...publisherSeams(),
      sourceCheckoutAvailable: true,
      readSourceStatus: () => '',
      readIgnoredSourceInputs: () => '',
      root: '/repo/podium',
      headSha: () => 'aaaaaaa',
      signingKey,
      fs: store.fs,
      lock: lockFixture([]),
      spawnBuild: async ({ artifacts }) => {
        builds++
        return artifacts.map(({ platform }) => ({ platform, signature }))
      },
    })

    const restored = await publisher.requestBuild(true)

    expect(builds).toBe(0)
    expect(restored).toMatchObject({
      version: '0.1.0-dev.1+aaaaaaa',
      path: '/repo/podium/dist-bun/podium-headless-0.1.0-dev.1+aaaaaaa-linux-x86_64-20260812T182015Z.tar.gz',
      signature,
    })
    expect(restored?.digest).toBe(digestOf(bytes))
    expect((await publisher.target())?.version).toBe('0.1.0-dev.1+aaaaaaa')
  })

  it('rebuilds rather than restore an artifact this server did not publish', async () => {
    const { bytes, signature, signingKey } = signedFixture()
    const cases: Array<{ label: string; store: ReturnType<typeof memoryFs> }> = [
      {
        label: 'no publication metadata at all',
        store: (() => {
          const store = published({
            sha: 'aaaaaaa',
            stamp: '20260812T182015Z',
            bytes,
            signature,
            signingKey,
          })
          store.text.delete(
            '/repo/podium/dist-bun/podium-headless-0.1.0-dev.1+aaaaaaa-linux-x86_64-20260812T182015Z.tar.gz.meta.json',
          )
          return store
        })(),
      },
      {
        label: 'signed under a key this server no longer holds',
        store: published({
          sha: 'aaaaaaa',
          stamp: '20260812T182015Z',
          bytes,
          signature,
          signingKey: signedFixture().signingKey,
        }),
      },
      {
        label: 'a truncated tarball',
        store: (() => {
          const store = published({
            sha: 'aaaaaaa',
            stamp: '20260812T182015Z',
            bytes,
            signature,
            signingKey,
          })
          store.blobs.set(
            '/repo/podium/dist-bun/podium-headless-0.1.0-dev.1+aaaaaaa-linux-x86_64-20260812T182015Z.tar.gz',
            bytes.slice(0, 2),
          )
          return store
        })(),
      },
    ]

    for (const { label, store } of cases) {
      let builds = 0
      const publisher = createDevBundlePublisher({
        ...publisherSeams(),
        sourceCheckoutAvailable: true,
        readSourceStatus: () => '',
        readIgnoredSourceInputs: () => '',
        root: '/repo/podium',
        headSha: () => 'aaaaaaa',
        signingKey,
        fs: store.fs,
        lock: lockFixture([]),
        spawnBuild: async ({ artifacts }) => {
          builds++
          return artifacts.map(({ platform, artifactPath }) => {
            store.blobs.set(artifactPath, bytes)
            return { platform, signature }
          })
        },
      })

      await publisher.requestBuild(true)
      expect(builds, label).toBe(1)
    }
  })

  it('keeps the previous bundle but stops advertising it after a later build fails', async () => {
    const { bytes, signature } = signedFixture()
    let head = 'aaaaaaa'
    let attempts = 0
    const events: string[] = []
    const publisher = createDevBundlePublisher({
      ...publisherSeams(),
      sourceCheckoutAvailable: true,
      readSourceStatus: () => '',
      readIgnoredSourceInputs: () => '',
      headSha: () => head,
      fs: stubFs(),
      lock: lockFixture(events),
      now: () => 100_000,
      spawnBuild: async ({ version, artifacts }) => {
        attempts++
        if (attempts === 2) throw new Error('second compile failed')
        return artifacts.map(({ platform }) => ({
          platform,
          path: '/stage/' + version,
          signature,
        }))
      },
    })

    await publisher.requestBuild(true)
    expect((await publisher.target())?.version).toBe('0.1.0-dev.1+aaaaaaa')
    head = 'bbbbbbb'
    await expect(publisher.requestBuild(true)).rejects.toThrow('second compile failed')
    // The signed bytes for the old commit survive — a later request at that sha
    // can still restore them — but they are no longer offered as the target,
    // because they are not what this server is running.
    expect(publisher.current()?.version).toBe('0.1.0-dev.1+aaaaaaa')
    expect((await publisher.target())?.version?.endsWith('+bbbbbbb')).toBe(true)
    expect((await publisher.target())?.version?.startsWith('dev+')).toBe(false)
    expect((await publisher.target())?.artifacts.web).toEqual({
      digest: 'bbbbbbb',
    })
    expect((await publisher.target())?.artifacts.headless).toBeUndefined()
  })

  it('refuses to build or restore anything from a dirty checkout', async () => {
    const { bytes, signature, signingKey } = signedFixture()
    const store = published({
      sha: 'aaaaaaa',
      stamp: '20260812T182015Z',
      bytes,
      signature,
      signingKey,
    })
    let builds = 0
    let reads = 0
    const publisher = createDevBundlePublisher({
      ...publisherSeams(),
      sourceCheckoutAvailable: true,
      root: '/repo/podium',
      headSha: () => 'aaaaaaa',
      signingKey,
      readSourceStatus: () => nul(' M apps/server/src/server.ts', '?? dist-bun/keep.tar.gz'),
      readIgnoredSourceInputs: () => '',
      fs: {
        ...store.fs,
        digest: async (path) => {
          reads++
          return store.fs.digest(path)
        },
      },
      lock: lockFixture([]),
      spawnBuild: async ({ artifacts }) => {
        builds++
        return artifacts.map(({ platform }) => ({ platform, signature }))
      },
    })

    await expect(publisher.requestBuild(true)).rejects.toThrow(
      /does not match HEAD \(aaaaaaa\).*apps\/server\/src\/server\.ts/s,
    )
    // Neither compiled, nor republished an artifact left over from that sha.
    expect(builds).toBe(0)
    expect(reads).toBe(0)
    expect(publisher.current()).toBeNull()
    expect(await publisher.target()).toBeUndefined()
    expect(publisher.unavailable()).toContain('apps/server/src/server.ts')
    // And nothing was reclaimed: a refusal is not a licence to touch the disk.
    expect(store.names()).toContain(
      'podium-headless-0.1.0-dev.1+aaaaaaa-linux-x86_64-20260812T182015Z.tar.gz',
    )
  })

  it('refuses when the checkout cannot be verified at all', async () => {
    const publisher = createDevBundlePublisher({
      ...publisherSeams(),
      sourceCheckoutAvailable: true,
      headSha: () => 'aaaaaaa',
      readSourceStatus: () => {
        throw new Error('not a git repository')
      },
      readIgnoredSourceInputs: () => '',
      fs: stubFs(),
      lock: lockFixture([]),
      spawnBuild: async () => {
        throw new Error('should not build')
      },
    })

    await expect(publisher.requestBuild(true)).rejects.toThrow(
      /could not verify the source checkout.*not a git repository/s,
    )
  })

  it('clears the diagnostic once the checkout is clean again', async () => {
    const { bytes, signature } = signedFixture()
    let porcelain = nul(' M apps/server/src/server.ts')
    const publisher = createDevBundlePublisher({
      ...publisherSeams(),
      sourceCheckoutAvailable: true,
      headSha: () => 'aaaaaaa',
      readSourceStatus: () => porcelain,
      readIgnoredSourceInputs: () => '',
      fs: stubFs(),
      lock: lockFixture([]),
      spawnBuild: async ({ version, artifacts }) =>
        artifacts.map(({ platform }) => ({ platform, path: '/stage/' + version, signature })),
    })

    await expect(publisher.requestBuild(true)).rejects.toThrow(/does not match HEAD/)
    porcelain = ''
    await publisher.requestBuild(true)

    expect(publisher.current()?.version).toBe('0.1.0-dev.1+aaaaaaa')
    expect(publisher.unavailable()).toBeUndefined()
  })

  /**
   * The one build at a time rule, under the shape that can actually break it.
   *
   * Deciding whether to build now takes awaits — HEAD and the two tree walks
   * are `git` subprocesses, off the server's event loop (POD-2048) — so the
   * `inFlight` check and the assignment that satisfies it no longer happen in
   * one synchronous turn. Both seams here are asynchronous ON PURPOSE: with
   * synchronous stand-ins the two requests could not interleave and the test
   * would pass whether or not admissions are serialised.
   */
  it('coalesces concurrent explicit requests into one build', async () => {
    let resolveBuildStarted!: () => void
    const buildStarted = new Promise<void>((resolve) => {
      resolveBuildStarted = resolve
    })
    const { bytes, signature } = signedFixture()
    let resolveBuild!: () => void
    const buildDone = new Promise<void>((resolve) => {
      resolveBuild = resolve
    })
    let builds = 0
    const publisher = createDevBundlePublisher({
      ...publisherSeams(),
      sourceCheckoutAvailable: true,
      headSha: async () => 'aaaaaaa',
      readSourceStatus: async () => '',
      readIgnoredSourceInputs: async () => '',
      fs: stubFs(),
      lock: lockFixture([]),
      spawnBuild: async ({ version, artifacts }) => {
        builds++
        resolveBuildStarted()
        await buildDone
        return artifacts.map(({ platform }) => ({
          platform,
          path: '/stage/' + version,
          signature,
        }))
      },
    })

    const first = publisher.requestBuild(true)
    const second = publisher.requestBuild(true)
    await buildStarted
    expect(builds).toBe(1)
    resolveBuild()
    // The second request is answered by the first one's compile — the same
    // descriptor, not a second quarter-gigabyte tarball.
    expect(await second).toBe(await first)
    expect(builds).toBe(1)
  })
})

describe('development bundle readiness', () => {
  function readinessFixture(options: { porcelain?: () => string } = {}) {
    const { bytes, signature } = signedFixture()
    let head = 'aaaaaaa'
    let fail: string | null = null
    const publisher = createDevBundlePublisher({
      ...publisherSeams(),
      sourceCheckoutAvailable: true,
      headSha: () => head,
      readSourceStatus: options.porcelain ?? (() => ''),
      readIgnoredSourceInputs: () => '',
      fs: stubFs(),
      lock: lockFixture([]),
      now: () => 100_000,
      spawnBuild: async ({ version, artifacts }) => {
        if (fail) throw new Error(fail)
        return artifacts.map(({ platform }) => ({
          platform,
          path: '/stage/' + version,
          signature,
        }))
      },
    })
    return {
      publisher,
      moveHead: (sha: string) => {
        head = sha
      },
      failNextBuild: (message: string | null) => {
        fail = message
      },
    }
  }

  it('is idle before anything has been built for this HEAD', async () => {
    const { publisher } = readinessFixture()
    expect(await publisher.readiness()).toEqual({
      state: 'idle',
      headSha: 'aaaaaaa',
    })
  })

  it('is ready, with the version, once HEAD is built', async () => {
    const { publisher } = readinessFixture()
    await publisher.requestBuild(true)
    expect(await publisher.readiness()).toEqual({
      state: 'ready',
      headSha: 'aaaaaaa',
      version: '0.1.0-dev.1+aaaaaaa',
    })
    expect((await publisher.target())?.version).toBe('0.1.0-dev.1+aaaaaaa')
  })

  it('withdraws the old target the moment HEAD advances', async () => {
    const { publisher, moveHead } = readinessFixture()
    await publisher.requestBuild(true)
    moveHead('bbbbbbb')

    // The bundle still exists and is still dev+aaaaaaa; it is simply not the
    // target for the commit this server is now running.
    expect(publisher.current()?.version).toBe('0.1.0-dev.1+aaaaaaa')
    expect((await publisher.target())?.version?.endsWith('+bbbbbbb')).toBe(true)
    expect((await publisher.target())?.version?.startsWith('dev+')).toBe(false)
    expect((await publisher.target())?.artifacts.web).toEqual({
      digest: 'bbbbbbb',
    })
    expect((await publisher.target())?.artifacts.headless).toBeUndefined()
    expect(await publisher.readiness()).toEqual({
      state: 'idle',
      headSha: 'bbbbbbb',
    })
  })

  it('reports failed for the new HEAD, not ready from the old one', async () => {
    const { publisher, moveHead, failNextBuild } = readinessFixture()
    await publisher.requestBuild(true)
    moveHead('bbbbbbb')
    failNextBuild('compile blew up')
    await expect(publisher.requestBuild(true)).rejects.toThrow('compile blew up')

    const readiness = await publisher.readiness()
    expect(readiness.state).toBe('failed')
    expect(readiness).toMatchObject({
      headSha: 'bbbbbbb',
      reason: 'compile blew up',
      publicReason: 'Building the development bundle for dev+bbbbbbb failed. See the server log.',
    })
    expect((await publisher.target())?.version?.endsWith('+bbbbbbb')).toBe(true)
    expect((await publisher.target())?.version?.startsWith('dev+')).toBe(false)
    expect((await publisher.target())?.artifacts.web).toEqual({
      digest: 'bbbbbbb',
    })
  })

  it('keeps a dirty checkout out of the public reason while the log gets the paths', async () => {
    const { publisher } = readinessFixture({
      porcelain: () => nul(' M apps/server/src/server.ts', '?? apps/web/scratch.ts'),
    })
    await expect(publisher.requestBuild(true)).rejects.toThrow(/does not match HEAD/)

    const readiness = await publisher.readiness()
    expect(readiness).toMatchObject({
      state: 'failed',
      headSha: 'aaaaaaa',
      publicReason:
        'The source checkout has 2 uncommitted changes and no longer matches HEAD (aaaaaaa). ' +
        'Commit or stash them to publish dev+aaaaaaa.',
    })
    // The operator's copy names the files; the client's copy never does.
    expect(publisher.unavailable()).toContain('apps/server/src/server.ts')
    expect(readiness.state === 'failed' && readiness.publicReason).not.toContain('apps/')
  })

  /**
   * `dirty-working-tree` is still produced HERE, on the publisher, not on a
   * retired git-delivery consumer. The shared table must classify the real
   * sentence `assertSourceMatchesHead` writes, not only the table's own
   * example.
   */
  it('classifies a dirty checkout as dirty-working-tree from the real constructor', async () => {
    let caught: unknown
    try {
      await assertSourceMatchesHead('/repo', 'aaaaaaa', async () =>
        nul(' M apps/server/src/server.ts'),
      )
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    const refusal = caught as Error & { publicReason?: string }
    expect(matchUpdateFailureToken(refusal.publicReason ?? '')).toBe('dirty-working-tree')
    expect(matchUpdateFailureToken(refusal.message)).toBe('dirty-working-tree')
  })

  it('does not carry an old HEAD failure into a new one', async () => {
    const { publisher, moveHead, failNextBuild } = readinessFixture()
    failNextBuild('compile blew up')
    await expect(publisher.requestBuild(true)).rejects.toThrow('compile blew up')
    expect((await publisher.readiness()).state).toBe('failed')

    moveHead('bbbbbbb')
    expect(await publisher.readiness()).toEqual({
      state: 'idle',
      headSha: 'bbbbbbb',
    })
  })

  it('is preparing while a build for this HEAD is in flight', async () => {
    const { bytes, signature } = signedFixture()
    let resolveBuild!: () => void
    const buildDone = new Promise<void>((resolve) => {
      resolveBuild = resolve
    })
    let announceAdmitted!: () => void
    const admitted = new Promise<void>((resolve) => {
      announceAdmitted = resolve
    })
    const publisher = createDevBundlePublisher({
      ...publisherSeams(),
      sourceCheckoutAvailable: true,
      headSha: async () => 'aaaaaaa',
      readSourceStatus: async () => '',
      readIgnoredSourceInputs: async () => '',
      fs: stubFs(),
      lock: lockFixture([]),
      onAdmitted: () => {
        announceAdmitted()
      },
      spawnBuild: async ({ version, artifacts }) => {
        await buildDone
        return artifacts.map(({ platform }) => ({
          platform,
          path: '/stage/' + version,
          signature,
        }))
      },
    })

    const built = publisher.requestBuild(true)
    // `onAdmitted`, not the call returning: admission reads HEAD and walks the
    // tree off the loop, so a request is not yet in flight when `requestBuild`
    // hands back its promise. This is the moment the read model is told to stop
    // advertising the previous commit's target.
    await admitted
    expect(await publisher.readiness()).toEqual({
      state: 'preparing',
      headSha: 'aaaaaaa',
    })
    resolveBuild()
    await built
    expect((await publisher.readiness()).state).toBe('ready')
  })
})

describe('ignored source inputs gate the build', () => {
  it('refuses a checkout whose ignored files include importable source', async () => {
    const { bytes, signature } = signedFixture()
    let builds = 0
    const publisher = createDevBundlePublisher({
      ...publisherSeams(),
      sourceCheckoutAvailable: true,
      headSha: () => 'aaaaaaa',
      // Clean by git status — the first query sees nothing at all.
      readSourceStatus: () => '',
      readIgnoredSourceInputs: () => nul('apps/server/src/local-override.ts'),
      fs: stubFs(),
      lock: lockFixture([]),
      spawnBuild: async ({ artifacts }) => {
        builds++
        return artifacts.map(({ platform }) => ({ platform, signature }))
      },
    })

    await expect(publisher.requestBuild(true)).rejects.toThrow(
      /ignored source files.*apps\/server\/src\/local-override\.ts/s,
    )
    expect(builds).toBe(0)
    expect(await publisher.readiness()).toMatchObject({
      state: 'failed',
      publicReason:
        'The source checkout has 1 ignored source file that could be compiled into ' +
        'dev+aaaaaaa without being part of HEAD (aaaaaaa).',
    })
  })

  it('builds when the ignored files are only outputs and evidence', async () => {
    const { bytes, signature } = signedFixture()
    const publisher = createDevBundlePublisher({
      ...publisherSeams(),
      sourceCheckoutAvailable: true,
      headSha: () => 'aaaaaaa',
      readSourceStatus: () => '',
      readIgnoredSourceInputs: () =>
        nul('apps/server/node_modules/left-pad/index.js', 'apps/web/shot.png'),
      fs: stubFs(),
      lock: lockFixture([]),
      spawnBuild: async ({ version, artifacts }) =>
        artifacts.map(({ platform }) => ({ platform, path: '/stage/' + version, signature })),
    })

    await publisher.requestBuild(true)
    expect((await publisher.readiness()).state).toBe('ready')
  })

  it('refuses when the ignored-source query itself cannot be run', async () => {
    const publisher = createDevBundlePublisher({
      ...publisherSeams(),
      sourceCheckoutAvailable: true,
      headSha: () => 'aaaaaaa',
      readSourceStatus: () => '',
      readIgnoredSourceInputs: () => {
        throw new Error('git exploded')
      },
      fs: stubFs(),
      lock: lockFixture([]),
      spawnBuild: async () => {
        throw new Error('should not build')
      },
    })

    await expect(publisher.requestBuild(true)).rejects.toThrow(
      /could not enumerate ignored source inputs.*git exploded/s,
    )
  })
})

/**
 * WHAT A TARGET SAYS ABOUT THE DATABASE IT CAN OPEN (POD-2213).
 *
 * A daemon cannot look inside the build it is about to swap in, so the target
 * carries the migration list, and the publisher reads it from the commit it is
 * advertising — never from the build it happens to be running, which is the one
 * case (a checkout going backwards) where those two differ and the difference
 * bricks the install.
 */
describe('development targets declare the schema they can open', () => {
  const migrations = ['20260715135845_baseline', '20260816092917_operations-table']

  it('declares the migrations defined at the advertised commit', () => {
    const target = devIdentityTarget('0.1.0-dev.1+f9485d3', 'f9485d31b', {
      sourceRoot: '/repo/podium',
      schemaMigrations: migrations,
    })
    expect(target.schema).toEqual({ migrations })
  })

  it('refuses an identity target without migration declarations', () => {
    expect(() =>
      devIdentityTarget('0.1.0-dev.1+f9485d3', 'f9485d31b', {
        sourceRoot: '/repo/podium',
      }),
    ).toThrow(/no migrations found/)
  })

  it('publishes the declaration with the identity target', async () => {
    const publisher = createDevBundlePublisher({
      ...publisherSeams(),
      sourceCheckoutAvailable: true,
      headSha: () => 'f9485d31b',
      root: '/repo/podium',
      migrationsAt: async (sha: string) => (sha === 'f9485d3' ? migrations : undefined),
      readSourceStatus: () => '',
      readIgnoredSourceInputs: () => '',
      fs: stubFs(),
      lock: lockFixture([]),
      spawnBuild: async () => {
        throw new Error('should not build')
      },
    })
    expect((await publisher.target())?.schema).toEqual({ migrations })
  })

  it('reports a corrupt publisher state as no target instead of throwing', async () => {
    // `dev-publisher-wiring.ts` calls `publishReadiness()` as a floating promise
    // with no `.catch`, and that awaits `target()`. Minting reads the checkout's
    // package.json, reads and rewrites publisher state and fails closed when it
    // cannot prove the mint is newer — so an unwrapped throw here is an
    // unhandled rejection on the live server, where the honest answer is "no
    // release available, and here is why".
    const stateDir = publisherDir()
    writeFileSync(join(stateDir, 'dev-publisher-version.json'), '{ not json at all')
    const publisher = createDevBundlePublisher({
      ...publisherSeams(),
      publisherStateDir: stateDir,
      sourceCheckoutAvailable: true,
      headSha: () => 'f9485d31b',
      root: '/repo/podium',
      migrationsAt: async () => migrations,
      readSourceStatus: () => '',
      readIgnoredSourceInputs: () => '',
      fs: stubFs(),
      lock: lockFixture([]),
      spawnBuild: async () => {
        throw new Error('should not build')
      },
    })
    expect(await publisher.target()).toBeUndefined()
    expect(publisher.unavailable()).toMatch(/invalid persisted development publisher state/)
  })

  it('refuses to publish a target when migrations cannot be declared', async () => {
    const publisher = createDevBundlePublisher({
      ...publisherSeams(),
      sourceCheckoutAvailable: true,
      headSha: () => 'f9485d31b',
      root: '/repo/podium',
      migrationsAt: async () => undefined,
      readSourceStatus: () => '',
      readIgnoredSourceInputs: () => '',
      fs: stubFs(),
      lock: lockFixture([]),
      spawnBuild: async () => {
        throw new Error('should not build')
      },
    })
    expect(await publisher.target()).toBeUndefined()
    expect(publisher.unavailable()).toMatch(/no migrations found/)
    expect(() => requireDefinedMigrations(undefined, 'f9485d3')).toThrow(/no migrations found/)
  })

  it('refuses to form a built target without schema migrations', () => {
    expect(() =>
      devTarget(
        {
          version: '0.1.0-dev.1+1234567',
          path: '/x',
          size: 1,
          digest: 'sha256-x',
          signature: 'sig',
          artifacts: [
            {
              platform: 'linux-x86_64',
              path: '/x',
              size: 1,
              digest: 'sha256-x',
              signature: 'sig',
              version: '0.1.0-dev.1+1234567',
            },
          ],
        },
        { sourceRoot: '/repo/podium' },
      ),
    ).toThrow(/no migrations found/)
  })
})

/**
 * PUBLISHING IS WRITING THE MANIFEST (spec §6 step 4).
 *
 * The publisher used to PUSH a deliverable target straight into the updates
 * service. It writes a `podium-update.json` into its served feed directory
 * instead, and the ordinary resolver pulls it back — which is what makes the
 * dev channel resolve through the same code as edge and stable.
 *
 * These arms are about that document: that it is written only for a release
 * that really exists at THIS commit, that it is a manifest the shared parser
 * accepts, and that it never names its own trust root.
 */
describe('the dev feed manifest the publisher writes', () => {
  // Two shells that a reader can tell apart at a glance — different versions, and each
  // served from its own standing release. Which one a dev server hands out is the whole
  // question this suite exists to answer, so the fixtures must never be interchangeable.
  const devShellManifest = {
    version: '0.4.3-dev.2',
    bridgeVersion: 1,
    platforms: {
      'linux-x86_64': {
        url: 'https://github.com/madeinorbit/podium/releases/download/dev/Podium_0.4.3-dev.2_amd64.AppImage',
        signature: 'DEV-SIGNATURE',
      },
    },
  }
  const edgeShellManifest = {
    version: '0.4.2-edge.7',
    bridgeVersion: 1,
    platforms: {
      'linux-x86_64': {
        url: 'https://github.com/madeinorbit/podium/releases/download/edge/Podium_0.4.2-edge.7_amd64.AppImage',
        signature: 'EDGE-SIGNATURE',
      },
    },
  }

  function publisherFor(
    store: ReturnType<typeof memoryFs>,
    head: () => string,
    proposalFacts: NonNullable<
      Parameters<typeof createDevBundlePublisher>[0]['proposalFacts']
    > = async ({ headSha }) => ({
      branch: 'main',
      commits: [{ sha: headSha, summary: `Commit ${headSha}` }],
      addedMigrations: [],
    }),
    /** Lets a test hold the build open and observe the publisher mid-flight. */
    holdBuild?: () => Promise<void>,
    fixture = signedFixture(),
    shells: Partial<Record<DesktopFeedChannel, unknown>> = {
      dev: devShellManifest,
      edge: edgeShellManifest,
    },
    timing?: ReleaseBuildTimingDeps,
  ) {
    const { bytes, signature, signingKey } = fixture
    return createDevBundlePublisher({
      ...publisherSeams(),
      sourceCheckoutAvailable: true,
      readSourceStatus: () => '',
      readIgnoredSourceInputs: () => '',
      root: '/repo/podium',
      headSha: head,
      proposalRunningVersion: 'dev+1111111',
      proposalRunningSha: '1111111',
      proposalFacts,
      snapshotBuild: async (_approvedSha, build) => build('/repo/podium-snapshot'),
      platform: 'linux-x86_64',
      signingKey,
      ...(timing ? { timing } : {}),
      fs: store.fs,
      lock: lockFixture([]),
      artifactUrl: (version) =>
        `https://ludovico.test/updates/feed/dev/artifact/${encodeURIComponent(version)}?token=t`,
      desktopShellManifest: async (channel) => {
        const raw = shells[channel]
        return raw === undefined
          ? { missing: `${channel} desktop manifest returned HTTP 404` }
          : { raw }
      },
      now: () => Date.UTC(2026, 7, 12, 18, 20, 15),
      spawnBuild: async ({ artifacts }) => {
        await holdBuild?.()
        for (const { artifactPath } of artifacts) {
          store.blobs.set(artifactPath, bytes)
          store.text.set(`${artifactPath}.sig`, `${signature}\n`)
        }
      },
    })
  }

  it('records artifact publication, desktop work, and feed activation at distinct boundaries', async () => {
    const store = memoryFs()
    const records: ReleaseBuildTimingRecord[] = []
    let tick = 0
    const timing: ReleaseBuildTimingDeps = {
      enabled: true,
      now: () => ++tick,
      emit: (record) => records.push(record),
    }
    const publisher = publisherFor(
      store,
      () => 'aaaaaaa',
      undefined,
      undefined,
      undefined,
      undefined,
      timing,
    )

    await publisher.requestBuild(true)
    expect(await publisher.publishFeed()).toBe(true)

    expect(
      records
        .filter((record) => record.granularity === 'task')
        .filter((record) =>
          ['artifact-publication', 'desktop-work', 'feed-activation'].includes(record.phase),
        )
        .map((record) => [record.phase, record.task, record.outcome]),
    ).toEqual([
      ['artifact-publication', 'describe-artifact', 'success'],
      ['artifact-publication', 'retention', 'success'],
      ['desktop-work', 'resolve-standing-shell', 'success'],
      ['feed-activation', 'write-feed-manifests', 'success'],
    ])
  })

  it('records feed activation failure without relabeling desktop resolution', async () => {
    const store = memoryFs()
    const records: ReleaseBuildTimingRecord[] = []
    let tick = 0
    const timing: ReleaseBuildTimingDeps = {
      enabled: true,
      now: () => ++tick,
      emit: (record) => records.push(record),
    }
    const publisher = publisherFor(
      store,
      () => 'aaaaaaa',
      undefined,
      undefined,
      undefined,
      undefined,
      timing,
    )
    await publisher.requestBuild(true)
    const writeText = store.fs.writeText
    store.fs.writeText = async (path, contents) => {
      if (path === publisher.feedManifestPath()) throw new Error('feed write failed')
      return writeText(path, contents)
    }

    expect(await publisher.publishFeed()).toBe(false)
    const tasks = records.filter((record) => record.granularity === 'task')
    expect(tasks).toContainEqual(
      expect.objectContaining({
        phase: 'desktop-work',
        task: 'resolve-standing-shell',
        outcome: 'success',
      }),
    )
    expect(tasks).toContainEqual(
      expect.objectContaining({
        phase: 'feed-activation',
        task: 'write-feed-manifests',
        outcome: 'failure',
      }),
    )
  })

  it('writes nothing until a release for this commit has actually been built', async () => {
    const store = memoryFs()
    const publisher = publisherFor(store, () => 'aaaaaaa')

    expect(await publisher.feedManifest()).toBeUndefined()
    expect(await publisher.publishFeed()).toBe(false)
    expect(store.names()).not.toContain('podium-update.json')
  })

  it('refuses to build when HEAD moved after the proposal was approved', async () => {
    const store = memoryFs()
    const publisher = publisherFor(store, () => 'bbbbbbb')

    await expect(
      publisher.requestBuild(true, {
        headSha: 'aaaaaaa',
        version: '0.1.0-dev.1+aaaaaaa',
      }),
    ).rejects.toThrow(/approval named aaaaaaa, but HEAD is bbbbbbb/)
    expect(store.names()).not.toContain('podium-update.json')
  })

  it('keeps tracked snapshot byte drift unpublished after a platform compile', async () => {
    const parent = publisherDir()
    const root = join(parent, 'repo')
    mkdirSync(root)
    execFileSync('git', ['init', '--quiet'], { cwd: root })
    execFileSync('git', ['config', 'user.email', 'bundle@test.invalid'], {
      cwd: root,
    })
    execFileSync('git', ['config', 'user.name', 'Bundle Test'], { cwd: root })
    writeFileSync(join(root, 'package.json'), '{"version":"0.1.0-edge.20"}\n')
    writeFileSync(join(root, 'approved-source.ts'), 'export const bytes = "approved"\n')
    execFileSync('git', ['add', '.'], { cwd: root })
    execFileSync('git', ['commit', '--quiet', '-m', 'approved'], { cwd: root })
    const sha = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim()
    const store = memoryFs()
    const { bytes, signature, signingKey } = signedFixture()
    const publisher = createDevBundlePublisher({
      ...publisherSeams(),
      root,
      sourceCheckoutAvailable: true,
      headSha: () => sha,
      readSourceStatus: () => '',
      readIgnoredSourceInputs: () => '',
      proposalFacts: async () => ({
        branch: 'main',
        commits: [{ sha, summary: 'Approved' }],
        addedMigrations: [],
      }),
      snapshotBuild: (approvedSha, build) =>
        withDevBuildSnapshot({ sourceRoot: root, approvedSha, install: async () => {} }, build),
      signingKey,
      fs: store.fs,
      lock: lockFixture([]),
      platform: 'linux-x86_64',
      spawnBuild: async ({ root: snapshotRoot, artifacts }) => {
        for (const { artifactPath } of artifacts) {
          store.blobs.set(artifactPath, bytes)
          store.text.set(`${artifactPath}.sig`, `${signature}\n`)
        }
        writeFileSync(
          join(snapshotRoot, 'approved-source.ts'),
          'export const bytes = "mutated during compile"\n',
        )
      },
    })
    const approved = await publisher.proposal()
    expect(approved).toBeDefined()

    await expect(publisher.requestBuild(true, approved)).rejects.toThrow(
      /snapshot .* changed while building; refusing to publish/i,
    )
    expect(await publisher.publishFeed()).toBe(false)
    expect(store.names()).toEqual([])
  })

  it('serves the dev shell, and says so, when a dev desktop release exists', async () => {
    const store = memoryFs()
    const publisher = publisherFor(store, () => 'aaaaaaa')
    await publisher.requestBuild(true)
    expect(await publisher.publishFeed()).toBe(true)

    const served = JSON.parse(await store.fs.readText(publisher.desktopManifestPath()))
    expect(served).toMatchObject({ version: '0.4.3-dev.2' })
    // Not "we asked for dev" — what the served document actually names.
    expect(desktopManifestFeedChannel(served)).toBe('dev')
    expect(publisher.desktopManifestSource()).toEqual({ channel: 'dev' })
  })

  it('falls back to the edge shell when no dev desktop release exists, and reports it', async () => {
    // An instance with no dev desktop release must keep working exactly as it did before
    // the dev channel existed. What must NOT happen is it working silently: a server
    // handing out an edge build while every label says dev is the defect this guards.
    const store = memoryFs()
    const publisher = publisherFor(store, () => 'aaaaaaa', undefined, undefined, undefined, {
      edge: edgeShellManifest,
    })
    await publisher.requestBuild(true)
    expect(await publisher.publishFeed()).toBe(true)

    const served = JSON.parse(await store.fs.readText(publisher.desktopManifestPath()))
    expect(served).toMatchObject({ version: '0.4.2-edge.7' })
    expect(desktopManifestFeedChannel(served)).toBe('edge')
    const source = publisher.desktopManifestSource()
    expect(source?.channel).toBe('edge')
    expect(source?.fellBackBecause).toMatch(/dev desktop manifest returned HTTP 404/)
  })

  it('refuses to publish a dev shell manifest served from the wrong release', async () => {
    // A dev manifest that exists but points at edge assets is a BROKEN dev release, not an
    // absent one. Falling back there would put an edge shell behind a dev label with
    // nothing amiss to see — so this fails loudly instead.
    const store = memoryFs()
    const publisher = publisherFor(store, () => 'aaaaaaa', undefined, undefined, undefined, {
      dev: edgeShellManifest,
      edge: edgeShellManifest,
    })
    await publisher.requestBuild(true)

    expect(await publisher.publishFeed()).toBe(false)
    expect(publisher.unavailable()).toMatch(/served from outside the dev feed/)
    // The previous complete pair is left alone: nothing was written.
    expect(store.names()).not.toContain('latest.json')
  })

  it('publishes nothing when neither shell can be fetched, naming both attempts', async () => {
    const store = memoryFs()
    const publisher = publisherFor(store, () => 'aaaaaaa', undefined, undefined, undefined, {})
    await publisher.requestBuild(true)

    expect(await publisher.publishFeed()).toBe(false)
    expect(publisher.unavailable()).toMatch(/dev desktop manifest returned HTTP 404/)
    expect(publisher.unavailable()).toMatch(/edge desktop manifest returned HTTP 404/)
  })

  it('writes a manifest the shared parser accepts, naming this build', async () => {
    const store = memoryFs()
    const publisher = publisherFor(store, () => 'aaaaaaa')
    await publisher.requestBuild(true)

    expect(await publisher.publishFeed()).toBe(true)
    expect(publisher.feedManifestPath()).toBe('/repo/podium/dist-bun/podium-update.json')
    expect(publisher.desktopManifestPath()).toBe('/repo/podium/dist-bun/latest.json')
    expect(JSON.parse(await store.fs.readText(publisher.desktopManifestPath()))).toMatchObject({
      version: '0.4.3-dev.2',
      bridgeVersion: 1,
    })

    const parsed = UpdateTarget.parse(
      JSON.parse(await store.fs.readText(publisher.feedManifestPath())),
    )
    expect(parsed.version).toBe(publisher.current()?.version)
    expect(parsed.schema).toEqual({ migrations: ['20260715135845_baseline'] })
    expect(parsed.artifacts.headless).toMatchObject({
      delivery: 'feed',
      platforms: {
        'linux-x86_64': {
          url: `https://ludovico.test/updates/feed/dev/artifact/${encodeURIComponent(
            publisher.current()?.version ?? '',
          )}?token=t`,
          digest: publisher.current()?.digest,
        },
      },
    })
    // The resolver stamps the trust root and REFUSES a manifest that names one,
    // so a publisher that wrote one would make its own releases unresolvable.
    expect(parsed.trust).toBeUndefined()
  })

  it('names integrity when published artifact bytes change after publication', async () => {
    const store = memoryFs()
    const fixture = signedFixture()
    const publisher = publisherFor(store, () => 'aaaaaaa', undefined, undefined, fixture)
    await publisher.requestBuild(true)
    expect(await publisher.publishFeed()).toBe(true)

    const published = publisher.current()?.artifacts[0]
    expect(published).toBeDefined()
    if (!published) throw new Error('fixture did not publish a host artifact')
    store.blobs.set(published.path, new Uint8Array([...fixture.bytes, 9]))

    // A fresh publisher has no in-memory build descriptor to trust. It must
    // reconstruct the artifact from the publication and hash the bytes that
    // are now on disk, which is the same path exercised after a server restart.
    const restarted = publisherFor(store, () => 'aaaaaaa', undefined, undefined, fixture)
    const app = new Hono()
    registerDevFeedRoutes(app, {
      publishedArtifact: (version, platform) => restarted.publishedArtifact(version, platform),
      manifestPath: () => restarted.feedManifestPath(),
      authenticate: () => true,
    })

    const manifest = UpdateTarget.parse(
      JSON.parse(await store.fs.readText(restarted.feedManifestPath())),
    )
    const asset = manifest.artifacts.headless?.platforms['linux-x86_64']
    expect(asset).toBeDefined()
    if (!asset) throw new Error('fixture manifest did not name the host artifact')

    let detail = ''
    try {
      await fetchArtifact(asset, {
        fetch: async (input, init) => app.request(input, init),
        pubkey: 'unused-release-key',
        pinnedPubkey: 'unused-instance-key',
        trust: 'instance',
      })
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error)
    }

    const code = classifyMachineFailure(detail)
    const visible = describeUpdateOperationFailure({
      code,
      places: ['m_a', 'm_b'],
      names: ['fleet-a', 'fleet-b'],
      detail,
    })
    expect(code).toBe('machine-artifact-rejected')
    expect(detail).toMatch(/digest|signature|integrity/i)
    expect(visible.message).toMatch(/verification|signed|integrity/i)
    expect(`${visible.message} ${detail}`).not.toMatch(/could not download|check the connection/i)
  })

  it('publishes the approved commit if HEAD advances while it builds', async () => {
    const store = memoryFs()
    let head = 'aaaaaaa'
    let beginPreparation!: () => void
    const preparing = new Promise<void>((resolve) => {
      beginPreparation = resolve
    })
    let finishPreparation!: () => void
    const prepared = new Promise<void>((resolve) => {
      finishPreparation = resolve
    })
    const publisher = publisherFor(
      store,
      () => head,
      undefined,
      async () => {
        beginPreparation()
        await prepared
      },
    )
    const approved = await publisher.proposal()
    expect(approved).toBeDefined()
    const building = publisher.requestBuild(true, approved)
    await preparing

    // A commit lands and receives its own reserved version while the approved
    // commit is still preparing. Neither identity may replace the other.
    head = 'bbbbbbb'
    expect((await publisher.proposal())?.version).toBe('0.1.0-dev.2+bbbbbbb')
    finishPreparation()
    await building
    expect(await publisher.publishFeed()).toBe(true)
    const published = UpdateTarget.parse(
      JSON.parse(await store.fs.readText(publisher.feedManifestPath())),
    )
    expect(published.version).toBe('0.1.0-dev.1+aaaaaaa')
    expect((await publisher.proposal())?.headSha).toBe('bbbbbbb')
  })

  it('rewrites the manifest whole on the next release, never merging into it', async () => {
    const store = memoryFs()
    let head = 'aaaaaaa'
    const publisher = publisherFor(store, () => head)
    await publisher.requestBuild(true)
    await publisher.publishFeed()
    const first = JSON.parse(await store.fs.readText(publisher.feedManifestPath())) as {
      version: string
    }

    head = 'bbbbbbb'
    await publisher.requestBuild(true)
    await publisher.publishFeed()
    const second = JSON.parse(await store.fs.readText(publisher.feedManifestPath())) as {
      version: string
    }

    expect(second.version).not.toBe(first.version)
    expect(UpdateTarget.parse(second).artifacts.headless).toBeDefined()
  })

  it('collapses rapid commits to HEAD and disappears only after publication', async () => {
    const store = memoryFs()
    let head = 'aaaaaaa'
    const ranges: Array<{ headSha: string; runningSha?: string; sinceSha?: string }> = []
    const publisher = publisherFor(
      store,
      () => head,
      async (input) => {
        ranges.push(input)
        return {
          branch: 'feature/collapsing',
          commits: [{ sha: input.headSha, summary: `Commit ${input.headSha}` }],
          addedMigrations: input.headSha === 'ccccccc' ? ['20260821110000_release'] : [],
        }
      },
    )

    head = 'bbbbbbb'
    head = 'ccccccc'
    expect(await publisher.proposal()).toMatchObject({
      headSha: 'ccccccc',
      runningVersion: 'dev+1111111',
      branch: 'feature/collapsing',
      addedMigrations: ['20260821110000_release'],
      commits: [{ sha: 'ccccccc' }],
    })

    await publisher.requestBuild(true)
    await publisher.publishFeed()
    expect(await publisher.proposal()).toBeUndefined()

    head = 'ddddddd'
    expect(await publisher.proposal()).toMatchObject({ headSha: 'ddddddd' })
    expect(ranges.at(-1)).toEqual({
      headSha: 'ddddddd',
      runningSha: '1111111',
      sinceSha: 'ccccccc',
    })
  })
})
