import { type AssetVerdict, classifyAssets, parseServerVersion } from '@podium/protocol'
import { pageBundleVersion } from './logging/build-version'
import { servedWebsiteForPage } from './served-website'

/**
 * ASKING, SEPARATED FROM TELLING (POD-2762).
 *
 * `features/setup/version-guard` owns what a page DOES about a build
 * disagreement: it warns, it raises the skew banner, it holds the reload
 * budget. Two callers now need only the question underneath that — is the
 * server still serving the build this page is running? — and one of them is the
 * chunk-recovery path, which must be able to ask it while everything above it
 * is failing and without dragging a feature's notification machinery in with it.
 *
 * So the FETCH AND THE COMPARISON live here, in the same layer as
 * `served-website` and for the same stated reason: the callers are
 * `features/setup`, `features/updates` and the shell, a feature may not import
 * another feature, and `lib/` is the shared floor under all three. What stayed
 * behind in the feature is everything that has an opinion.
 */

/**
 * `AssetVerdict` plus the one answer a COMPARISON cannot produce: there was
 * nothing to compare, because the server did not answer at all.
 *
 * This distinction is the whole of POD-2762. Folded into `unknown`, a chunk that
 * failed during a restart looked exactly like a chunk that failed for an
 * unnameable reason, and the interface put a crash page over an app that was
 * seconds from being fine. `replaced` means the assets MOVED and a reload is the
 * remedy; `unreachable` means nothing moved and the remedy is to wait. They are
 * opposite responses, and anything that treats them alike gets one of them
 * wrong.
 */
export type ServedAssetsAnswer = AssetVerdict | 'unreachable'

/** The identity of the website this server is serving, beside this page's own. */
export interface ServedAssets {
  answer: ServedAssetsAnswer
  /** What the server says it is serving, when it said anything. */
  servedBundle?: string
  servedVersion?: string
}

/**
 * Ask the server whether the website it serves is still the one this page was
 * loaded from.
 *
 * WHY `/version` AND NOT THE PAGE'S OWN STAMP: `/podium-build.json` returns
 * whatever is on disk NOW, which after a swap is the build that replaced this
 * one — the page would be comparing the new build against itself. Only the
 * server can name the bytes it is currently handing out. The page's half comes
 * from its own `<script>` element, the one fact about it no later swap can move.
 */
export async function askServedAssets(
  httpOrigin: string,
  /** Injected for the test; production reads the entry script off this document. */
  page: string | undefined = pageBundleVersion(),
): Promise<ServedAssets> {
  let server: ReturnType<typeof parseServerVersion>
  try {
    const res = await fetch(`${httpOrigin}/version`)
    server = parseServerVersion(await res.json())
  } catch {
    return { answer: 'unreachable' }
  }
  const served = servedWebsiteForPage(server, httpOrigin)
  const answer = classifyAssets(served, { bundle: page })
  return {
    answer,
    ...(served?.bundle === undefined ? {} : { servedBundle: served.bundle }),
    ...(served?.appVersion === undefined ? {} : { servedVersion: served.appVersion }),
  }
}
