import { parseServerOrigin } from '@podium/client-core/transport'
import {
  MobilePairClaimResponse,
  MobilePairCompleteResponse,
  decodePairingEnvelope,
  mobilePairingUrl,
  parseMobilePairingUrl,
  type MobilePairingEnvelope,
  WIRE_VERSION,
} from '@podium/protocol'
import * as Crypto from 'expo-crypto'
import { Platform } from 'react-native'
import { classifyServerTransport, type ServerTransport } from './server-profiles'

const MAX_ENVELOPE_LENGTH = 8_192
const PREFLIGHT_TIMEOUT_MS = 10_000

export type { MobilePairingEnvelope }

export interface ParsedPairingLink {
  envelope: MobilePairingEnvelope
  source: 'https-fragment' | 'custom-scheme'
}

export class PairingLinkError extends Error {}

/**
 * Accept the server-owned HTTPS fragment and the installed-app bridge. The
 * bridge must carry the exact HTTPS URL as `url=`; it is not a second envelope
 * format and therefore cannot quietly relax any validation.
 */
export function parsePairingLink(raw: string): ParsedPairingLink {
  if (raw.length > MAX_ENVELOPE_LENGTH * 2)
    throw new PairingLinkError('This pairing link is too large.')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new PairingLinkError('This is not a valid Podium pairing link.')
  }
  if (url.protocol === 'podium:') {
    if (url.hostname !== 'pair' || url.username || url.password || url.hash) {
      throw new PairingLinkError('This is not a valid Podium app link.')
    }
    let nested = url.searchParams.get('url')
    if (!nested) {
      const token = url.pathname.replace(/^\/+/, '') || url.searchParams.get('pair')
      if (!token) throw new PairingLinkError('This app link does not contain a pairing URL.')
      try {
        const envelope = decodePairingEnvelope(token)
        if (envelope.v !== 2 || envelope.kind !== 'mobile-client') throw new Error('wrong kind')
        nested = mobilePairingUrl(envelope)
      } catch {
        throw new PairingLinkError('This app link contains an invalid pairing code.')
      }
    }
    const parsed = parsePairingLink(nested)
    return { ...parsed, source: 'custom-scheme' }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new PairingLinkError('Podium pairing links must use HTTPS.')
  }
  try {
    const envelope = parseMobilePairingUrl(raw)
    if (envelope.mode === 'pair' && !envelope.serverUrl.startsWith('https://')) {
      throw new Error('protected pairing requires HTTPS')
    }
    return { envelope, source: 'https-fragment' }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    if (detail.includes('expired')) {
      throw new PairingLinkError(
        'This pairing code has expired. Create a new code on your computer.',
      )
    }
    throw new PairingLinkError('This is not a valid Podium pairing link.')
  }
}

export function normalizeManualServer(value: string): string {
  const trimmed = value.trim()
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error('Enter a full server address, such as https://podium.example.')
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
    throw new Error('Use an http://, https://, ws://, or wss:// address.')
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname && url.pathname !== '/')
  ) {
    throw new Error('Enter the server origin only, without a path, login, query, or fragment.')
  }
  const parsed = parseServerOrigin(trimmed)
  if (!parsed) throw new Error('That server address is not supported.')
  return new URL(parsed.httpOrigin).origin
}

export type PreflightFailureKind =
  | 'not-podium'
  | 'version-mismatch'
  | 'tls-untrusted'
  | 'unreachable'
  | 'cleartext-blocked'

export type ServerPreflight =
  | {
      ok: true
      httpOrigin: string
      instanceId: string
      appVersion: string
      mode: 'open' | 'protected'
      transport: ServerTransport
    }
  | {
      ok: false
      kind: PreflightFailureKind
      title: string
      detail: string
      transport: ServerTransport
    }

function timeoutSignal(): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS)
    : undefined
}

function transportFailure(origin: string, cause: unknown): ServerPreflight {
  const transport = classifyServerTransport(origin)
  if (transport === 'tailscale-http') {
    return {
      ok: false,
      kind: 'cleartext-blocked',
      title: 'Tailscale HTTPS is required',
      detail:
        'A 100.x Tailscale address is not an iOS local-network exception. Configure Tailscale Serve and use its https://…ts.net address.',
      transport,
    }
  }
  if (transport === 'insecure-http') {
    return {
      ok: false,
      kind: 'cleartext-blocked',
      title: 'Cleartext connection blocked',
      detail:
        'Podium will not send credentials to an HTTP hostname. Use Tailscale Serve or a reverse proxy with a trusted certificate.',
      transport,
    }
  }
  const message = cause instanceof Error ? cause.message.toLowerCase() : String(cause).toLowerCase()
  if (/certificate|cert |ssl|tls|trust|hostname/.test(message)) {
    return {
      ok: false,
      kind: 'tls-untrusted',
      title: 'Certificate not trusted',
      detail:
        'Install and trust the server CA on this phone, or use Tailscale Serve/Caddy with a trusted certificate. Podium cannot bypass certificate checks.',
      transport,
    }
  }
  return {
    ok: false,
    kind: 'unreachable',
    title:
      transport === 'tailscale-serve'
        ? 'Private server unreachable'
        : transport === 'trusted-https'
          ? 'Secure connection failed'
          : 'Server unreachable',
    detail:
      transport === 'tailscale-serve'
        ? 'Connect this phone to the correct Tailscale network, then try again.'
        : transport === 'trusted-https'
          ? 'Check that the server is reachable and its certificate is trusted, current, and valid for this hostname. For a private CA, install and trust it on this phone.'
          : 'Check the address and local network, then try again.',
    transport,
  }
}

export async function preflightServer(httpOrigin: string): Promise<ServerPreflight> {
  const origin = normalizeManualServer(httpOrigin)
  const transport = classifyServerTransport(origin)
  if (
    transport === 'tailscale-http' ||
    transport === 'insecure-http' ||
    (Platform.OS !== 'web' && transport === 'insecure-lan')
  ) {
    if (transport === 'insecure-lan') {
      return {
        ok: false,
        kind: 'cleartext-blocked',
        title: 'LAN HTTP is unavailable',
        detail:
          'Podium release builds do not permit cleartext native traffic. Use trusted HTTPS or Tailscale Serve.',
        transport,
      }
    }
    return transportFailure(origin, new Error('cleartext'))
  }
  try {
    const versionResponse = await fetch(`${origin}/version`, {
      credentials: 'omit',
      signal: timeoutSignal(),
    })
    if (!versionResponse.ok) {
      return {
        ok: false,
        kind: 'not-podium',
        title: 'Not a Podium server',
        detail: `The server answered /version with HTTP ${versionResponse.status}.`,
        transport,
      }
    }
    let version: Record<string, unknown>
    try {
      const body = await versionResponse.json()
      if (body === null || typeof body !== 'object') throw new Error('not an object')
      version = body as Record<string, unknown>
    } catch {
      return {
        ok: false,
        kind: 'not-podium',
        title: 'Not a Podium server',
        detail: 'The /version response was not valid Podium JSON.',
        transport,
      }
    }
    if (
      typeof version.wireVersion !== 'number' ||
      typeof version.minSupportedVersion !== 'number' ||
      typeof version.instanceId !== 'string'
    ) {
      return {
        ok: false,
        kind: 'not-podium',
        title: 'Not a compatible Podium server',
        detail: 'The /version response did not contain Podium server identity fields.',
        transport,
      }
    }
    const clientTooOld = WIRE_VERSION < version.minSupportedVersion
    const serverTooOld = WIRE_VERSION > version.wireVersion
    if (clientTooOld || serverTooOld) {
      return {
        ok: false,
        kind: 'version-mismatch',
        title: clientTooOld ? 'Update this app' : 'Update the server',
        detail: `App wire ${WIRE_VERSION} and server range ${version.minSupportedVersion}–${version.wireVersion} are incompatible.`,
        transport,
      }
    }
    const authResponse = await fetch(`${origin}/auth/status`, {
      credentials: 'omit',
      signal: timeoutSignal(),
    })
    if (!authResponse.ok) throw new Error(`auth status failed: ${authResponse.status}`)
    const auth = (await authResponse.json().catch(() => null)) as Record<string, unknown> | null
    if (
      auth === null ||
      typeof auth !== 'object' ||
      typeof auth.needsAuth !== 'boolean' ||
      typeof auth.authed !== 'boolean' ||
      !(
        auth.userId === undefined ||
        auth.userId === null ||
        (typeof auth.userId === 'string' && auth.userId.length > 0)
      )
    ) {
      return {
        ok: false,
        kind: 'not-podium',
        title: 'Not a compatible Podium server',
        detail: 'The /auth/status response did not match the Podium authentication protocol.',
        transport,
      }
    }
    const mode = auth.needsAuth ? 'protected' : 'open'
    if (transport === 'insecure-lan' && mode === 'protected') {
      return {
        ok: false,
        kind: 'cleartext-blocked',
        title: 'Secure sign-in required',
        detail:
          'This LAN server requires credentials, which Podium will not send over HTTP. Use Tailscale Serve or trusted HTTPS.',
        transport,
      }
    }
    return {
      ok: true,
      httpOrigin: origin,
      instanceId: version.instanceId,
      appVersion: typeof version.appVersion === 'string' ? version.appVersion : 'unknown',
      mode,
      transport,
    }
  } catch (cause) {
    return transportFailure(origin, cause)
  }
}

function bytesToBase64Url(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  let result = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index]!
    const b = bytes[index + 1]
    const c = bytes[index + 2]
    result += alphabet[a >> 2]
    result += alphabet[((a & 3) << 4) | ((b ?? 0) >> 4)]
    if (b !== undefined) result += alphabet[((b & 15) << 2) | ((c ?? 0) >> 6)]
    if (c !== undefined) result += alphabet[c & 63]
  }
  return result
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export interface PairingClaim {
  claimId: string
  claimSecret: string
  phrase: string[]
}

export async function claimMobilePairing(
  envelope: Extract<MobilePairingEnvelope, { mode: 'pair' }>,
  deviceId: string,
  deviceName: string,
  platform: string,
): Promise<PairingClaim> {
  // Copy Expo's ArrayBufferLike-typed result onto a definite ArrayBuffer. Web
  // Crypto's BufferSource contract deliberately excludes SharedArrayBuffer.
  const secretBytes: Uint8Array<ArrayBuffer> = new Uint8Array(Crypto.getRandomBytes(32))
  const claimSecret = bytesToBase64Url(secretBytes)
  // The server decodes claimSecret and hashes these original 32 bytes. Hashing
  // the base64url text instead produces a different digest and makes every
  // otherwise-valid claim impossible to complete.
  const claimHash = bytesToHex(
    new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, secretBytes)),
  )
  const response = await fetch(`${envelope.serverUrl}/auth/mobile-pair/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      pairCode: envelope.pairCode,
      claimHash,
      deviceId,
      deviceName,
      platform:
        platform === 'ios' || platform === 'android' || platform === 'web' ? platform : 'unknown',
    }),
    credentials: 'omit',
    signal: timeoutSignal(),
  })
  if (!response.ok) {
    if (response.status === 409)
      throw new Error(
        'This code was already claimed. Create a new code if that was not your phone.',
      )
    if (response.status === 410)
      throw new Error('Pairing expired. Create a new code on your computer.')
    if (response.status === 429)
      throw new Error('Too many pairing attempts. Wait a moment and create a new code.')
    if (response.status === 400) {
      throw new Error(
        'Pairing is unavailable. It may have expired or the server may have restarted. Create a new code.',
      )
    }
    throw new Error(`The server refused this pairing code (${response.status}).`)
  }
  const body = MobilePairClaimResponse.safeParse(await response.json())
  if (!body.success) throw new Error('The server returned an invalid claim.')
  return { claimId: body.data.claimId, claimSecret, phrase: body.data.phrase }
}

export type PairingCompletion =
  | { status: 'pending' }
  | { status: 'denied'; reason: string }
  | { status: 'complete'; bearer: string | null; userId: string }

/** Kept separate from claim so a test can drive one poll without timers. */
export async function pollMobilePairing(
  serverUrl: string,
  claim: PairingClaim,
  mode: 'native' | 'web' = 'native',
): Promise<PairingCompletion> {
  const response = await fetch(`${serverUrl}/auth/mobile-pair/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ claimId: claim.claimId, claimSecret: claim.claimSecret }),
    credentials: mode === 'web' ? 'include' : 'omit',
    signal: timeoutSignal(),
  })
  if (response.status === 202) return { status: 'pending' }
  if (
    response.status === 400 ||
    response.status === 403 ||
    response.status === 404 ||
    response.status === 410
  ) {
    return {
      status: 'denied',
      reason: 'Pairing expired or the server restarted. Create a new code.',
    }
  }
  if (!response.ok) throw new Error(`Pairing status failed (${response.status}).`)
  const body = MobilePairCompleteResponse.safeParse(await response.json())
  if (!body.success)
    throw new Error('The server approved pairing without returning a valid session.')
  if (
    (mode === 'native' && body.data.delivery !== 'native') ||
    (mode === 'web' && body.data.delivery !== 'browser')
  ) {
    throw new Error('The server returned the wrong session delivery mode.')
  }
  return {
    status: 'complete',
    bearer: body.data.delivery === 'native' ? body.data.token : null,
    userId: body.data.userId,
  }
}
