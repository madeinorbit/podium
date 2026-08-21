import { describe, expect, it, vi } from 'vitest'
import {
  desktopReleaseManifestUrl,
  releaseManifestUrl,
  resolveReleaseTarget,
} from './release-target'

const HEADLESS_URL = 'https://downloads.test/podium-headless-linux-x64.tar.gz'
const DESKTOP_URL = 'https://downloads.test/Podium.app.tar.gz'

function releaseManifest(version = '0.4.2') {
  return {
    version,
    critical: false,
    artifacts: {
      headless: {
        delivery: 'feed',
        platforms: {
          'linux-x86_64': {
            url: HEADLESS_URL,
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
  return vi.fn<typeof fetch>(async (request, init) => {
    const url = String(request)
    if (url === releaseManifestUrl('edge')) return json(input.release ?? releaseManifest())
    if (url === desktopReleaseManifestUrl('edge')) {
      return json(input.desktop ?? desktopManifest())
    }
    return new Response(null, { status: input.artifactStatus?.[url] ?? 200 })
  })
}

describe('resolveReleaseTarget', () => {
  it('publishes the target only after the matching desktop build and named artifacts exist', async () => {
    const fetchImpl = fetchFixture({})

    await expect(resolveReleaseTarget('edge', fetchImpl)).resolves.toMatchObject({
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

    await expect(resolveReleaseTarget('edge', fetchImpl)).rejects.toThrow(
      'desktop build for 0.4.2 is not published yet',
    )

    // The version mismatch is sufficient proof of the publication window; no
    // download can make these two manifests describe one installable release.
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('does not advertise a target whose desktop artifact is not fetchable', async () => {
    const fetchImpl = fetchFixture({ artifactStatus: { [DESKTOP_URL]: 404 } })

    await expect(resolveReleaseTarget('edge', fetchImpl)).rejects.toThrow(
      'desktop darwin-aarch64 artifact returned HTTP 404',
    )
  })

  it('does not advertise a target whose headless artifact is not fetchable', async () => {
    const fetchImpl = fetchFixture({ artifactStatus: { [HEADLESS_URL]: 404 } })

    await expect(resolveReleaseTarget('edge', fetchImpl)).rejects.toThrow(
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
      artifactStatus: { [FOUR_PLATFORM_URLS['darwin-aarch64']]: 404 },
    })

    await expect(resolveReleaseTarget('edge', fetchImpl)).rejects.toThrow(
      'headless darwin-aarch64 artifact returned HTTP 404',
    )
  })
})
