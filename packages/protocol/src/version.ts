/**
 * Podium WIRE protocol version (client↔server and server↔daemon message shapes in this
 * package). Bump on any breaking change. Distinct from the MCP spec-date constant in
 * apps/server/src/mcp-route.ts. Peers on different releases/machines compare this to
 * decide compatibility (see isProtocolCompatible) and tell the user to update on a miss.
 *
 * ---------------------------------------------------------------------------
 * THE SUPPORT WINDOW IS PERMANENT ARCHITECTURE; WHAT SITS IN IT IS NOT
 * ---------------------------------------------------------------------------
 *
 * `[MIN_SUPPORTED_VERSION, WIRE_VERSION]` is a WINDOW, not two constants that
 * happen to differ. A Podium client is a PWA: a browser may hold a cached build
 * from before the deploy, and a phone may not open the app for a week. A server
 * that only ever accepted its own version would break every one of those on every
 * breaking release — so the window, the per-version edge adapters (`./edge/`),
 * the minimum-connected-version telemetry and the 426 backstop are KEPT
 * architecture. Deleting them recreates the next rollout's problem.
 *
 * What is temporary is whatever CONCRETE adapter currently fills the window. At
 * wire 2 that is `apps/server/src/gateway/legacy-wire-v1-adapter.ts`, which
 * carries a mechanical expiry (`scripts/audit-wire-adapters.ts`) rather than a
 * date in a docstring. When it goes, `MIN_SUPPORTED_VERSION` rises to 2 and the
 * window closes to a single version — the mechanism unchanged and unused, which
 * is the correct resting state for a mechanism whose whole job is the NEXT
 * rollout.
 */

/** WIRE 2 (POD-308): the scoped feed on the wire — `feedDelta` / `feedBootstrap`
 *  / `feedRescope` / `feedResyncRequired`, with the certified range and the
 *  retention floor REQUIRED on every frame that carries rows. WIRE 1 was the
 *  pre-rewrite `metadataDelta` + full-list-snapshot pipeline. */
export const WIRE_VERSION = 2

/**
 * Two peers are compatible iff they share the same wire version. A single integer
 * today; this function is the seam for a major/minor scheme later.
 *
 * NOTE the asymmetry with {@link versionSupport}, and it is deliberate. This is
 * "are we IDENTICAL", for peers that must speak the same dialect with no
 * translation available. That is "can this be SERVED", for the gateway, where an
 * edge adapter may stand between.
 */
export function isProtocolCompatible(a: number, b: number): boolean {
  return Number.isInteger(a) && Number.isInteger(b) && a === b
}

/**
 * Oldest wire version the server still accepts. Raise per breaking release to
 * FORCE older peers to update — and note that raising it is the ACT that expires
 * the adapter for the version being dropped: `scripts/audit-wire-adapters.ts`
 * fails while an adapter for a version below this floor still exists, so the
 * floor and the adapter set cannot drift apart.
 */
export const MIN_SUPPORTED_VERSION = 1

/**
 * Every version inside the window, ascending.
 *
 * The one place a "which versions do we serve" answer comes from. A caller
 * deriving its own from the two constants is how a gateway ends up advertising a
 * version it has no adapter for — so the adapter registry checks its coverage
 * against THIS, and refuses at construction if a version in the window has
 * nothing to serve it.
 */
export const SUPPORTED_WIRE_VERSIONS: readonly number[] = Array.from(
  { length: WIRE_VERSION - MIN_SUPPORTED_VERSION + 1 },
  (_unused, index) => MIN_SUPPORTED_VERSION + index,
)

export function versionSupport(
  v: number,
  wire: number = WIRE_VERSION,
  min: number = MIN_SUPPORTED_VERSION,
): 'ok' | 'too-old' | 'too-new' {
  if (!Number.isInteger(v) || v < min) return 'too-old'
  if (v > wire) return 'too-new'
  return 'ok'
}
