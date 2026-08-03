import { createHash, randomBytes } from 'node:crypto'
import { asUserId, FIRST_ADMIN_USER_ID, type UserId, type UserRole } from '@podium/model'
import { SESSION_COOKIE } from '@podium/protocol'
import {
  hashPassword,
  hasPassword,
  verifyPassword,
  verifyPasswordHash,
} from '@podium/runtime/auth-store'
import type { Context, Hono, MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'

/** The subset of the store the auth surface needs (the human-UI login sessions). */
export interface ClientSessionStore {
  createClientSession(tokenHash: string, userId: UserId, expiresAt: string): void
  getClientSession(tokenHash: string): { userId: UserId; expiresAt: string } | undefined
  isClientSessionValid(tokenHash: string, nowIso: string): boolean
  extendClientSession(tokenHash: string, expiresAt: string): void
  deleteClientSession(tokenHash: string): void
  deleteExpiredClientSessions?(nowIso: string): void
}

// The cookie name lives in @podium/protocol (shared wire-level constant with
// @podium/sync's node⇄hub client, which must not import apps/server) —
// re-exported here so existing apps/server/src imports of './auth-route' keep
// working unchanged.
export { SESSION_COOKIE }

/** 30 days — a logged-in device stays logged in across server redeploys. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
/** Renew at most once a day: the first authenticated request after a session was last
 *  renewed >24h ago pushes its expiry back to a full TTL. Keeps an active client logged in
 *  forever (the idle window resets on any day it's used) while bounding the write to ~1/day. */
const SESSION_RENEW_AFTER_MS = 24 * 60 * 60 * 1000

const DEFAULT_MAX_FAILURES = 8
const DEFAULT_LOCKOUT_MS = 5 * 60 * 1000

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** True when the request carries a valid (unexpired) session cookie. Reused by the
 *  auth middleware and the /client WS upgrade gate so they share one definition of "authed". */
export function requestUserId(
  store: ClientSessionStore,
  cookieHeader: string | undefined,
  nowMs: number = Date.now(),
): UserId | undefined {
  const token = parseSessionCookie(cookieHeader)
  if (!token) return undefined
  const tokenHash = hashToken(token)
  if (!store.isClientSessionValid(tokenHash, new Date(nowMs).toISOString())) return undefined
  return store.getClientSession(tokenHash)?.userId
}

export function isRequestAuthed(
  store: ClientSessionStore,
  cookieHeader: string | undefined,
  nowMs: number = Date.now(),
): boolean {
  return requestUserId(store, cookieHeader, nowMs) !== undefined
}

function parseSessionCookie(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === SESSION_COOKIE) return decodeURIComponent(rest.join('='))
  }
  return undefined
}

function isHttps(c: Context): boolean {
  if (c.req.header('x-forwarded-proto')?.split(',')[0]?.trim() === 'https') return true
  try {
    return new URL(c.req.url).protocol === 'https:'
  } catch {
    return false
  }
}

/** Issue (or refresh) the session cookie with the full TTL. One definition used by login
 *  and the sliding-renewal path so their cookie attributes can't drift apart. */
function setSessionCookie(c: Context, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: isHttps(c),
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  })
}

/**
 * Hono middleware that gates a client surface (e.g. /trpc, /files) behind the login session.
 * Open (passes through) when no password is configured; otherwise requires a valid session
 * cookie. CORS preflight (OPTIONS) is always allowed so cross-origin clients can negotiate.
 */
export function clientAuthGuard(opts: {
  store?: ClientSessionStore
  users?: AccountCredentialStore
  authDir?: string
  now?: () => number
}): MiddlewareHandler {
  const now = opts.now ?? (() => Date.now())
  return async (c, next) => {
    if (c.req.method === 'OPTIONS') return next()
    if (!hasPassword(opts.authDir) && !opts.users?.hasPerUserCredentials()) return next()
    const store = opts.store
    const token = store ? parseSessionCookie(c.req.header('cookie')) : undefined
    const nowMs = now()
    if (
      !store ||
      !token ||
      !store.isClientSessionValid(hashToken(token), new Date(nowMs).toISOString())
    ) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    // Sliding renewal: if this session was last renewed more than a day ago, push the expiry
    // back out and refresh the cookie so an actively-used client never gets logged out. Same
    // token. Bounded to ~one renewal write per session per day.
    const session = store.getClientSession(hashToken(token))
    if (
      session &&
      SESSION_TTL_MS - (Date.parse(session.expiresAt) - nowMs) >= SESSION_RENEW_AFTER_MS
    ) {
      store.extendClientSession(hashToken(token), new Date(nowMs + SESSION_TTL_MS).toISOString())
      setSessionCookie(c, token)
    }
    return next()
  }
}

export interface AccountCredentialStore {
  get(userId: string): { role: UserRole } | undefined
  create(
    account: {
      id: string
      displayName: string
      role: UserRole
      createdAt: string
      disabledAt: null
    },
    passwordHash: string,
  ): void
  credentialFor(userId: string):
    | {
        source: 'instance-password' | 'per-user-scrypt'
        passwordHash: string | null
      }
    | undefined
  hasPerUserCredentials(): boolean
}

export interface AuthRouteOptions {
  store?: ClientSessionStore
  users?: AccountCredentialStore
  /**
   * Resolve the request's transport principal at the server composition root.
   *
   * When present this is the SAME resolver used by tRPC and the client socket;
   * the auth route reports its result and never invents an account of its own.
   * This keeps the open/dev bootstrap policy in one place instead of growing a
   * second first-admin fallback at an unauthenticated status endpoint.
   */
  resolveUserId?: (cookieHeader: string | undefined) => UserId | undefined
  /** State dir holding the password hash (auth.json). Defaults to the real state dir. */
  authDir?: string
  throttle?: { maxFailures?: number; lockoutMs?: number }
  now?: () => number
}

export function registerAuthRoute(app: Hono, opts: AuthRouteOptions = {}): void {
  const store = opts.store
  const authDir = opts.authDir
  const users = opts.users
  const now = opts.now ?? (() => Date.now())
  const maxFailures = opts.throttle?.maxFailures ?? DEFAULT_MAX_FAILURES
  const lockoutMs = opts.throttle?.lockoutMs ?? DEFAULT_LOCKOUT_MS

  // Single-user: one global throttle is enough to blunt online password guessing.
  let failures = 0
  let lockedUntil = 0

  app.get('/auth/status', (c) => {
    const needsAuth = hasPassword(authDir) || Boolean(users?.hasPerUserCredentials())
    const cookie = c.req.header('cookie')
    const userId = opts.resolveUserId
      ? opts.resolveUserId(cookie)
      : store
        ? requestUserId(store, cookie, now())
        : undefined
    const authed = userId !== undefined
    return c.json({ needsAuth, authed, ...(userId ? { userId } : {}) })
  })

  app.post('/auth/login', async (c) => {
    if (!hasPassword(authDir) && !users?.hasPerUserCredentials()) {
      // No password configured → auth is disabled; there's nothing to log into.
      return c.json({ error: 'auth disabled' }, 400)
    }
    const at = now()
    if (at < lockedUntil) {
      const retryAfter = Math.ceil((lockedUntil - at) / 1000)
      return c.json({ error: 'too many attempts' }, 429, {
        'retry-after': String(retryAfter),
      })
    }

    let password = ''
    let userId: UserId = FIRST_ADMIN_USER_ID
    try {
      const body = (await c.req.json()) as {
        userId?: unknown
        password?: unknown
      }
      if (typeof body?.userId === 'string' && body.userId.trim()) userId = body.userId as UserId
      if (typeof body?.password === 'string') password = body.password
    } catch {
      // fall through — empty password fails verification below
    }

    const credential = users?.credentialFor(userId)
    const ok = password
      ? credential?.source === 'per-user-scrypt' && credential.passwordHash
        ? await verifyPasswordHash(password, credential.passwordHash)
        : credential?.source === 'instance-password' || (!users && userId === FIRST_ADMIN_USER_ID)
          ? await verifyPassword(password, authDir)
          : false
      : false
    if (!ok) {
      failures += 1
      if (failures >= maxFailures) {
        lockedUntil = at + lockoutMs
        failures = 0
      }
      return c.json({ error: 'invalid password' }, 401)
    }

    failures = 0
    lockedUntil = 0

    const token = randomBytes(32).toString('base64url')
    const expiresMs = at + SESSION_TTL_MS
    const expiresAt = new Date(expiresMs).toISOString()
    store?.deleteExpiredClientSessions?.(new Date(at).toISOString())
    // WHICH PERSON this device belongs to. The shared password authenticates a
    // CONNECTION, not a human (ADR 9 D1.3), so the only true answer available is
    // the instance's one account — passed EXPLICITLY rather than defaulted in the
    // store, so per-user login (POD-315) changes this line and nothing silently
    // keeps writing one id for everybody.
    store?.createClientSession(hashToken(token), userId, expiresAt)

    setSessionCookie(c, token)
    return c.json({ ok: true, userId })
  })

  app.post('/auth/users', async (c) => {
    if (!store || !users) return c.json({ error: 'account store unavailable' }, 503)
    const actorId = requestUserId(store, c.req.header('cookie'), now())
    if (!actorId) return c.json({ error: 'authentication required' }, 401)
    if (users.get(actorId)?.role !== 'admin') {
      return c.json({ error: 'admin account required' }, 403)
    }
    let body: { userId?: unknown; displayName?: unknown; role?: unknown; password?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid request body' }, 400)
    }
    if (
      typeof body.userId !== 'string' ||
      !body.userId.trim() ||
      typeof body.displayName !== 'string' ||
      !body.displayName.trim() ||
      (body.role !== 'admin' && body.role !== 'member') ||
      typeof body.password !== 'string' ||
      body.password.length < 8
    ) {
      return c.json(
        { error: 'userId, displayName, role, and an 8-character password are required' },
        400,
      )
    }
    const userId = asUserId(body.userId.trim())
    if (users.get(userId)) return c.json({ error: 'account already exists' }, 409)
    const createdAt = new Date(now()).toISOString()
    users.create(
      {
        id: userId,
        displayName: body.displayName.trim(),
        role: body.role,
        createdAt,
        disabledAt: null,
      },
      await hashPassword(body.password),
    )
    return c.json({ id: userId, displayName: body.displayName.trim(), role: body.role }, 201)
  })

  app.post('/auth/logout', (c) => {
    const token = getCookie(c, SESSION_COOKIE)
    if (token && store) store.deleteClientSession(hashToken(token))
    deleteCookie(c, SESSION_COOKIE, { path: '/' })
    return c.json({ ok: true })
  })
}
