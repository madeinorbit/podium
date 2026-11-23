/**
 * THE KEYS (POD-6954 design 4.5: "an asymmetric key held by Core; the verifier
 * has the public key and a key id for rotation").
 *
 * Ed25519. A key ring is an ordered list of keys, each with an id. The first
 * key that has its private half signs; every key verifies. Rotation is a new
 * ring: the new key first, the previous one kept after it until the longest
 * grant it signed has expired (one hour, a daemon grant), then dropped.
 *
 * The same JSON shape configures Core (private halves) and the room or the
 * daemon (public halves only):
 *
 *   { "keys": [ { "kid": "2026-11", "privateKey": "<PKCS#8 DER, base64>" },
 *               { "kid": "2026-10", "publicKey":  "<SPKI DER, base64>" } ] }
 *
 * `kid` is optional; without it the id is derived from the public key.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from 'node:crypto'

/** A key id: what the token's second segment names. */
const KEY_ID = /^[A-Za-z0-9_-]{1,64}$/

export class LiveGrantKeyError extends Error {
  override readonly name = 'LiveGrantKeyError'
}

export interface LiveGrantKey {
  readonly kid: string
  readonly publicKey: KeyObject
  /** Absent on a verifier's ring. */
  readonly privateKey?: KeyObject
}

/** An ordered, immutable set of keys. */
export class LiveGrantKeyRing {
  private readonly byId: ReadonlyMap<string, LiveGrantKey>

  constructor(readonly keys: readonly LiveGrantKey[]) {
    const byId = new Map<string, LiveGrantKey>()
    for (const key of keys) {
      if (!KEY_ID.test(key.kid)) throw new LiveGrantKeyError(`invalid key id '${key.kid}'`)
      if (byId.has(key.kid)) throw new LiveGrantKeyError(`key id '${key.kid}' appears twice`)
      if (key.publicKey.asymmetricKeyType !== 'ed25519') {
        throw new LiveGrantKeyError(`key '${key.kid}' is not an Ed25519 key`)
      }
      byId.set(key.kid, key)
    }
    this.byId = byId
  }

  /** The key that signs: the first one with a private half. */
  signingKey(): (LiveGrantKey & { readonly privateKey: KeyObject }) | undefined {
    const key = this.keys.find((candidate) => candidate.privateKey !== undefined)
    return key as (LiveGrantKey & { readonly privateKey: KeyObject }) | undefined
  }

  publicKey(kid: string): KeyObject | undefined {
    return this.byId.get(kid)?.publicKey
  }

  /** The same ring with the private halves removed: what a verifier is given. */
  publicOnly(): LiveGrantKeyRing {
    return new LiveGrantKeyRing(this.keys.map(({ kid, publicKey }) => ({ kid, publicKey })))
  }

  /** The ring as key-file JSON. Private halves are written only when asked for. */
  toJson(opts: { includePrivate: boolean }): string {
    return JSON.stringify({
      keys: this.keys.map((key) =>
        opts.includePrivate && key.privateKey
          ? { kid: key.kid, privateKey: derBase64(key.privateKey, 'pkcs8') }
          : { kid: key.kid, publicKey: derBase64(key.publicKey, 'spki') },
      ),
    })
  }
}

function derBase64(key: KeyObject, type: 'pkcs8' | 'spki'): string {
  return (
    type === 'pkcs8'
      ? key.export({ format: 'der', type: 'pkcs8' })
      : key.export({ format: 'der', type: 'spki' })
  ).toString('base64')
}

/** The id a key gets when its entry names none: 16 characters of its SPKI digest. */
export function deriveKeyId(publicKey: KeyObject): string {
  return createHash('sha256')
    .update(publicKey.export({ format: 'der', type: 'spki' }))
    .digest('base64url')
    .slice(0, 16)
}

/** A new signing key. */
export function mintLiveGrantKey(kid?: string): LiveGrantKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return { kid: kid ?? deriveKeyId(publicKey), privateKey, publicKey }
}

/**
 * Read key-file JSON. Throws {@link LiveGrantKeyError} on anything that is not
 * a list of Ed25519 keys; a damaged file never yields a partial ring.
 */
export function parseLiveGrantKeyRing(json: string): LiveGrantKeyRing {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new LiveGrantKeyError('the live grant key file is not JSON')
  }
  const entries = (parsed as { keys?: unknown } | null)?.keys
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new LiveGrantKeyError('the live grant key file names no keys')
  }
  return new LiveGrantKeyRing(entries.map((entry, index) => keyOfEntry(entry, index)))
}

function keyOfEntry(entry: unknown, index: number): LiveGrantKey {
  if (typeof entry !== 'object' || entry === null) {
    throw new LiveGrantKeyError(`key ${index} is not an object`)
  }
  const { kid, privateKey, publicKey } = entry as Record<string, unknown>
  if (kid !== undefined && typeof kid !== 'string') {
    throw new LiveGrantKeyError(`key ${index} has a key id that is not a string`)
  }
  try {
    if (typeof privateKey === 'string') {
      const secret = createPrivateKey({
        key: Buffer.from(privateKey, 'base64'),
        format: 'der',
        type: 'pkcs8',
      })
      if (secret.asymmetricKeyType !== 'ed25519') throw new Error('not Ed25519')
      const derived = createPublicKey(secret)
      if (typeof publicKey === 'string' && derBase64(derived, 'spki') !== publicKey) {
        throw new Error('the public half does not match the private half')
      }
      return { kid: kid ?? deriveKeyId(derived), privateKey: secret, publicKey: derived }
    }
    if (typeof publicKey === 'string') {
      const key = createPublicKey({
        key: Buffer.from(publicKey, 'base64'),
        format: 'der',
        type: 'spki',
      })
      if (key.asymmetricKeyType !== 'ed25519') throw new Error('not Ed25519')
      return { kid: kid ?? deriveKeyId(key), publicKey: key }
    }
  } catch (error) {
    throw new LiveGrantKeyError(
      `key ${index} cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  throw new LiveGrantKeyError(`key ${index} has neither a privateKey nor a publicKey`)
}
