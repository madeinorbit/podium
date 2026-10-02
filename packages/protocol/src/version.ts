/**
 * Podium WIRE protocol versions — the protocol/FRAMING version of the
 * client↔server and server↔daemon message shapes in this package. One of three
 * INDEPENDENT version namespaces, which are never conflated (ADR 2 D4):
 *
 *  1. wire versions — peer-to-peer compatibility, sent on the WS URL (`/client?v=`);
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
 * DAEMON_WIRE_VERSION and MIN_DAEMON_WIRE_VERSION own daemon framing;
 * CLIENT_WIRE_VERSION and MIN_CLIENT_WIRE_VERSION own client framing. A
 * client-only feature never moves the daemon constant. Each peer offers its
 * inclusive [min,max] window; the acceptor answers the highest common version.
 * On the wire the maximum stays a bare integer (v / wireVersion / URL ?v=),
 * with an additive floor (vmin / wireVersionMin / URL &vmin=). An absent floor
 * offers only the maximum, preserving deployed parsers during rolling upgrades.
 *
 * Peers compare via {@link versionSupport} — the RANGE — not {@link isProtocolCompatible}.
 *
 * ---------------------------------------------------------------------------
 * THE SUPPORT WINDOW IS PERMANENT ARCHITECTURE; WHAT SITS IN IT IS NOT
 * ---------------------------------------------------------------------------
 *
 * `[MIN_CLIENT_WIRE_VERSION, CLIENT_WIRE_VERSION]` is a WINDOW, not two constants that
 * happen to differ. A Podium client is a PWA: a browser may hold a cached build
 * from before the deploy, and a phone may not open the app for a week. A server
 * that only ever accepted its own version would break every one of those on every
 * breaking release — so the window, the per-version edge adapters (`./edge/`),
 * the minimum-connected-version telemetry and the 426 backstop are KEPT
 * architecture. Deleting them recreates the next rollout's problem.
 *
 * Concrete translators carry mechanical expiry. When the support floor passes
 * their version, remove them and keep the registry, telemetry and 426 backstop
 * for the next rollout. The current window is [4, 4].
 */

import { z } from 'zod'

/** Client framing evolves independently of daemon framing. Bump only for breaking
 * changes; additive features negotiate capabilities. Each floor retains the edge
 * adapters needed for cached clients and rolling daemon upgrades. */
export const CLIENT_WIRE_VERSION = 4

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
export const MIN_CLIENT_WIRE_VERSION = 4

/**
 * Every version inside the window, ascending.
 *
 * The one place a "which versions do we serve" answer comes from. A caller
 * deriving its own from the two constants is how a gateway ends up advertising a
 * version it has no adapter for — so the adapter registry checks its coverage
 * against THIS, and refuses at construction if a version in the window has
 * nothing to serve it.
 */
export const SUPPORTED_CLIENT_WIRE_VERSIONS: readonly number[] = Array.from(
  { length: CLIENT_WIRE_VERSION - MIN_CLIENT_WIRE_VERSION + 1 },
  (_unused, index) => MIN_CLIENT_WIRE_VERSION + index,
)

/** Inclusive support window. A bare legacy version offers only that dialect. */
export const WireVersionRange = z.object({
  min: z.number().int().positive(),
  max: z.number().int().positive(),
}).refine((range) => range.min <= range.max, 'inverted wire version range')

export const WireVersionOffer = z.union([z.number().int(), WireVersionRange])

export type WireVersionRange = z.infer<typeof WireVersionRange>
export type WireVersionOffer = z.infer<typeof WireVersionOffer>

// Preserve bare v3 hellos from deployed daemons. Future client bumps never move this.
export const DAEMON_WIRE_VERSION = 3
export const MIN_DAEMON_WIRE_VERSION = 1

export function versionSupport(
  offered: WireVersionOffer,
  wire: number = CLIENT_WIRE_VERSION,
  min: number = MIN_CLIENT_WIRE_VERSION,
): 'ok' | 'too-old' | 'too-new' {
  const range = typeof offered === 'number' ? { min: offered, max: offered } : offered
  if (!Number.isInteger(range.min) || !Number.isInteger(range.max) ||
      range.min < 1 || range.min > range.max || range.max < min) return 'too-old'
  if (range.min > wire) return 'too-new'
  return 'ok'
}
