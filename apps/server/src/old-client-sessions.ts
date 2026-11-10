/**
 * THE OLD `client_sessions` HELPERS (moved out of auth-route.ts by POD-6746).
 *
 * NOTHING HERE SIGNS ANYONE IN. Since POD-6746 a request is resolved to a
 * member by the identity package alone (`identity/member-of-request.ts`); no
 * transport calls these functions to decide who a caller is.
 *
 * They stay only because the pairing routes, the device list and the
 * server-transfer claim still read and write the old table until they move to
 * device sign-ins and one-time codes (POD-6748, which deletes this file), and
 * because the sign-in carry-over needs the old cookie name (POD-6751).
 */
import { createHash } from 'node:crypto'
import type { UserId } from '@podium/model'
import { SESSION_COOKIE } from '@podium/protocol'
import type { Context } from 'hono'
import { setCookie } from 'hono/cookie'
import { isHttps } from './request-scheme'

export { SESSION_COOKIE }

/** The subset of the store the auth surface needs (the human-UI login sessions). */
export interface ClientSessionStore {
  createClientSession(
    tokenHash: string,
    userId: UserId,
    expiresAt: string,
    label?: string,
    metadata?: ClientSessionMetadata,
  ): Promise<void>
  getClientSession(tokenHash: string): Promise<ClientSessionRecord | undefined>
  extendClientSession(tokenHash: string, expiresAt: string): Promise<void>
  deleteClientSession(tokenHash: string): Promise<void>
  touchClientSession?(tokenHash: string, lastSeenAt: string): Promise<void>
  deleteExpiredClientSessions?(nowIso: string): Promise<void>
}

export interface ClientSessionMetadata {
  sessionId?: string
  deviceId?: string
  deviceName?: string
  platform?: string
  lastSeenAt?: string
}

export interface ClientSessionRecord extends ClientSessionMetadata {
  userId: UserId
  expiresAt: string
  label?: string
}

export interface ClientCredentialHeaders {
  cookieHeader?: string
  authorizationHeader?: string
}

export interface ResolvedClientCredential {
  tokenHash: string
  source: 'cookie' | 'bearer'
  session: ClientSessionRecord
  renewed: boolean
}

/** 30 days — a logged-in device stays logged in across server redeploys. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
/** Renew at most once a day: the first authenticated request after a session was last
 *  renewed >24h ago pushes its expiry back to a full TTL. Keeps an active client logged in
 *  forever (the idle window resets on any day it's used) while bounding the write to ~1/day. */
const SESSION_RENEW_AFTER_MS = 24 * 60 * 60 * 1000

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** The old client session an old cookie or bearer names, or undefined. Authorizes nothing. */
export async function resolveClientCredential(
  store: ClientSessionStore,
  headers: ClientCredentialHeaders,
  nowMs: number = Date.now(),
): Promise<ResolvedClientCredential | undefined> {
  const fromBearer = headers.authorizationHeader !== undefined
  const token = fromBearer
    ? parseBearerToken(headers.authorizationHeader)
    : parseSessionCookie(headers.cookieHeader)
  if (!token) return undefined
  const tokenHash = hashToken(token)
  const maintained = await maintainClientCredentialByHash(store, tokenHash, nowMs)
  if (!maintained) return undefined
  if (fromBearer && maintained.session.label !== 'mobile') return undefined
  return {
    tokenHash,
    source: fromBearer ? 'bearer' : 'cookie',
    session: maintained.session,
    renewed: maintained.renewed,
  }
}

/** Validate and maintain a credential when a transport retains only its token hash (WebSocket). */
export async function maintainClientCredentialByHash(
  store: ClientSessionStore,
  tokenHash: string,
  nowMs: number = Date.now(),
): Promise<{ session: ClientSessionRecord; renewed: boolean } | undefined> {
  // One read: the row and its expiry together (POD-6220). ISO strings compare in time order.
  const current = await store.getClientSession(tokenHash)
  if (!current || !(current.expiresAt > new Date(nowMs).toISOString())) return undefined
  let session = current
  if (
    session.label === 'mobile' &&
    (!session.lastSeenAt || nowMs - Date.parse(session.lastSeenAt) >= 5 * 60_000)
  ) {
    await store.touchClientSession?.(tokenHash, new Date(nowMs).toISOString())
  }
  const renewed =
    ((session.label ?? 'login') === 'login' || session.label === 'mobile') &&
    SESSION_TTL_MS - (Date.parse(session.expiresAt) - nowMs) >= SESSION_RENEW_AFTER_MS
  if (renewed) {
    const expiresAt = new Date(nowMs + SESSION_TTL_MS).toISOString()
    await store.extendClientSession(tokenHash, expiresAt)
    session = { ...session, expiresAt }
  }
  return { session, renewed }
}

export function parseSessionCookie(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === SESSION_COOKIE) return decodeURIComponent(rest.join('='))
  }
  return undefined
}

function parseBearerToken(authorizationHeader: string | undefined): string | undefined {
  if (!authorizationHeader) return undefined
  const match = /^Bearer ([A-Za-z0-9_-]{20,512})$/i.exec(authorizationHeader.trim())
  return match?.[1]
}

/** Issue (or refresh) the session cookie with the full TTL. One definition used by login
 *  and the sliding-renewal path so their cookie attributes can't drift apart. */
export function setSessionCookie(c: Context, token: string, trustedProxyHops: number = 0): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: isHttps(c, trustedProxyHops),
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  })
}
