import {
  classifySkew,
  parseServerVersion,
  type ServerVersion,
  WIRE_VERSION,
  wireSchemaDigest,
} from '@podium/protocol'

/**
 * THE GUARD ON THE LAST-RESORT UI (updater-convergence spec §2.1, durability layer 3).
 *
 * Podium is offline-first, so the interesting failure is not "no server" — the app is built to
 * survive that — it is "no server AND the UI that came up is older than the data already on
 * this device". That combination is only reachable one way: the desktop shell could not reach
 * its local server and fell back to the copy of the UI baked into the .app, which is frozen at
 * whatever shipped and may predate every payload update since. Running it against a newer
 * local replica is how a user's own state gets misread or written back wrong.
 *
 * The ordinary skew machinery cannot answer this. It grades the page against a REACHABLE
 * server's `/version` (see `version-guard.ts`), and by definition nothing answers here. So the
 * shell records the build identity of the local server it last actually read, persists it
 * across restarts, and injects it into the baked document as `__PODIUM_LOCAL_BUILD__`
 * (`bootstrap::local_build_injection_script`). That stamp is a LOCAL fact about local data —
 * no network — and it is what this build grades itself against.
 *
 * WHAT THIS DELIBERATELY DOES NOT BLOCK: a digest difference at the same wire version
 * (`schema-skew`). Wire-compatible builds can decode each other's rows, dev builds differ by
 * digest constantly, and blocking there would ground the app for a cosmetic drift. The
 * existing skew notice already speaks to that case. Only `client-too-old` — this build is
 * below the recorded wire version, or below the minimum that build supported — means the rows
 * on disk may be shapes this code has never seen.
 */

/** What the desktop shell injects into a local document. Absent everywhere else. */
function injectedStamp(): unknown {
  return (globalThis as { __PODIUM_LOCAL_BUILD__?: unknown }).__PODIUM_LOCAL_BUILD__
}

/**
 * The build that last owned this device's local data, as the shell recorded it.
 *
 * `undefined` in a browser, in remote desktop modes, and on any device whose shell has never
 * once reached its local server — all cases where there is no local history to be too old for.
 */
export function localBuildStamp(raw: unknown = injectedStamp()): ServerVersion | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const parsed = parseServerVersion(raw)
  // A stamp with no wire version cannot decide anything, and an undecidable stamp must not
  // look like an answer.
  return parsed.wireVersion === undefined ? undefined : parsed
}

/**
 * Is the UI that is running too old for the data this device already holds?
 *
 * Answer it only where it is the real question — the baked fallback with nothing on the
 * network. A reachable server has its own, better-informed handshake.
 */
export function isTooOldForLocalData(stamp = localBuildStamp()): boolean {
  if (!stamp) return false
  return (
    classifySkew(stamp, { wire: WIRE_VERSION, digest: wireSchemaDigest() }) === 'client-too-old'
  )
}
