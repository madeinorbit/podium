/**
 * WHAT A LIVE GRANT SAYS (POD-6954 design 4.5).
 *
 * Core issues a grant; the room and the daemon read it with Core's public key
 * and ask nobody. Two kinds:
 *
 * - a CLIENT grant: the workspace, the member and their role, the sessions and
 *   machines the member may view, use or manage, per machine the roots a direct
 *   ask may touch, and the machines whose provider logins' quota the member may
 *   see. A screen asks for one grant for what it shows.
 * - a DAEMON grant: the workspace and the machine the daemon is.
 *
 * Both carry the workspace as their audience, and may carry a connection key
 * (the thumbprint of a key the connection proves it holds) and a routing epoch.
 * This package only carries those two; binding them to a connection is the
 * room's (task "Revocation push and grant binding").
 */

/** What a member may do with a session or a machine through the room. */
export const LIVE_GRANT_ACTIONS = ['view', 'use', 'manage'] as const
export type LiveGrantAction = (typeof LIVE_GRANT_ACTIONS)[number]

/** A client grant's life (design 4.5: five minutes, refreshed at half time). */
export const CLIENT_GRANT_LIFETIME_MS = 5 * 60_000
/** A daemon grant's life (design 4.5: one hour, refreshed at half time). */
export const DAEMON_GRANT_LIFETIME_MS = 60 * 60_000

/** The most session ids, and the most machine ids, one client grant names. */
export const MAX_GRANT_IDS = 1000

/** When a holder should ask for the next grant: at half its life. */
export function refreshAtOf(issuedAt: number, expiresAt: number): number {
  return issuedAt + Math.floor((expiresAt - issuedAt) / 2)
}

/** Binding facts both kinds may carry. Absent means "not bound". */
export interface GrantBinding {
  /** Thumbprint of a key the connection proves it holds (design 4.5 additions). */
  readonly connectionKey?: string
  /** The routing epoch of the workspace when the grant was issued (design 4.4 additions). */
  readonly epoch?: number
}

/** What Core signs into a client grant. */
export interface ClientGrantClaims extends GrantBinding {
  readonly kind: 'client'
  readonly workspace: string
  readonly member: string
  readonly role: string
  /** Session id to the actions the member holds on it. An id with no action is left out. */
  readonly sessions: Readonly<Record<string, readonly LiveGrantAction[]>>
  /** Machine id to the actions the member holds on it. */
  readonly machines: Readonly<Record<string, readonly LiveGrantAction[]>>
  /** Machine id to the roots a direct ask on that machine may touch. */
  readonly roots: Readonly<Record<string, readonly string[]>>
  /** Machines whose provider logins' quota the member may see (design 4.5, 4.8). */
  readonly logins: readonly string[]
}

/** What Core signs into a daemon grant. */
export interface DaemonGrantClaims extends GrantBinding {
  readonly kind: 'daemon'
  readonly workspace: string
  readonly machine: string
}

export type LiveGrantClaims = ClientGrantClaims | DaemonGrantClaims
export type LiveGrantKind = LiveGrantClaims['kind']

/** A signed grant and the times its holder needs. */
export interface SignedLiveGrant {
  /** The bearer string: `plg1.<key id>.<payload>.<signature>`. */
  readonly token: string
  readonly keyId: string
  /** Epoch milliseconds. */
  readonly issuedAt: number
  readonly expiresAt: number
  readonly refreshAt: number
}

/** Why a grant was refused. One closed list, for logs and for the room's close reason. */
export const LIVE_GRANT_REFUSALS = [
  'malformed',
  'unknown-key',
  'bad-signature',
  'expired',
  'not-yet-valid',
  'wrong-workspace',
  'wrong-kind',
] as const
export type LiveGrantRefusal = (typeof LIVE_GRANT_REFUSALS)[number]
