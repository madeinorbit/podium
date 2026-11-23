/** Core's half: sign a grant with the ring's signing key. */

import { sign } from 'node:crypto'
import {
  CLIENT_GRANT_LIFETIME_MS,
  type ClientGrantClaims,
  DAEMON_GRANT_LIFETIME_MS,
  type DaemonGrantClaims,
  type LiveGrantClaims,
  refreshAtOf,
  type SignedLiveGrant,
} from './claims'
import type { LiveGrantKeyRing } from './keys'
import { encodePayload, signedPart } from './wire'

/** The ring has no private key: this process cannot issue grants. */
export class LiveGrantSigningUnavailable extends Error {
  override readonly name = 'LiveGrantSigningUnavailable'
}

export interface SignOptions {
  /** Epoch ms; defaults to `Date.now()`. */
  readonly now?: number
  /** Defaults to the kind's lifetime. */
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
  const expiresAt = issuedAt + lifetime
  const payload = encodePayload({ ...claims, issuedAt, expiresAt })
  const signed = signedPart(key.kid, payload)
  const signature = sign(null, Buffer.from(signed, 'ascii'), key.privateKey).toString('base64url')
  return {
    token: `${signed}.${signature}`,
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
