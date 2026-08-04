import { WIRE_RELOAD_COUNTER_KEY } from '@podium/client-core/ui-state'
import {
  classifySkew,
  parseServerVersion,
  WIRE_VERSION,
  wireSchemaDigest,
} from '@podium/protocol'
import { reportSkew } from '@/app/skew-notice'

/**
 * Wire-version handshake for the web client. A cached PWA shell can outlive a server redeploy
 * that bumped the wire protocol; left alone it would speak a stale dialect to the new server.
 * On boot (and reconnect) the client fetches `/version` and, on a mismatch, HARD-reloads —
 * evicting the service worker + all caches so the browser fetches the fresh shell.
 */

/** sessionStorage key holding how many hard-reloads this tab has already forced this session.
 *  DELIBERATELY not in the replica's ui-state collection: this loop guard must work exactly
 *  when everything else is broken (stale shell, poisoned replica, wedged storage collections)
 *  — it runs before the store exists and must never depend on it.
 *  Spelling lives in the ui-state routing table (POD-329). */
const RELOAD_COUNTER_KEY = WIRE_RELOAD_COUNTER_KEY
/** After this many reloads without resolving the mismatch, stop looping and surface an error. */
const MAX_RELOADS = 2

/** Result of a version check: matched, a hard-reload was triggered, or the loop guard tripped. */
export type VersionCheck = 'ok' | 'reloaded' | 'blocked' | 'server-behind'

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
  let server: ReturnType<typeof parseServerVersion>
  try {
    const res = await fetch(`${httpOrigin}/version`)
    server = parseServerVersion(await res.json())
  } catch {
    return 'ok' // unreachable or non-JSON /version → proceed rather than block
  }

  const verdict = classifySkew(server, { wire: WIRE_VERSION, digest: wireSchemaDigest() })

  if (verdict === 'ok') {
    clearReloadCounter()
    return 'ok'
  }

  /**
   * This client is AHEAD of its server. A reload cannot fix that: the fresh
   * bundle would be just as far ahead. Reloading here would burn both attempts
   * and then tell the user to rebuild, which is the wrong instruction. The thing
   * to move is the server, so say so and leave the reload budget alone.
   */
  if (verdict === 'client-too-new') {
    reportSkew({
      source: 'boot-digest',
      severe: false,
      message:
        `Your server is running an older version of Podium than this app ` +
        `(wire ${server.wireVersion} against ${WIRE_VERSION}). Update your server to continue.`,
    })
    return 'server-behind'
  }

  const serverWire = server.wireVersion
  const serverMin = server.minSupportedVersion
  const serverSchema = server.wireSchemaDigest
  const schemaSkew = verdict === 'schema-skew'

  const reloads = readReloadCounter()
  if (reloads >= MAX_RELOADS) {
    console.error(
      `[podium] wire-version mismatch persists after ${reloads} reload(s) ` +
        `(bundle=${WIRE_VERSION}, server wire=${serverWire}, min=${serverMin}); not reloading again.`,
    )
    // The loop guard has tripped, so reloading is off the table and this bundle
    // is going to run against a server it does not match. SAY SO — that silence
    // is the whole of POD-1610. The wording avoids "reload": two have already
    // happened and neither worked, which means the SERVED build is stale.
    reportSkew({
      source: 'boot-digest',
      severe: false,
      message: schemaSkew
        ? 'This app build does not match the server it is talking to ' +
          `(schema ${wireSchemaDigest().slice(0, 8)} vs ${(serverSchema ?? '').slice(0, 8)}). ` +
          'Reloading did not fix it, so the build being served is out of date and needs ' +
          'rebuilding: `bun run build`.'
        : `This app speaks wire version ${WIRE_VERSION} and the server speaks ${serverWire}. ` +
          'Reloading did not fix it, so the build being served is out of date and needs ' +
          'rebuilding: `bun run build`.',
    })
    return 'blocked'
  }
  writeReloadCounter(reloads + 1)
  await forceReload()
  return 'reloaded'
}
