/**
 * THE LOCATE PROOF (POD-5921): how a client checks that an address Podium
 * Connect named really is ITS server before it reconnects there.
 *
 * A client that lost its server reads the Connect record, which only NAMES
 * candidates. Before adopting one it sends a fresh 32-byte nonce to the
 * candidate's `POST /.well-known/podium/locate`; the server signs
 *
 *     utf8("podium-locate-v1\n") || nonce || utf8(publicUrl)
 *
 * with its installation key, where `publicUrl` is the origin the server itself
 * is configured to be reachable at. The client accepts only when the signature
 * verifies under the installation key it STORED earlier (at pairing or at its
 * last authenticated login), the id matches, and `publicUrl` is the candidate's
 * own origin. A relay can only obtain a signature over the real server's
 * address, which fails that last check anywhere else; the nonce makes every
 * answer fresh.
 *
 * Pure, no I/O, no `Buffer`, no DOM typings: React Native, browsers, Bun and
 * Workers all import this file. Verification itself lives with the callers
 * (`@podium/runtime/server-follow`, Connect), which own a signature library.
 */

/** The installation a client last authenticated to, stored next to its address. */
export interface ServerIdentity {
  /** `pdm_` + base64url of 32 random bytes. */
  installationId: string
  /** `ed25519:` + base64url of the raw 32-byte public key. */
  installationPublicKey: string
}

export const LOCATE_PROOF_PATH = '/.well-known/podium/locate'
/** Domain separation: distinct from every other installation-key prefix, and
 *  neither a prefix of one nor prefixed by one. */
export const LOCATE_PROOF_PREFIX = 'podium-locate-v1\n'
export const LOCATE_NONCE_BYTES = 32
/** The largest request body the route reads. */
export const LOCATE_PROOF_MAX_REQUEST_BYTES = 1024
/** The largest response body a client parses. */
export const LOCATE_PROOF_MAX_RESPONSE_BYTES = 4096

export interface LocateProofResponse {
  installationId: string
  /** The server's configured public origin, `URL.origin` form. */
  publicUrl: string
  /** base64url (no padding) of the 64-byte Ed25519 signature. */
  signature: string
}

const INSTALLATION_ID_RE = /^pdm_[A-Za-z0-9_-]{43}$/
const INSTALLATION_PUBLIC_KEY_RE = /^ed25519:[A-Za-z0-9_-]{43}$/
const NONCE_RE = /^[A-Za-z0-9_-]{43}$/
const SIGNATURE_RE = /^[A-Za-z0-9_-]{86}$/
const MAX_URL_CHARS = 2048
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const PUBLIC_KEY_WIRE = 'ed25519:'

/** Minimal URL declaration keeps this L0 package free of DOM typings while using the global. */
declare const URL: {
  new (input: string): { protocol: string; username: string; password: string; origin: string }
}

export const isServerIdentity = (value: unknown): value is ServerIdentity => {
  if (typeof value !== 'object' || value === null) return false
  const { installationId, installationPublicKey } = value as Partial<ServerIdentity>
  return (
    typeof installationId === 'string' &&
    INSTALLATION_ID_RE.test(installationId) &&
    typeof installationPublicKey === 'string' &&
    INSTALLATION_PUBLIC_KEY_RE.test(installationPublicKey)
  )
}

export function utf8Bytes(value: string): Uint8Array {
  const bytes: number[] = []
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0xfffd
    if (point <= 0x7f) bytes.push(point)
    else if (point <= 0x7ff) bytes.push(0xc0 | (point >> 6), 0x80 | (point & 0x3f))
    else if (point <= 0xffff) {
      bytes.push(0xe0 | (point >> 12), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f))
    } else {
      bytes.push(
        0xf0 | (point >> 18),
        0x80 | ((point >> 12) & 0x3f),
        0x80 | ((point >> 6) & 0x3f),
        0x80 | (point & 0x3f),
      )
    }
  }
  return Uint8Array.from(bytes)
}

/** base64url, no padding. */
export function base64urlFromBytes(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    out += BASE64URL[a >> 2]
    out += BASE64URL[((a & 3) << 4) | ((b ?? 0) >> 4)]
    if (b !== undefined) out += BASE64URL[((b & 15) << 2) | ((c ?? 0) >> 6)]
    if (c !== undefined) out += BASE64URL[c & 63]
  }
  return out
}

/** Strict base64url (no padding, canonical trailing bits); `undefined` otherwise. */
export function bytesFromBase64url(value: string): Uint8Array | undefined {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) {
    return undefined
  }
  const bytes: number[] = []
  let accumulator = 0
  let bits = 0
  for (const character of value) {
    accumulator = (accumulator << 6) | BASE64URL.indexOf(character)
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((accumulator >> bits) & 0xff)
      accumulator &= (1 << bits) - 1
    }
  }
  if (bits > 0 && accumulator !== 0) return undefined
  return Uint8Array.from(bytes)
}

/** The raw 32 bytes of an `ed25519:<base64url>` public key, or `undefined`. */
export function rawPublicKeyFromWire(wire: string): Uint8Array | undefined {
  if (typeof wire !== 'string' || !INSTALLATION_PUBLIC_KEY_RE.test(wire)) return undefined
  const raw = bytesFromBase64url(wire.slice(PUBLIC_KEY_WIRE.length))
  return raw?.length === 32 ? raw : undefined
}

/**
 * An http(s) URL reduced to `URL.origin` (no trailing slash, no path), or
 * `undefined`. ws(s) is NOT converted here: `publicUrl` is always http(s).
 */
export function locateOrigin(value: string): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL_CHARS) {
    return undefined
  }
  try {
    const parsed = new URL(value.trim())
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined
    if (parsed.username || parsed.password) return undefined
    return parsed.origin
  } catch {
    return undefined
  }
}

/** `utf8(prefix) || nonce || utf8(publicUrl)`. `publicUrl` is used byte for byte. */
export function locateProofMessage(nonce: Uint8Array, publicUrl: string): Uint8Array {
  const prefix = utf8Bytes(LOCATE_PROOF_PREFIX)
  const url = utf8Bytes(publicUrl)
  const message = new Uint8Array(prefix.length + nonce.length + url.length)
  message.set(prefix, 0)
  message.set(nonce, prefix.length)
  message.set(url, prefix.length + nonce.length)
  return message
}

/** The request body `{"nonce": "<base64url of exactly 32 bytes>"}`. */
export function parseLocateProofRequest(body: unknown): { nonce: Uint8Array } | { error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { error: 'body must be a JSON object' }
  }
  const { nonce } = body as { nonce?: unknown }
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) {
    return { error: 'nonce must be base64url of exactly 32 bytes' }
  }
  const bytes = bytesFromBase64url(nonce)
  if (!bytes || bytes.length !== LOCATE_NONCE_BYTES) {
    return { error: 'nonce must be base64url of exactly 32 bytes' }
  }
  return { nonce: bytes }
}

/** A well-formed response, or `undefined`. Says nothing about whether it verifies. */
export function parseLocateProofResponse(body: unknown): LocateProofResponse | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined
  const { installationId, publicUrl, signature } = body as Partial<
    Record<keyof LocateProofResponse, unknown>
  >
  if (typeof installationId !== 'string' || !INSTALLATION_ID_RE.test(installationId)) {
    return undefined
  }
  if (typeof publicUrl !== 'string' || locateOrigin(publicUrl) === undefined) return undefined
  if (typeof signature !== 'string' || !SIGNATURE_RE.test(signature)) return undefined
  if (bytesFromBase64url(signature)?.length !== 64) return undefined
  return { installationId, publicUrl, signature }
}
