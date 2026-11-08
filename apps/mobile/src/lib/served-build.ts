/**
 * "A NEWER PODIUM IS BEING SERVED — REFRESH" (updater-convergence spec §8c
 * decision 11).
 *
 * The phone's interface is a second dist inside the headless bundle (§2), so it
 * is replaced whenever an update is applied — by someone, on some other device,
 * with this phone nowhere near the decision. The page that is open at that
 * moment keeps running the build it loaded, and nothing tells it otherwise.
 *
 * This is deliberately NOT the update panel the desktop app has. The phone gets
 * one sentence and one button: the update has already happened and been
 * consented to elsewhere; all that is left here is to pick it up.
 *
 * WHAT IS COMPARED, and why not something cleverer: the build stamp the running
 * document carries (`<meta name="podium-version">`, injected by
 * `write-web-build-stamp.ts`) against the `appVersion` in the stamp file beside
 * the dist that is being SERVED right now. Both are the artefacts' own identity
 * — neither is inferred from the server's version or from the channel's target
 * (§2.2b). An unstamped page reports the honest `dev` and never offers anything:
 * a page that cannot say what it is running cannot claim something newer exists.
 *
 * WHY REFRESH IS JUST A RELOAD. `/mobile` ships no service worker: the Expo
 * export registers none, and the desktop app's worker explicitly refuses to
 * answer `/mobile` navigations (`NAVIGATION_FALLBACK_DENYLIST`). The server
 * serves `index.html` as `no-cache` and every asset under a content-hashed
 * name, so a reload IS the swap here — there is no waiting worker to hand over
 * to. If the phone ever gets its own worker, this is the one place that changes.
 */
import { useCallback, useEffect, useState } from 'react'
import { Platform } from 'react-native'
import { appVersion } from './logging'

/** The stamp file the built dist carries, as far as this comparison cares. */
export interface ServedBuild {
  appVersion?: string
}

/** Where the served phone dist keeps its stamp, on the origin that served us. */
export const SERVED_BUILD_STAMP_URL = '/mobile/podium-build.json'

/**
 * The version an unstamped build honestly reports. It means "I do not know what
 * I am", which can never be the basis for telling someone their page is old.
 */
const UNSTAMPED = 'dev'

export function servesNewerBuild(pageVersion: string, served: ServedBuild | undefined): boolean {
  if (!served?.appVersion) return false
  if (!pageVersion || pageVersion === UNSTAMPED) return false
  return served.appVersion !== pageVersion
}

/**
 * Read the served dist's stamp. `no-store` because the whole question is what
 * the server has RIGHT NOW; a cached answer would be the old build agreeing
 * with itself. Any failure is silence — an unreachable stamp is not evidence of
 * a new build, and a phone with no signal must not sprout a banner.
 */
export async function readServedBuild(
  fetchImpl: typeof fetch | undefined = typeof fetch === 'undefined' ? undefined : fetch,
  url: string = SERVED_BUILD_STAMP_URL,
): Promise<ServedBuild | undefined> {
  if (!fetchImpl) return undefined
  try {
    const response = await fetchImpl(url, { cache: 'no-store' })
    if (!response.ok) return undefined
    const body: unknown = await response.json()
    if (typeof body !== 'object' || body === null) return undefined
    const version = (body as { appVersion?: unknown }).appVersion
    return typeof version === 'string' ? { appVersion: version } : {}
  } catch {
    return undefined
  }
}

/**
 * Take the refresh. A reload is the whole mechanism here (see the header), so
 * this is one line plus the guard that keeps it out of a native build.
 */
export function refreshToServedBuild(
  target: { location: { reload(): void } } | undefined = typeof window === 'undefined'
    ? undefined
    : window,
): void {
  target?.location.reload()
}

export interface ServedBuildRefresh {
  /** True once the server is serving a build this page is not running. */
  needsRefresh: boolean
  refresh: () => void
}

/**
 * WHEN THE PAGE ASKS (POD-5798): no timer. The server names its build in every
 * `welcome`, so a redeploy shows up as a new `serverBuild` on the reconnect
 * that follows it, and that is when the stamp is read. The phone also asks once
 * each time it comes back to the foreground, where a suspended page catches up.
 */
export function useServedBuildRefresh(
  serverBuild: string | undefined,
  read: () => Promise<ServedBuild | undefined> = readServedBuild,
  pageVersion: string = appVersion(),
): ServedBuildRefresh {
  const [needsRefresh, setNeedsRefresh] = useState(false)

  useEffect(() => {
    // Only the web build has a served dist to be behind. A native app updates
    // through its store and has no stamp file to read.
    if (Platform.OS !== 'web' || typeof window === 'undefined') return
    if (needsRefresh) return // The answer cannot become false; stop asking.
    let cancelled = false
    const check = async (): Promise<void> => {
      const served = await read()
      if (!cancelled && servesNewerBuild(pageVersion, served)) setNeedsRefresh(true)
    }
    void check()
    // The decisive moment for an installed phone app: it comes back to the
    // foreground, after however long suspended, and asks once.
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void check()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisible)
    }
    // `serverBuild` is the trigger: each build the server names is asked about once.
  }, [needsRefresh, pageVersion, read, serverBuild])

  const refresh = useCallback(() => refreshToServedBuild(), [])
  return { needsRefresh, refresh }
}
