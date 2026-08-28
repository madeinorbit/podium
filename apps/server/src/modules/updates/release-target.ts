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
  compareVersions,
  UpdateTarget,
  type UpdateTarget as UpdateTargetValue,
  type UpdateTrustRoot,
} from '@podium/protocol'

export type ReleaseUpdateChannel = UpdateChannel

/**
 * The desktop channels published onto a STANDING release that is republished in place.
 *
 * Stable is absent because it is not one: each stable cut is an immutable per-version tag,
 * fetched through `releases/latest/`, and nothing re-serves it.
 */
export type DesktopFeedChannel = 'edge' | 'dev'

const RELEASE_BASE = 'https://github.com/madeinorbit/podium/releases'
/** Every release artifact `scripts/release.ts` names lives under this prefix. */
const RELEASE_ARTIFACT_BASE = `${RELEASE_BASE}/download/`

/**
 * Hosts a RELEASE-CHANNEL artifact HEAD may land on after GitHub redirects.
 *
 * GitHub serves every `releases/download/...` asset by 302ing to
 * `objects.githubusercontent.com`. The named URL stays under the GitHub
 * download prefix; the bytes live on that object host. This list is the
 * voucher for that hop — compared as the whole hostname, never as a suffix,
 * so `objects.githubusercontent.com.evil.example` is not a match. Dev has
 * no entry: that feed never redirects.
 */
export const RELEASE_ARTIFACT_REDIRECT_HOSTS = [
  'github.com',
  'objects.githubusercontent.com',
] as const

/** GitHub 302s once; two extra hops is slack, not a tour of the internet. */
export const RELEASE_ARTIFACT_REDIRECT_HOPS = 3

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
  /**
   * Hosts an artifact HEAD may land on after a redirect. Compared as the
   * whole hostname. ABSENT means this feed never redirects — the dev feed,
   * which is this server serving its own artifacts.
   */
  redirectHosts?: readonly string[]
}

export function releaseManifestUrl(channel: 'edge' | 'stable'): string {
  return channel === 'stable'
    ? `${RELEASE_BASE}/latest/download/podium-update.json`
    : `${RELEASE_BASE}/download/edge/podium-update.json`
}

/**
 * Where a channel's DESKTOP SHELL is published — always a GitHub release, `dev` included.
 *
 * This is not the same fact as {@link releaseChannelFeed}, and the difference is the one
 * thing to keep straight here. A dev machine's UPDATE FEED is its own source server. Its
 * SHELL is a signed, notarized macOS bundle that only CI can produce, so it is published
 * to GitHub like any other, onto a standing `dev` release that no edge or stable install
 * ever reads. The source server fetches from here and re-serves it on its own feed.
 */
export function desktopReleaseManifestUrl(channel: ReleaseUpdateChannel): string {
  return channel === 'stable'
    ? `${RELEASE_BASE}/latest/download/latest.json`
    : `${RELEASE_BASE}/download/${channel}/latest.json`
}

/** The standing release a moving desktop channel publishes onto. */
function desktopFeedBase(channel: DesktopFeedChannel): string {
  return `${RELEASE_BASE}/download/${channel}/`
}

/** Where the source server serves its own feed, relative to its origin. */
export const DEV_FEED_ROUTE = '/updates/feed/dev'
export const DEV_FEED_MANIFEST = 'podium-update.json'
export const DEV_DESKTOP_MANIFEST = 'latest.json'

export function devFeedManifestUrl(origin: string): string {
  return `${origin.replace(/\/+$/, '')}${DEV_FEED_ROUTE}/${DEV_FEED_MANIFEST}`
}

export function devDesktopManifestUrl(origin: string): string {
  return origin.replace(/\/+$/, '') + DEV_FEED_ROUTE + '/' + DEV_DESKTOP_MANIFEST
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
    redirectHosts: RELEASE_ARTIFACT_REDIRECT_HOSTS,
  }
}

export type DesktopReleaseManifest = {
  version: string
  bridgeVersion?: number
  platforms: Record<string, { url: string; signature: string }>
  downloads?: string[]
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

export function parseDesktopManifest(
  channel: ReleaseUpdateChannel,
  raw: unknown,
): DesktopReleaseManifest {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`${channel} target unavailable: invalid desktop manifest`)
  }
  const manifest = raw as {
    version?: unknown
    bridgeVersion?: unknown
    platforms?: unknown
    downloads?: unknown
  }
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
  if (
    manifest.downloads !== undefined &&
    (!Array.isArray(manifest.downloads) ||
      manifest.downloads.some((url) => typeof url !== 'string' || url.length === 0))
  ) {
    throw new Error(channel + ' target unavailable: invalid desktop downloads')
  }
  if (
    manifest.bridgeVersion !== undefined &&
    (!Number.isInteger(manifest.bridgeVersion) || (manifest.bridgeVersion as number) < 0)
  ) {
    throw new Error(channel + ' target unavailable: invalid desktop bridge version')
  }
  return {
    version: manifest.version,
    ...(typeof manifest.bridgeVersion === 'number'
      ? { bridgeVersion: manifest.bridgeVersion }
      : {}),
    platforms,
    ...(Array.isArray(manifest.downloads) ? { downloads: manifest.downloads as string[] } : {}),
  }
}

/**
 * Decode until the segment stops changing. A legitimate filename may carry
 * `%2B` for `+`; it must not carry an encoded separator or an encoded `..`.
 * Decoding a fixed number of times just moves the attack to N+1, so we iterate
 * to a fixed point and REJECT (rather than walk) the first round that
 * introduces `/`, `\`, `.` or `..`. A decode bomb is itself a refusal.
 */
const MAX_DECODE_ROUNDS = 8

function decodeSegmentToStable(raw: string): string | undefined {
  let current = raw
  for (let round = 0; round < MAX_DECODE_ROUNDS; round++) {
    let next: string
    try {
      next = decodeURIComponent(current.replace(/\+/g, '%20'))
    } catch {
      return undefined
    }
    if (next === current) {
      if (next === '.' || next === '..') return undefined
      return next
    }
    if (/[/\\]/.test(next) || next === '.' || next === '..') return undefined
    current = next
  }
  return undefined
}

function pathSegmentsOrReject(pathname: string): string[] | undefined {
  const segments: string[] = []
  for (const raw of pathname.split('/')) {
    if (raw === '') continue
    const decoded = decodeSegmentToStable(raw)
    if (decoded === undefined) return undefined
    segments.push(decoded)
  }
  return segments
}

/**
 * Whether `url` is genuinely under `artifactBase`: same origin, no userinfo,
 * and a path that is a descendant after decoding to a fixed point. A URL that
 * fails to parse, or whose encoding hides a separator or `..`, is not inside
 * the feed.
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
  // Userinfo is not origin. `fetch` turns `https://user:pw@host/...` into an
  // Authorization header, so a path that sits inside the fence is still a
  // request made as someone else.
  if (artifact.username !== '' || artifact.password !== '') return false
  if (artifact.origin !== feed.origin) return false
  const feedPath = pathSegmentsOrReject(feed.pathname)
  const artifactPath = pathSegmentsOrReject(artifact.pathname)
  if (!feedPath || !artifactPath) return false
  if (artifactPath.length <= feedPath.length) return false
  return feedPath.every((segment, i) => artifactPath[i] === segment)
}

/**
 * HEAD the named URL without letting `fetch` walk us somewhere the channel
 * does not vouch for.
 *
 * Default redirect-following is how an in-feed URL becomes a request to
 * another origin: the fence passed on the name, then the transport followed
 * a 302. Containment is per channel, because the channels have different
 * trust shapes:
 *
 *  - DEV never redirects. It is this server serving its own artifacts.
 *  - EDGE and STABLE follow hops by hand, capped, https-only, and only onto
 *    hosts {@link ChannelFeed.redirectHosts} names — GitHub's object host,
 *    not the open internet.
 */
export function validateDesktopFeedManifest(
  channel: DesktopFeedChannel,
  raw: unknown,
): DesktopReleaseManifest {
  const manifest = parseDesktopManifest(channel, raw)
  const base = desktopFeedBase(channel)
  for (const [platform, artifact] of Object.entries(manifest.platforms)) {
    if (artifactUrlBelongsToFeed(artifact.url, base)) continue
    throw new Error(
      channel +
        ' target unavailable: desktop ' +
        platform +
        ' artifact is served from outside the ' +
        channel +
        ' feed (' +
        artifact.url +
        ')',
    )
  }
  for (const url of manifest.downloads ?? []) {
    if (artifactUrlBelongsToFeed(url, base)) continue
    throw new Error(
      channel +
        ' target unavailable: desktop download is served from outside the ' +
        channel +
        ' feed (' +
        url +
        ')',
    )
  }
  return manifest
}

/**
 * WHICH SHELL A SERVED MANIFEST ACTUALLY CARRIES, read off its own URLs.
 *
 * A dev source server serves the dev shell when one is published and the edge shell when
 * none is. Both are legitimate; serving one while claiming the other is not. So the answer
 * is derived from the bytes being served rather than remembered from the fetch that
 * produced them: a memory is lost at restart and can drift from the document, and the
 * failure that costs days is the record that reports intent instead of fact.
 *
 * `undefined` when the manifest names no single release — including a mixture, which is
 * a manifest nobody should be serving.
 */
export function desktopManifestFeedChannel(raw: unknown): DesktopFeedChannel | undefined {
  let manifest: DesktopReleaseManifest
  try {
    manifest = parseDesktopManifest('dev', raw)
  } catch {
    return undefined
  }
  const urls = [
    ...Object.values(manifest.platforms).map((artifact) => artifact.url),
    ...(manifest.downloads ?? []),
  ]
  const channels: DesktopFeedChannel[] = ['dev', 'edge']
  const named = channels.filter((channel) =>
    urls.every((url) => artifactUrlBelongsToFeed(url, desktopFeedBase(channel))),
  )
  return named.length === 1 ? named[0] : undefined
}

async function assertArtifactsFetchable(
  channel: ReleaseUpdateChannel,
  feed: ChannelFeed,
  artifacts: Array<{ place: string; url: string }>,
  fetchImpl: typeof fetch,
): Promise<void> {
  const allowedHosts = feed.redirectHosts ?? []
  const maxRedirects = allowedHosts.length > 0 ? RELEASE_ARTIFACT_REDIRECT_HOPS : 0
  // HEAD proves only that the named URL is reachable now. It cannot prove immutable bytes;
  // rolling-release artifact names must still include the version they were signed for.
  await Promise.all(
    artifacts.map(async ({ place, url }) => {
      let current = url
      let redirects = 0
      for (;;) {
        let response: Response
        try {
          response = await fetchImpl(current, {
            method: 'HEAD',
            redirect: 'manual',
            cache: 'no-store',
            ...(feed.headers ? { headers: { ...feed.headers } } : {}),
            signal: AbortSignal.timeout(5_000),
          })
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          throw new Error(`${channel} target unavailable: ${place} artifact ${detail}`)
        }
        if (response.status >= 300 && response.status < 400) {
          if (maxRedirects === 0) {
            throw new Error(
              `${channel} target unavailable: ${place} artifact redirected; the ` +
                `${channel} feed does not follow redirects`,
            )
          }
          if (redirects >= maxRedirects) {
            throw new Error(
              `${channel} target unavailable: ${place} artifact redirected too many times`,
            )
          }
          const location = response.headers.get('location')
          if (!location) {
            throw new Error(
              `${channel} target unavailable: ${place} artifact redirected without a Location`,
            )
          }
          let next: URL
          try {
            next = new URL(location, current)
          } catch {
            throw new Error(
              `${channel} target unavailable: ${place} artifact redirected outside the ` +
                `${channel} feed (${location})`,
            )
          }
          if (next.protocol !== 'https:') {
            throw new Error(
              `${channel} target unavailable: ${place} artifact redirected to a non-https URL ` +
                `(${next.href})`,
            )
          }
          if (next.username !== '' || next.password !== '') {
            throw new Error(
              `${channel} target unavailable: ${place} artifact redirected outside the ` +
                `${channel} feed (${next.href})`,
            )
          }
          if (!allowedHosts.includes(next.hostname)) {
            throw new Error(
              `${channel} target unavailable: ${place} artifact redirected outside the ` +
                `${channel} feed (${next.href})`,
            )
          }
          current = next.href
          redirects++
          continue
        }
        if (!response.ok) {
          throw new Error(
            `${channel} target unavailable: ${place} artifact returned HTTP ${response.status}`,
          )
        }
        return
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

  // THE DESKTOP LEG CANNOT WITHDRAW THE HEADLESS OFFER (POD-2794).
  //
  // The two payloads are different things for different surfaces on different
  // version lines, and a headless machine — a VPS, a Linux server, anything with
  // no shell — has no stake whatsoever in whether a shell was built. Yet until
  // this, every edge and stable resolve fetched `latest.json` unconditionally
  // and then HEADed the shell assets it named, so THREE unrelated facts could
  // each retract a perfectly good headless target: no desktop build published at
  // this version (404), a manifest that failed to parse, and a shell artifact
  // pruned from an old release. Each surfaced as the channel having no target,
  // which an operator reads as "I am up to date" — the silent stranding.
  //
  // So the shell contributes to the headless target through exactly ONE fact,
  // and only when the release itself states it: `minRequired.desktop` /
  // `minRequired.desktopBridge`, which is this payload SAYING it needs a shell
  // at least that new. When nothing is stated the manifest is not consulted at
  // all — deliberately not "fetched and forgiven", because a fetch whose answer
  // is ignored is one refactor away from mattering again.
  //
  // Reachability of the shell assets is likewise not this resolver's business:
  // it returns the HEADLESS target, which never names them. The shell fetches
  // `latest.json` itself, and the dev feed's re-serving path keeps its own
  // origin fence in `validateDesktopFeedManifest`.
  //
  // Dev reaches this with no `desktopManifestUrl` at all (spec §1): dev never
  // mints a shell, so pairing it here would block every dev release on a darwin
  // builder — the coupling in the other direction.
  const minimumShell = target.minRequired?.desktop
  const minimumBridge = target.minRequired?.desktopBridge
  if (feed.desktopManifestUrl && (minimumShell !== undefined || minimumBridge !== undefined)) {
    // A stated requirement that cannot be checked is NOT waived. The refusal
    // here is the honest one: this release says it needs a shell and the
    // document that would prove it is missing or unreadable.
    const desktop = parseDesktopManifest(
      channel,
      await fetchFeedJson(channel, feed, 'desktop', feed.desktopManifestUrl, fetchImpl),
    )
    if (minimumShell !== undefined) {
      const order = compareVersions(desktop.version, minimumShell)
      if (order === null || order < 0) {
        throw new Error(
          channel +
            ' target unavailable: desktop shell ' +
            desktop.version +
            ' is below required ' +
            minimumShell,
        )
      }
    }
    if (minimumBridge !== undefined && (desktop.bridgeVersion ?? 0) < minimumBridge) {
      throw new Error(
        channel +
          ' target unavailable: desktop bridge ' +
          (desktop.bridgeVersion ?? 0) +
          ' is below required ' +
          minimumBridge,
      )
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
