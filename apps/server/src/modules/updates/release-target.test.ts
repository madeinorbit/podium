import { describe, expect, it, vi } from 'vitest'
import {
  type ChannelFeed,
  desktopReleaseManifestUrl,
  devFeedManifestUrl,
  releaseChannelFeed,
  releaseManifestUrl,
  resolveReleaseTarget,
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
  'linux-x86_64': 'https://downloads.test/podium-headless-linux-x64.tar.gz',
  'linux-aarch64': 'https://downloads.test/podium-headless-linux-arm64.tar.gz',
  'darwin-aarch64': 'https://downloads.test/podium-headless-darwin-arm64.tar.gz',
  'darwin-x86_64': 'https://downloads.test/podium-headless-darwin-x64.tar.gz',
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
  it('publishes the target only after the matching desktop build and named artifacts exist', async () => {
    const fetchImpl = fetchFixture({})

    await expect(resolveReleaseTarget('edge', { fetch: fetchImpl })).resolves.toMatchObject({
      version: '0.4.2',
    })

    expect(fetchImpl).toHaveBeenCalledTimes(4)
    const calls = fetchImpl.mock.calls
    expect(calls.map(([url]) => String(url))).toEqual([
      releaseManifestUrl('edge'),
      desktopReleaseManifestUrl('edge'),
      HEADLESS_URL,
      DESKTOP_URL,
    ])
    expect(calls.slice(0, 2).every(([, init]) => init?.cache === 'no-store')).toBe(true)
    expect(
      calls.slice(2).every(([, init]) => init?.method === 'HEAD' && init?.cache === 'no-store'),
    ).toBe(true)
  })

  it('does not advertise a headless version while the desktop feed still names the old build', async () => {
    const fetchImpl = fetchFixture({ desktop: desktopManifest('0.4.1') })

    await expect(resolveReleaseTarget('edge', { fetch: fetchImpl })).rejects.toThrow(
      'desktop build for 0.4.2 is not published yet',
    )

    // The version mismatch is sufficient proof of the publication window; no
    // download can make these two manifests describe one installable release.
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('does not advertise a target whose desktop artifact is not fetchable', async () => {
    const fetchImpl = fetchFixture({ artifactStatus: { [DESKTOP_URL]: 404 } })

    await expect(resolveReleaseTarget('edge', { fetch: fetchImpl })).rejects.toThrow(
      'desktop darwin-aarch64 artifact returned HTTP 404',
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

    await expect(resolveReleaseTarget('edge', fetchImpl)).resolves.toMatchObject({
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

    await expect(resolveReleaseTarget('edge', fetchImpl)).rejects.toThrow(
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

  it('REFUSES a release manifest that names a dev-feed artifact URL', async () => {
    const fetchImpl = fetchFixture({ release: releaseManifest('0.4.2', DEV_ARTIFACT_URL) })

    await expect(resolveReleaseTarget('edge', { fetch: fetchImpl })).rejects.toThrow(
      /headless linux-x86_64 artifact is served from outside the edge feed/,
    )
    // Refused at RESOLVE time: nothing was ever downloaded from the other origin.
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).not.toContain(DEV_ARTIFACT_URL)
  })

  /**
   * TEXT PREFIX IS NOT CONTAINMENT. `startsWith(artifactBase)` accepts a URL
   * that still has the fence as a prefix and then walks out of it with `../`.
   * `fetch` parses the URL and drops the dot segments, so the HEAD goes to
   * another repository on the same host. The fence's job is to refuse that at
   * resolve time, not after a download, and not on a signature mismatch.
   */
  it('REFUSES a path-traversal URL that still string-prefixes the fence', async () => {
    const escaped = `${RELEASE_BASE}/../../../../attacker/repo/releases/download/x.tar.gz`
    const fetchImpl = fetchFixture({ release: releaseManifest('0.4.2', escaped) })

    await expect(resolveReleaseTarget('edge', { fetch: fetchImpl })).rejects.toThrow(
      /headless linux-x86_64 artifact is served from outside the edge feed/,
    )
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      releaseManifestUrl('edge'),
      desktopReleaseManifestUrl('edge'),
    ])
  })

  it('REFUSES a percent-encoded path traversal out of the feed', async () => {
    const escaped = `${RELEASE_BASE}/%2e%2e/%2e%2e/%2e%2e/%2e%2e/attacker/repo/releases/download/x.tar.gz`
    const fetchImpl = fetchFixture({ release: releaseManifest('0.4.2', escaped) })

    await expect(resolveReleaseTarget('edge', { fetch: fetchImpl })).rejects.toThrow(
      /headless linux-x86_64 artifact is served from outside the edge feed/,
    )
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      releaseManifestUrl('edge'),
      desktopReleaseManifestUrl('edge'),
    ])
  })

  it('REFUSES a single-segment encoded slash traversal out of the feed', async () => {
    const escaped = `${RELEASE_BASE}/%2e%2e%2f%2e%2e%2f%2e%2e%2f%2e%2e%2fattacker/x.tar.gz`
    const fetchImpl = fetchFixture({ release: releaseManifest('0.4.2', escaped) })

    await expect(resolveReleaseTarget('edge', { fetch: fetchImpl })).rejects.toThrow(
      /headless linux-x86_64 artifact is served from outside the edge feed/,
    )
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      releaseManifestUrl('edge'),
      desktopReleaseManifestUrl('edge'),
    ])
  })

  /**
   * THE SPELLING `new URL().href.startsWith(base)` WOULD PASS. `new URL`
   * resolves `../`, `%2e%2e`, and `.%2e` as dot segments; it does NOT decode
   * `%2f` before that, so `..%2f..%2fattacker` stays a path that still string-
   * prefixes the fence. Only a later, lenient origin server would decode it.
   * Per-segment decode-and-split is what refuses it here.
   */
  it('REFUSES a literal-dot encoded-slash traversal that href.startsWith would accept', async () => {
    const escaped = `${RELEASE_BASE}/..%2f..%2f..%2f..%2fattacker/x.tar.gz`
    const fetchImpl = fetchFixture({ release: releaseManifest('0.4.2', escaped) })

    await expect(resolveReleaseTarget('edge', { fetch: fetchImpl })).rejects.toThrow(
      /headless linux-x86_64 artifact is served from outside the edge feed/,
    )
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      releaseManifestUrl('edge'),
      desktopReleaseManifestUrl('edge'),
    ])
  })

  /**
   * Same origin, path inside the fence, credentials in the userinfo. `fetch`
   * turns that into an Authorization header, so a manifest that names
   * `https://user:pw@github.com/...` is not a feed artifact — it is a request
   * made as someone else.
   */
  it('REFUSES an artifact URL that carries userinfo', async () => {
    const withUserinfo = HEADLESS_URL.replace('https://', 'https://user:pw@')
    const fetchImpl = fetchFixture({ release: releaseManifest('0.4.2', withUserinfo) })

    await expect(resolveReleaseTarget('edge', { fetch: fetchImpl })).rejects.toThrow(
      /headless linux-x86_64 artifact is served from outside the edge feed/,
    )
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      releaseManifestUrl('edge'),
      desktopReleaseManifestUrl('edge'),
    ])
  })

  it('REFUSES an artifact URL that does not parse', async () => {
    const fetchImpl = fetchFixture({ release: releaseManifest('0.4.2', 'https://[broken') })

    await expect(resolveReleaseTarget('edge', { fetch: fetchImpl })).rejects.toThrow(
      /headless linux-x86_64 artifact is served from outside the edge feed/,
    )
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
