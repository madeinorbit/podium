/**
 * The room's and the daemon's half: verify a grant and read its scopes.
 *
 * No database, no network, no clock but the caller's. The answer is a typed
 * grant the room asks per subscribe and per input, and its expiry, which the
 * room enforces on open streams (design 4.5: a subscription ends when its
 * grant expires without a refresh).
 */

import { verify as verifySignature } from 'node:crypto'
import { isMachinePathWithinRoot, machinePathSegments, normalizeMachinePath } from '@podium/model'
import type { LiveGrantAction, LiveGrantKind, LiveGrantRefusal } from './claims'
import type { LiveGrantKeyRing } from './keys'
import {
  type DecodedClientGrant,
  type DecodedDaemonGrant,
  decodePayload,
  MalformedGrant,
  splitToken,
} from './wire'

/** How far in the future a grant's issue time may be: Core's and the room's clocks differ. */
export const MAX_ISSUE_SKEW_MS = 60_000

const NO_ACTIONS: ReadonlySet<LiveGrantAction> = new Set()

/** No `.` or `..` segment, and nothing normalizing would change (read against `root`'s separator). */
function isPlainPath(root: string, path: string): boolean {
  if (machinePathSegments(path, root).some((part) => part === '.' || part === '..')) return false
  return normalizeMachinePath(path, root) === path
}

interface GrantTimes {
  readonly keyId: string
  readonly workspace: string
  readonly issuedAt: number
  readonly expiresAt: number
  readonly connectionKey: string | undefined
  readonly epoch: number | undefined
}

abstract class VerifiedGrant implements GrantTimes {
  readonly workspace: string
  readonly issuedAt: number
  readonly expiresAt: number
  readonly connectionKey: string | undefined
  readonly epoch: number | undefined

  constructor(
    readonly keyId: string,
    decoded: DecodedClientGrant | DecodedDaemonGrant,
  ) {
    this.workspace = decoded.workspace
    this.issuedAt = decoded.issuedAt
    this.expiresAt = decoded.expiresAt
    this.connectionKey = decoded.connectionKey
    this.epoch = decoded.epoch
  }

  /** Still in force at `now` (epoch ms). */
  isLive(now: number): boolean {
    return now < this.expiresAt
  }
}

/** A member's verified scopes. */
export class VerifiedClientGrant extends VerifiedGrant {
  readonly kind = 'client' as const
  readonly member: string
  readonly role: string
  private readonly sessions: ReadonlyMap<string, ReadonlySet<LiveGrantAction>>
  private readonly machines: ReadonlyMap<string, ReadonlySet<LiveGrantAction>>
  private readonly roots: ReadonlyMap<string, readonly string[]>
  private readonly logins: ReadonlySet<string>

  constructor(keyId: string, decoded: DecodedClientGrant) {
    super(keyId, decoded)
    this.member = decoded.member
    this.role = decoded.role
    this.sessions = decoded.sessions
    this.machines = decoded.machines
    this.roots = decoded.roots
    this.logins = decoded.logins
  }

  sessionActions(sessionId: string): ReadonlySet<LiveGrantAction> {
    return this.sessions.get(sessionId) ?? NO_ACTIONS
  }

  allowsSession(sessionId: string, action: LiveGrantAction): boolean {
    return this.sessionActions(sessionId).has(action)
  }

  machineActions(machineId: string): ReadonlySet<LiveGrantAction> {
    return this.machines.get(machineId) ?? NO_ACTIONS
  }

  allowsMachine(machineId: string, action: LiveGrantAction): boolean {
    return this.machineActions(machineId).has(action)
  }

  /** The roots a direct ask on this machine may touch. */
  rootsOf(machineId: string): readonly string[] {
    return this.roots.get(machineId) ?? []
  }

  /**
   * A direct ask at `path` on this machine: `use` there, and the path inside a
   * granted root. Containment is a literal prefix test on POSIX, so a path that
   * is not already in its normal form (a `.` or `..` segment, a doubled or
   * trailing separator) is refused before it: `/repo/../etc` never passes as
   * inside `/repo`.
   */
  mayAskPath(machineId: string, path: string): boolean {
    return (
      this.allowsMachine(machineId, 'use') &&
      this.rootsOf(machineId).some(
        (root) => isPlainPath(root, path) && isMachinePathWithinRoot(root, path),
      )
    )
  }

  /** The quota readings of this machine's provider logins may go to this member. */
  maySeeLogins(machineId: string): boolean {
    return this.logins.has(machineId)
  }

  /** Every session id the grant names, for replacing an open socket's scopes whole. */
  sessionIds(): IterableIterator<string> {
    return this.sessions.keys()
  }

  machineIds(): IterableIterator<string> {
    return this.machines.keys()
  }
}

/** A daemon's verified identity. */
export class VerifiedDaemonGrant extends VerifiedGrant {
  readonly kind = 'daemon' as const
  readonly machine: string

  constructor(keyId: string, decoded: DecodedDaemonGrant) {
    super(keyId, decoded)
    this.machine = decoded.machine
  }
}

export type VerifiedLiveGrant = VerifiedClientGrant | VerifiedDaemonGrant

export type VerifyResult<G extends VerifiedLiveGrant = VerifiedLiveGrant> =
  | { readonly ok: true; readonly grant: G }
  | { readonly ok: false; readonly refusal: LiveGrantRefusal }

export interface VerifyOptions<K extends LiveGrantKind> {
  /** The public keys, or a function that returns the current ring (a rotated ring is used at once). */
  readonly keys: LiveGrantKeyRing | (() => LiveGrantKeyRing)
  /** The workspace this room or daemon serves: the grant's audience must be it. */
  readonly workspace: string
  /** The kind this caller accepts; the other kind is refused. Required, so no path can forget it. */
  readonly kind: K
  /** Epoch ms; defaults to `Date.now()`. */
  readonly now?: number
}

type GrantOfKind<K extends LiveGrantKind> = K extends 'client'
  ? VerifiedClientGrant
  : VerifiedDaemonGrant

const refused = (refusal: LiveGrantRefusal) => ({ ok: false, refusal }) as const

/**
 * Verify `token`. The checks run in this order, so nothing about an unsigned
 * payload is ever read: shape, key id, signature, contents, audience, kind,
 * time.
 */
export function verifyLiveGrant<K extends LiveGrantKind>(
  token: unknown,
  opts: VerifyOptions<K>,
): VerifyResult<GrantOfKind<K>> {
  const parts = splitToken(token)
  if (!parts) return refused('malformed')
  const ring = typeof opts.keys === 'function' ? opts.keys() : opts.keys
  const publicKey = ring.publicKey(parts.kid)
  if (!publicKey) return refused('unknown-key')
  let valid: boolean
  try {
    valid = verifySignature(null, Buffer.from(parts.signed, 'ascii'), publicKey, parts.signature)
  } catch {
    valid = false
  }
  if (!valid) return refused('bad-signature')
  let decoded: DecodedClientGrant | DecodedDaemonGrant
  try {
    decoded = decodePayload(parts.payload)
  } catch (error) {
    if (error instanceof MalformedGrant) return refused('malformed')
    throw error
  }
  if (decoded.workspace !== opts.workspace) return refused('wrong-workspace')
  if (decoded.kind !== opts.kind) return refused('wrong-kind')
  const now = opts.now ?? Date.now()
  if (now >= decoded.expiresAt) return refused('expired')
  if (decoded.issuedAt > now + MAX_ISSUE_SKEW_MS) return refused('not-yet-valid')
  const grant =
    decoded.kind === 'client'
      ? new VerifiedClientGrant(parts.kid, decoded)
      : new VerifiedDaemonGrant(parts.kid, decoded)
  return { ok: true, grant: grant as GrantOfKind<K> }
}
