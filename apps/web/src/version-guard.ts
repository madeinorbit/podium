import { WIRE_VERSION } from '@podium/protocol'

/**
 * Wire-version handshake for the web client. A cached PWA shell can outlive a server redeploy
 * that bumped the wire protocol; left alone it would speak a stale dialect to the new server.
 * On boot (and reconnect) the client fetches `/version` and, on a mismatch, HARD-reloads —
 * evicting the service worker + all caches so the browser fetches the fresh shell.
 */

/** sessionStorage key holding how many hard-reloads this tab has already forced this session. */
const RELOAD_COUNTER_KEY = 'podium.vreload'
/** After this many reloads without resolving the mismatch, stop looping and surface an error. */
const MAX_RELOADS = 2

/** Result of a version check: matched, a hard-reload was triggered, or the loop guard tripped. */
export type VersionCheck = 'ok' | 'reloaded' | 'blocked'

/** Shape the server's `/version` endpoint returns (see apps/server GET /version). */
interface ServerVersion {
  wireVersion?: unknown
  minSupportedVersion?: unknown
  appVersion?: unknown
}

/**
 * Evict the PWA service worker + every cache, then hard-reload. Best-effort: a failure in
 * either eviction step must not prevent the reload (a plain reload still beats a wedged tab).
 */
export async function forceReload(): Promise<void> {
  try {
    const regs = await navigator.serviceWorker?.getRegistrations?.()
    if (regs) await Promise.all(regs.map((r) => r.unregister()))
  } catch {
    // best-effort: unregister failures shouldn't block the reload
  }
  try {
    if (typeof caches !== 'undefined') {
      const keys = await caches.keys()
      await Promise.all(keys.map((k) => caches.delete(k)))
    }
  } catch {
    // best-effort: cache eviction failures shouldn't block the reload
  }
  location.reload()
}

function readReloadCounter(): number {
  try {
    const raw = globalThis.sessionStorage?.getItem(RELOAD_COUNTER_KEY)
    const n = raw ? Number.parseInt(raw, 10) : 0
    return Number.isFinite(n) && n > 0 ? n : 0
  } catch {
    return 0
  }
}

function writeReloadCounter(n: number): void {
  try {
    globalThis.sessionStorage?.setItem(RELOAD_COUNTER_KEY, String(n))
  } catch {
    // sessionStorage may be unavailable (private mode) — the loop guard degrades gracefully
  }
}

function clearReloadCounter(): void {
  try {
    globalThis.sessionStorage?.removeItem(RELOAD_COUNTER_KEY)
  } catch {
    // ignore — nothing to clear if storage is unavailable
  }
}

/**
 * Fetch the server's `/version` and hard-reload when this cached bundle is out of sync with it:
 * either the bundle predates the server's `minSupportedVersion`, or the two `wireVersion`s differ.
 *
 * - Matched → `'ok'`, clears the loop counter.
 * - Mismatch → `forceReload()`, returns `'reloaded'` (the page is now reloading).
 * - Mismatch persisting after `MAX_RELOADS` reloads this session → `'blocked'` (logged), no reload,
 *   so a broken deploy can't spin the tab in an endless reload loop.
 * - Network / parse error → `'ok'` (never block the app on a flaky `/version`).
 */
export async function checkServerVersion(httpOrigin: string): Promise<VersionCheck> {
  let server: ServerVersion
  try {
    const res = await fetch(`${httpOrigin}/version`)
    server = (await res.json()) as ServerVersion
  } catch {
    return 'ok' // unreachable or non-JSON /version → proceed rather than block
  }

  const serverWire = typeof server.wireVersion === 'number' ? server.wireVersion : undefined
  const serverMin =
    typeof server.minSupportedVersion === 'number' ? server.minSupportedVersion : undefined

  const tooOld = serverMin !== undefined && WIRE_VERSION < serverMin
  const mismatch = serverWire !== undefined && serverWire !== WIRE_VERSION
  if (!tooOld && !mismatch) {
    clearReloadCounter()
    return 'ok'
  }

  const reloads = readReloadCounter()
  if (reloads >= MAX_RELOADS) {
    console.error(
      `[podium] wire-version mismatch persists after ${reloads} reload(s) ` +
        `(bundle=${WIRE_VERSION}, server wire=${serverWire}, min=${serverMin}); not reloading again.`,
    )
    return 'blocked'
  }
  writeReloadCounter(reloads + 1)
  await forceReload()
  return 'reloaded'
}
