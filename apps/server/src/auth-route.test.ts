import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FIRST_ADMIN_USER_ID } from '@podium/model'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  clientAuthGuard,
  hashToken,
  isRequestAuthed,
  registerAuthRoute,
  requestUserId,
} from './auth-route'
import { setPassword } from './auth-store'
import { SessionStore } from './store'

let dir: string
let store: SessionStore

function makeApp(opts: Parameters<typeof registerAuthRoute>[1] = {}) {
  const app = new Hono()
  registerAuthRoute(app, { store: store.auth, authDir: dir, ...opts })
  return app
}

function cookieValue(res: Response): string | undefined {
  const setCookie = res.headers.get('set-cookie')
  return setCookie?.match(/podium_session=([^;]+)/)?.[1]
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'podium-authroute-'))
  store = new SessionStore(':memory:')
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('auth-route', () => {
  test('status reports needsAuth=false when no password is set (open)', async () => {
    const res = await makeApp().request('/auth/status')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ needsAuth: false, authed: false })
  })

  test('status reports the composition-root principal without deriving an open-mode user', async () => {
    const res = await makeApp({ resolveUserId: () => FIRST_ADMIN_USER_ID }).request('/auth/status')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      needsAuth: false,
      authed: true,
      userId: FIRST_ADMIN_USER_ID,
    })
  })

  test('status reports needsAuth=true once a password is set', async () => {
    await setPassword('hunter2', dir)
    const res = await makeApp().request('/auth/status')
    expect(await res.json()).toEqual({ needsAuth: true, authed: false })
  })

  test('login with no password configured is a 400 (nothing to log into)', async () => {
    const res = await makeApp().request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'whatever' }),
    })
    expect(res.status).toBe(400)
  })

  test('login with the wrong password is rejected with 401 and sets no cookie', async () => {
    await setPassword('hunter2', dir)
    const res = await makeApp().request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'nope' }),
    })
    expect(res.status).toBe(401)
    expect(cookieValue(res)).toBeUndefined()
  })

  test('login with the right password sets an HttpOnly SameSite=Lax session cookie', async () => {
    await setPassword('hunter2', dir)
    const res = await makeApp().request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'hunter2' }),
    })
    expect(res.status).toBe(200)
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).toMatch(/podium_session=/)
    expect(setCookie).toMatch(/HttpOnly/i)
    expect(setCookie).toMatch(/SameSite=Lax/i)
    // Plain http (loopback) must NOT set Secure or the browser drops the cookie.
    expect(setCookie).not.toMatch(/Secure/i)
  })

  test('the session cookie marks the client authed; logout clears it', async () => {
    await setPassword('hunter2', dir)
    const app = makeApp()
    const login = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'hunter2' }),
    })
    const token = cookieValue(login)
    expect(token).toBeTruthy()

    const status = await app.request('/auth/status', {
      headers: { cookie: `podium_session=${token}` },
    })
    expect(await status.json()).toEqual({
      needsAuth: true,
      authed: true,
      userId: FIRST_ADMIN_USER_ID,
    })

    const logout = await app.request('/auth/logout', {
      method: 'POST',
      headers: { cookie: `podium_session=${token}` },
    })
    expect(logout.status).toBe(200)

    const after = await app.request('/auth/status', {
      headers: { cookie: `podium_session=${token}` },
    })
    expect(await after.json()).toEqual({ needsAuth: true, authed: false })
  })

  test('a forged/random cookie does not authenticate', async () => {
    await setPassword('hunter2', dir)
    const res = await makeApp().request('/auth/status', {
      headers: { cookie: 'podium_session=not-a-real-token' },
    })
    expect(await res.json()).toEqual({ needsAuth: true, authed: false })
  })

  test('the cookie sets Secure when the request arrives over https (proxy)', async () => {
    await setPassword('hunter2', dir)
    const res = await makeApp().request('/auth/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-proto': 'https',
      },
      body: JSON.stringify({ password: 'hunter2' }),
    })
    expect(res.headers.get('set-cookie') ?? '').toMatch(/Secure/i)
  })

  test('repeated wrong passwords trip the login throttle (429)', async () => {
    await setPassword('hunter2', dir)
    const app = makeApp({ throttle: { maxFailures: 3, lockoutMs: 60_000 } })
    const attempt = () =>
      app.request('/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'wrong' }),
      })
    expect((await attempt()).status).toBe(401)
    expect((await attempt()).status).toBe(401)
    expect((await attempt()).status).toBe(401)
    // 4th attempt within the window is locked out
    expect((await attempt()).status).toBe(429)
  })

  test('a successful login resets the failure counter', async () => {
    await setPassword('hunter2', dir)
    const app = makeApp({ throttle: { maxFailures: 3, lockoutMs: 60_000 } })
    const bad = () =>
      app.request('/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'wrong' }),
      })
    await bad()
    await bad()
    // success resets
    await app.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'hunter2' }),
    })
    // counter cleared: two more bad attempts should not yet lock out
    expect((await bad()).status).toBe(401)
    expect((await bad()).status).toBe(401)
  })
})

describe('clientAuthGuard (HTTP surface gate)', () => {
  function guardedApp() {
    const app = new Hono()
    app.use('/trpc/*', clientAuthGuard({ store: store.auth, authDir: dir }))
    app.get('/trpc/ping', (c) => c.text('pong'))
    app.options('/trpc/ping', (c) => c.body(null, 204))
    return app
  }

  function validCookie(): string {
    const token = 'raw-session-token'
    store.auth.createClientSession(
      hashToken(token),
      FIRST_ADMIN_USER_ID,
      new Date(Date.now() + 60_000).toISOString(),
    )
    return `podium_session=${token}`
  }

  test('passes through when no password is set (open mode)', async () => {
    const res = await guardedApp().request('/trpc/ping')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('pong')
  })

  test('blocks an unauthenticated request with 401 once a password is set', async () => {
    await setPassword('hunter2', dir)
    const res = await guardedApp().request('/trpc/ping')
    expect(res.status).toBe(401)
  })

  test('allows a request carrying a valid session cookie', async () => {
    await setPassword('hunter2', dir)
    const res = await guardedApp().request('/trpc/ping', { headers: { cookie: validCookie() } })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('pong')
  })

  test('lets CORS preflight (OPTIONS) through even without a cookie', async () => {
    await setPassword('hunter2', dir)
    const res = await guardedApp().request('/trpc/ping', { method: 'OPTIONS' })
    expect(res.status).not.toBe(401)
  })

  const DAY = 24 * 60 * 60 * 1000
  function guardedAppAt(nowMs: number) {
    const app = new Hono()
    app.use('/trpc/*', clientAuthGuard({ store: store.auth, authDir: dir, now: () => nowMs }))
    app.get('/trpc/ping', (c) => c.text('pong'))
    return app
  }

  const HOUR = 60 * 60 * 1000

  test('renews a session not renewed in over a day, refreshing the cookie (same token)', async () => {
    await setPassword('hunter2', dir)
    const nowMs = Date.UTC(2026, 0, 1)
    const token = 'rolling-token'
    // 28 days left of a 30-day TTL ⇒ last renewed ~2 days ago ⇒ due for a daily renewal.
    store.auth.createClientSession(
      hashToken(token),
      FIRST_ADMIN_USER_ID,
      new Date(nowMs + 28 * DAY).toISOString(),
    )
    const res = await guardedAppAt(nowMs).request('/trpc/ping', {
      headers: { cookie: `podium_session=${token}` },
    })
    expect(res.status).toBe(200)
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).toMatch(/podium_session=rolling-token/) // same token, not a new one
    // Expiry pushed back out toward now + 30 days.
    const expiry = Date.parse(store.auth.getClientSession(hashToken(token))?.expiresAt ?? '')
    expect(expiry).toBeGreaterThan(nowMs + 29 * DAY)
  })

  test('does not renew a session renewed within the last day (no cookie churn)', async () => {
    await setPassword('hunter2', dir)
    const nowMs = Date.UTC(2026, 0, 1)
    const token = 'fresh-token'
    // ~1 hour into the 30-day TTL ⇒ renewed within the day ⇒ no re-issue.
    store.auth.createClientSession(
      hashToken(token),
      FIRST_ADMIN_USER_ID,
      new Date(nowMs + 30 * DAY - HOUR).toISOString(),
    )
    const res = await guardedAppAt(nowMs).request('/trpc/ping', {
      headers: { cookie: `podium_session=${token}` },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toBeNull()
  })
})

/**
 * Gate-level coverage for requestUserId / isRequestAuthed (POD-1410).
 *
 * The store predicate alone is not enough: requestPrincipal trusts this gate
 * with no second expiry check. A mutant that drops the isClientSessionValid
 * call still lets getClientSession return the user for an expired-but-present
 * row — and every earlier test either hit the store directly or only exercised
 * valid / missing-token paths, so the expired cookie case was invisible.
 */
describe('requestUserId / isRequestAuthed (auth gate)', () => {
  const nowMs = Date.UTC(2026, 5, 15, 12, 0, 0)

  function cookieFor(token: string): string {
    return `podium_session=${token}`
  }

  test('resolves a valid session cookie to its user', () => {
    const token = 'gate-valid-token'
    store.auth.createClientSession(
      hashToken(token),
      FIRST_ADMIN_USER_ID,
      new Date(nowMs + 60_000).toISOString(),
    )
    const cookie = cookieFor(token)
    expect(requestUserId(store.auth, cookie, nowMs)).toBe(FIRST_ADMIN_USER_ID)
    expect(isRequestAuthed(store.auth, cookie, nowMs)).toBe(true)
  })

  test('rejects an expired session cookie (present row, past expiresAt)', () => {
    const token = 'gate-expired-token'
    // Row still exists — getClientSession would return the userId. The gate must
    // still refuse: expiry is enforced here, not only in the store helper.
    store.auth.createClientSession(
      hashToken(token),
      FIRST_ADMIN_USER_ID,
      new Date(nowMs - 1_000).toISOString(),
    )
    const cookie = cookieFor(token)
    expect(store.auth.getClientSession(hashToken(token))?.userId).toBe(FIRST_ADMIN_USER_ID)
    expect(requestUserId(store.auth, cookie, nowMs)).toBeUndefined()
    expect(isRequestAuthed(store.auth, cookie, nowMs)).toBe(false)
  })

  test('rejects an unknown session cookie', () => {
    const cookie = cookieFor('never-issued-token')
    expect(requestUserId(store.auth, cookie, nowMs)).toBeUndefined()
    expect(isRequestAuthed(store.auth, cookie, nowMs)).toBe(false)
  })

  test('rejects a missing or empty cookie header', () => {
    expect(requestUserId(store.auth, undefined, nowMs)).toBeUndefined()
    expect(requestUserId(store.auth, '', nowMs)).toBeUndefined()
    expect(isRequestAuthed(store.auth, undefined, nowMs)).toBe(false)
  })
})

describe('client session store', () => {
  test('a session validates until it expires, then no longer', () => {
    const future = new Date(Date.now() + 60_000).toISOString()
    const past = new Date(Date.now() - 1_000).toISOString()
    store.auth.createClientSession('hash-a', FIRST_ADMIN_USER_ID, future)
    store.auth.createClientSession('hash-b', FIRST_ADMIN_USER_ID, past)
    const now = new Date().toISOString()
    expect(store.auth.getClientSession('hash-a')?.expiresAt).toBe(future)
    expect(store.auth.isClientSessionValid('hash-a', now)).toBe(true)
    expect(store.auth.isClientSessionValid('hash-b', now)).toBe(false)
    expect(store.auth.isClientSessionValid('missing', now)).toBe(false)
  })

  test('extendClientSession pushes out the expiry of an existing session', () => {
    const t1 = new Date(Date.now() + 1_000).toISOString()
    const t2 = new Date(Date.now() + 999_000).toISOString()
    store.auth.createClientSession('ext', FIRST_ADMIN_USER_ID, t1)
    store.auth.extendClientSession('ext', t2)
    expect(store.auth.getClientSession('ext')?.expiresAt).toBe(t2)
  })

  test('deleteClientSession revokes one; deleteAllClientSessions revokes every session', () => {
    const future = new Date(Date.now() + 60_000).toISOString()
    const now = new Date().toISOString()
    store.auth.createClientSession('one', FIRST_ADMIN_USER_ID, future)
    store.auth.createClientSession('two', FIRST_ADMIN_USER_ID, future)
    store.auth.deleteClientSession('one')
    expect(store.auth.isClientSessionValid('one', now)).toBe(false)
    expect(store.auth.isClientSessionValid('two', now)).toBe(true)
    store.auth.deleteAllClientSessions()
    expect(store.auth.isClientSessionValid('two', now)).toBe(false)
  })

  /**
   * A DEVICE THAT RESOLVES TO A USER (POD-1075, ADR 9 D1.3).
   *
   * The column landing in the schema is not the deliverable — a column nothing
   * writes is a column that is NULL in production and correct in the migration
   * test. These two assert the round trip: the login path supplies a person,
   * and reading the session back names them.
   */
  test('a session records WHICH PERSON the device belongs to', () => {
    const future = new Date(Date.now() + 60_000).toISOString()
    store.auth.createClientSession('with-user', FIRST_ADMIN_USER_ID, future)
    expect(store.auth.getClientSession('with-user')?.userId).toBe(FIRST_ADMIN_USER_ID)
  })

  test('device and person are separable — two devices, one person', () => {
    // The property the column exists for. Before it, "which device" and "who"
    // had one answer; a test that only checked `userId` was non-empty could not
    // tell the two questions apart.
    const future = new Date(Date.now() + 60_000).toISOString()
    store.auth.createClientSession('laptop', FIRST_ADMIN_USER_ID, future)
    store.auth.createClientSession('phone', FIRST_ADMIN_USER_ID, future)

    expect(store.auth.getClientSession('laptop')?.userId).toBe(
      store.auth.getClientSession('phone')?.userId,
    )
    // …and revoking one device does not revoke the person's other device, which
    // is what makes them separable rather than two names for one row.
    const now = new Date().toISOString()
    store.auth.deleteClientSession('laptop')
    expect(store.auth.isClientSessionValid('laptop', now)).toBe(false)
    expect(store.auth.isClientSessionValid('phone', now)).toBe(true)
  })
})
