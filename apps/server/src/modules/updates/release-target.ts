import { UpdateTarget, type UpdateTarget as UpdateTargetValue } from '@podium/protocol'

export type ReleaseUpdateChannel = 'edge' | 'stable'

const RELEASE_BASE = 'https://github.com/madeinorbit/podium/releases'

export function releaseManifestUrl(channel: ReleaseUpdateChannel): string {
  return channel === 'stable'
    ? `${RELEASE_BASE}/latest/download/podium-update.json`
    : `${RELEASE_BASE}/download/edge/podium-update.json`
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
  let response: Response
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(5_000) })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`${channel} target unavailable: ${detail}`)
  }
  if (!response.ok) {
    throw new Error(
      `${channel} target unavailable: release manifest returned HTTP ${response.status}`,
    )
  }

  let target: UpdateTargetValue
  try {
    target = UpdateTarget.parse(await response.json())
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`${channel} target unavailable: invalid release manifest (${detail})`)
  }

  const headless = target.artifacts.headless
  if (!headless) throw new Error(`${channel} target unavailable: manifest has no headless artifact`)
  const deliveries = [headless, ...(target.artifacts.headlessAlternatives ?? [])]
  if (deliveries.some((artifact) => artifact.delivery !== 'feed')) {
    throw new Error(`${channel} target unavailable: release manifest offered a non-feed delivery`)
  }
  return target
}
