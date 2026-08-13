import { z } from 'zod'

/** The largest envelope accepted from a QR/deep link. Pairing secrets should stay tiny. */
export const MAX_PAIRING_ENVELOPE_CHARS = 4096

/** The daemon join payload shipped before mobile pairing existed. Keep this shape additive. */
export const MachineJoinEnvelope = z.object({
  v: z.literal(1),
  kind: z.literal('machine').optional(),
  serverUrl: z.string().min(1),
  pairCode: z.string().min(1),
  podiumManaged: z.boolean().optional(),
  name: z.string().optional(),
})
export type MachineJoinEnvelope = z.infer<typeof MachineJoinEnvelope>

const httpOrigin = z
  .string()
  .min(1)
  .max(2048)
  .superRefine((value, ctx) => {
    try {
      if (normalizeHttpOrigin(value) !== value) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'serverUrl must be a canonical origin',
        })
      }
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : 'invalid serverUrl',
      })
    }
  })

export const MobilePairEnvelope = z
  .object({
    v: z.literal(2),
    kind: z.literal('mobile-client'),
    mode: z.literal('pair'),
    serverUrl: httpOrigin.refine((value) => value.startsWith('https://'), {
      message: 'credentialed mobile pairing requires https',
    }),
    pairCode: z.string().min(20).max(256),
    expiresAt: z.string().datetime(),
    instanceId: z.string().min(1).max(256),
  })
  .strict()
export type MobilePairEnvelope = z.infer<typeof MobilePairEnvelope>

export const MobileOpenEnvelope = z
  .object({
    v: z.literal(2),
    kind: z.literal('mobile-client'),
    mode: z.literal('open'),
    serverUrl: httpOrigin,
    instanceId: z.string().min(1).max(256),
  })
  .strict()
export type MobileOpenEnvelope = z.infer<typeof MobileOpenEnvelope>

export const MobilePairingEnvelope = z.union([MobilePairEnvelope, MobileOpenEnvelope])
export type MobilePairingEnvelope = z.infer<typeof MobilePairingEnvelope>

export const PairingEnvelope = z.union([
  MachineJoinEnvelope,
  MobilePairEnvelope,
  MobileOpenEnvelope,
])
export type PairingEnvelope = z.infer<typeof PairingEnvelope>

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

function utf8Encode(value: string): number[] {
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
  return bytes
}

function utf8Decode(bytes: readonly number[]): string {
  let out = ''
  for (let i = 0; i < bytes.length; ) {
    const first = bytes[i++]!
    let point: number
    let remaining: number
    if (first <= 0x7f) {
      point = first
      remaining = 0
    } else if (first >= 0xc2 && first <= 0xdf) {
      point = first & 0x1f
      remaining = 1
    } else if (first >= 0xe0 && first <= 0xef) {
      point = first & 0x0f
      remaining = 2
    } else if (first >= 0xf0 && first <= 0xf4) {
      point = first & 0x07
      remaining = 3
    } else throw new Error('invalid pairing envelope (invalid UTF-8)')
    for (let offset = 0; offset < remaining; offset += 1) {
      const next = bytes[i++]
      if (next === undefined || (next & 0xc0) !== 0x80) {
        throw new Error('invalid pairing envelope (invalid UTF-8)')
      }
      point = (point << 6) | (next & 0x3f)
    }
    if (
      (remaining === 2 && point < 0x800) ||
      (remaining === 3 && point < 0x10000) ||
      (point >= 0xd800 && point <= 0xdfff) ||
      point > 0x10ffff
    ) {
      throw new Error('invalid pairing envelope (invalid UTF-8)')
    }
    out += String.fromCodePoint(point)
  }
  return out
}

function base64urlEncode(bytes: readonly number[]): string {
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

function base64urlDecode(value: string): number[] {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
    throw new Error('invalid pairing envelope (not base64url)')
  }
  const bytes: number[] = []
  let accumulator = 0
  let bits = 0
  for (const character of value) {
    const index = BASE64URL.indexOf(character)
    accumulator = (accumulator << 6) | index
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((accumulator >> bits) & 0xff)
      accumulator &= (1 << bits) - 1
    }
  }
  if (bits > 0 && accumulator !== 0) throw new Error('invalid pairing envelope (non-canonical)')
  return bytes
}

/** Buffer-free codec safe to import from React Native/Hermes. */
export function encodePairingEnvelope(envelope: PairingEnvelope): string {
  return base64urlEncode(utf8Encode(JSON.stringify(PairingEnvelope.parse(envelope))))
}

/** Decode and validate without relying on Buffer, atob, TextDecoder, or Node globals. */
export function decodePairingEnvelope(token: string): PairingEnvelope {
  if (!token || token.length > MAX_PAIRING_ENVELOPE_CHARS) {
    throw new Error('invalid pairing envelope (size)')
  }
  let value: unknown
  try {
    value = JSON.parse(utf8Decode(base64urlDecode(token)))
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('invalid pairing envelope (not JSON)')
    throw error
  }
  return PairingEnvelope.parse(value)
}

/** Minimal URL declaration keeps this L0 package free of DOM typings while using the RN global. */
declare const URL: {
  new (
    input: string,
  ): {
    protocol: string
    username: string
    password: string
    hostname: string
    port: string
    pathname: string
    search: string
    hash: string
    origin: string
  }
}

/** Normalize an HTTP(S)/WS(S) server address to the canonical HTTP(S) origin. */
export function normalizeHttpOrigin(input: string): string {
  let parsed: InstanceType<typeof URL>
  try {
    parsed = new URL(input.trim())
  } catch {
    throw new Error('serverUrl must be an absolute URL')
  }
  if (parsed.username || parsed.password) throw new Error('serverUrl must not contain userinfo')
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('serverUrl must contain only an origin')
  }
  const protocol =
    parsed.protocol === 'ws:' ? 'http:' : parsed.protocol === 'wss:' ? 'https:' : parsed.protocol
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new Error('serverUrl must use http or https')
  }
  return `${protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`
}

export function mobilePairingUrl(envelope: MobilePairingEnvelope): string {
  const encoded = encodePairingEnvelope(envelope)
  return `${envelope.serverUrl}/mobile#pair=${encoded}`
}

/** Parse the one credential-bearing URL form accepted by native and web-mobile. */
export function parseMobilePairingUrl(
  value: string,
  nowMs: number = Date.now(),
): MobilePairingEnvelope {
  let parsed: InstanceType<typeof URL>
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('invalid mobile pairing URL')
  }
  if (parsed.username || parsed.password || parsed.pathname !== '/mobile' || parsed.search) {
    throw new Error('invalid mobile pairing URL')
  }
  const prefix = '#pair='
  if (!parsed.hash.startsWith(prefix)) throw new Error('invalid mobile pairing URL')
  const envelope = MobilePairingEnvelope.parse(
    decodePairingEnvelope(parsed.hash.slice(prefix.length)),
  )
  if (normalizeHttpOrigin(parsed.origin) !== envelope.serverUrl) {
    throw new Error('pairing URL origin does not match envelope')
  }
  if (envelope.mode === 'pair' && Date.parse(envelope.expiresAt) <= nowMs) {
    throw new Error('mobile pairing envelope expired')
  }
  return envelope
}

export const MobilePlatform = z.enum(['ios', 'android', 'web', 'unknown'])
export type MobilePlatform = z.infer<typeof MobilePlatform>
export const MobileDelivery = z.enum(['native', 'browser'])
export type MobileDelivery = z.infer<typeof MobileDelivery>

export const MobilePairStartRequest = z.object({}).strict()
export type MobilePairStartRequest = z.infer<typeof MobilePairStartRequest>

export const MobileTransportReadiness = z.object({
  grade: z.enum(['https', 'tailscale', 'insecure']),
  title: z.string(),
  guidance: z.string(),
})
export type MobileTransportReadiness = z.infer<typeof MobileTransportReadiness>

export const MobilePairStartResponse = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('pair'),
    pairingId: z.string(),
    envelope: z.string(),
    pairingUrl: z.string(),
    canonicalOrigin: z.string(),
    transport: MobileTransportReadiness,
    expiresAt: z.string().datetime(),
    instanceId: z.string(),
  }),
  z.object({
    mode: z.literal('open'),
    mobileUrl: z.string(),
    canonicalOrigin: z.string(),
    transport: MobileTransportReadiness,
    instanceId: z.string(),
  }),
])
export type MobilePairStartResponse = z.infer<typeof MobilePairStartResponse>

export const MobilePairClaimRequest = z.object({
  pairCode: z.string().min(20).max(256),
  claimHash: z.string().regex(/^[a-f0-9]{64}$/),
  deviceId: z.string().min(1).max(256),
  deviceName: z.string().trim().min(1).max(120),
  platform: MobilePlatform,
  delivery: MobileDelivery,
})
export type MobilePairClaimRequest = z.infer<typeof MobilePairClaimRequest>

export const MobilePairClaimResponse = z.object({
  claimId: z.string(),
  phrase: z.tuple([z.string(), z.string(), z.string()]),
  expiresAt: z.string().datetime(),
})
export type MobilePairClaimResponse = z.infer<typeof MobilePairClaimResponse>

const claimedDevice = z.object({
  deviceId: z.string(),
  deviceName: z.string(),
  platform: MobilePlatform,
  delivery: MobileDelivery,
  phrase: z.tuple([z.string(), z.string(), z.string()]),
})
export const MobilePairStatusResponse = z.discriminatedUnion('state', [
  z.object({ state: z.literal('pending'), expiresAt: z.string().datetime() }),
  claimedDevice.extend({
    state: z.literal('claimed'),
    expiresAt: z.string().datetime(),
  }),
  claimedDevice.extend({
    state: z.literal('approved'),
    expiresAt: z.string().datetime(),
  }),
  z.object({ state: z.literal('denied') }),
  z.object({ state: z.literal('completed') }),
  z.object({ state: z.literal('expired') }),
])
export type MobilePairStatusResponse = z.infer<typeof MobilePairStatusResponse>

export const MobilePairingIdRequest = z.object({
  pairingId: z.string().min(1).max(256),
})
export type MobilePairingIdRequest = z.infer<typeof MobilePairingIdRequest>

export const MobilePairCompleteRequest = z.object({
  claimId: z.string().min(1).max(256),
  claimSecret: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
})
export type MobilePairCompleteRequest = z.infer<typeof MobilePairCompleteRequest>

export const MobilePairCompleteResponse = z.discriminatedUnion('delivery', [
  z.object({
    status: z.literal('complete'),
    delivery: z.literal('native'),
    token: z.string(),
    userId: z.string(),
    expiresAt: z.string().datetime(),
  }),
  z.object({
    status: z.literal('complete'),
    delivery: z.literal('browser'),
    userId: z.string(),
    expiresAt: z.string().datetime(),
  }),
])
export type MobilePairCompleteResponse = z.infer<typeof MobilePairCompleteResponse>

export const MobilePairCompletePendingResponse = z.object({
  status: z.literal('pending'),
})
export type MobilePairCompletePendingResponse = z.infer<typeof MobilePairCompletePendingResponse>
export const MobilePairCompleteResult = z.union([
  MobilePairCompletePendingResponse,
  MobilePairCompleteResponse,
])
export type MobilePairCompleteResult = z.infer<typeof MobilePairCompleteResult>

export const MobileClientSession = z.object({
  sessionId: z.string(),
  userId: z.string(),
  label: z.literal('mobile'),
  deviceId: z.string(),
  deviceName: z.string(),
  platform: MobilePlatform,
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  lastSeenAt: z.string().datetime().nullable(),
  current: z.boolean(),
})
export type MobileClientSession = z.infer<typeof MobileClientSession>

export const MobileClientSessionsResponse = z.object({
  sessions: z.array(MobileClientSession),
})
export type MobileClientSessionsResponse = z.infer<typeof MobileClientSessionsResponse>
export const RevokeMobileClientSessionRequest = z.object({
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{20,64}$/),
})
export type RevokeMobileClientSessionRequest = z.infer<typeof RevokeMobileClientSessionRequest>

export const NativeClientLoginRequest = z.object({
  delivery: z.literal('native'),
  userId: z.string().min(1).optional(),
  password: z.string(),
  deviceId: z.string().min(1).max(256),
  deviceName: z.string().trim().min(1).max(120),
  platform: z.enum(['ios', 'android', 'unknown']),
})
export type NativeClientLoginRequest = z.infer<typeof NativeClientLoginRequest>

export const NativeClientLoginResponse = z.object({
  ok: z.literal(true),
  delivery: z.literal('native'),
  token: z.string(),
  userId: z.string(),
  expiresAt: z.string().datetime(),
})
export type NativeClientLoginResponse = z.infer<typeof NativeClientLoginResponse>

// 64 × 32 fixed combinations = 2,048 stable, human-readable phrase words.
const WORD_PREFIXES = [
  'amber',
  'apple',
  'autumn',
  'azure',
  'bamboo',
  'berry',
  'birch',
  'blue',
  'brave',
  'bright',
  'calm',
  'cedar',
  'cherry',
  'clear',
  'cloud',
  'coral',
  'cosmic',
  'crystal',
  'dawn',
  'delta',
  'eager',
  'elm',
  'ember',
  'fern',
  'forest',
  'gentle',
  'gold',
  'green',
  'happy',
  'harbor',
  'hazel',
  'indigo',
  'jade',
  'juniper',
  'kind',
  'lake',
  'lilac',
  'lively',
  'lunar',
  'maple',
  'meadow',
  'mint',
  'misty',
  'navy',
  'noble',
  'ocean',
  'olive',
  'orange',
  'pearl',
  'pine',
  'plum',
  'quiet',
  'rapid',
  'red',
  'river',
  'rose',
  'royal',
  'silver',
  'soft',
  'solar',
  'swift',
  'teal',
  'velvet',
  'violet',
] as const
const WORD_SUFFIXES = [
  'anchor',
  'bird',
  'bloom',
  'breeze',
  'brook',
  'canyon',
  'cloud',
  'comet',
  'cove',
  'dove',
  'field',
  'flame',
  'fox',
  'garden',
  'grove',
  'harbor',
  'hill',
  'island',
  'leaf',
  'light',
  'moon',
  'orbit',
  'owl',
  'peak',
  'pine',
  'rain',
  'reef',
  'river',
  'sky',
  'spark',
  'star',
  'stone',
] as const

export function mobilePairingPhraseFromDigest(digest: Uint8Array): [string, string, string] {
  if (digest.length < 5) throw new Error('pairing phrase digest must contain at least 33 bits')
  const value =
    (BigInt(digest[0]!) << 32n) |
    (BigInt(digest[1]!) << 24n) |
    (BigInt(digest[2]!) << 16n) |
    (BigInt(digest[3]!) << 8n) |
    BigInt(digest[4]!)
  const first33 = value >> 7n
  const words = [22n, 11n, 0n].map((shift) => {
    const index = Number((first33 >> shift) & 0x7ffn)
    return `${WORD_PREFIXES[index >> 5]}${WORD_SUFFIXES[index & 31]}`
  })
  return words as [string, string, string]
}
