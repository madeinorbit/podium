/**
 * Secret handling (people and sign-in specification, sections 1.6 and 7.1).
 *
 * Device sign-in tokens, one-time codes and invitation tokens are stored only
 * as hashes. Nothing here reads or writes a database.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/** The stored form of a device sign-in token: SHA-256, base64url. */
export function storedTokenForm(token: string): string {
  return createHash('sha256').update(token).digest('base64url')
}

/** The stored form of a one-time code, an invitation token or a receiver verifier: SHA-256, hex. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** A new one-time code or invitation token: 32 random bytes, base64url, 43 characters. */
export function newSecret(): string {
  return randomBytes(32).toString('base64url')
}

/** A public id for a row of ours: 18 random bytes, never derived from a secret. */
export function newPublicId(): string {
  return randomBytes(18).toString('base64url')
}

/**
 * The library's signed cookie value: `<token>.<base64 HMAC-SHA-256 of the token>`.
 * The same value is the signed bearer.
 */
export function signToken(token: string, secret: string): string {
  return `${token}.${createHmac('sha256', secret).update(token).digest('base64')}`
}

/**
 * The token of a signed value, or undefined when the signature does not verify.
 * A value that fails is treated as no credential.
 */
export function verifySignedToken(value: string, secret: string): string | undefined {
  const dot = value.lastIndexOf('.')
  if (dot <= 0) return undefined
  const token = value.slice(0, dot)
  const given = Buffer.from(value.slice(dot + 1), 'base64')
  const expected = createHmac('sha256', secret).update(token).digest()
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined
  return token
}

const GENERATED_DOMAIN = '@no-email.invalid'
const GENERATED_PATTERN = /^no-email-[0-9a-f]{32}@no-email\.invalid$/

/**
 * An identifier for a person who never gave an address. `.invalid` is a
 * reserved top-level domain, so it is never deliverable and never collides with
 * a real address. Nothing is derived from any other fact.
 */
export function generatedIdentifier(): string {
  return `no-email-${randomBytes(16).toString('hex')}${GENERATED_DOMAIN}`
}

export function isGeneratedIdentifier(value: string): boolean {
  return GENERATED_PATTERN.test(value)
}

/** True for any address in the reserved domain. Such an address is never accepted as input. */
export function inGeneratedDomain(value: string): boolean {
  return value.trim().toLowerCase().endsWith(GENERATED_DOMAIN)
}

export function normaliseEmail(value: string): string {
  return value.trim().toLowerCase()
}

const CONSONANTS = 'bdfghjklmnprstvz'
const VOWELS = 'aeiou'

/**
 * Three pronounceable words from a digest, 11 bits each. The package's own
 * naming of a pairing claim, used when the caller supplies no phrase function.
 */
export function phraseFromDigest(digest: Uint8Array): [string, string, string] {
  const word = (offset: number): string => {
    const bits = ((digest[offset] ?? 0) << 8) | (digest[offset + 1] ?? 0)
    const c = (shift: number) => CONSONANTS[(bits >> shift) & 15]
    const v = (shift: number) => VOWELS[((bits >> shift) & 7) % 5]
    return `${c(12)}${v(9)}${c(5)}${v(2)}${c(0)}`
  }
  return [word(0), word(2), word(4)]
}

export function defaultPhrase(claimId: string, challenge: string): [string, string, string] {
  return phraseFromDigest(
    createHash('sha256').update(`podium-pairing-phrase\0${claimId}\0${challenge}`).digest(),
  )
}
