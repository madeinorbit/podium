import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  buildDevBundle,
  classifyIgnoredSourceInputs,
  classifySourceIdentity,
  createDevBundlePublisher,
  type DevBundleLock,
  decideDevBuild,
  devTarget,
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
    expect(
      classifyIgnoredSourceInputs(nul('apps/server/src/local-override.ts')),
    ).toEqual(['apps/server/src/local-override.ts'])
  })

  it('ignores non-source evidence living in the same trees', () => {
    expect(
      classifyIgnoredSourceInputs(
        nul('apps/web/screenshot.png', 'packages/harness/notes.md', 'scripts/.podium-update-dev.key'),
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

describe('buildDevBundle', () => {
  it('builds a signed dev target and releases the lease after reading the bytes', async () => {
    const { bytes, signature } = signedFixture()
    const events: string[] = []
    const built = await buildDevBundle({
      headSha: '123456789abcdef',
      lock: lockFixture(events),
      renewIntervalMs: 60_000,
      spawnBuild: async ({ version }) => {
        events.push('build:' + version)
        return { path: '/stage/podium-headless.tar.gz', bytes, signature }
      },
    })

    expect(built.version).toBe('dev+1234567')
    expect(built.digest).toBe('sha256-' + createHash('sha256').update(bytes).digest('base64'))
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
  })

  it('releases the lease and keeps a failed build unpublished', async () => {
    const events: string[] = []
    await expect(
      buildDevBundle({
        headSha: '123456789abcdef',
        lock: lockFixture(events),
        spawnBuild: async () => {
          events.push('build')
          throw new Error('compile failed')
        },
      }),
    ).rejects.toThrow('compile failed')
    expect(events).toEqual(['acquire', 'build', 'release'])
  })

  it('restores the signed HEAD artifact after a publisher restart without rebuilding', async () => {
    const { bytes, signature, signingKey } = signedFixture()
    let builds = 0
    const publisher = createDevBundlePublisher({
      isSourceRun: true,
      readSourceStatus: () => '',
      readIgnoredSourceInputs: () => '',
      root: '/repo/podium',
      headSha: () => 'aaaaaaa',
      signingKey,
      readFile: async (path) => {
        if (path.endsWith('.sig')) return Buffer.from(signature + '\n')
        if (path.endsWith('podium-headless-dev+aaaaaaa.tar.gz')) return bytes
        throw new Error('not found')
      },
      lock: lockFixture([]),
      spawnBuild: async () => {
        builds++
        return { bytes, signature }
      },
    })

    const restored = await publisher.requestBuild(true)

    expect(builds).toBe(0)
    expect(restored).toMatchObject({
      version: 'dev+aaaaaaa',
      path: '/repo/podium/dist-bun/podium-headless-dev+aaaaaaa.tar.gz',
      signature,
    })
    expect(restored?.digest).toBe('sha256-' + createHash('sha256').update(bytes).digest('base64'))
    expect(publisher.target()?.version).toBe('dev+aaaaaaa')
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
    expect(publisher.target()).toBeUndefined()
  })

  it('refuses to build or restore anything from a dirty checkout', async () => {
    const { bytes, signature, signingKey } = signedFixture()
    let builds = 0
    let reads = 0
    const publisher = createDevBundlePublisher({
      isSourceRun: true,
      root: '/repo/podium',
      headSha: () => 'aaaaaaa',
      signingKey,
      readSourceStatus: () => nul(' M apps/server/src/server.ts', '?? dist-bun/keep.tar.gz'),
      readIgnoredSourceInputs: () => '',
      readFile: async () => {
        reads++
        return bytes
      },
      lock: lockFixture([]),
      spawnBuild: async () => {
        builds++
        return { bytes, signature }
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
  })

  it('refuses when the checkout cannot be verified at all', async () => {
    const publisher = createDevBundlePublisher({
      isSourceRun: true,
      headSha: () => 'aaaaaaa',
      readSourceStatus: () => {
        throw new Error('not a git repository')
      },
      readIgnoredSourceInputs: () => '',
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
      lock: lockFixture([]),
      spawnBuild: async ({ version }) => ({ path: '/stage/' + version, bytes, signature }),
    })

    await expect(publisher.requestBuild(true)).rejects.toThrow(/does not match HEAD/)
    porcelain = ''
    await publisher.requestBuild(true)

    expect(publisher.current()?.version).toBe('dev+aaaaaaa')
    expect(publisher.unavailable()).toBeUndefined()
  })

  it('coalesces concurrent explicit requests into one build', async () => {
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
      lock: lockFixture([]),
      spawnBuild: async ({ version }) => {
        builds++
        await buildDone
        return { path: '/stage/' + version, bytes, signature }
      },
    })

    const first = publisher.requestBuild(true)
    const second = publisher.requestBuild(true)
    expect(second).toBe(first)
    await new Promise((resolve) => setImmediate(resolve))
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
    expect(publisher.target()).toBeUndefined()
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
    expect(publisher.target()).toBeUndefined()
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
      lock: lockFixture([]),
      spawnBuild: async () => {
        builds++
        return { bytes, signature }
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
      lock: lockFixture([]),
      spawnBuild: async ({ version }) => ({ path: '/stage/' + version, bytes, signature }),
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
