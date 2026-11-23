/**
 * THE TOKEN (POD-6954 design 4.5).
 *
 *   plg1.<key id>.<payload>.<signature>
 *
 * - `payload` is base64url of the raw-DEFLATE of the claims' JSON. Ids are most
 *   of a grant's bytes, and a session id is a UUID: compressed they take about
 *   half their text (the size test states the numbers).
 * - `signature` is base64url of the Ed25519 signature over the ASCII bytes of
 *   `plg1.<key id>.<payload>`, so the version and the key id are signed too.
 * - The verifier checks the signature BEFORE it inflates anything, so only bytes
 *   Core signed are ever decompressed, and it inflates into a bounded buffer.
 *
 * In the JSON, actions are grouped: each group is `[mask, ids]`, where the mask
 * has a bit per action (view 1, use 2, manage 4). Machine actions are not a
 * ladder (an admin may manage a machine it may not use), so a group names the
 * exact set. An id appears in at most one group.
 */

import { deflateRawSync, inflateRawSync } from 'node:zlib'
import {
  type ClientGrantClaims,
  type DaemonGrantClaims,
  LIVE_GRANT_ACTIONS,
  type LiveGrantAction,
  type LiveGrantClaims,
} from './claims'

export const TOKEN_PREFIX = 'plg1'

/** A token longer than this is refused unread. A 1,000-session grant is about 26 KB. */
export const MAX_TOKEN_CHARS = 512 * 1024
/** The most bytes a payload inflates to. */
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024
/** The most ids, of each list, a decoded grant may hold. */
const MAX_DECODED_IDS = 10_000
/** The longest life a decoded grant may claim: a day. Anything longer is not ours. */
const MAX_LIFETIME_MS = 24 * 60 * 60_000
const MAX_ID_CHARS = 256
const MAX_ROOT_CHARS = 4096
const MAX_ROOTS_PER_MACHINE = 1024

const ACTION_BIT: Record<LiveGrantAction, number> = { view: 1, use: 2, manage: 4 }

/** The claims with the times the signer stamped. */
export type StampedClaims = LiveGrantClaims & {
  readonly issuedAt: number
  readonly expiresAt: number
}

export class MalformedGrant extends Error {
  override readonly name = 'MalformedGrant'
}

// ---------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------

function maskOf(actions: readonly LiveGrantAction[]): number {
  let mask = 0
  for (const action of actions) {
    const bit = ACTION_BIT[action]
    if (bit === undefined) throw new MalformedGrant(`unknown action '${String(action)}'`)
    mask |= bit
  }
  return mask
}

/** `{ id: actions }` as sorted `[mask, ids]` groups; an id with no action is left out. */
function groupsOf(
  scopes: Readonly<Record<string, readonly LiveGrantAction[]>>,
): [number, string[]][] {
  const byMask = new Map<number, string[]>()
  for (const [id, actions] of Object.entries(scopes)) {
    const mask = maskOf(actions)
    if (mask === 0) continue
    const ids = byMask.get(mask)
    if (ids) ids.push(id)
    else byMask.set(mask, [id])
  }
  return [...byMask.entries()].sort(([a], [b]) => a - b).map(([mask, ids]) => [mask, ids.sort()])
}

function wireOf(claims: StampedClaims): Record<string, unknown> {
  const binding = {
    ...(claims.connectionKey === undefined ? {} : { ck: claims.connectionKey }),
    ...(claims.epoch === undefined ? {} : { ep: claims.epoch }),
  }
  if (claims.kind === 'daemon') {
    return {
      v: 1,
      k: 'd',
      ws: claims.workspace,
      iat: claims.issuedAt,
      exp: claims.expiresAt,
      mc: claims.machine,
      ...binding,
    }
  }
  const roots: Record<string, string[]> = {}
  for (const [machine, list] of Object.entries(claims.roots)) {
    if (list.length > 0) roots[machine] = [...new Set(list)].sort()
  }
  return {
    v: 1,
    k: 'c',
    ws: claims.workspace,
    iat: claims.issuedAt,
    exp: claims.expiresAt,
    m: claims.member,
    ro: claims.role,
    s: groupsOf(claims.sessions),
    h: groupsOf(claims.machines),
    r: roots,
    l: [...new Set(claims.logins)].sort(),
    ...binding,
  }
}

/** The signed part's text and its payload segment. */
export function encodePayload(claims: StampedClaims): string {
  const json = JSON.stringify(wireOf(claims))
  // Decode what we are about to sign: Core never signs a grant the verifier would refuse.
  const payload = deflateRawSync(Buffer.from(json, 'utf8')).toString('base64url')
  decodePayload(payload)
  return payload
}

export function signedPart(kid: string, payload: string): string {
  return `${TOKEN_PREFIX}.${kid}.${payload}`
}

// ---------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------

export interface TokenParts {
  readonly kid: string
  readonly payload: string
  readonly signature: Buffer
  readonly signed: string
}

const SEGMENT = /^[A-Za-z0-9_-]+$/

/** Split a token. `undefined` when it is not one. */
export function splitToken(token: unknown): TokenParts | undefined {
  if (typeof token !== 'string' || token.length > MAX_TOKEN_CHARS) return undefined
  const parts = token.split('.')
  if (parts.length !== 4 || parts[0] !== TOKEN_PREFIX) return undefined
  const [, kid, payload, signature] = parts as [string, string, string, string]
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(kid) || !SEGMENT.test(payload) || !SEGMENT.test(signature)) {
    return undefined
  }
  const bytes = Buffer.from(signature, 'base64url')
  if (bytes.length !== 64) return undefined
  return { kid, payload, signature: bytes, signed: signedPart(kid, payload) }
}

const isId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_CHARS

function id(value: unknown, what: string): string {
  if (!isId(value)) throw new MalformedGrant(`${what} is not an id`)
  return value
}

function time(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new MalformedGrant(`${what} is not a time`)
  }
  return value
}

function ids(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_DECODED_IDS) {
    throw new MalformedGrant(`${what} is not a list of ids`)
  }
  return value.map((entry) => id(entry, what))
}

function groups(value: unknown, what: string): Map<string, ReadonlySet<LiveGrantAction>> {
  if (!Array.isArray(value)) throw new MalformedGrant(`${what} is not a list of groups`)
  const out = new Map<string, ReadonlySet<LiveGrantAction>>()
  for (const group of value) {
    if (!Array.isArray(group) || group.length !== 2) {
      throw new MalformedGrant(`${what} has a group that is not [mask, ids]`)
    }
    const [mask, members] = group as [unknown, unknown]
    if (typeof mask !== 'number' || !Number.isInteger(mask) || mask < 1 || mask > 7) {
      throw new MalformedGrant(`${what} has an unknown action mask`)
    }
    const actions = new Set(
      LIVE_GRANT_ACTIONS.filter((action) => (mask & ACTION_BIT[action]) !== 0),
    )
    for (const member of ids(members, what)) {
      if (out.has(member)) throw new MalformedGrant(`${what} names '${member}' twice`)
      out.set(member, actions)
    }
    if (out.size > MAX_DECODED_IDS) throw new MalformedGrant(`${what} names too many ids`)
  }
  return out
}

function roots(value: unknown): Map<string, readonly string[]> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MalformedGrant('roots is not an object')
  }
  const out = new Map<string, readonly string[]>()
  for (const [machine, list] of Object.entries(value)) {
    id(machine, 'a roots machine')
    if (!Array.isArray(list) || list.length > MAX_ROOTS_PER_MACHINE) {
      throw new MalformedGrant('roots has a list that is not a list of paths')
    }
    for (const root of list) {
      if (typeof root !== 'string' || root.length === 0 || root.length > MAX_ROOT_CHARS) {
        throw new MalformedGrant('roots has a path that is not a path')
      }
    }
    out.set(machine, list as string[])
  }
  if (out.size > MAX_DECODED_IDS) throw new MalformedGrant('roots names too many machines')
  return out
}

/** A decoded client grant, its lists as maps. */
export interface DecodedClientGrant {
  readonly kind: 'client'
  readonly workspace: string
  readonly issuedAt: number
  readonly expiresAt: number
  readonly member: string
  readonly role: string
  readonly sessions: ReadonlyMap<string, ReadonlySet<LiveGrantAction>>
  readonly machines: ReadonlyMap<string, ReadonlySet<LiveGrantAction>>
  readonly roots: ReadonlyMap<string, readonly string[]>
  readonly logins: ReadonlySet<string>
  readonly connectionKey?: string
  readonly epoch?: number
}

export interface DecodedDaemonGrant {
  readonly kind: 'daemon'
  readonly workspace: string
  readonly issuedAt: number
  readonly expiresAt: number
  readonly machine: string
  readonly connectionKey?: string
  readonly epoch?: number
}

export type DecodedGrant = DecodedClientGrant | DecodedDaemonGrant

/** Inflate and validate a payload segment. Throws {@link MalformedGrant}. */
export function decodePayload(payload: string): DecodedGrant {
  let wire: Record<string, unknown>
  try {
    const json = inflateRawSync(Buffer.from(payload, 'base64url'), {
      maxOutputLength: MAX_PAYLOAD_BYTES,
    }).toString('utf8')
    wire = JSON.parse(json) as Record<string, unknown>
  } catch {
    throw new MalformedGrant('the payload cannot be read')
  }
  if (typeof wire !== 'object' || wire === null || Array.isArray(wire) || wire.v !== 1) {
    throw new MalformedGrant('the payload is not a version 1 grant')
  }
  const issuedAt = time(wire.iat, 'iat')
  const expiresAt = time(wire.exp, 'exp')
  if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_LIFETIME_MS) {
    throw new MalformedGrant('the grant life is out of range')
  }
  const binding = {
    ...(wire.ck === undefined ? {} : { connectionKey: id(wire.ck, 'ck') }),
    ...(wire.ep === undefined ? {} : { epoch: time(wire.ep, 'ep') }),
  }
  const workspace = id(wire.ws, 'ws')
  if (wire.k === 'd') {
    return {
      kind: 'daemon',
      workspace,
      issuedAt,
      expiresAt,
      machine: id(wire.mc, 'mc'),
      ...binding,
    }
  }
  if (wire.k !== 'c') throw new MalformedGrant('the grant kind is unknown')
  return {
    kind: 'client',
    workspace,
    issuedAt,
    expiresAt,
    member: id(wire.m, 'm'),
    role: id(wire.ro, 'ro'),
    sessions: groups(wire.s, 'sessions'),
    machines: groups(wire.h, 'machines'),
    roots: roots(wire.r),
    logins: new Set(ids(wire.l, 'logins')),
    ...binding,
  }
}

export type { ClientGrantClaims, DaemonGrantClaims }
