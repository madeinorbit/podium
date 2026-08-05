import { describe, expect, it } from 'vitest'
import { UpdateTarget } from './target'

const feedTarget = {
  version: '0.4.2',
  artifacts: {
    headless: {
      delivery: 'feed',
      platforms: {
        'linux-x86_64': {
          url: 'https://example.test/podium-headless-0.4.2.tar.gz',
          digest: 'sha256-aaa',
          signature: 'sig',
        },
      },
    },
  },
}

describe('UpdateTarget', () => {
  it('parses a feed-delivered target', () => {
    const t = UpdateTarget.parse(feedTarget)
    expect(t.artifacts.headless?.delivery).toBe('feed')
    expect(t.critical).toBe(false)
  })

  it('parses a server-hosted bundle target', () => {
    const t = UpdateTarget.parse({
      version: 'dev+9f3a1c2',
      artifacts: {
        headless: {
          delivery: 'bundle',
          platforms: {
            'linux-x86_64': {
              url: 'https://server.test/update/headless.tar.gz',
              digest: 'sha256-bbb',
              signature: 'sig',
            },
          },
        },
      },
    })
    expect(t.artifacts.headless?.delivery).toBe('bundle')
  })

  it('parses a git target, which has a sha instead of a url', () => {
    const t = UpdateTarget.parse({
      version: 'dev+9f3a1c2',
      artifacts: {
        headless: { delivery: 'git', repo: '/home/u/src/podium', sha: '9f3a1c2' },
      },
    })
    expect(t.artifacts.headless).toEqual({
      delivery: 'git',
      repo: '/home/u/src/podium',
      sha: '9f3a1c2',
    })
  })

  it('rejects a feed artifact with no url', () => {
    expect(() =>
      UpdateTarget.parse({
        version: '0.4.2',
        artifacts: { headless: { delivery: 'feed', platforms: { 'linux-x86_64': { digest: 'd', signature: 's' } } } },
      }),
    ).toThrow()
  })

  it('carries release notes and a changelog link when they exist', () => {
    const t = UpdateTarget.parse({
      ...feedTarget,
      notes: { summary: 'Faster reconnects.', url: 'https://example.test/CHANGELOG.md#042' },
    })
    expect(t.notes?.summary).toBe('Faster reconnects.')
  })

  it('omits notes entirely when there are none', () => {
    expect(UpdateTarget.parse(feedTarget).notes).toBeUndefined()
  })

  it('carries a structured critical flag rather than a prose marker', () => {
    expect(UpdateTarget.parse({ ...feedTarget, critical: true }).critical).toBe(true)
  })

  it('carries per-surface and per-platform minimum required versions', () => {
    const t = UpdateTarget.parse({
      ...feedTarget,
      minRequired: { desktop: '0.4.0', mobile: { ios: '0.3.9', android: '0.4.0' } },
    })
    expect(t.minRequired?.mobile?.ios).toBe('0.3.9')
  })

  it('ignores unknown top-level fields instead of rejecting them', () => {
    expect(() => UpdateTarget.parse({ ...feedTarget, aFieldFromTheFuture: 1 })).not.toThrow()
  })
  it('round-trips every prepared platform through UpdateTarget', () => {
    const t = UpdateTarget.parse({
      ...feedTarget,
      artifacts: {
        headless: {
          delivery: 'feed',
          platforms: {
            ...feedTarget.artifacts.headless.platforms,
            'linux-aarch64': {
              url: 'https://example.test/podium-headless-0.4.2-arm64.tar.gz',
              digest: 'sha256-arm',
              signature: 'sig-arm',
            },
          },
        },
      },
    })
    expect(t.artifacts.headless?.delivery).toBe('feed')
    if (t.artifacts.headless?.delivery !== 'feed') throw new Error('expected feed artifact')
    expect(Object.keys(t.artifacts.headless.platforms)).toEqual([
      'linux-x86_64',
      'linux-aarch64',
    ])
    expect(t.artifacts.headless.platforms['linux-aarch64']?.digest).toBe('sha256-arm')
  })

  it('represents a target without the running platform', () => {
    const t = UpdateTarget.parse(feedTarget)
    if (t.artifacts.headless?.delivery !== 'feed') throw new Error('expected feed artifact')
    expect(t.artifacts.headless.platforms['darwin-aarch64']).toBeUndefined()
  })
})
