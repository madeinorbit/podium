import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  buildDevBundle,
  createDevBundlePublisher,
  decideDevBuild,
  devTarget,
  type DevBundleLock,
} from './dev-bundle'

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

function signedFixture() {
  const bytes = new Uint8Array([1, 2, 3, 4])
  const { privateKey } = generateKeyPairSync('ed25519')
  const signature = sign(null, bytes, privateKey).toString('base64')
  return { bytes, signature }
}

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

  it('keeps the previous target after a later build fails', async () => {
    const { bytes, signature } = signedFixture()
    let head = 'aaaaaaa'
    let attempts = 0
    const events: string[] = []
    const publisher = createDevBundlePublisher({
      isSourceRun: true,
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
    const previous = publisher.target()
    head = 'bbbbbbb'
    await expect(publisher.requestBuild(true)).rejects.toThrow('second compile failed')
    expect(publisher.target()).toEqual(previous)
    expect(publisher.current()?.version).toBe('dev+aaaaaaa')
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
    await Promise.resolve()
    expect(builds).toBe(1)
    resolveBuild()
    await first
  })
})
