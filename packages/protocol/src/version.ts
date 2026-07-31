/**
 * Podium WIRE protocol version — the protocol/FRAMING version of the
 * client↔server and server↔daemon message shapes in this package. One of three
 * INDEPENDENT version namespaces, which are never conflated (ADR 2 D4):
 *
 *  1. this one — peer-to-peer compatibility, sent on the WS URL (`/client?v=`);
 *  2. the replica schema version — the CLIENT's local store shape, owned by the
 *     client (ADR 6);
 *  3. the server's drizzle journal [spec:SP-4428] — server-internal, NEVER on
 *     the wire, never compared with a peer, never sent to a client.
 *
 * Conflating 1 and 3 is wrong in both directions: a migration that adds an index
 * moves the journal and changes NOTHING observable on the wire, while a reshaped
 * projection composed in code may touch no table at all. Different owners,
 * different lifecycles, different failure modes.
 *
 * **Bump ONLY on a breaking framing change.** Additive features — new fields, new
 * entity kinds on the change feed — negotiate by CAPABILITY instead (`hello.caps`,
 * e.g. CAP_METADATA_DELTA / CAP_SYNC_FEED_IDENTITY). That is why the oplog and
 * feed identity both shipped without a bump. Distinct from the MCP spec-date
 * constant in apps/server/src/mcp-route.ts.
 *
 * Peers compare via {@link versionSupport} — the RANGE — not {@link isProtocolCompatible}.
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
 * @deprecated Use {@link versionSupport}. This equality check is NOT what the
 * server does and has no production callers — re-verified at the POD-1246
 * catch-up: `versionSupport` is the live gate (gateway/ws-server.ts and
 * handshake/negotiation.ts), `isProtocolCompatible` is called from nothing but
 * its own tests. ADR 2 D4 ratifies the range: it is both what ships and what is
 * correct, since it allows a rolling upgrade where server and client deploy
 * separately — already true of the PWA, whose bundle can lag the server across a
 * redeploy.
 *
 * The two agreed only NUMERICALLY while MIN_SUPPORTED_VERSION === WIRE_VERSION,
 * which is exactly why the drift went unnoticed. THAT COVER IS NOW GONE: at the
 * POD-1246 catch-up the window opened to [1, 2], so an equality check and a range
 * check no longer return the same answer for a v1 peer — this function would
 * refuse one the server is deliberately still serving through
 * `legacy-wire-v1-adapter.ts`. Which is the concrete reason it is deprecated
 * rather than merely redundant.
 *
 * The distinction the two encode, kept because it is the reason both names exist:
 * this asks "are we IDENTICAL", for peers that must speak the same dialect with
 * no translation available; `versionSupport` asks "can this be SERVED", for the
 * gateway, where an edge adapter may stand between.
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
