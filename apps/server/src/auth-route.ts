import { createHash, randomBytes } from 'node:crypto'
import type { Context, Hono, MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { hasPassword, verifyPassword } from './auth-store'

/** The subset of the store the auth surface needs (the human-UI login sessions). */
export interface ClientSessionStore {
  createClientSession(tokenHash: string, expiresAt: string): void
  isClientSessionValid(tokenHash: string, nowIso: string): boolean
  deleteClientSession(tokenHash: string): void
  deleteExpiredClientSessions?(nowIso: string): void
}

export const SESSION_COOKIE = 'podium_session'

/** 30 days — a logged-in device stays logged in across server redeploys. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

const DEFAULT_MAX_FAILURES = 8
const DEFAULT_LOCKOUT_MS = 5 * 60 * 1000

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** True when the request carries a valid (unexpired) session cookie. Reused by the
 *  auth middleware and the /client WS upgrade gate so they share one definition of "authed". */
export function isRequestAuthed(
  store: ClientSessionStore,
  cookieHeader: string | undefined,
  nowMs: number = Date.now(),
): boolean {
  const token = parseSessionCookie(cookieHeader)
  if (!token) return false
  return store.isClientSessionValid(hashToken(token), new Date(nowMs).toISOString())
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

/**
 * Hono middleware that gates a client surface (e.g. /trpc, /files) behind the login session.
 * Open (passes through) when no password is configured; otherwise requires a valid session
 * cookie. CORS preflight (OPTIONS) is always allowed so cross-origin clients can negotiate.
 */
export function clientAuthGuard(opts: {
  store?: ClientSessionStore
  authDir?: string
  now?: () => number
}): MiddlewareHandler {
  const now = opts.now ?? (() => Date.now())
  return async (c, next) => {
    if (c.req.method === 'OPTIONS') return next()
    if (!hasPassword(opts.authDir)) return next()
    if (opts.store && isRequestAuthed(opts.store, c.req.header('cookie'), now())) return next()
    return c.json({ error: 'unauthorized' }, 401)
  }
}

export interface AuthRouteOptions {
  store?: ClientSessionStore
  /** State dir holding the password hash (auth.json). Defaults to the real state dir. */
  authDir?: string
  throttle?: { maxFailures?: number; lockoutMs?: number }
  now?: () => number
}

export function registerAuthRoute(app: Hono, opts: AuthRouteOptions = {}): void {
  const store = opts.store
  const authDir = opts.authDir
  const now = opts.now ?? (() => Date.now())
  const maxFailures = opts.throttle?.maxFailures ?? DEFAULT_MAX_FAILURES
  const lockoutMs = opts.throttle?.lockoutMs ?? DEFAULT_LOCKOUT_MS

  // Single-user: one global throttle is enough to blunt online password guessing.
  let failures = 0
  let lockedUntil = 0

  app.get('/auth/status', (c) => {
    const needsAuth = hasPassword(authDir)
    const authed =
      needsAuth && store ? isRequestAuthed(store, c.req.header('cookie'), now()) : false
    return c.json({ needsAuth, authed })
  })

  app.post('/auth/login', async (c) => {
    if (!hasPassword(authDir)) {
      // No password configured → auth is disabled; there's nothing to log into.
      return c.json({ error: 'auth disabled' }, 400)
    }
    const at = now()
    if (at < lockedUntil) {
      const retryAfter = Math.ceil((lockedUntil - at) / 1000)
      return c.json({ error: 'too many attempts' }, 429, { 'retry-after': String(retryAfter) })
    }

    let password = ''
    try {
      const body = (await c.req.json()) as { password?: unknown }
      if (typeof body?.password === 'string') password = body.password
    } catch {
      // fall through — empty password fails verification below
    }

    const ok = password ? await verifyPassword(password, authDir) : false
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
    store?.createClientSession(hashToken(token), expiresAt)

    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: isHttps(c),
      path: '/',
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    })
    return c.json({ ok: true })
  })

  app.post('/auth/logout', (c) => {
    const token = getCookie(c, SESSION_COOKIE)
    if (token && store) store.deleteClientSession(hashToken(token))
    deleteCookie(c, SESSION_COOKIE, { path: '/' })
    return c.json({ ok: true })
  })
}
