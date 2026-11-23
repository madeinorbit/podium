import {
  MIRROR_RELEASE_ORIGIN,
  PRIMARY_RELEASE_ORIGIN,
  releaseChannelPath,
  releaseUrl,
} from '@podium/runtime/release-origins'
import { describe, expect, it } from 'vitest'
import { type ChannelFeed, resolveReleaseTarget } from './release-target'

const feed: ChannelFeed = {
  manifestUrl: 'http://local.test/feed/podium-update.json',
  artifactBase: 'http://local.test/feed/',
  trust: 'instance',
}
const target = {
  version: '1.2.3',
  critical: false,
  artifacts: {
    headless: {
      delivery: 'feed',
      platforms: Object.fromEntries(
        ['linux-x86_64', 'linux-aarch64', 'darwin-x86_64', 'darwin-aarch64'].map((platform) => [
          platform,
          {
            url: `http://local.test/feed/${platform}.tar.gz`,
            digest: 'sha256-fixture',
            signature: 'signature',
          },
        ]),
      ),
    },
  },
}

describe('release feed request measurement', () => {
  it.each([
    PRIMARY_RELEASE_ORIGIN,
    MIRROR_RELEASE_ORIGIN,
  ])('counts the %s manifest transport without any platform requests', async (origin) => {
    const path = releaseChannelPath('edge') + 'podium-update.json'
    const manifestUrl = releaseUrl(path, origin)
    const objectUrl = 'https://release-assets.githubusercontent.com/release/manifest.json'
    const manifest = structuredClone(target)
    for (const [platform, asset] of Object.entries(manifest.artifacts.headless.platforms)) {
      asset.url = releaseUrl(releaseChannelPath('edge') + platform + '.tar.gz', origin)
    }
    const requests: Array<{ url: string; conditional: string | null }> = []
    const countingFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const address = String(url)
      const conditional = new Headers(init?.headers).get('if-none-match')
      requests.push({ url: address, conditional })
      if (origin.id === 'github' && address === manifestUrl) {
        return new Response(null, { status: 302, headers: { location: objectUrl } })
      }
      if (address !== manifestUrl && address !== objectUrl)
        throw new Error('artifact request during discovery')
      return conditional
        ? new Response(null, { status: 304 })
        : Response.json(manifest, { headers: { etag: '"manifest-v1"' } })
    }) as typeof fetch
    const publicFeed: ChannelFeed = {
      manifestUrl,
      artifactBase: releaseUrl('download/', origin),
      releaseOrigin: origin,
      originPinned: true,
      trust: 'release',
    }
    const previous = await resolveReleaseTarget('edge', { feed: publicFeed, fetch: countingFetch })
    const before = requests.length
    expect(
      await resolveReleaseTarget('edge', { feed: publicFeed, fetch: countingFetch, previous }),
    ).toBe(previous)
    const unchanged = requests.length - before
    expect(unchanged).toBe(origin.id === 'github' ? 2 : 1)
    expect(requests.filter((request) => request.url === manifestUrl)).toHaveLength(2)
    expect(requests.every((request) => request.conditional === null)).toBe(true)
    if (origin.id === 'mirror') {
      const beforeConditional = requests.length
      const conditional = await countingFetch(manifestUrl, {
        headers: { 'if-none-match': '"manifest-v1"' },
      })
      expect(conditional.status).toBe(304)
      // A 304 saves bytes, but still costs one direct request: no validator is retained.
      expect(requests.length - beforeConditional).toBe(unchanged)
    }
    console.info(
      JSON.stringify({
        measurement: 'release-origin-requests',
        origin: origin.id,
        unchangedWireRequests: unchanged,
        manifestOriginRequestsPerRefresh: 1,
        artifactRequests: 0,
      }),
    )
  })

  it('counts every request across two unchanged four-platform refreshes', async () => {
    const requests: Array<{ url: string; method: string }> = []
    const countingFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), method: init?.method ?? 'GET' })
      return init?.method === 'HEAD' ? new Response(null) : Response.json(target)
    }) as typeof fetch
    const previous = await resolveReleaseTarget('dev', { feed, fetch: countingFetch })
    const first = requests.length
    await resolveReleaseTarget('dev', { feed, fetch: countingFetch, previous })
    const second = requests.length - first
    console.info(
      JSON.stringify({
        measurement: 'release-requests',
        first,
        unchanged: second,
        artifactRequests: requests.filter((request) => request.method === 'HEAD').length,
      }),
    )
    // Measured baseline at e948fd23e6: 5 + 5 requests, including 8 artifact HEADs.
    expect({ first, unchanged: second }).toEqual({ first: 1, unchanged: 1 })
    expect(
      requests.every(
        (request) => request.method === 'GET' && request.url.endsWith('podium-update.json'),
      ),
    ).toBe(true)
  })
})
