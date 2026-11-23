/** Core's half: sign a grant with the ring's signing key. */

import { sign } from 'node:crypto'
import {
  CLIENT_GRANT_LIFETIME_MS,
  type ClientGrantClaims,
  DAEMON_GRANT_LIFETIME_MS,
  type DaemonGrantClaims,
  type LiveGrantClaims,
  MAX_GRANT_BYTES,
  MAX_LIFETIME_MS,
  MAX_ROOT_CHARS,
  MAX_ROOTS_PER_MACHINE,
  refreshAtOf,
  type SignedLiveGrant,
} from './claims'
import type { LiveGrantKeyRing } from './keys'
import { encodePayload, signedPart } from './wire'

/** The ring has no private key: this process cannot issue grants. */
export class LiveGrantSigningUnavailable extends Error {
  override readonly name = 'LiveGrantSigningUnavailable'
}

/**
 * The grant would be larger than a grant may be: too many roots on a machine,
 * a root too long, or a token over {@link MAX_GRANT_BYTES}. A refusal the
 * caller can name, never a 500.
 */
export class LiveGrantTooLarge extends Error {
  override readonly name = 'LiveGrantTooLarge'
  constructor(
    readonly reason: 'roots' | 'root-length' | 'bytes',
    message: string,
  ) {
    super(message)
  }
}

function checkRoots(claims: LiveGrantClaims): void {
  if (claims.kind !== 'client') return
  for (const [machine, roots] of Object.entries(claims.roots)) {
    if (roots.length > MAX_ROOTS_PER_MACHINE) {
      throw new LiveGrantTooLarge(
        'roots',
        `machine ${machine} has ${roots.length} roots; a grant holds at most ${MAX_ROOTS_PER_MACHINE}`,
      )
    }
    if (roots.some((root) => root.length > MAX_ROOT_CHARS)) {
      throw new LiveGrantTooLarge(
        'root-length',
        `machine ${machine} has a root longer than ${MAX_ROOT_CHARS} characters`,
      )
    }
  }
}

export interface SignOptions {
  /** Epoch ms; defaults to `Date.now()`. */
  readonly now?: number
  /** Defaults to the kind's lifetime, and may not exceed it. */
  readonly lifetimeMs?: number
}

export function signLiveGrant(
  ring: LiveGrantKeyRing,
  claims: LiveGrantClaims,
  opts: SignOptions = {},
): SignedLiveGrant {
  const key = ring.signingKey()
  if (!key) throw new LiveGrantSigningUnavailable('no live grant signing key is configured')
  const issuedAt = opts.now ?? Date.now()
  const lifetime =
    opts.lifetimeMs ??
    (claims.kind === 'client' ? CLIENT_GRANT_LIFETIME_MS : DAEMON_GRANT_LIFETIME_MS)
  if (lifetime <= 0 || lifetime > MAX_LIFETIME_MS[claims.kind]) {
    throw new RangeError(`a ${claims.kind} grant lives at most ${MAX_LIFETIME_MS[claims.kind]} ms`)
  }
  checkRoots(claims)
  const expiresAt = issuedAt + lifetime
  const payload = encodePayload({ ...claims, issuedAt, expiresAt })
  const signed = signedPart(key.kid, payload)
  const signature = sign(null, Buffer.from(signed, 'ascii'), key.privateKey).toString('base64url')
  const token = `${signed}.${signature}`
  const bytes = Buffer.byteLength(token)
  if (bytes > MAX_GRANT_BYTES) {
    throw new LiveGrantTooLarge('bytes', `the grant is ${bytes} bytes; at most ${MAX_GRANT_BYTES}`)
  }
  return {
    token,
    keyId: key.kid,
    issuedAt,
    expiresAt,
    refreshAt: refreshAtOf(issuedAt, expiresAt),
  }
}

export const signClientGrant = (
  ring: LiveGrantKeyRing,
  claims: Omit<ClientGrantClaims, 'kind'>,
  opts?: SignOptions,
): SignedLiveGrant => signLiveGrant(ring, { kind: 'client', ...claims }, opts)

export const signDaemonGrant = (
  ring: LiveGrantKeyRing,
  claims: Omit<DaemonGrantClaims, 'kind'>,
  opts?: SignOptions,
): SignedLiveGrant => signLiveGrant(ring, { kind: 'daemon', ...claims }, opts)
