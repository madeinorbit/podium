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
 */
export const WIRE_VERSION = 1

/**
 * @deprecated Use {@link versionSupport}. This equality check is NOT what the
 * server does and has no production callers; the live WS gate is the RANGE
 * (wsServer.ts rejects a mismatched peer with HTTP 426). ADR 2 D4 ratifies the
 * range: it is both what ships and what is correct, since it allows a rolling
 * upgrade where server and client deploy separately — already true of the PWA,
 * whose bundle can lag the server across a redeploy.
 *
 * The two agree only NUMERICALLY today, because MIN_SUPPORTED_VERSION ===
 * WIRE_VERSION === 1 — which is exactly why the drift went unnoticed, and why it
 * must be settled before the first bump makes them disagree in production.
 */
export function isProtocolCompatible(a: number, b: number): boolean {
  return Number.isInteger(a) && Number.isInteger(b) && a === b
}

/** Oldest wire version the server still accepts. Raise per breaking release to FORCE older peers. */
export const MIN_SUPPORTED_VERSION = 1

export function versionSupport(
  v: number,
  wire: number = WIRE_VERSION,
  min: number = MIN_SUPPORTED_VERSION,
): 'ok' | 'too-old' | 'too-new' {
  if (!Number.isInteger(v) || v < min) return 'too-old'
  if (v > wire) return 'too-new'
  return 'ok'
}
