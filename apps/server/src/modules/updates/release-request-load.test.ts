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
  it('counts every request across two unchanged four-platform refreshes', async () => {
    const requests: Array<{ url: string; method: string }> = []
    const countingFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), method: init?.method ?? 'GET' })
      return init?.method === 'HEAD' ? new Response(null) : Response.json(target)
    }) as typeof fetch
    await resolveReleaseTarget('dev', { feed, fetch: countingFetch })
    const first = requests.length
    await resolveReleaseTarget('dev', { feed, fetch: countingFetch })
    const second = requests.length - first
    console.info(
      JSON.stringify({
        measurement: 'release-requests',
        first,
        unchanged: second,
        artifactRequests: requests.filter((request) => request.method === 'HEAD').length,
      }),
    )
    // Baseline before removing the platform probes. The final change tightens this to one.
    expect({ first, unchanged: second }).toEqual({ first: 5, unchanged: 5 })
  })
})
