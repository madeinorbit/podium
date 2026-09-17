/** Storage-agnostic Ed25519 keys and domain-prefixed signatures. */
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  sign,
  verify,
} from 'node:crypto'

const WIRE = 'ed25519:'

export interface SigningKeyPair {
  /** PKCS#8 DER, base64. Secret. */
  privateKey: string
  /** SPKI DER, base64. */
  publicKey: string
}

export function mintSigningKeyPair(): SigningKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return {
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  }
}

/** Persisted key halves must be Ed25519 and agree; damage never causes minting. */
export function isSigningKeyPair(value: unknown): value is SigningKeyPair {
  if (typeof value !== 'object' || value === null) return false
  const pair = value as Partial<SigningKeyPair>
  if (typeof pair.privateKey !== 'string' || typeof pair.publicKey !== 'string') return false
  try {
    const key = createPrivateKey({
      key: Buffer.from(pair.privateKey, 'base64'),
      format: 'der',
      type: 'pkcs8',
    })
    return (
      key.asymmetricKeyType === 'ed25519' &&
      createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64') ===
        pair.publicKey
    )
  } catch {
    return false
  }
}

function rawPublicKey(publicKey: KeyObject): string {
  return publicKey.export({ format: 'jwk' }).x as string
}

/** `ed25519:<base64url of the raw 32 bytes>`. */
export function publicKeyWire(identity: Pick<SigningKeyPair, 'publicKey'>): string {
  const key = createPublicKey({
    key: Buffer.from(identity.publicKey, 'base64'),
    format: 'der',
    type: 'spki',
  })
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('expected an Ed25519 public key')
  return `${WIRE}${rawPublicKey(key)}`
}

export function parseWirePublicKey(wire: string): KeyObject | undefined {
  if (typeof wire !== 'string' || !wire.startsWith(WIRE)) return undefined
  const x = wire.slice(WIRE.length)
  if (!/^[A-Za-z0-9_-]{43}$/.test(x)) return undefined
  try {
    return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' })
  } catch {
    return undefined
  }
}

/** base64url Ed25519 signature over `prefix || message`. */
export function signMessage(
  identity: Pick<SigningKeyPair, 'privateKey'>,
  prefix: string,
  message: string,
): string {
  const key = createPrivateKey({
    key: Buffer.from(identity.privateKey, 'base64'),
    format: 'der',
    type: 'pkcs8',
  })
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('expected an Ed25519 private key')
  return sign(null, Buffer.from(prefix + message, 'utf8'), key).toString('base64url')
}

/** False on every failure, never thrown. */
export function verifyWithWireKey(
  publicKeyWire: string,
  prefix: string,
  message: string,
  signature: string,
): boolean {
  const key = parseWirePublicKey(publicKeyWire)
  if (!key) return false
  if (typeof signature !== 'string' || !/^[A-Za-z0-9_-]+$/.test(signature)) return false
  try {
    return verify(
      null,
      Buffer.from(prefix + message, 'utf8'),
      key,
      Buffer.from(signature, 'base64url'),
    )
  } catch {
    return false
  }
}
