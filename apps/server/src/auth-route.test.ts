import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { clientAuthGuard, hashToken, registerAuthRoute } from './auth-route'
import { setPassword } from './auth-store'
import { SessionStore } from './store'

let dir: string
let store: SessionStore

function makeApp(opts: Parameters<typeof registerAuthRoute>[1] = {}) {
  const app = new Hono()
  registerAuthRoute(app, { store, authDir: dir, ...opts })
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
    expect(await status.json()).toEqual({ needsAuth: true, authed: true })

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
    app.use('/trpc/*', clientAuthGuard({ store, authDir: dir }))
    app.get('/trpc/ping', (c) => c.text('pong'))
    app.options('/trpc/ping', (c) => c.body(null, 204))
    return app
  }

  function validCookie(): string {
    const token = 'raw-session-token'
    store.createClientSession(hashToken(token), new Date(Date.now() + 60_000).toISOString())
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
})

describe('client session store', () => {
  test('a session validates until it expires, then no longer', () => {
    const future = new Date(Date.now() + 60_000).toISOString()
    const past = new Date(Date.now() - 1_000).toISOString()
    store.createClientSession('hash-a', future)
    store.createClientSession('hash-b', past)
    const now = new Date().toISOString()
    expect(store.getClientSession('hash-a')?.expiresAt).toBe(future)
    expect(store.isClientSessionValid('hash-a', now)).toBe(true)
    expect(store.isClientSessionValid('hash-b', now)).toBe(false)
    expect(store.isClientSessionValid('missing', now)).toBe(false)
  })

  test('deleteClientSession revokes one; deleteAllClientSessions revokes every session', () => {
    const future = new Date(Date.now() + 60_000).toISOString()
    const now = new Date().toISOString()
    store.createClientSession('one', future)
    store.createClientSession('two', future)
    store.deleteClientSession('one')
    expect(store.isClientSessionValid('one', now)).toBe(false)
    expect(store.isClientSessionValid('two', now)).toBe(true)
    store.deleteAllClientSessions()
    expect(store.isClientSessionValid('two', now)).toBe(false)
  })
})
