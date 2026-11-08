/** Release addressing and transport trust. Native/shell adapters consume the same policy. */
import policy from './release-origins.json'

export type ReleaseChannel = 'stable' | 'edge' | 'dev'
export type ReleaseOrigin = (typeof policy.origins)[number]
export const RELEASE_PATHS = policy.paths
export const RELEASE_REDIRECT_HOPS = policy.redirectHops
export const STABLE_INSTALLER_URL = policy.stableInstallerUrl
export const RELEASE_ORIGINS: readonly ReleaseOrigin[] = policy.origins.filter(
  (origin) => origin.id !== 'mirror' || policy.mirrorReadEnabled,
)
export const PRIMARY_RELEASE_ORIGIN = policy.origins[0]!
export const MIRROR_RELEASE_ORIGIN = policy.origins[1]!

export function releaseChannelPath(channel: ReleaseChannel): string {
  return channel === 'stable' ? RELEASE_PATHS.latest : RELEASE_PATHS[channel]
}

export function releaseTagPath(tag: string): string {
  if (!tag || /[/\\?#]/.test(tag) || tag === '.' || tag === '..') {
    throw new Error('invalid release tag')
  }
  return `${RELEASE_PATHS.download}${encodeURIComponent(tag)}/`
}

export function releaseUrl(path: string, origin = PRIMARY_RELEASE_ORIGIN): string {
  if (!path || path.startsWith('/') || /[\\?#]/.test(path)) {
    throw new Error('invalid release path')
  }
  const mapped = path.startsWith(RELEASE_PATHS.latest)
    ? origin.latestPath + path.slice(RELEASE_PATHS.latest.length)
    : path
  const url = new URL(mapped, origin.baseUrl)
  if (!urlBelongsToReleaseDirectory(url.href, origin.baseUrl)) {
    throw new Error('release path escapes origin')
  }
  return url.href
}

// Decode to a fixed point: nested escapes must not hide separators or dot segments.
function pathSegments(path: string): string[] | undefined {
  const segments: string[] = []
  for (const raw of path.split('/').filter(Boolean)) {
    let current = raw
    let stable = false
    for (let round = 0; round < 8; round++) {
      let next: string
      try {
        next = decodeURIComponent(current.replace(/\+/g, '%20'))
      } catch {
        return
      }
      if (/[/\\]/.test(next) || next === '.' || next === '..') return
      if (next === current) {
        stable = true
        break
      }
      current = next
    }
    if (!stable) return
    segments.push(current)
  }
  return segments
}

/** Also used for private dev feeds; public release callers obtain the directory here. */
export function urlBelongsToReleaseDirectory(url: string, directory: string): boolean {
  try {
    const artifact = new URL(url)
    const base = new URL(directory)
    if (
      !['http:', 'https:'].includes(artifact.protocol) ||
      artifact.username ||
      artifact.password ||
      artifact.origin !== base.origin
    )
      return false
    const prefix = pathSegments(base.pathname)
    const path = pathSegments(artifact.pathname)
    return (
      !!prefix &&
      !!path &&
      path.length > prefix.length &&
      prefix.every((segment, i) => path[i] === segment)
    )
  } catch {
    return false
  }
}

export function releaseArtifactBase(origin = PRIMARY_RELEASE_ORIGIN): string {
  return releaseUrl(RELEASE_PATHS.download, origin)
}

export function releaseOriginForArtifact(url: string): ReleaseOrigin | undefined {
  return RELEASE_ORIGINS.find((origin) =>
    urlBelongsToReleaseDirectory(url, releaseArtifactBase(origin)),
  )
}

export function releaseRedirectAllowed(url: URL, origin: ReleaseOrigin): boolean {
  return (
    url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    !url.port &&
    origin.redirectHosts.includes(url.hostname)
  )
}

/** Absolute names must already name the serving origin. Relative names are root release paths. */
export function resolveReleaseArtifact(
  name: string,
  origin: ReleaseOrigin,
  directory = RELEASE_PATHS.download,
): string {
  const url = /^[a-z][a-z\d+.-]*:/i.test(name) ? name : releaseUrl(name, origin)
  if (!urlBelongsToReleaseDirectory(url, releaseUrl(directory, origin))) {
    throw new Error(`artifact is served from outside the release feed (${name})`)
  }
  return url
}

export type ReleaseFetchOptions<T> = {
  fetch?: typeof fetch
  timeoutMs?: number
  signal?: AbortSignal
  /** Pin companion documents to the origin that served the product manifest. */
  origin?: ReleaseOrigin
  read?: (response: Response) => Promise<T>
}

/** Redirect validation is shared by manifest and artifact GETs. No origin failover here. */
export async function fetchFromReleaseOrigin(
  url: string,
  origin: ReleaseOrigin,
  init: RequestInit = {},
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  let current = url
  for (let hop = 0; ; hop++) {
    const response = await fetchImpl(current, { ...init, redirect: 'manual' })
    if (response.status < 300 || response.status >= 400) return response
    const location = response.headers.get('location')
    await response.body?.cancel()
    if (!location || hop >= RELEASE_REDIRECT_HOPS) throw new Error('invalid release redirect')
    const next = new URL(location, current)
    if (!releaseRedirectAllowed(next, origin))
      throw new Error('release redirected outside its origin')
    current = next.href
  }
}

export function createReleaseFetcher() {
  let lastSuccessfulOrigin: ReleaseOrigin | undefined
  // Only the unpublished mirror is cooled down. This does not alter update polling/backoff.
  const mirrorRetryAt = new WeakMap<typeof fetch, number>()
  return {
    getLastSuccessfulOrigin: () => lastSuccessfulOrigin,
    async fetchRelease<T = Response>(
      path: string,
      options: ReleaseFetchOptions<T> = {},
    ): Promise<{
      data: T
      response: Response
      origin: ReleaseOrigin
      url: string
    }> {
      const origins = options.origin ? [options.origin] : RELEASE_ORIGINS
      const fetchImpl = options.fetch ?? fetch
      const failures: string[] = []
      for (const origin of origins) {
        if (
          !options.origin &&
          origin.id === 'mirror' &&
          Date.now() < (mirrorRetryAt.get(fetchImpl) ?? 0)
        )
          continue
        options.signal?.throwIfAborted()
        const controller = new AbortController()
        const signal = options.signal
          ? AbortSignal.any([options.signal, controller.signal])
          : controller.signal
        const timer = setTimeout(
          () => controller.abort(new Error('release origin timed out')),
          options.timeoutMs ?? 5_000,
        )
        const url = releaseUrl(path, origin)
        try {
          const timedOut = new Promise<never>((_, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          })
          const result = await Promise.race([
            (async () => {
              const response = await fetchFromReleaseOrigin(
                url,
                origin,
                { signal, cache: 'no-store' },
                options.fetch,
              )
              if (!response.ok) {
                await response.body?.cancel()
                throw new Error(`HTTP ${response.status}`)
              }
              const data = options.read ? await options.read(response) : (response as T)
              return { data, response, origin, url }
            })(),
            timedOut,
          ])
          lastSuccessfulOrigin = origin
          if (origin.id === 'mirror') mirrorRetryAt.delete(fetchImpl)
          return result
        } catch (error) {
          options.signal?.throwIfAborted()
          // A served but malformed document is a broken publication, not an outage.
          if (error instanceof SyntaxError) throw error
          failures.push(`${origin.id}: ${error instanceof Error ? error.message : String(error)}`)
          if (origin.id === 'mirror') mirrorRetryAt.set(fetchImpl, Date.now() + 60_000)
        } finally {
          clearTimeout(timer)
        }
      }
      throw new Error(`release unavailable (${failures.join('; ') || 'mirror cooling down'})`)
    },
  }
}

const processFetcher = createReleaseFetcher()
export const fetchRelease = processFetcher.fetchRelease
export const lastSuccessfulReleaseOrigin = processFetcher.getLastSuccessfulOrigin
