import { describe, expect, it, vi } from 'vitest'
import {
  type ChannelFeed,
  desktopManifestFeedChannel,
  desktopReleaseManifestUrl,
  devFeedManifestUrl,
  RELEASE_ARTIFACT_REDIRECT_HOSTS,
  releaseChannelFeed,
  releaseManifestUrl,
  resolveReleaseTarget,
  validateDesktopFeedManifest,
} from './release-target'

const RELEASE_BASE = 'https://github.com/madeinorbit/podium/releases/download/edge'
const HEADLESS_URL = `${RELEASE_BASE}/podium-headless-linux-x64.tar.gz`
const DESKTOP_URL = `${RELEASE_BASE}/Podium.app.tar.gz`

const DEV_ORIGIN = 'https://ludovico.test'
const DEV_ARTIFACT_URL = `${DEV_ORIGIN}/updates/feed/dev/podium-headless-0.1.2-dev.4-x.tar.gz`
const DEV_FEED: ChannelFeed = {
  manifestUrl: devFeedManifestUrl(DEV_ORIGIN),
  artifactBase: `${DEV_ORIGIN}/updates/feed/dev/`,
  trust: 'instance',
  headers: { authorization: 'Bearer machine-token' },
}

function releaseManifest(version = '0.4.2', url = HEADLESS_URL) {
  return {
    version,
    critical: false,
    artifacts: {
      headless: {
        delivery: 'feed',
        platforms: {
          'linux-x86_64': {
            url,
            digest: 'sha256-headless',
            signature: 'HEADLESS-SIGNATURE',
          },
        },
      },
    },
  }
}

/** The four platforms a release publishes, and where each one's tarball lives. */
const FOUR_PLATFORM_URLS: Record<string, string> = {
  'linux-x86_64': `${RELEASE_BASE}/podium-headless-linux-x64.tar.gz`,
  'linux-aarch64': `${RELEASE_BASE}/podium-headless-linux-arm64.tar.gz`,
  'darwin-aarch64': `${RELEASE_BASE}/podium-headless-darwin-arm64.tar.gz`,
  'darwin-x86_64': `${RELEASE_BASE}/podium-headless-darwin-x64.tar.gz`,
}

function fourPlatformManifest(version = '0.4.2') {
  return {
    version,
    critical: false,
    artifacts: {
      headless: {
        delivery: 'feed',
        platforms: Object.fromEntries(
          Object.entries(FOUR_PLATFORM_URLS).map(([platform, url]) => [
            platform,
            { url, digest: `sha256-${platform}`, signature: `SIG-${platform}` },
          ]),
        ),
      },
    },
  }
}

function desktopManifest(version = '0.4.2') {
  return {
    version,
    bridgeVersion: 1,
    platforms: {
      'darwin-aarch64': {
        url: DESKTOP_URL,
        signature: 'DESKTOP-SIGNATURE',
      },
    },
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function fetchFixture(input: {
  release?: unknown
  desktop?: unknown
  artifactStatus?: Partial<Record<string, number>>
}) {
  return vi.fn<typeof fetch>(async (request) => {
    const url = String(request)
    if (url === releaseManifestUrl('edge')) return json(input.release ?? releaseManifest())
    if (url === desktopReleaseManifestUrl('edge')) {
      return json(input.desktop ?? desktopManifest())
    }
    return new Response(null, { status: input.artifactStatus?.[url] ?? 200 })
  })
}

/** The dev feed answers only its own manifest; everything else is an artifact HEAD. */
function devFetchFixture(input: {
  release?: unknown
  artifactStatus?: Partial<Record<string, number>>
}) {
  return vi.fn<typeof fetch>(async (request) => {
    const url = String(request)
    if (url === DEV_FEED.manifestUrl) {
      return json(input.release ?? releaseManifest('0.1.2-dev.4+abc1234', DEV_ARTIFACT_URL))
    }
    return new Response(null, { status: input.artifactStatus?.[url] ?? 200 })
  })
}

describe('resolveReleaseTarget', () => {
  it('publishes the target once the headless artifacts it names exist', async () => {
    const fetchImpl = fetchFixture({})

    await expect(resolveReleaseTarget('edge', { fetch: fetchImpl })).resolves.toMatchObject({
      version: '0.4.2',
    })

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const calls = fetchImpl.mock.calls
    expect(calls.map(([url]) => String(url))).toEqual([releaseManifestUrl('edge'), HEADLESS_URL])
    expect(calls.slice(0, 1).every(([, init]) => init?.cache === 'no-store')).toBe(true)
    expect(
      calls
        .slice(1)
        .every(
          ([, init]) =>
            init?.method === 'HEAD' && init?.cache === 'no-store' && init?.redirect === 'manual',
        ),
    ).toBe(true)
  })

  it('offers the headless payload when no desktop build was ever published', async () => {
    // THE STRANDING THIS ROW EXISTS FOR (POD-2794). A headless-only release
    // uploads no `latest.json`, so the desktop leg 404s. That must not be able
    // to withdraw the headless offer: a machine with no shell has no stake in
    // whether a shell exists.
    const fetchImpl = vi.fn<typeof fetch>(async (request) => {
      const url = String(request)
      if (url === releaseManifestUrl('edge')) return json(releaseManifest())
      if (url === desktopReleaseManifestUrl('edge')) return new Response(null, { status: 404 })
      return new Response(null, { status: 200 })
    })

    await expect(resolveReleaseTarget('edge', { fetch: fetchImpl })).resolves.toMatchObject({
      version: '0.4.2',
    })
  })

  it('never asks for the desktop manifest when the release requires no shell', async () => {
    // Not merely tolerating the 404 — not depending on the answer at all. The
    // shell fetches `latest.json` itself; the only thing the desktop leg owes
    // the HEADLESS target is a `minRequired.desktop*` this release actually
    // stated. Asserting the call LIST rather than a count is what makes the
    // decoupling visible when someone reintroduces the fetch.
    const fetchImpl = fetchFixture({})

    await expect(resolveReleaseTarget('edge', { fetch: fetchImpl })).resolves.toMatchObject({
      version: '0.4.2',
    })
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).not.toContain(
      desktopReleaseManifestUrl('edge'),
    )
  })

  it('offers the headless payload when the standing shell artifact has been pruned', async () => {
    // Was the inverse assertion until POD-2794: a desktop artifact returning 404
    // used to fail the whole target, so pruning an old shell silently stopped
    // every headless install from being offered anything.
    const fetchImpl = fetchFixture({ artifactStatus: { [DESKTOP_URL]: 404 } })

    await expect(resolveReleaseTarget('edge', { fetch: fetchImpl })).resolves.toMatchObject({
      version: '0.4.2',
    })
  })

  it('offers the headless payload when the desktop manifest is unreadable', async () => {
    const fetchImpl = fetchFixture({ desktop: { version: 7, platforms: 'nonsense' } })

    await expect(resolveReleaseTarget('edge', { fetch: fetchImpl })).resolves.toMatchObject({
      version: '0.4.2',
    })
  })

  it('keeps advertising a headless release while latest.json references the standing shell', async () => {
    const fetchImpl = fetchFixture({ desktop: desktopManifest('0.4.1') })

    await expect(resolveReleaseTarget('edge', { fetch: fetchImpl })).resolves.toMatchObject({
      version: '0.4.2',
    })
  })

  it('refuses a stated shell requirement it cannot verify', async () => {
    // The mirror of the rows above, and what keeps them from being a blanket
    // "ignore the desktop leg": a release that SAYS it needs a shell must not be
    // handed out when the manifest that would prove it is missing.
    const release = { ...releaseManifest(), minRequired: { desktop: '0.4.2' } }
    const fetchImpl = vi.fn<typeof fetch>(async (request) => {
      const url = String(request)
      if (url === releaseManifestUrl('edge')) return json(release)
      if (url === desktopReleaseManifestUrl('edge')) return new Response(null, { status: 404 })
      return new Response(null, { status: 200 })
    })

    await expect(resolveReleaseTarget('edge', { fetch: fetchImpl })).rejects.toThrow(
      'desktop manifest returned HTTP 404',
    )
  })

  it('offers a shell-requiring release whose satisfying shell asset is unreachable', async () => {
    // The narrow case the two rows above cannot reach. When a release DOES state
    // `minRequired.desktop`, the manifest is fetched — and the temptation is to
    // HEAD the shell assets while we are holding it. That would put the
    // stranding straight back for exactly the releases that care most about the
    // shell: the version window is satisfied, nothing is wrong with the payload,
    // and a pruned old asset would still retract it. Reachability of the shell
    // is the shell's own business; this resolver returns the headless target,
    // which never names these URLs.
    const release = { ...releaseManifest(), minRequired: { desktop: '0.4.0' } }
    const fetchImpl = fetchFixture({ release, artifactStatus: { [DESKTOP_URL]: 404 } })

    await expect(resolveReleaseTarget('edge', { fetch: fetchImpl })).resolves.toMatchObject({
      version: '0.4.2',
    })
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).not.toContain(DESKTOP_URL)
  })

  it('refuses a standing shell outside the declared compatibility window', async () => {
    const release = {
      ...releaseManifest(),
      minRequired: { desktop: '0.4.2', desktopBridge: 2 },
    }
    const fetchImpl = fetchFixture({ release, desktop: desktopManifest('0.4.1') })

    await expect(resolveReleaseTarget('edge', { fetch: fetchImpl })).rejects.toThrow(
      'desktop shell 0.4.1 is below required 0.4.2',
    )
  })

  it('refuses a standing shell whose bridge is below the declared compatibility window', async () => {
    const release = { ...releaseManifest(), minRequired: { desktopBridge: 2 } }
    const fetchImpl = fetchFixture({ release, desktop: desktopManifest('0.4.2') })

    await expect(resolveReleaseTarget('edge', { fetch: fetchImpl })).rejects.toThrow(
      'desktop bridge 1 is below required 2',
    )
  })

  it('does not advertise a target whose headless artifact is not fetchable', async () => {
    const fetchImpl = fetchFixture({ artifactStatus: { [HEADLESS_URL]: 404 } })

    await expect(resolveReleaseTarget('edge', { fetch: fetchImpl })).rejects.toThrow(
      'headless linux-x86_64 artifact returned HTTP 404',
    )
  })

  // A release now names four headless platforms, both Darwin ones included
  // [spec:SP-6144 section 8b]. The resolver reads whatever the manifest declares rather
  // than a list of its own, so widening the set needed no change here — these two tests
  // are what turn that from an assumption into something checked.
  it('checks every platform a four-platform release names', async () => {
    const fetchImpl = fetchFixture({ release: fourPlatformManifest() })

    await expect(resolveReleaseTarget('edge', { fetch: fetchImpl })).resolves.toMatchObject({
      version: '0.4.2',
    })
    const asked = fetchImpl.mock.calls.map(([url]) => String(url))
    for (const url of Object.values(FOUR_PLATFORM_URLS)) expect(asked).toContain(url)
  })

  it('does not advertise a release whose darwin artifact is missing from the page', async () => {
    const fetchImpl = fetchFixture({
      release: fourPlatformManifest(),
      artifactStatus: { [FOUR_PLATFORM_URLS['darwin-aarch64'] as string]: 404 },
    })

    await expect(resolveReleaseTarget('edge', { fetch: fetchImpl })).rejects.toThrow(
      'headless darwin-aarch64 artifact returned HTTP 404',
    )
  })
})

/**
 * THE TRUST ROOT IS A FACT ABOUT THE CHANNEL (spec §1, dispositions 1 and 2).
 *
 * Before this, `dev` was pushed by the publisher and edge/stable were pulled,
 * and the key a daemon verified against was read off the DELIVERY KIND. These
 * arms are the two halves of the replacement: the resolver stamps the root from
 * the channel it was asked for, and it refuses a manifest that tries to reach
 * across into another channel's trust domain.
 */
describe('resolveReleaseTarget trust root', () => {
  it('stamps `release` on a release channel', async () => {
    await expect(resolveReleaseTarget('edge', { fetch: fetchFixture({}) })).resolves.toMatchObject({
      trust: 'release',
    })
  })

  it('stamps `instance` on the dev channel and carries machine credentials', async () => {
    const fetchImpl = devFetchFixture({})

    await expect(
      resolveReleaseTarget('dev', { fetch: fetchImpl, feed: DEV_FEED }),
    ).resolves.toMatchObject({ version: '0.1.2-dev.4+abc1234', trust: 'instance' })

    // Manifest AND artifact HEAD both authenticated: the dev feed is 401-first,
    // and a resolver that authenticated only the manifest would resolve targets
    // whose artifacts nothing could actually fetch.
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      DEV_FEED.manifestUrl,
      DEV_ARTIFACT_URL,
    ])
    for (const [, init] of fetchImpl.mock.calls) {
      expect((init?.headers as Record<string, string>)?.authorization).toBe('Bearer machine-token')
    }
  })

  it('sends NO credentials on a release channel', async () => {
    const fetchImpl = fetchFixture({})
    await resolveReleaseTarget('edge', { fetch: fetchImpl })
    for (const [, init] of fetchImpl.mock.calls) expect(init?.headers).toBeUndefined()
  })

  /**
   * THE ATTACK LIST. Every spelling that has ever walked this fence, as a
   * permanent case, so the next edit cannot quietly reopen one.
   */
  describe('origin fence attacks', () => {
    const expectRefusedAtResolve = async (url: string) => {
      const fetchImpl = fetchFixture({ release: releaseManifest('0.4.2', url) })
      await expect(resolveReleaseTarget('edge', { fetch: fetchImpl })).rejects.toThrow(
        /headless linux-x86_64 artifact is served from outside the edge feed/,
      )
      // The point of the list: the refusal lands at RESOLVE time, before a
      // single artifact byte is requested. Reading the manifest is the only
      // fetch a fenced-out release gets to cause.
      expect(fetchImpl.mock.calls.map(([request]) => String(request))).toEqual([
        releaseManifestUrl('edge'),
      ])
    }

    it('REFUSES an absolute URL on another host', async () => {
      await expectRefusedAtResolve(DEV_ARTIFACT_URL)
    })

    it('REFUSES a host that is a prefix of the feed host', async () => {
      await expectRefusedAtResolve(
        'https://github.com.attacker.example/madeinorbit/podium/releases/download/edge/x.tar.gz',
      )
    })

    it('REFUSES a path-traversal URL that still string-prefixes the fence', async () => {
      await expectRefusedAtResolve(
        `${RELEASE_BASE}/../../../../attacker/repo/releases/download/x.tar.gz`,
      )
    })

    it('REFUSES a percent-encoded path traversal out of the feed', async () => {
      await expectRefusedAtResolve(
        `${RELEASE_BASE}/%2e%2e/%2e%2e/%2e%2e/%2e%2e/attacker/repo/releases/download/x.tar.gz`,
      )
    })

    it('REFUSES a single-segment encoded slash traversal out of the feed', async () => {
      await expectRefusedAtResolve(
        `${RELEASE_BASE}/%2e%2e%2f%2e%2e%2f%2e%2e%2f%2e%2e%2fattacker/x.tar.gz`,
      )
    })

    it('REFUSES a literal-dot encoded-slash traversal that href.startsWith would accept', async () => {
      await expectRefusedAtResolve(`${RELEASE_BASE}/..%2f..%2f..%2f..%2fattacker/x.tar.gz`)
    })

    /**
     * SINGLE-DECODING IS NOT ENOUGH. One decode of `%252e%252e%252f` leaves
     * `%2e%2e%2f`, which still looks like a filename. A second decode produces
     * the slash. Decode-once-and-split accepts this; decode-to-a-fixed-point
     * and refuse a newly-introduced separator does not.
     */
    it('REFUSES a double-encoded path traversal out of the feed', async () => {
      await expectRefusedAtResolve(
        `${RELEASE_BASE}/%252e%252e%252f%252e%252e%252f%252e%252e%252fattacker/x.tar.gz`,
      )
    })

    it('REFUSES an artifact URL that carries userinfo', async () => {
      await expectRefusedAtResolve(HEADLESS_URL.replace('https://', 'https://user:pw@'))
    })

    it('REFUSES an artifact URL that does not parse', async () => {
      await expectRefusedAtResolve('https://[broken')
    })

    /**
     * CONTAINMENT AT FETCH TIME. The named URL sits inside the fence; the
     * transport then follows a 302 to another origin. Default `fetch` follows
     * redirects, so the URL we validated is not the URL we HEAD. A feed
     * serving its own artifacts has no reason to send us off-origin.
     */
    it('REFUSES an in-feed artifact that redirects to another origin', async () => {
      const attacker = 'https://attacker.example/x.tar.gz'
      const fetchImpl = vi.fn<typeof fetch>(async (request, init) => {
        const url = String(request)
        if (url === releaseManifestUrl('edge')) return json(releaseManifest())
        if (url === desktopReleaseManifestUrl('edge')) return json(desktopManifest())
        if (url === HEADLESS_URL) {
          const mode = init?.redirect ?? 'follow'
          if (mode === 'follow') {
            // Default fetch would request Location next. Returning 200 here is
            // that hop succeeding against the attacker, without a recursive
            // mock that TypeScript cannot type.
            return new Response(null, { status: 200 })
          }
          if (mode === 'error') throw new TypeError('Failed to fetch')
          return new Response(null, { status: 302, headers: { location: attacker } })
        }
        if (url === attacker) return new Response(null, { status: 200 })
        return new Response(null, { status: 200 })
      })

      await expect(resolveReleaseTarget('edge', { fetch: fetchImpl })).rejects.toThrow(
        /headless linux-x86_64 artifact redirected outside the edge feed/,
      )
      expect(fetchImpl.mock.calls.map(([request]) => String(request))).not.toContain(attacker)
    })
  })

  /**
   * REDIRECTS ARE PER CHANNEL. Dev never follows: it is this server serving
   * its own artifacts. Edge and stable follow GitHub's object-host hop, and
   * only that hop — bounded, https, whole-host allowlist.
   */
  describe('artifact redirect hops', () => {
    const GITHUB_OBJECT =
      'https://objects.githubusercontent.com/github-production-release-asset/x.tar.gz'

    const edgeFetch = (onHeadless: (init?: RequestInit) => Response) =>
      vi.fn<typeof fetch>(async (request, init) => {
        const url = String(request)
        if (url === releaseManifestUrl('edge')) return json(releaseManifest())
        if (url === desktopReleaseManifestUrl('edge')) return json(desktopManifest())
        if (url === HEADLESS_URL) return onHeadless(init)
        return new Response(null, { status: 200 })
      })

    it('REFUSES a dev-feed artifact that redirects anywhere, including inside the feed', async () => {
      const inFeed = `${DEV_ORIGIN}/updates/feed/dev/other.tar.gz`
      const fetchImpl = vi.fn<typeof fetch>(async (request, init) => {
        const url = String(request)
        if (url === DEV_FEED.manifestUrl) {
          return json(releaseManifest('0.1.2-dev.4+abc1234', DEV_ARTIFACT_URL))
        }
        if (url === DEV_ARTIFACT_URL) {
          const mode = init?.redirect ?? 'follow'
          if (mode === 'follow') return new Response(null, { status: 200 })
          return new Response(null, { status: 302, headers: { location: inFeed } })
        }
        if (url === inFeed) return new Response(null, { status: 200 })
        return new Response(null, { status: 200 })
      })

      await expect(
        resolveReleaseTarget('dev', { fetch: fetchImpl, feed: DEV_FEED }),
      ).rejects.toThrow(/redirect/)
      expect(fetchImpl.mock.calls.map(([request]) => String(request))).not.toContain(inFeed)
    })

    it('ACCEPTS a release-channel hop from github.com to objects.githubusercontent.com', async () => {
      const fetchImpl = vi.fn<typeof fetch>(async (request, init) => {
        const url = String(request)
        if (url === releaseManifestUrl('edge')) return json(releaseManifest())
        if (url === desktopReleaseManifestUrl('edge')) return json(desktopManifest())
        if (url === HEADLESS_URL) {
          expect(init?.redirect).toBe('manual')
          return new Response(null, { status: 302, headers: { location: GITHUB_OBJECT } })
        }
        if (url === GITHUB_OBJECT) return new Response(null, { status: 200 })
        return new Response(null, { status: 200 })
      })

      await expect(resolveReleaseTarget('edge', { fetch: fetchImpl })).resolves.toMatchObject({
        version: '0.4.2',
      })
      expect(fetchImpl.mock.calls.map(([request]) => String(request))).toContain(GITHUB_OBJECT)
    })

    it('REFUSES a release-channel hop to a lookalike of the object host', async () => {
      const lookalike = 'https://objects.githubusercontent.com.evil.example/x.tar.gz'
      const fetchImpl = edgeFetch(
        () => new Response(null, { status: 302, headers: { location: lookalike } }),
      )

      await expect(resolveReleaseTarget('edge', { fetch: fetchImpl })).rejects.toThrow(
        /redirected outside the edge feed/,
      )
      expect(fetchImpl.mock.calls.map(([request]) => String(request))).not.toContain(lookalike)
    })

    it('REFUSES a redirect chain longer than the hop cap', async () => {
      const hops = [
        `${RELEASE_BASE}/h1.tar.gz`,
        `${RELEASE_BASE}/h2.tar.gz`,
        `${RELEASE_BASE}/h3.tar.gz`,
        GITHUB_OBJECT,
      ]
      const fetchImpl = vi.fn<typeof fetch>(async (request) => {
        const url = String(request)
        if (url === releaseManifestUrl('edge')) return json(releaseManifest())
        if (url === desktopReleaseManifestUrl('edge')) return json(desktopManifest())
        if (url === HEADLESS_URL) {
          return new Response(null, { status: 302, headers: { location: hops[0] } })
        }
        const index = hops.indexOf(url)
        if (index >= 0 && index < hops.length - 1) {
          return new Response(null, { status: 302, headers: { location: hops[index + 1] } })
        }
        return new Response(null, { status: 200 })
      })

      await expect(resolveReleaseTarget('edge', { fetch: fetchImpl })).rejects.toThrow(
        /redirected too many times/,
      )
      expect(fetchImpl.mock.calls.map(([request]) => String(request))).not.toContain(GITHUB_OBJECT)
    })

    it('REFUSES an http downgrade on any hop', async () => {
      const downgrade =
        'http://objects.githubusercontent.com/github-production-release-asset/x.tar.gz'
      const fetchImpl = edgeFetch(
        () => new Response(null, { status: 302, headers: { location: downgrade } }),
      )

      await expect(resolveReleaseTarget('edge', { fetch: fetchImpl })).rejects.toThrow(/https/)
      expect(fetchImpl.mock.calls.map(([request]) => String(request))).not.toContain(downgrade)
    })

    it('lists the GitHub object host on the release feed, never as a suffix match', () => {
      expect(RELEASE_ARTIFACT_REDIRECT_HOSTS).toEqual([
        'github.com',
        'objects.githubusercontent.com',
      ])
      expect(releaseChannelFeed('edge')?.redirectHosts).toEqual([
        ...RELEASE_ARTIFACT_REDIRECT_HOSTS,
      ])
      expect(DEV_FEED.redirectHosts).toBeUndefined()
    })
  })

  it('REFUSES a release manifest that names a dev-feed artifact URL', async () => {
    const fetchImpl = fetchFixture({ release: releaseManifest('0.4.2', DEV_ARTIFACT_URL) })

    await expect(resolveReleaseTarget('edge', { fetch: fetchImpl })).rejects.toThrow(
      /headless linux-x86_64 artifact is served from outside the edge feed/,
    )
    // Refused at RESOLVE time: nothing was ever downloaded from the other origin.
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).not.toContain(DEV_ARTIFACT_URL)
  })

  it('REFUSES a dev manifest that names an artifact outside the dev feed', async () => {
    const fetchImpl = devFetchFixture({
      release: releaseManifest('0.1.2-dev.4+abc1234', HEADLESS_URL),
    })

    await expect(resolveReleaseTarget('dev', { fetch: fetchImpl, feed: DEV_FEED })).rejects.toThrow(
      /artifact is served from outside the dev feed/,
    )
  })

  it('REFUSES a manifest that declares its own trust root, on any channel', async () => {
    const fetchImpl = fetchFixture({ release: { ...releaseManifest(), trust: 'instance' } })

    await expect(resolveReleaseTarget('edge', { fetch: fetchImpl })).rejects.toThrow(
      'release manifest declared its own trust root',
    )
  })

  /**
   * THE NON-FEED REJECTION, on all three channels and on BOTH artifact slots.
   *
   * It is checked against the raw manifest precisely so it can fire: after the
   * parse it would be unreachable, because the artifact union has one arm. The
   * `git` alternative case is the one that mattered in practice — a release
   * manifest could offer a `feed` primary and slip a second descriptor in
   * beside it, and only the alternatives list would carry it.
   */
  it.each([
    ['edge' as const, 'bundle', undefined],
    ['stable' as const, 'git', undefined],
    ['dev' as const, 'bundle', DEV_FEED],
  ])('REFUSES a %s manifest offering %s delivery', async (channel, delivery, feed) => {
    const manifest = { ...releaseManifest(), artifacts: { headless: { delivery, platforms: {} } } }
    const fetchImpl = vi.fn<typeof fetch>(async () => json(manifest))

    await expect(
      resolveReleaseTarget(channel, { fetch: fetchImpl, ...(feed ? { feed } : {}) }),
    ).rejects.toThrow(`${channel} target unavailable: release manifest offered a non-feed delivery`)
  })

  it('REFUSES a non-feed delivery hidden in the ALTERNATIVES beside a good primary', async () => {
    const fetchImpl = fetchFixture({
      release: {
        ...releaseManifest(),
        artifacts: {
          ...releaseManifest().artifacts,
          headlessAlternatives: [{ delivery: 'git', repo: '/repo', sha: 'abc1234' }],
        },
      },
    })

    await expect(resolveReleaseTarget('edge', { fetch: fetchImpl })).rejects.toThrow(
      /offered a non-feed delivery \(git\)/,
    )
  })

  it('refuses the dev channel outright when this server has no dev feed configured', async () => {
    const fetchImpl = vi.fn<typeof fetch>()

    await expect(resolveReleaseTarget('dev', { fetch: fetchImpl })).rejects.toThrow(
      'no feed is configured for this channel on this server',
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('has no built-in feed for dev, and a release feed for the other two', () => {
    expect(releaseChannelFeed('dev')).toBeUndefined()
    expect(releaseChannelFeed('edge')?.trust).toBe('release')
    expect(releaseChannelFeed('stable')?.trust).toBe('release')
  })
})

describe('desktop shell manifests', () => {
  const shell = (base: string) => ({
    version: '0.4.2-edge.7',
    bridgeVersion: 1,
    platforms: { 'darwin-aarch64': { url: `${base}Podium.app.tar.gz`, signature: 'SIG' } },
  })
  const edgeBase = 'https://github.com/madeinorbit/podium/releases/download/edge/'
  const devBase = 'https://github.com/madeinorbit/podium/releases/download/dev/'

  it('gives the dev shell its own release URL, leaving edge and stable untouched', () => {
    expect(desktopReleaseManifestUrl('edge')).toBe(`${edgeBase}latest.json`)
    expect(desktopReleaseManifestUrl('stable')).toBe(
      'https://github.com/madeinorbit/podium/releases/latest/download/latest.json',
    )
    expect(desktopReleaseManifestUrl('dev')).toBe(`${devBase}latest.json`)
  })

  it('fences each channel to its own release, refusing the other channel by name', () => {
    expect(validateDesktopFeedManifest('edge', shell(edgeBase)).bridgeVersion).toBe(1)
    expect(validateDesktopFeedManifest('dev', shell(devBase)).bridgeVersion).toBe(1)
    // The fence is what keeps the two channels from bleeding into each other. A "dev"
    // manifest whose assets live on the edge release would put an edge shell on a dev
    // machine while every label said dev.
    expect(() => validateDesktopFeedManifest('dev', shell(edgeBase))).toThrow(
      /dev target unavailable: desktop darwin-aarch64 artifact is served from outside the dev feed/,
    )
    expect(() => validateDesktopFeedManifest('edge', shell(devBase))).toThrow(
      /edge target unavailable: desktop darwin-aarch64 artifact is served from outside the edge feed/,
    )
  })

  it('names the channel a served manifest actually carries, from its own URLs', () => {
    // Read off the SHIPPED BYTES rather than remembered at publish time: this is what a
    // reader gets to check, and it survives a restart that forgets what was fetched.
    expect(desktopManifestFeedChannel(shell(devBase))).toBe('dev')
    expect(desktopManifestFeedChannel(shell(edgeBase))).toBe('edge')
    expect(desktopManifestFeedChannel({ nonsense: true })).toBeUndefined()
    expect(
      desktopManifestFeedChannel({
        version: '1',
        platforms: {
          a: { url: `${devBase}A.tar.gz`, signature: 'S' },
          b: { url: `${edgeBase}B.tar.gz`, signature: 'S' },
        },
      }),
      'a manifest straddling two releases names neither',
    ).toBeUndefined()
  })
})
