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

  /**
   * THE RETIRED KINDS ARE REFUSED, not ignored (spec §1, disposition 5).
   *
   * `bundle` and `git` used to be the other two arms of this union, and each had
   * its own parse test here. A one-armed union is what makes their absence a
   * REFUSAL rather than a shape that passes through `.passthrough()` and reaches
   * a verifier that no longer knows what to do with it — so the tests that
   * parsed them become the tests that prove they cannot be parsed.
   */
  it.each(['bundle', 'git'])('refuses a %s artifact, on either slot', (delivery) => {
    expect(() =>
      UpdateTarget.parse({
        version: '0.1.2-dev.4+9f3a1c2',
        artifacts: { headless: { delivery, platforms: {}, repo: '/r', sha: '9f3a1c2' } },
      }),
    ).toThrow()
    expect(() =>
      UpdateTarget.parse({
        ...feedTarget,
        artifacts: {
          ...feedTarget.artifacts,
          headlessAlternatives: [{ delivery, platforms: {}, repo: '/r', sha: '9f3a1c2' }],
        },
      }),
    ).toThrow()
  })

  it('parses ordered headless delivery alternatives without changing the primary', () => {
    const alternative = {
      delivery: 'feed',
      platforms: {
        'linux-aarch64': {
          url: 'https://example.test/alt.tar.gz',
          digest: 'sha256-alt',
          signature: 'sig',
        },
      },
    }
    const t = UpdateTarget.parse({
      ...feedTarget,
      artifacts: { ...feedTarget.artifacts, headlessAlternatives: [alternative] },
    })
    expect(t.artifacts.headless?.delivery).toBe('feed')
    expect(t.artifacts.headlessAlternatives).toEqual([alternative])
  })

  /**
   * THE TRUST ROOT IS OPTIONAL AND ABSENT MEANS `release`.
   *
   * The resolver stamps it, so every manifest published before it existed says
   * nothing — and the baked release key is the narrower reading of silence: an
   * instance-signed artifact checked against it simply fails.
   */
  it('carries a resolver-stamped trust root, and leaves it absent when none was set', () => {
    expect(UpdateTarget.parse({ ...feedTarget, trust: 'instance' }).trust).toBe('instance')
    expect(UpdateTarget.parse({ ...feedTarget, trust: 'release' }).trust).toBe('release')
    expect(UpdateTarget.parse(feedTarget).trust).toBeUndefined()
  })

  it('refuses a trust root it has never heard of', () => {
    expect(() => UpdateTarget.parse({ ...feedTarget, trust: 'whatever-i-say' })).toThrow()
  })

  it('rejects a feed artifact with no url', () => {
    expect(() =>
      UpdateTarget.parse({
        version: '0.4.2',
        artifacts: {
          headless: {
            delivery: 'feed',
            platforms: { 'linux-x86_64': { digest: 'd', signature: 's' } },
          },
        },
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
      minRequired: {
        desktop: '0.4.0',
        desktopBridge: 2,
        mobile: { ios: '0.3.9', android: '0.4.0' },
      },
    })
    expect(t.minRequired?.desktopBridge).toBe(2)
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
    expect(Object.keys(t.artifacts.headless.platforms)).toEqual(['linux-x86_64', 'linux-aarch64'])
    expect(t.artifacts.headless.platforms['linux-aarch64']?.digest).toBe('sha256-arm')
  })

  it('represents a target without the running platform', () => {
    const t = UpdateTarget.parse(feedTarget)
    if (t.artifacts.headless?.delivery !== 'feed') throw new Error('expected feed artifact')
    expect(t.artifacts.headless.platforms['darwin-aarch64']).toBeUndefined()
  })
})

describe('UpdateTarget schema declaration', () => {
  it('carries the migrations the target build can open', () => {
    // POD-2213: what a daemon needs to know BEFORE it swaps — a build that does
    // not define a migration this machine's database has applied refuses to
    // start, and from there nothing inside Podium can put it back.
    const t = UpdateTarget.parse({
      ...feedTarget,
      schema: { migrations: ['20260715135845_baseline', '20260816092917_operations-table'] },
    })
    expect(t.schema?.migrations).toEqual([
      '20260715135845_baseline',
      '20260816092917_operations-table',
    ])
  })

  it('leaves the declaration absent for a target published before it existed', () => {
    expect(UpdateTarget.parse(feedTarget).schema).toBeUndefined()
  })

  it('refuses a declaration that is not a list of migration names', () => {
    // A malformed declaration must not reach the daemon's gate looking like a
    // real one: the gate treats "declared" as proof and "absent" as unproven,
    // and a string where the list belongs would be neither.
    expect(() =>
      UpdateTarget.parse({ ...feedTarget, schema: { migrations: 'all of them' } }),
    ).toThrow()
  })
})
