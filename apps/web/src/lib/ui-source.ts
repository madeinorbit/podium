/**
 * WHERE THE RUNNING INTERFACE CAME FROM (updater-convergence spec §2.1, §8).
 *
 * Once the desktop shell loads the UI from the server it is connected to
 * (POD-2510), "Web app <version>" in settings stopped being a fact of its own —
 * it is the server's own dist, so the row said the server's version twice. What
 * is NOT knowable from any other row is which of §2.1's three durability layers
 * actually answered this document:
 *
 *   1. the live server — fetched over the network just now;
 *   2. the service-worker cache — the offline layer, best-effort and evictable;
 *   3. the copy baked into the .app — last resort, potentially stale, and the
 *      one the stale-build guard (`local-build-guard.ts`) exists to refuse.
 *
 * Layer 3 is a page-origin fact: the baked document is the only one served on
 * the tauri scheme. Layers 1 and 2 are a navigation-timing fact: a document the
 * service worker answered has a non-zero `workerStart`, and one it answered
 * FROM ITS CACHE rather than by passing the request to the network transferred
 * no bytes. Both halves must hold — a worker that fetched from the network is
 * the live server with an extra hop, not a cached copy.
 *
 * When the timing entry is missing (an engine that does not keep one, a
 * document restored from bfcache before the entry lands) the answer is
 * `unknown`, and unknown renders as unknown. A source we cannot inspect must
 * never be reported as the live server — that is the POD-1610 rule about checks
 * that answer "ok" for what they did not look at.
 */

export type UiSourceKind = 'live' | 'cache' | 'baked' | 'unknown'

export interface UiSource {
  kind: UiSourceKind
  /** The value the settings row shows. */
  label: string
  /** One sentence under it, when the kind is worth explaining. */
  note?: string
}

/** The timing fields this decision reads; narrowed so tests can supply them. */
export interface NavigationSample {
  workerStart: number
  transferSize: number
}

/** The document's navigation timing, or undefined when the engine kept none. */
export function navigationSample(
  perf: Pick<Performance, 'getEntriesByType'> | undefined = globalThis.performance,
): NavigationSample | undefined {
  const entry = perf?.getEntriesByType('navigation')?.[0] as Partial<NavigationSample> | undefined
  if (!entry) return undefined
  if (typeof entry.workerStart !== 'number' || typeof entry.transferSize !== 'number') {
    return undefined
  }
  return { workerStart: entry.workerStart, transferSize: entry.transferSize }
}

/** True for the one document the desktop shell serves out of the .app itself. */
function isBakedDocument(location: Pick<Location, 'protocol' | 'hostname'>): boolean {
  return location.protocol === 'tauri:' || location.hostname === 'tauri.localhost'
}

export function uiSource(
  location: Pick<Location, 'protocol' | 'hostname'> = window.location,
  sample: NavigationSample | undefined = navigationSample(),
): UiSource {
  if (isBakedDocument(location)) {
    return {
      kind: 'baked',
      label: 'Built-in copy',
      note: 'This window fell back to the interface built into the app, so it may be older than the server.',
    }
  }
  if (!sample) return { kind: 'unknown', label: 'Not reported' }
  if (sample.workerStart > 0 && sample.transferSize === 0) {
    return {
      kind: 'cache',
      label: 'Offline cache',
      note: 'This page came from the copy saved on this device, not from the server.',
    }
  }
  return { kind: 'live', label: 'Live server' }
}
