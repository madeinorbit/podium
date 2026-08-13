import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  buildDevBundle,
  classifyIgnoredSourceInputs,
  classifySourceIdentity,
  createDevBundlePublisher,
  DEV_BUNDLE_RETAINED,
  type DevBundleFs,
  type DevBundleLock,
  decideDevBuild,
  devBundleFileName,
  devBundleKeyFingerprint,
  devBundleStamp,
  devIdentityTarget,
  devTarget,
  listDevBundles,
  parseDevBundleName,
  selectDevBundleSweep,
  sweepDevBundles,
} from './dev-bundle'
import { createServerDevBundleLock } from './dev-bundle-lock'

const base = {
  isSourceRun: true,
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
      decideDevBuild({ ...base, builtSha: 'old', lastAttemptAt: 99_999, explicit: true }),
    ).toEqual({ build: true })
  })

  it('an explicit request still does not stack on an in-flight build', () => {
    expect(decideDevBuild({ ...base, builtSha: 'old', explicit: true, inFlight: true })).toEqual({
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

  it('never builds on an installed (non-source) server', () => {
    // An installed server has no checkout to build from. It follows a channel.
    expect(decideDevBuild({ ...base, isSourceRun: false, explicit: true })).toEqual({
      build: false,
      reason: 'not-a-source-run',
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
    expect(classifySourceIdentity(porcelain)).toEqual({ clean: true, offending: [] })
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
}) {
  const path =
    (input.root ?? '/repo/podium') +
    '/dist-bun/' +
    devBundleFileName('dev+' + input.sha, input.stamp)
  return memoryFs({
    blobs: { [path]: input.bytes },
    text: {
      [path + '.sig']: input.signature + '\n',
      [path + '.meta.json']: JSON.stringify({
        version: 'dev+' + input.sha,
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
    digest: async () => ({ digest: digestOf(new Uint8Array([1, 2, 3, 4])), size: 4 }),
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
    expect(devBundleFileName('dev+abc1234', '20260812T182015Z')).toBe(
      'podium-headless-dev+abc1234-20260812T182015Z.tar.gz',
    )
  })

  it('recognises this build’s own artifacts, stamped or not', () => {
    expect(parseDevBundleName('podium-headless-dev+abc1234-20260812T182015Z.tar.gz')).toEqual({
      name: 'podium-headless-dev+abc1234-20260812T182015Z.tar.gz',
      sha: 'abc1234',
      stamp: '20260812T182015Z',
    })
    // The shape that accumulated before builds were stamped is still ours.
    expect(parseDevBundleName('podium-headless-dev+abc1234.tar.gz')).toMatchObject({
      sha: 'abc1234',
      stamp: '',
    })
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
    expect(selectDevBundleSweep([newest, previous, older], { keep: 1, protect: [older] })).toEqual([
      previous,
    ])
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

describe('buildDevBundle', () => {
  it('builds a signed dev target and releases the lease after describing the artifact', async () => {
    const { bytes, signature } = signedFixture()
    const store = memoryFs()
    const events: string[] = []
    const built = await buildDevBundle({
      root: '/repo/podium',
      headSha: '123456789abcdef',
      fs: store.fs,
      lock: lockFixture(events),
      renewIntervalMs: 60_000,
      now: () => Date.UTC(2026, 7, 12, 18, 20, 15),
      spawnBuild: async ({ version, artifactPath }) => {
        events.push('build:' + version)
        store.blobs.set(artifactPath, bytes)
        store.text.set(artifactPath + '.sig', signature + '\n')
      },
    })

    expect(built.version).toBe('dev+1234567')
    // The version a daemon sees names the commit; the FILE also names the build.
    expect(built.path).toBe(
      '/repo/podium/dist-bun/podium-headless-dev+1234567-20260812T182015Z.tar.gz',
    )
    expect(built.size).toBe(bytes.length)
    expect(built.digest).toBe(digestOf(bytes))
    expect(events).toEqual(['acquire', 'build:dev+1234567', 'release'])
    const target = devTarget(built, {
      platform: 'linux-x86_64',
      artifactUrl: 'http://server.test/updates/dev-bundle/dev%2B1234567',
      sourceRoot: '/repo/podium',
    })
    expect(target.artifacts.headless).toEqual({
      delivery: 'bundle',
      platforms: {
        'linux-x86_64': {
          url: 'http://server.test/updates/dev-bundle/dev%2B1234567',
          digest: built.digest,
          signature,
        },
      },
    })
    expect(target.artifacts.headlessAlternatives).toEqual([
      { delivery: 'git', repo: '/repo/podium', sha: '1234567' },
    ])
    expect(target.artifacts.web).toEqual({ digest: '1234567' })
  })

  it('advertises dev+HEAD with a web digest when there is no tarball yet', () => {
    const identity = devIdentityTarget('f9485d31b', { sourceRoot: '/repo/podium' })
    expect(identity.version).toBe('dev+f9485d3')
    expect(identity.artifacts.web).toEqual({ digest: 'f9485d3' })
    expect(identity.artifacts.headless).toBeUndefined()
    expect(identity.artifacts.headlessAlternatives).toEqual([
      { delivery: 'git', repo: '/repo/podium', sha: 'f9485d3' },
    ])
  })

  it('never holds the bundle, and says how big the one on disk is', async () => {
    const big = new Uint8Array(4096).fill(7)
    const store = memoryFs()
    const built = await buildDevBundle({
      root: '/repo/podium',
      headSha: '123456789abcdef',
      fs: store.fs,
      lock: lockFixture([]),
      spawnBuild: async ({ artifactPath }) => {
        store.blobs.set(artifactPath, big)
        return { signature: 'signed' }
      },
    })

    // The descriptor is metadata; there is nowhere for a payload to hide in it.
    expect(Object.keys(built).sort()).toEqual(['digest', 'path', 'signature', 'size', 'version'])
    expect(built.size).toBe(4096)
    expect(built.digest).toBe(digestOf(big))
  })

  it('rebuilding one commit writes a new file instead of overwriting the published one', async () => {
    const store = memoryFs()
    const built: string[] = []
    for (const at of [Date.UTC(2026, 7, 12, 18, 20, 15), Date.UTC(2026, 7, 12, 19, 30, 45)]) {
      const bundle = await buildDevBundle({
        root: '/repo/podium',
        headSha: 'aaaaaaa',
        fs: store.fs,
        lock: lockFixture([]),
        now: () => at,
        spawnBuild: async ({ artifactPath }) => {
          store.blobs.set(artifactPath, new Uint8Array([1, 2, 3, 4]))
          return { signature: 'signed' }
        },
      })
      built.push(bundle.path)
    }

    expect(built[0]).not.toBe(built[1])
    // Both survive: a request already streaming the first one keeps its file.
    expect(store.names()).toContain('podium-headless-dev+aaaaaaa-20260812T182015Z.tar.gz')
    expect(store.names()).toContain('podium-headless-dev+aaaaaaa-20260812T193045Z.tar.gz')
  })

  it('records how it published, so a later restore can check it without the bytes', async () => {
    const { bytes, signature, signingKey } = signedFixture()
    const store = memoryFs()
    const built = await buildDevBundle({
      root: '/repo/podium',
      headSha: 'aaaaaaa',
      signingKey,
      fs: store.fs,
      lock: lockFixture([]),
      now: () => Date.UTC(2026, 7, 12, 18, 20, 15),
      spawnBuild: async ({ artifactPath }) => {
        store.blobs.set(artifactPath, bytes)
        store.text.set(artifactPath + '.sig', signature + '\n')
      },
    })

    expect(JSON.parse(store.text.get(built.path + '.meta.json') as string)).toEqual({
      version: 'dev+aaaaaaa',
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
      isSourceRun: true,
      readSourceStatus: () => '',
      readIgnoredSourceInputs: () => '',
      root: '/repo/podium',
      headSha: () => head,
      signingKey,
      fs: store.fs,
      lock: lockFixture([]),
      now: () => Date.UTC(2026, 7, 12, 18, minute, 0),
      spawnBuild: async ({ artifactPath }) => {
        store.blobs.set(artifactPath, bytes)
        store.text.set(artifactPath + '.sig', signature + '\n')
      },
    })

    for (const sha of shas) {
      head = sha
      minute += 10
      await publisher.requestBuild(true)
    }

    expect(store.names()).toEqual([
      'podium-headless-dev+5555555-20260812T185000Z.tar.gz',
      'podium-headless-dev+5555555-20260812T185000Z.tar.gz.meta.json',
      'podium-headless-dev+5555555-20260812T185000Z.tar.gz.sig',
      'podium-headless-dev+6666666-20260812T190000Z.tar.gz',
      'podium-headless-dev+6666666-20260812T190000Z.tar.gz.meta.json',
      'podium-headless-dev+6666666-20260812T190000Z.tar.gz.sig',
    ])
    expect(publisher.target()?.version).toBe('dev+6666666')
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
      isSourceRun: true,
      readSourceStatus: () => '',
      readIgnoredSourceInputs: () => '',
      root: '/repo/podium',
      headSha: () => 'aaaaaaa',
      signingKey,
      fs: store.fs,
      lock: lockFixture([]),
      spawnBuild: async () => {
        builds++
        return { signature }
      },
    })

    await publisher.requestBuild(true)

    expect(builds).toBe(0)
    expect(store.names()).toEqual([
      'podium-headless-dev+3333333-20260812T180000Z.tar.gz',
      'podium-headless-dev+3333333-20260812T180000Z.tar.gz.sig',
      'podium-headless-dev+aaaaaaa-20260812T190000Z.tar.gz',
      'podium-headless-dev+aaaaaaa-20260812T190000Z.tar.gz.meta.json',
      'podium-headless-dev+aaaaaaa-20260812T190000Z.tar.gz.sig',
    ])
  })

  it('releases the lease and keeps a failed build unpublished', async () => {
    const events: string[] = []
    await expect(
      buildDevBundle({
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
      isSourceRun: true,
      readSourceStatus: () => '',
      readIgnoredSourceInputs: () => '',
      root: '/repo/podium',
      headSha: () => 'aaaaaaa',
      signingKey,
      fs: store.fs,
      lock: lockFixture([]),
      spawnBuild: async () => {
        builds++
        return { signature }
      },
    })

    const restored = await publisher.requestBuild(true)

    expect(builds).toBe(0)
    expect(restored).toMatchObject({
      version: 'dev+aaaaaaa',
      path: '/repo/podium/dist-bun/podium-headless-dev+aaaaaaa-20260812T182015Z.tar.gz',
      signature,
    })
    expect(restored?.digest).toBe(digestOf(bytes))
    expect(publisher.target()?.version).toBe('dev+aaaaaaa')
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
            '/repo/podium/dist-bun/podium-headless-dev+aaaaaaa-20260812T182015Z.tar.gz.meta.json',
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
            '/repo/podium/dist-bun/podium-headless-dev+aaaaaaa-20260812T182015Z.tar.gz',
            bytes.slice(0, 2),
          )
          return store
        })(),
      },
    ]

    for (const { label, store } of cases) {
      let builds = 0
      const publisher = createDevBundlePublisher({
        isSourceRun: true,
        readSourceStatus: () => '',
        readIgnoredSourceInputs: () => '',
        root: '/repo/podium',
        headSha: () => 'aaaaaaa',
        signingKey,
        fs: store.fs,
        lock: lockFixture([]),
        spawnBuild: async ({ artifactPath }) => {
          builds++
          store.blobs.set(artifactPath, bytes)
          return { signature }
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
      isSourceRun: true,
      readSourceStatus: () => '',
      readIgnoredSourceInputs: () => '',
      headSha: () => head,
      fs: stubFs(),
      lock: lockFixture(events),
      now: () => 100_000,
      spawnBuild: async ({ version }) => {
        attempts++
        if (attempts === 2) throw new Error('second compile failed')
        return { path: '/stage/' + version, bytes, signature }
      },
    })

    await publisher.requestBuild(true)
    expect(publisher.target()?.version).toBe('dev+aaaaaaa')
    head = 'bbbbbbb'
    await expect(publisher.requestBuild(true)).rejects.toThrow('second compile failed')
    // The signed bytes for the old commit survive — a later request at that sha
    // can still restore them — but they are no longer offered as the target,
    // because they are not what this server is running.
    expect(publisher.current()?.version).toBe('dev+aaaaaaa')
    expect(publisher.target()?.version).toBe('dev+bbbbbbb')
    expect(publisher.target()?.artifacts.web).toEqual({ digest: 'bbbbbbb' })
    expect(publisher.target()?.artifacts.headless).toBeUndefined()
  })

  it('builds the website before the compile that requires it', async () => {
    // The compile refuses a dev+<sha> tarball whose web half was built from
    // another commit. While producing that dist belonged to a separate systemd
    // unit, the refusal was a race — 28 of 112 attempts in the week to
    // 2026-08-13 (POD-1985). Sequencing it here is what removes the race.
    const { bytes, signature } = signedFixture()
    const order: string[] = []
    const publisher = createDevBundlePublisher({
      isSourceRun: true,
      readSourceStatus: () => '',
      readIgnoredSourceInputs: () => '',
      headSha: () => 'aaaaaaa',
      fs: stubFs(),
      lock: lockFixture([]),
      ensureWebBuild: async (headSha) => {
        order.push('web:' + headSha)
      },
      spawnBuild: async ({ version }) => {
        order.push('bundle')
        return { path: '/stage/' + version, bytes, signature }
      },
    })

    await publisher.requestBuild(true)
    expect(order).toEqual(['web:aaaaaaa', 'bundle'])
  })

  it('does not compile when the website could not be built', async () => {
    let builds = 0
    const publisher = createDevBundlePublisher({
      isSourceRun: true,
      readSourceStatus: () => '',
      readIgnoredSourceInputs: () => '',
      headSha: () => 'aaaaaaa',
      fs: stubFs(),
      lock: lockFixture([]),
      ensureWebBuild: () => Promise.reject(new Error('vite blew up')),
      spawnBuild: async () => {
        builds++
      },
    })

    await expect(publisher.requestBuild(true)).rejects.toThrow('vite blew up')
    // The whole point of hoisting the precondition: nothing expensive runs.
    expect(builds).toBe(0)
    expect(publisher.readiness()).toMatchObject({ state: 'failed', headSha: 'aaaaaaa' })
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
      isSourceRun: true,
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
      spawnBuild: async () => {
        builds++
        return { signature }
      },
    })

    await expect(publisher.requestBuild(true)).rejects.toThrow(
      /does not match HEAD \(aaaaaaa\).*apps\/server\/src\/server\.ts/s,
    )
    // Neither compiled, nor republished an artifact left over from that sha.
    expect(builds).toBe(0)
    expect(reads).toBe(0)
    expect(publisher.current()).toBeNull()
    expect(publisher.target()).toBeUndefined()
    expect(publisher.unavailable()).toContain('apps/server/src/server.ts')
    // And nothing was reclaimed: a refusal is not a licence to touch the disk.
    expect(store.names()).toContain('podium-headless-dev+aaaaaaa-20260812T182015Z.tar.gz')
  })

  it('refuses when the checkout cannot be verified at all', async () => {
    const publisher = createDevBundlePublisher({
      isSourceRun: true,
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
      isSourceRun: true,
      headSha: () => 'aaaaaaa',
      readSourceStatus: () => porcelain,
      readIgnoredSourceInputs: () => '',
      fs: stubFs(),
      lock: lockFixture([]),
      spawnBuild: async ({ version }) => ({ path: '/stage/' + version, signature }),
    })

    await expect(publisher.requestBuild(true)).rejects.toThrow(/does not match HEAD/)
    porcelain = ''
    await publisher.requestBuild(true)

    expect(publisher.current()?.version).toBe('dev+aaaaaaa')
    expect(publisher.unavailable()).toBeUndefined()
  })

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
      isSourceRun: true,
      headSha: () => 'aaaaaaa',
      readSourceStatus: () => '',
      readIgnoredSourceInputs: () => '',
      fs: stubFs(),
      lock: lockFixture([]),
      spawnBuild: async ({ version }) => {
        builds++
        resolveBuildStarted()
        await buildDone
        return { path: '/stage/' + version, bytes, signature }
      },
    })

    const first = publisher.requestBuild(true)
    const second = publisher.requestBuild(true)
    expect(second).toBe(first)
    await buildStarted
    expect(builds).toBe(1)
    resolveBuild()
    await first
  })
})

describe('development bundle readiness', () => {
  function readinessFixture(options: { porcelain?: () => string } = {}) {
    const { bytes, signature } = signedFixture()
    let head = 'aaaaaaa'
    let fail: string | null = null
    const publisher = createDevBundlePublisher({
      isSourceRun: true,
      headSha: () => head,
      readSourceStatus: options.porcelain ?? (() => ''),
      readIgnoredSourceInputs: () => '',
      fs: stubFs(),
      lock: lockFixture([]),
      now: () => 100_000,
      spawnBuild: async ({ version }) => {
        if (fail) throw new Error(fail)
        return { path: '/stage/' + version, bytes, signature }
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

  it('is idle before anything has been built for this HEAD', () => {
    const { publisher } = readinessFixture()
    expect(publisher.readiness()).toEqual({ state: 'idle', headSha: 'aaaaaaa' })
  })

  it('is ready, with the version, once HEAD is built', async () => {
    const { publisher } = readinessFixture()
    await publisher.requestBuild(true)
    expect(publisher.readiness()).toEqual({
      state: 'ready',
      headSha: 'aaaaaaa',
      version: 'dev+aaaaaaa',
    })
    expect(publisher.target()?.version).toBe('dev+aaaaaaa')
  })

  it('withdraws the old target the moment HEAD advances', async () => {
    const { publisher, moveHead } = readinessFixture()
    await publisher.requestBuild(true)
    moveHead('bbbbbbb')

    // The bundle still exists and is still dev+aaaaaaa; it is simply not the
    // target for the commit this server is now running.
    expect(publisher.current()?.version).toBe('dev+aaaaaaa')
    expect(publisher.target()?.version).toBe('dev+bbbbbbb')
    expect(publisher.target()?.artifacts.web).toEqual({ digest: 'bbbbbbb' })
    expect(publisher.target()?.artifacts.headless).toBeUndefined()
    expect(publisher.readiness()).toEqual({ state: 'idle', headSha: 'bbbbbbb' })
  })

  it('reports failed for the new HEAD, not ready from the old one', async () => {
    const { publisher, moveHead, failNextBuild } = readinessFixture()
    await publisher.requestBuild(true)
    moveHead('bbbbbbb')
    failNextBuild('compile blew up')
    await expect(publisher.requestBuild(true)).rejects.toThrow('compile blew up')

    const readiness = publisher.readiness()
    expect(readiness.state).toBe('failed')
    expect(readiness).toMatchObject({
      headSha: 'bbbbbbb',
      reason: 'compile blew up',
      publicReason: 'Building the development bundle for dev+bbbbbbb failed. See the server log.',
    })
    expect(publisher.target()?.version).toBe('dev+bbbbbbb')
    expect(publisher.target()?.artifacts.web).toEqual({ digest: 'bbbbbbb' })
  })

  it('keeps a dirty checkout out of the public reason while the log gets the paths', async () => {
    const { publisher } = readinessFixture({
      porcelain: () => nul(' M apps/server/src/server.ts', '?? apps/web/scratch.ts'),
    })
    await expect(publisher.requestBuild(true)).rejects.toThrow(/does not match HEAD/)

    const readiness = publisher.readiness()
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

  it('does not carry an old HEAD failure into a new one', async () => {
    const { publisher, moveHead, failNextBuild } = readinessFixture()
    failNextBuild('compile blew up')
    await expect(publisher.requestBuild(true)).rejects.toThrow('compile blew up')
    expect(publisher.readiness().state).toBe('failed')

    moveHead('bbbbbbb')
    expect(publisher.readiness()).toEqual({ state: 'idle', headSha: 'bbbbbbb' })
  })

  it('is preparing while a build for this HEAD is in flight', async () => {
    const { bytes, signature } = signedFixture()
    let resolveBuild!: () => void
    const buildDone = new Promise<void>((resolve) => {
      resolveBuild = resolve
    })
    const publisher = createDevBundlePublisher({
      isSourceRun: true,
      headSha: () => 'aaaaaaa',
      readSourceStatus: () => '',
      readIgnoredSourceInputs: () => '',
      fs: stubFs(),
      lock: lockFixture([]),
      spawnBuild: async ({ version }) => {
        await buildDone
        return { path: '/stage/' + version, bytes, signature }
      },
    })

    const built = publisher.requestBuild(true)
    expect(publisher.readiness()).toEqual({ state: 'preparing', headSha: 'aaaaaaa' })
    resolveBuild()
    await built
    expect(publisher.readiness().state).toBe('ready')
  })
})

describe('ignored source inputs gate the build', () => {
  it('refuses a checkout whose ignored files include importable source', async () => {
    const { bytes, signature } = signedFixture()
    let builds = 0
    const publisher = createDevBundlePublisher({
      isSourceRun: true,
      headSha: () => 'aaaaaaa',
      // Clean by git status — the first query sees nothing at all.
      readSourceStatus: () => '',
      readIgnoredSourceInputs: () => nul('apps/server/src/local-override.ts'),
      fs: stubFs(),
      lock: lockFixture([]),
      spawnBuild: async () => {
        builds++
        return { signature }
      },
    })

    await expect(publisher.requestBuild(true)).rejects.toThrow(
      /ignored source files.*apps\/server\/src\/local-override\.ts/s,
    )
    expect(builds).toBe(0)
    expect(publisher.readiness()).toMatchObject({
      state: 'failed',
      publicReason:
        'The source checkout has 1 ignored source file that could be compiled into ' +
        'dev+aaaaaaa without being part of HEAD (aaaaaaa).',
    })
  })

  it('builds when the ignored files are only outputs and evidence', async () => {
    const { bytes, signature } = signedFixture()
    const publisher = createDevBundlePublisher({
      isSourceRun: true,
      headSha: () => 'aaaaaaa',
      readSourceStatus: () => '',
      readIgnoredSourceInputs: () =>
        nul('apps/server/node_modules/left-pad/index.js', 'apps/web/shot.png'),
      fs: stubFs(),
      lock: lockFixture([]),
      spawnBuild: async ({ version }) => ({ path: '/stage/' + version, signature }),
    })

    await publisher.requestBuild(true)
    expect(publisher.readiness().state).toBe('ready')
  })

  it('refuses when the ignored-source query itself cannot be run', async () => {
    const publisher = createDevBundlePublisher({
      isSourceRun: true,
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
