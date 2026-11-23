import { readFileSync } from 'node:fs'

/** Exercise the real release transport and delivery gates with GitHub unavailable. */
import {
  createReleaseFetcher,
  fetchFromReleaseOrigin,
  MIRROR_RELEASE_ORIGIN,
  type ReleaseChannel,
  releaseChannelPath,
  releaseUrl,
  resolveReleaseArtifact,
} from '../packages/runtime/src/release-origins'
import { fetchArtifact, PODIUM_UPDATE_PUBKEY } from '../packages/runtime/src/update-delivery'
import { mirrorReferences } from './release-mirror-backfill'

type Json = Record<string, unknown>
export async function verifyLiveReleaseMirror(channels: readonly ReleaseChannel[]): Promise<void> {
  let primaryAttempts = 0
  const withoutPrimary: typeof fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (new URL(url).hostname === 'github.com') {
        primaryAttempts++
        return new Response('primary deliberately unavailable', { status: 503 })
      }
      return fetch(input, {
        ...init,
        headers: {
          ...Object.fromEntries(new Headers(init?.headers)),
          'user-agent': 'Podium-release-mirror-verification',
        },
      })
    },
    { preconnect: fetch.preconnect },
  )
  const checked = new Set<string>()
  const checkReferences = async (name: string, manifest: Json) => {
    for (const reference of mirrorReferences(name, manifest)) {
      const url = resolveReleaseArtifact(reference.url, MIRROR_RELEASE_ORIGIN)
      if (checked.has(url)) continue
      const response = await fetchFromReleaseOrigin(
        url,
        MIRROR_RELEASE_ORIGIN,
        { method: 'HEAD', signal: AbortSignal.timeout(30_000) },
        withoutPrimary,
      )
      if (!response.ok) throw new Error(`mirror artifact unavailable: ${response.status} ${url}`)
      await response.body?.cancel()
      checked.add(url)
    }
  }
  const reports: Array<{ channel: string; version: unknown; platform: string }> = []
  for (const channel of channels) {
    const path = releaseChannelPath(channel)
    const probe = await fetchFromReleaseOrigin(
      releaseUrl(path + 'podium-update.json', MIRROR_RELEASE_ORIGIN),
      MIRROR_RELEASE_ORIGIN,
      { signal: AbortSignal.timeout(30_000) },
      withoutPrimary,
    )
    if (probe.status === 404 && channel === 'dev') {
      await probe.body?.cancel()
      const desktop = await createReleaseFetcher().fetchRelease<Json>(path + 'latest.json', {
        fetch: withoutPrimary,
        read: (response) => response.json() as Promise<Json>,
      })
      if (desktop.origin.id !== MIRROR_RELEASE_ORIGIN.id)
        throw new Error('desktop failover did not select the mirror')
      await checkReferences('latest.json', desktop.data)
      reports.push({ channel, version: desktop.data.version, platform: 'desktop feed' })
      continue
    }
    if (!probe.ok) throw new Error(`mirror feed is unavailable: ${channel} HTTP ${probe.status}`)
    await probe.body?.cancel()
    const resolved = await createReleaseFetcher().fetchRelease<Json>(path + 'podium-update.json', {
      fetch: withoutPrimary,
      read: (response) => response.json() as Promise<Json>,
    })
    if (resolved.origin.id !== MIRROR_RELEASE_ORIGIN.id)
      throw new Error('failover did not select the mirror')
    await checkReferences('podium-update.json', resolved.data)
    const artifacts = resolved.data.artifacts as
      | { headless?: { platforms?: Record<string, unknown> }; desktop?: unknown }
      | undefined
    const platforms =
      artifacts?.headless?.platforms ??
      (resolved.data.platforms as Record<string, unknown> | undefined)
    const platform = 'linux-x86_64'
    const raw = platforms?.[platform] as
      | { url?: string; signature?: string; digest?: string }
      | undefined
    if (!raw?.url || !raw.signature || !raw.digest)
      throw new Error(`feed has no complete signed ${platform} payload`)
    const asset = { ...raw, url: resolveReleaseArtifact(raw.url, resolved.origin) } as Parameters<
      typeof fetchArtifact
    >[0]
    const delivered = await fetchArtifact(asset, {
      fetch: withoutPrimary,
      pubkey: PODIUM_UPDATE_PUBKEY,
    })
    if (!delivered.bytes.length) throw new Error('signed mirror payload is empty')
    const cached: typeof fetch = Object.assign(
      async () => new Response(new Uint8Array(delivered.bytes)),
      { preconnect: fetch.preconnect },
    )
    let rejected = false
    try {
      await fetchArtifact(
        { ...asset, signature: 'invalid' },
        { fetch: cached, pubkey: PODIUM_UPDATE_PUBKEY },
      )
    } catch (error) {
      rejected = error instanceof Error && error.message.includes('signature verification FAILED')
    }
    if (!rejected) throw new Error('invalid signature did not fail closed')
    // Older headless documents omit the desktop family while latest.json still serves apps.
    const companion = await fetchFromReleaseOrigin(
      releaseUrl(path + 'latest.json', resolved.origin),
      resolved.origin,
      { signal: AbortSignal.timeout(30_000) },
      withoutPrimary,
    )
    if (companion.ok) {
      await checkReferences('latest.json', (await companion.json()) as Json)
    } else {
      await companion.body?.cancel()
      if (companion.status !== 404 || artifacts?.desktop)
        throw new Error(`mirror desktop feed is unavailable: ${channel} HTTP ${companion.status}`)
    }
    reports.push({ channel, version: resolved.data.version, platform })
  }
  if (!reports.length || !primaryAttempts)
    throw new Error('no primary-failure headless delivery was exercised')
  console.log(
    '[release-mirror-live]',
    JSON.stringify({ primaryAttempts, verifiedArtifactUrls: checked.size, reports }),
  )
}
if (import.meta.main) {
  const at = process.argv.indexOf('--channels')
  const value = at < 0 ? 'all' : process.argv[at + 1]
  const reportAt = process.argv.indexOf('--report')
  const report = reportAt < 0 ? undefined : process.argv[reportAt + 1]
  const channels: string[] | undefined = report
    ? (JSON.parse(readFileSync(report, 'utf8')) as { channels: string[] }).channels
    : value === 'all'
      ? ['stable', 'edge', 'dev']
      : value?.split(',')
  if (!channels?.length || channels.some((channel) => !['stable', 'edge', 'dev'].includes(channel)))
    throw new Error('invalid verification channels')
  await verifyLiveReleaseMirror(channels as ReleaseChannel[])
}
