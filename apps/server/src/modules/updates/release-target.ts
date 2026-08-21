/**
 * ONE RESOLVER FOR EVERY CHANNEL (spec §1, dispositions 1, 2 and 3).
 *
 * `dev`, `edge` and `stable` differ in exactly three facts, and this module is
 * where all three live:
 *
 *  - the FEED ORIGIN — GitHub releases for the two release channels, the source
 *    server's own HTTP feed for `dev`;
 *  - the TRUST ROOT — the baked release key for edge/stable, the Ed25519 key a
 *    daemon pinned at pairing for `dev`;
 *  - whether fetches CARRY MACHINE CREDENTIALS — the dev feed is private, the
 *    release feeds are public.
 *
 * Everything else — parse, pair the desktop build, HEAD every named artifact,
 * refuse a non-feed delivery — is channel-identical, which is the whole point:
 * development use becomes the continuous test of the release mechanism.
 */
import type { UpdateChannel } from '@podium/model'
import {
  UpdateTarget,
  type UpdateTarget as UpdateTargetValue,
  type UpdateTrustRoot,
} from '@podium/protocol'

export type ReleaseUpdateChannel = UpdateChannel

const RELEASE_BASE = 'https://github.com/madeinorbit/podium/releases'
/** Every release artifact `scripts/release.ts` names lives under this prefix. */
const RELEASE_ARTIFACT_BASE = `${RELEASE_BASE}/download/`

/** Where a channel's manifests live, what may sign its artifacts, and who may ask. */
export interface ChannelFeed {
  /** The product manifest — `podium-update.json`. */
  manifestUrl: string
  /**
   * The companion desktop manifest — `latest.json` — when this channel mints
   * shells at all.
   *
   * ABSENT FOR `dev`, and that absence is a decision rather than an omission
   * (spec §5, §6 step 3). Dev never builds a shell: its desktop manifest is
   * regenerated to point at the current EDGE shell, which is POD-2509's job and
   * a different publication with a different lifetime. Pairing a dev headless
   * release with it here would block every dev release on a darwin builder —
   * the exact coupling §6 exists to remove.
   */
  desktopManifestUrl?: string
  /**
   * THE ORIGIN FENCE. Every artifact URL either manifest names must sit under
   * this directory: same origin, and a path that is a descendant after the URL
   * is parsed and `..` / encoded-dot segments are resolved.
   *
   * A manifest is an advertisement fetched off a network, and the one thing an
   * advertisement must not be able to do is move the reader to another trust
   * domain. Without this fence a release-channel manifest could name a dev-feed
   * URL: the bytes would then be fetched from the source server and checked
   * against the baked release key — a signature failure, so it fails closed
   * either way, but it fails LATE, after a quarter-gigabyte download, and with
   * a sentence about signatures rather than about the feed that lied. Checking
   * the origin makes the refusal happen at resolve time and say what it means.
   *
   * A string prefix is not containment: `…/download/../attacker/…` still starts
   * with the fence, and `fetch` then issues the HEAD against the escaped host
   * path. The comparison is structural so those walk-outs refuse here.
   */
  artifactBase: string
  /** Which key a machine must verify this channel's artifacts against. */
  trust: UpdateTrustRoot
  /**
   * Sent on every fetch this resolver makes for the channel. The dev feed is
   * machine-authenticated (the artifact route is 401-first); release feeds are
   * public and carry nothing.
   */
  headers?: Readonly<Record<string, string>>
}

export function releaseManifestUrl(channel: 'edge' | 'stable'): string {
  return channel === 'stable'
    ? `${RELEASE_BASE}/latest/download/podium-update.json`
    : `${RELEASE_BASE}/download/edge/podium-update.json`
}

export function desktopReleaseManifestUrl(channel: 'edge' | 'stable'): string {
  return channel === 'stable'
    ? `${RELEASE_BASE}/latest/download/latest.json`
    : `${RELEASE_BASE}/download/edge/latest.json`
}

/** Where the source server serves its own feed, relative to its origin. */
export const DEV_FEED_ROUTE = '/updates/feed/dev'
export const DEV_FEED_MANIFEST = 'podium-update.json'

export function devFeedManifestUrl(origin: string): string {
  return `${origin.replace(/\/+$/, '')}${DEV_FEED_ROUTE}/${DEV_FEED_MANIFEST}`
}

/**
 * The two channels whose feed is a constant of the build.
 *
 * `dev` is deliberately NOT here: its origin, its trust root and its credential
 * are all facts about THIS installation, so only the composition root can state
 * them. A caller that asks for `dev` without supplying a feed gets a refusal
 * naming what is missing, never a silent fall back to a release feed.
 */
export function releaseChannelFeed(channel: ReleaseUpdateChannel): ChannelFeed | undefined {
  if (channel === 'dev') return undefined
  return {
    manifestUrl: releaseManifestUrl(channel),
    desktopManifestUrl: desktopReleaseManifestUrl(channel),
    artifactBase: RELEASE_ARTIFACT_BASE,
    trust: 'release',
  }
}

type DesktopReleaseManifest = {
  version: string
  platforms: Record<string, { url: string; signature: string }>
}

/**
 * Refuse a manifest that offers any delivery kind but `feed`, reading the
 * document as it arrived.
 *
 * Applies to all three channels. On `dev` it stops this server's own publisher
 * from reintroducing a pushed kind by accident; on `edge` and `stable` it is
 * the fence that stopped a release-labelled feed from nominating the delivery
 * whose trust root was the coordinator's key, and it stays as the statement of
 * that rule even though the union no longer has the arm.
 */
function assertOnlyFeedDeliveries(channel: ReleaseUpdateChannel, raw: unknown): void {
  const artifacts = (raw as { artifacts?: unknown } | null | undefined)?.artifacts
  if (!artifacts || typeof artifacts !== 'object') return
  const { headless, headlessAlternatives } = artifacts as {
    headless?: unknown
    headlessAlternatives?: unknown
  }
  const offered = [
    ...(headless ? [headless] : []),
    ...(Array.isArray(headlessAlternatives) ? headlessAlternatives : []),
  ]
  for (const artifact of offered) {
    if (!artifact || typeof artifact !== 'object') continue
    const delivery = (artifact as { delivery?: unknown }).delivery
    if (delivery === 'feed') continue
    throw new Error(
      `${channel} target unavailable: release manifest offered a non-feed delivery ` +
        `(${typeof delivery === 'string' ? delivery : 'unnamed'})`,
    )
  }
}

export interface ResolveReleaseTargetOptions {
  fetch?: typeof fetch
  /** Overrides {@link releaseChannelFeed}; REQUIRED for `dev`. */
  feed?: ChannelFeed
}

async function fetchFeedJson(
  channel: ReleaseUpdateChannel,
  feed: ChannelFeed,
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
      ...(feed.headers ? { headers: { ...feed.headers } } : {}),
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

/**
 * Decode one path segment, then split on any slash that decoding introduced
 * (`%2f`, `%5c`). A malformed escape stays as written rather than throwing —
 * an undecodable URL is not inside the feed.
 */
function decodePathSegment(segment: string): string[] {
  let decoded: string
  try {
    decoded = decodeURIComponent(segment.replace(/\+/g, '%20'))
  } catch {
    decoded = segment
  }
  return decoded.split(/[/\\]/)
}

/** Path segments with `.` dropped and `..` walked, after percent-decoding. */
function normalisedPathSegments(pathname: string): string[] {
  const out: string[] = []
  for (const piece of pathname.split('/').flatMap(decodePathSegment)) {
    if (piece === '' || piece === '.') continue
    if (piece === '..') {
      out.pop()
      continue
    }
    out.push(piece)
  }
  return out
}

/**
 * Whether `url` is genuinely under `artifactBase`: same origin, and a path
 * that is a descendant after normalisation. A URL that fails to parse is
 * not inside the feed.
 */
function artifactUrlBelongsToFeed(url: string, artifactBase: string): boolean {
  let artifact: URL
  let feed: URL
  try {
    artifact = new URL(url)
    feed = new URL(artifactBase)
  } catch {
    return false
  }
  if (artifact.protocol !== 'http:' && artifact.protocol !== 'https:') return false
  if (artifact.origin !== feed.origin) return false
  const feedPath = normalisedPathSegments(feed.pathname)
  const artifactPath = normalisedPathSegments(artifact.pathname)
  if (artifactPath.length <= feedPath.length) return false
  return feedPath.every((segment, i) => artifactPath[i] === segment)
}

async function assertArtifactsFetchable(
  channel: ReleaseUpdateChannel,
  feed: ChannelFeed,
  artifacts: Array<{ place: string; url: string }>,
  fetchImpl: typeof fetch,
): Promise<void> {
  // HEAD proves only that the named URL is reachable now. It cannot prove immutable bytes;
  // rolling-release artifact names must still include the version they were signed for.
  await Promise.all(
    artifacts.map(async ({ place, url }) => {
      let response: Response
      try {
        response = await fetchImpl(url, {
          method: 'HEAD',
          cache: 'no-store',
          ...(feed.headers ? { headers: { ...feed.headers } } : {}),
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
 * Resolve one channel's target without weakening its trust path.
 *
 * The manifest is an advertisement; machines still verify the selected artifact
 * signature against the key {@link ChannelFeed.trust} names. What this function
 * owes them is that the advertisement cannot choose that key, cannot point
 * outside its own feed, and cannot smuggle in a delivery kind nothing verifies.
 */
export async function resolveReleaseTarget(
  channel: ReleaseUpdateChannel,
  options: ResolveReleaseTargetOptions = {},
): Promise<UpdateTargetValue> {
  const fetchImpl = options.fetch ?? fetch
  const feed = options.feed ?? releaseChannelFeed(channel)
  if (!feed) {
    // Only `dev` can land here, and only from a caller that has not been given
    // this installation's feed. Say so rather than resolving something else.
    throw new Error(
      `${channel} target unavailable: no feed is configured for this channel on this server`,
    )
  }

  const raw = await fetchFeedJson(channel, feed, 'release', feed.manifestUrl, fetchImpl)
  // THE TRUST ROOT IS NOT NEGOTIABLE BY THE THING BEING TRUSTED. A manifest
  // that names one is refused outright rather than overwritten: overwriting
  // would silently accept a feed that had tried, and a feed that tried is the
  // one fact an operator most needs to see.
  if (raw && typeof raw === 'object' && 'trust' in raw) {
    throw new Error(`${channel} target unavailable: release manifest declared its own trust root`)
  }
  // …AND NEITHER IS THE DELIVERY KIND, checked on the RAW document and NOT on
  // the parsed one.
  //
  // This is the rejection that keeps a release-labelled channel out of the
  // coordinator-key trust domain, so it has to be an instrument that can
  // actually fire. `UpdateArtifact` is a single-armed union since the `bundle`
  // and `git` kinds were retired, which means the parse below already rejects
  // both — and a check placed AFTER the parse would therefore be unreachable
  // code that reads like a guard and can never say no. Asking the raw manifest
  // keeps the refusal reachable, testable, and named: an operator reading
  // "offered a non-feed delivery" knows what the feed tried, where "invalid
  // release manifest" from a zod union tells them nothing.
  assertOnlyFeedDeliveries(channel, raw)
  let target: UpdateTargetValue
  try {
    target = UpdateTarget.parse(raw)
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

  const namedArtifacts: Array<{ place: string; url: string }> = []
  for (const delivery of deliveries) {
    for (const [platform, artifact] of Object.entries(delivery.platforms)) {
      namedArtifacts.push({ place: `headless ${platform}`, url: artifact.url })
    }
  }

  // The headless and desktop workflows start from the same tag but finish at
  // different times. The release itself has to exist before the desktop job can
  // upload, so publication cannot be made atomic in scripts/release.ts without
  // deadlocking the two workflows. Resolve the pair atomically instead: the new
  // product target is invisible until the companion desktop build has the same
  // version and every URL either manifest names is reachable.
  //
  // A channel with no desktop manifest (`dev`) has no pair to resolve: its
  // shell comes from the edge channel entirely, so there is nothing here that
  // could be half-published.
  if (feed.desktopManifestUrl) {
    const desktop = parseDesktopManifest(
      channel,
      await fetchFeedJson(channel, feed, 'desktop', feed.desktopManifestUrl, fetchImpl),
    )
    if (desktop.version !== target.version) {
      throw new Error(
        `${channel} target unavailable: desktop build for ${target.version} is not published yet`,
      )
    }
    for (const [platform, artifact] of Object.entries(desktop.platforms)) {
      namedArtifacts.push({ place: `desktop ${platform}`, url: artifact.url })
    }
  }

  for (const named of namedArtifacts) {
    if (artifactUrlBelongsToFeed(named.url, feed.artifactBase)) continue
    throw new Error(
      `${channel} target unavailable: ${named.place} artifact is served from outside the ` +
        `${channel} feed (${named.url})`,
    )
  }
  await assertArtifactsFetchable(channel, feed, namedArtifacts, fetchImpl)
  // STAMPED HERE, from the channel that was asked for — the one place that
  // knows it. Everything downstream (the grant, the daemon, the coordinator's
  // own self-update) reads this rather than inferring a key from a delivery
  // kind or a version string.
  return { ...target, trust: feed.trust }
}
