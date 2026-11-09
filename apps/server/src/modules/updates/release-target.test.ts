import {
  fetchFromReleaseOrigin,
  MIRROR_RELEASE_ORIGIN,
  PRIMARY_RELEASE_ORIGIN,
  RELEASE_ORIGINS,
  releaseChannelPath,
  releaseUrl,
} from '@podium/runtime/release-origins'
import { describe, expect, it, vi } from 'vitest'
import { ReleasePublicationPendingError } from './feed-errors'
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

describe('release origin failover', () => {
  it('binds a mirror product manifest and companion to the mirror without artifact probes', async () => {
    const artifact = releaseUrl(releaseChannelPath('edge') + 'headless.tgz', MIRROR_RELEASE_ORIGIN)
    const release = { ...releaseManifest('1.0.0', artifact), minRequired: { desktop: '1.0.0' } }
    const mirrorManifest = releaseUrl(
      releaseChannelPath('edge') + 'podium-update.json',
      MIRROR_RELEASE_ORIGIN,
    )
    const mirrorDesktop = releaseUrl(
      releaseChannelPath('edge') + 'latest.json',
      MIRROR_RELEASE_ORIGIN,
    )
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url) === releaseManifestUrl('edge')) return new Response(null, { status: 504 })
      if (String(url) === mirrorManifest) return json(release)
      if (String(url) === mirrorDesktop)
        return json({
          ...desktopManifest('1.0.0'),
          platforms: {
            'darwin-aarch64': {
              url: releaseUrl('download/edge/Podium.app.tar.gz', MIRROR_RELEASE_ORIGIN),
              signature: 'DESKTOP-SIGNATURE',
            },
          },
        })
      if (String(url) === artifact && init?.method === 'HEAD') return new Response(null)
      throw new Error(`unexpected URL ${url}`)
    })
    const target = await resolveReleaseTarget('edge', { fetch: fetchImpl })
    expect(target.artifacts.headless?.platforms['linux-x86_64']?.url).toBe(artifact)
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      releaseManifestUrl('edge'),
      mirrorManifest,
      mirrorDesktop,
    ])
    expect(target.trust).toBe('release')
  })

  for (const serving of RELEASE_ORIGINS) {
    for (const other of RELEASE_ORIGINS.filter((origin) => origin !== serving)) {
      it(`${serving.id} cannot name ${other.id} artifacts`, async () => {
        const foreign = releaseUrl(releaseChannelPath('edge') + 'headless.tgz', other)
        const fetchImpl = vi.fn<typeof fetch>(async (url) =>
          String(url) === releaseUrl(releaseChannelPath('edge') + 'podium-update.json', serving)
            ? json(releaseManifest('1.0.0', foreign))
            : new Response(null, { status: 504 }),
        )
        await expect(resolveReleaseTarget('edge', { fetch: fetchImpl })).rejects.toThrow(
          'outside the edge feed',
        )
        expect(fetchImpl.mock.calls.every(([, init]) => init?.method !== 'HEAD')).toBe(true)
      })
    }
  }

  it('resolves relative artifact paths only against the serving origin', async () => {
    const manifestUrl = releaseUrl(
      releaseChannelPath('edge') + 'podium-update.json',
      MIRROR_RELEASE_ORIGIN,
    )
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      if (String(url) === releaseManifestUrl('edge')) return new Response(null, { status: 504 })
      if (String(url) === manifestUrl)
        return json(releaseManifest('1.0.0', 'download/edge/headless.tgz'))
      return new Response(null)
    })
    const result = await resolveReleaseTarget('edge', { fetch: fetchImpl })
    expect(result.artifacts.headless?.platforms['linux-x86_64']?.url).toBe(
      releaseUrl('download/edge/headless.tgz', MIRROR_RELEASE_ORIGIN),
    )
  })
})

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

/** The private dev feed authenticates its single discovery request. */
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
  it('resolves a published manifest with one request and no artifact probes', async () => {
    const fetchImpl = fetchFixture({})
    await expect(resolveReleaseTarget('edge', { fetch: fetchImpl })).resolves.toMatchObject({
      version: '0.4.2',
    })
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([releaseManifestUrl('edge')])
    expect(fetchImpl.mock.calls[0]?.[1]?.cache).toBe('no-store')
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

  it('does not probe a missing named artifact during discovery', async () => {
    const fetchImpl = fetchFixture({ artifactStatus: { [HEADLESS_URL]: 404 } })
    await expect(resolveReleaseTarget('edge', { fetch: fetchImpl })).resolves.toMatchObject({
      version: '0.4.2',
    })
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([releaseManifestUrl('edge')])
  })

  it('retains all four platform descriptors without requesting any artifact', async () => {
    const fetchImpl = fetchFixture({
      release: fourPlatformManifest(),
      artifactStatus: { [FOUR_PLATFORM_URLS['darwin-aarch64'] as string]: 404 },
    })
    const target = await resolveReleaseTarget('edge', { fetch: fetchImpl })
    expect(Object.keys(target.artifacts.headless?.platforms ?? {}).sort()).toEqual(
      Object.keys(FOUR_PLATFORM_URLS).sort(),
    )
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([releaseManifestUrl('edge')])
  })

  it('stops an unchanged manifest before rechecking its companion', async () => {
    const fetchImpl = fetchFixture({
      release: { ...releaseManifest(), minRequired: { desktop: '0.4.2' } },
    })
    const previous = await resolveReleaseTarget('edge', { fetch: fetchImpl })
    fetchImpl.mockClear()
    expect(await resolveReleaseTarget('edge', { fetch: fetchImpl, previous })).toBe(previous)
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([releaseManifestUrl('edge')])
  })

  it('rechecks a same-version manifest when its digest changes', async () => {
    const release = { ...releaseManifest(), minRequired: { desktop: '0.4.2' } }
    const fetchImpl = fetchFixture({ release })
    const previous = await resolveReleaseTarget('edge', { fetch: fetchImpl })
    release.artifacts.headless.platforms['linux-x86_64'].digest = 'sha256-republished'
    fetchImpl.mockClear()
    const changed = await resolveReleaseTarget('edge', { fetch: fetchImpl, previous })
    expect(changed.artifacts.headless?.platforms['linux-x86_64']?.digest).toBe('sha256-republished')
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      releaseManifestUrl('edge'),
      desktopReleaseManifestUrl('edge'),
    ])
  })

  it.each([
    404, 503,
  ])('uses short publication retry only for a required companion 404 (%s)', async (status) => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) =>
      String(url) === releaseManifestUrl('edge')
        ? json({ ...releaseManifest(), minRequired: { desktop: '0.4.2' } })
        : new Response(null, { status }),
    )
    const error = await resolveReleaseTarget('edge', { fetch: fetchImpl }).catch(
      (error: unknown) => error,
    )
    expect(error instanceof ReleasePublicationPendingError).toBe(status === 404)
    expect(error).toBeInstanceOf(Error)
  })

  it('validates trust even when the previous target has the same version and bytes', async () => {
    const previous = await resolveReleaseTarget('edge', { fetch: fetchFixture({}) })
    await expect(
      resolveReleaseTarget('edge', {
        previous,
        fetch: fetchFixture({ release: { ...releaseManifest(), trust: 'instance' } }),
      }),
    ).rejects.toThrow('declared its own trust root')
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

    // Discovery authenticates the manifest and makes no artifact requests.
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([DEV_FEED.manifestUrl])
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
  })

  // Discovery no longer touches artifact URLs. Redirect trust is enforced by the
  // shared transport when an artifact is actually downloaded.
  describe('artifact download redirect policy', () => {
    const object = 'https://objects.githubusercontent.com/github-production-release-asset/x.tar.gz'
    it.each(
      PRIMARY_RELEASE_ORIGIN.redirectHosts,
    )('accepts an allowed %s redirect', async (host) => {
      const destination = `https://${host}/payload.tar.gz`
      const fetchImpl = vi.fn<typeof fetch>(async (url) =>
        String(url) === HEADLESS_URL
          ? new Response(null, { status: 302, headers: { location: destination } })
          : new Response(null),
      )
      await expect(
        fetchFromReleaseOrigin(HEADLESS_URL, PRIMARY_RELEASE_ORIGIN, {}, fetchImpl),
      ).resolves.toHaveProperty('status', 200)
      expect(fetchImpl.mock.calls.map(([url]) => String(url))).toContain(destination)
    })
    it.each([
      'https://objects.githubusercontent.com.evil.example/a',
      'https://attacker.example/a',
      'http://objects.githubusercontent.com/a',
      'https://user:pw@objects.githubusercontent.com/a',
      'https://objects.githubusercontent.com:444/a',
    ])('refuses an unsafe artifact redirect %s', async (destination) => {
      const fetchImpl = vi.fn<typeof fetch>(
        async () => new Response(null, { status: 302, headers: { location: destination } }),
      )
      await expect(
        fetchFromReleaseOrigin(HEADLESS_URL, PRIMARY_RELEASE_ORIGIN, {}, fetchImpl),
      ).rejects.toThrow('redirected outside')
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    })
    it('caps redirect chains', async () => {
      const fetchImpl = vi.fn<typeof fetch>(
        async () => new Response(null, { status: 302, headers: { location: object } }),
      )
      await expect(
        fetchFromReleaseOrigin(HEADLESS_URL, PRIMARY_RELEASE_ORIGIN, {}, fetchImpl),
      ).rejects.toThrow('invalid release redirect')
    })
    it('leaves redirect hosts owned by the shared release-origin policy', () => {
      expect(releaseChannelFeed('edge')?.redirectHosts).toEqual(RELEASE_ARTIFACT_REDIRECT_HOSTS)
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
