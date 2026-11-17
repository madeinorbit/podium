/**
 * THE FINGERPRINT AND MASK OF A PASTED SECRET (credential management §6).
 *
 * The fingerprint answers one question: is this the same key as one the person
 * already stored? It is the same construction as the settings secret fingerprint
 * (`modules/settings/secret-fingerprint.ts`, which explains why a keyed MAC and
 * never a digest): HMAC-SHA256 under the server's fingerprint key, over a domain
 * of its own and the credential type, truncated. Without the server key nothing
 * can be compared against it.
 *
 * The mask is the display-only preview the old accounts page showed: the first
 * and last four characters, or a placeholder for a short secret.
 */

import { createHmac } from 'node:crypto'
import { FINGERPRINT_BYTES } from '../settings/secret-fingerprint'

/** Display-only preview of a secret. The full value never leaves the server. */
export function maskCredential(secret: string): string {
  if (secret.length <= 8) return '""""'
  return `${secret.slice(0, 4)}…${secret.slice(-4)}`
}

const DOMAIN = 'podium.credential.fingerprint.v1'
const SEP = String.fromCharCode(0)

export function credentialFingerprint(type: string, secret: string, serverKey: Buffer): string {
  if (secret.length === 0) throw new Error('an empty secret has no fingerprint')
  return createHmac('sha256', serverKey)
    .update([DOMAIN, type, secret].join(SEP))
    .digest('hex')
    .slice(0, FINGERPRINT_BYTES * 2)
}

/** The identity a pasted secret is stored with: its fingerprint and its mask. */
export function pastedIdentity(
  type: string,
  secret: string,
  serverKey: Buffer,
): { fingerprint: string; masked: string } {
  return {
    fingerprint: credentialFingerprint(type, secret, serverKey),
    masked: maskCredential(secret),
  }
}
