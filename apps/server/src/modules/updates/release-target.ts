import { UpdateTarget, type UpdateTarget as UpdateTargetValue } from '@podium/protocol'

export type ReleaseUpdateChannel = 'edge' | 'stable'

const RELEASE_BASE = 'https://github.com/madeinorbit/podium/releases'

type DesktopReleaseManifest = {
  version: string
  platforms: Record<string, { url: string; signature: string }>
}

export function releaseManifestUrl(channel: ReleaseUpdateChannel): string {
  return channel === 'stable'
    ? `${RELEASE_BASE}/latest/download/podium-update.json`
    : `${RELEASE_BASE}/download/edge/podium-update.json`
}

export function desktopReleaseManifestUrl(channel: ReleaseUpdateChannel): string {
  return channel === 'stable'
    ? `${RELEASE_BASE}/latest/download/latest.json`
    : `${RELEASE_BASE}/download/edge/latest.json`
}

async function fetchReleaseJson(
  channel: ReleaseUpdateChannel,
  kind: 'release' | 'desktop',
  url: string,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  let response: Response
  try {
    response = await fetchImpl(url, {
      // A rolling edge asset keeps one URL across releases. The resolver must
      // ask the origin/CDN to revalidate it rather than letting the publication
      // window survive in an HTTP cache after the matching build has landed.
      cache: 'no-store',
      signal: AbortSignal.timeout(5_000),
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`${channel} target unavailable: ${kind} manifest ${detail}`)
  }
  if (!response.ok) {
    throw new Error(
      `${channel} target unavailable: ${kind} manifest returned HTTP ${response.status}`,
    )
  }
  try {
    return await response.json()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`${channel} target unavailable: invalid ${kind} manifest (${detail})`)
  }
}

function parseDesktopManifest(channel: ReleaseUpdateChannel, raw: unknown): DesktopReleaseManifest {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`${channel} target unavailable: invalid desktop manifest`)
  }
  const manifest = raw as { version?: unknown; platforms?: unknown }
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new Error(`${channel} target unavailable: invalid desktop manifest version`)
  }
  if (!manifest.platforms || typeof manifest.platforms !== 'object') {
    throw new Error(`${channel} target unavailable: invalid desktop manifest platforms`)
  }

  const platforms: DesktopReleaseManifest['platforms'] = {}
  for (const [platform, rawArtifact] of Object.entries(manifest.platforms)) {
    if (!rawArtifact || typeof rawArtifact !== 'object') {
      throw new Error(`${channel} target unavailable: invalid desktop artifact ${platform}`)
    }
    const artifact = rawArtifact as { url?: unknown; signature?: unknown }
    if (
      typeof artifact.url !== 'string' ||
      artifact.url.length === 0 ||
      typeof artifact.signature !== 'string' ||
      artifact.signature.length === 0
    ) {
      throw new Error(`${channel} target unavailable: invalid desktop artifact ${platform}`)
    }
    platforms[platform] = { url: artifact.url, signature: artifact.signature }
  }
  if (Object.keys(platforms).length === 0) {
    throw new Error(`${channel} target unavailable: desktop manifest has no artifacts`)
  }
  return { version: manifest.version, platforms }
}

async function assertArtifactsFetchable(
  channel: ReleaseUpdateChannel,
  artifacts: Array<{ place: string; url: string }>,
  fetchImpl: typeof fetch,
): Promise<void> {
  await Promise.all(
    artifacts.map(async ({ place, url }) => {
      let response: Response
      try {
        response = await fetchImpl(url, {
          method: 'HEAD',
          cache: 'no-store',
          signal: AbortSignal.timeout(5_000),
        })
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(`${channel} target unavailable: ${place} artifact ${detail}`)
      }
      if (!response.ok) {
        throw new Error(
          `${channel} target unavailable: ${place} artifact returned HTTP ${response.status}`,
        )
      }
    }),
  )
}

/**
 * Resolve one production release target without weakening its trust path.
 *
 * The manifest is an advertisement; daemons still verify the selected artifact
 * signature against Podium's baked release key. Rejecting bundle/git descriptors
 * here prevents a release-labelled channel from silently crossing into the
 * coordinator-key trust domain used by development delivery.
 */
export async function resolveReleaseTarget(
  channel: ReleaseUpdateChannel,
  fetchImpl: typeof fetch = fetch,
): Promise<UpdateTargetValue> {
  const url = releaseManifestUrl(channel)
  let target: UpdateTargetValue
  try {
    target = UpdateTarget.parse(await fetchReleaseJson(channel, 'release', url, fetchImpl))
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${channel} target unavailable:`)) {
      throw error
    }
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`${channel} target unavailable: invalid release manifest (${detail})`)
  }

  const headless = target.artifacts.headless
  if (!headless) throw new Error(`${channel} target unavailable: manifest has no headless artifact`)
  const deliveries = [headless, ...(target.artifacts.headlessAlternatives ?? [])]
  if (deliveries.some((artifact) => artifact.delivery !== 'feed')) {
    throw new Error(`${channel} target unavailable: release manifest offered a non-feed delivery`)
  }

  // The headless and desktop workflows start from the same tag but finish at
  // different times. The release itself has to exist before the desktop job can
  // upload, so publication cannot be made atomic in scripts/release.ts without
  // deadlocking the two workflows. Resolve the pair atomically instead: the new
  // product target is invisible until the companion desktop build has the same
  // version and every URL either manifest names is reachable.
  const desktop = parseDesktopManifest(
    channel,
    await fetchReleaseJson(channel, 'desktop', desktopReleaseManifestUrl(channel), fetchImpl),
  )
  if (desktop.version !== target.version) {
    throw new Error(
      `${channel} target unavailable: desktop build for ${target.version} is not published yet`,
    )
  }

  const namedArtifacts: Array<{ place: string; url: string }> = []
  for (const delivery of deliveries) {
    if (delivery.delivery !== 'feed') continue
    for (const [platform, artifact] of Object.entries(delivery.platforms)) {
      namedArtifacts.push({ place: `headless ${platform}`, url: artifact.url })
    }
  }
  for (const [platform, artifact] of Object.entries(desktop.platforms)) {
    namedArtifacts.push({ place: `desktop ${platform}`, url: artifact.url })
  }
  await assertArtifactsFetchable(channel, namedArtifacts, fetchImpl)
  return target
}
