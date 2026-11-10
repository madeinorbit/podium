/**
 * The sign-in routes and the guard, on the shared identity package (POD-6746;
 * docs/design/people-and-sign-in.md, sections 4.1 and 5).
 *
 * The store is the server's real one and the identity is the one a self-hosted
 * server builds on it at boot. What the package itself guarantees (the budget
 * per identifier in every corner, who a sign-in without an address means,
 * expiry) is asserted by the shared suite; these tests are about the routes.
 */
import { asUserId, firstAdminMemberId, type UserId } from '@podium/model'
import { MEMBER_FENCE_HEADER, MEMBER_FENCE_REFUSAL } from '@podium/protocol'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  type AuthRouteOptions,
  clientAuthGuard,
  isSecureRequest,
  registerAuthRoute,
} from './auth-route'
import { hashToken } from './old-client-sessions'
import { authReadinessBoundary } from './readiness-boundary'
import type { SessionStore } from './store'
import { openTestStore } from './test-support/open-test-store'
import {
  memberResolution,
  openTestIdentity,
  stubMemberOfRequest,
  type TestIdentity,
} from './test-support/test-identity'

vi.mock('../../mobile/node_modules/react-native', () => ({ Platform: { OS: 'ios' } }))

const ORIGIN = 'https://podium.example'
const PASSWORD = 'hunter2-hunter2'

let store: SessionStore
let identity: TestIdentity
let admin: UserId

/** Every request comes from an address of its own: the sign-in library limits sign-ins per address. */
let peers = 0
const peer = () => {
  peers += 1
  return `198.51.${(peers >> 8) & 255}.${peers & 255}`
}

function makeApp(opts: Partial<AuthRouteOptions> = {}) {
  const app = new Hono()
  registerAuthRoute(app, {
    identity: identity.workspace,
    memberOfRequest: identity.memberOfRequest,
    memberOfAccount: (accountId) => store.users.findMemberByAccount(accountId),
    store: store.auth,
    ...opts,
  })
  return app
}

type App = ReturnType<typeof makeApp>

const post = (app: App, path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-podium-peer-address': peer(), ...headers },
    body: JSON.stringify(body),
  })

const get = (app: App, path: string, headers: Record<string, string> = {}) =>
  app.request(`${ORIGIN}${path}`, { headers: { 'x-podium-peer-address': peer(), ...headers } })

/** The `name=value` pair of the sign-in cookie a response set. */
function cookieOf(res: Response): string | undefined {
  return res.headers
    .getSetCookie()
    .find((c) => c.includes('session_token'))
    ?.split(';')[0]
}

beforeEach(async () => {
  store = await openTestStore(':memory:')
  identity = await openTestIdentity(store)
  admin = firstAdminMemberId()
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await store.close()
})

describe('request transport security', () => {
  test('trusts the real URL protocol and ignores forwarding by default', () => {
    expect(isSecureRequest('https://podium.example/auth/status', 'http')).toBe(true)
    expect(isSecureRequest('http://podium.internal/auth/status', 'https')).toBe(false)
  })

  test('selects the configured hop from the right of an appending proxy chain', () => {
    expect(isSecureRequest('http://podium.internal', 'spoofed, https', 1)).toBe(true)
    expect(isSecureRequest('http://podium.internal', 'https, http', 1)).toBe(false)
    expect(isSecureRequest('http://podium.internal', 'https, http', 2)).toBe(true)
    expect(isSecureRequest('http://podium.internal', 'https', 2)).toBe(false)
  })
})

describe('GET /auth/status', () => {
  test('a one-person server without a password needs no sign-in, and reports what it offers', async () => {
    const body = await (await get(makeApp(), '/auth/status')).json()
    expect(body).toMatchObject({
      needsAuth: false,
      authed: false,
      // Nobody has a password yet, so there is no one-field prompt to show.
      prompt: 'email-password',
      capabilities: {
        version: 1,
        passwordSignIn: true,
        providers: [],
        selfSignUp: false,
        invitationDelivery: 'link',
        passwordReset: 'admin-link',
        sameMachineSignIn: true,
        accountUrl: null,
      },
    })
    // The fields of the removed cloud hook are gone.
    for (const gone of ['mode', 'signInUrl', 'providerSignedIn', 'deniedReason']) {
      expect(body).not.toHaveProperty(gone)
    }
  })

  test('on its own machine the sole member is recognised without a sign-in', async () => {
    const res = await makeApp({ syncBoundaryId: () => 'installation-1' }).request(
      'http://127.0.0.1:18787/auth/status',
      { headers: { 'x-podium-peer-address': '127.0.0.1' } },
    )
    expect(await res.json()).toMatchObject({
      needsAuth: false,
      authed: true,
      userId: admin,
      memberId: admin,
      syncBoundaryId: 'installation-1',
    })
  })

  test('needs a sign-in once a password is set, and recognises the signed-in member', async () => {
    await identity.credentials.setPassword(admin, PASSWORD)
    const app = makeApp()
    expect(await (await get(app, '/auth/status')).json()).toMatchObject({
      needsAuth: true,
      authed: false,
      // Exactly one account has a password: one password field, no address.
      prompt: 'password',
    })
    const login = await post(app, '/auth/login', { password: PASSWORD })
    const cookie = cookieOf(login)
    expect(await (await get(app, '/auth/status', { cookie: cookie ?? '' })).json()).toMatchObject({
      needsAuth: true,
      authed: true,
      userId: admin,
      memberId: admin,
    })
  })

  test('says that a signed-in caller is not a member of this workspace', async () => {
    const app = makeApp({
      memberOfRequest: stubMemberOfRequest(() => ({ kind: 'not-a-member', accountId: 'acct' })),
    })
    const body = await (await get(app, '/auth/status')).json()
    expect(body).toMatchObject({ authed: false, denied: 'not_workspace_member' })
    expect(body).not.toHaveProperty('userId')
  })

  test('carries readiness and recognises nobody while the control plane is not available', async () => {
    const readiness = {
      state: 'unconfigured',
      reason: 'setup_required',
      dataPlane: 'blocked',
    } as const
    const res = await makeApp({
      readiness: () => readiness,
      controlPlaneAvailable: () => false,
    }).request('http://127.0.0.1:18787/auth/status', {
      headers: { 'x-podium-peer-address': '127.0.0.1' },
    })
    expect(await res.json()).toMatchObject({ needsAuth: false, authed: false, readiness })
  })
})

describe('POST /auth/login', () => {
  test('an operator can sign in and be recognised while activation is pending [POD-2766]', async () => {
    // The boundary has to SERVE `/auth/login` while the data plane is blocked,
    // and the status route has to REPORT the resulting sign-in, or the login
    // screen loops against a server that already accepted the password.
    await identity.credentials.setPassword(admin, PASSWORD)
    const readiness = {
      state: 'activation_pending',
      reason: 'restart_required',
      dataPlane: 'blocked',
      controlPlane: 'available',
      stale: ['persistence'],
    } as const
    const app = new Hono()
    app.use(
      '/auth/*',
      authReadinessBoundary(() => readiness),
    )
    registerAuthRoute(app, {
      identity: identity.workspace,
      memberOfRequest: identity.memberOfRequest,
      memberOfAccount: (accountId) => store.users.findMemberByAccount(accountId),
      readiness: () => readiness,
      controlPlaneAvailable: () => true,
    })
    const login = await post(app, '/auth/login', { password: PASSWORD })
    expect(login.status).toBe(200)
    const status = await get(app, '/auth/status', { cookie: cookieOf(login) ?? '' })
    expect(await status.json()).toMatchObject({
      needsAuth: true,
      authed: true,
      userId: admin,
      readiness: { state: 'activation_pending', stale: ['persistence'] },
    })
  })

  test('an unconfigured instance still refuses login outright', async () => {
    await identity.credentials.setPassword(admin, PASSWORD)
    const app = new Hono()
    app.use(
      '/auth/*',
      authReadinessBoundary(() => ({
        state: 'unconfigured',
        reason: 'setup_required',
        dataPlane: 'blocked',
        controlPlane: 'blocked',
      })),
    )
    registerAuthRoute(app, {
      identity: identity.workspace,
      memberOfRequest: identity.memberOfRequest,
      memberOfAccount: (accountId) => store.users.findMemberByAccount(accountId),
    })
    expect((await post(app, '/auth/login', { password: PASSWORD })).status).toBe(503)
  })

  test('is a 400 when sign-in is not required: there is nothing to sign in to', async () => {
    const res = await post(makeApp(), '/auth/login', { password: 'anything' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'auth disabled' })
  })

  test('prepares a verified local browser cookie before sign-in becomes required', async () => {
    await identity.credentials.setPassword(admin, PASSWORD)
    let required = false
    const app = makeApp({
      identity: { ...identity.workspace, signInRequired: async () => required },
      isLocalRequest: (request) => new URL(request.url).hostname === 'localhost',
    })
    const login = (origin: string, body: Record<string, unknown>) =>
      app.request(`${origin}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-podium-peer-address': '127.0.0.1' },
        body: JSON.stringify(body),
      })
    const local = 'http://localhost'
    const prepared = { password: PASSWORD, prepareSignIn: true }
    expect((await login('https://remote.example', prepared)).status).toBe(400)
    expect((await login(local, { password: PASSWORD })).status).toBe(400)
    const native = await login(local, { ...prepared, delivery: 'native' })
    expect(await native.json()).toEqual({ error: 'auth disabled' })
    expect((await login(local, { ...prepared, password: 'wrong' })).status).toBe(401)
    const response = await login(local, prepared)
    expect(response.status).toBe(200)
    const cookie = cookieOf(response)
    expect(cookie).toBeTruthy()

    required = true
    const status = await app.request(`${local}/auth/status`, {
      headers: { cookie: cookie!, 'x-podium-peer-address': '127.0.0.1' },
    })
    expect(await status.json()).toMatchObject({ needsAuth: true, authed: true, memberId: admin })
  })

  test('the right password sets a Secure, HttpOnly, SameSite=Lax, host-only cookie over HTTPS', async () => {
    await identity.credentials.setPassword(admin, PASSWORD)
    const res = await post(makeApp({ syncBoundaryId: () => 'installation-1' }), '/auth/login', {
      password: PASSWORD,
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      userId: admin,
      memberId: admin,
      syncBoundaryId: 'installation-1',
    })
    const cookie = res.headers.getSetCookie().find((c) => c.includes('session_token')) ?? ''
    expect(cookie).toMatch(/^__Secure-podium\.session_token=/)
    expect(cookie).toMatch(/HttpOnly/i)
    expect(cookie).toMatch(/Secure/i)
    expect(cookie).toMatch(/SameSite=Lax/i)
    expect(cookie).not.toMatch(/Domain=/i)
    expect(res.headers.get('cache-control')).toBe('no-store')
    // Only the hash of the token is stored.
    const token = decodeURIComponent(cookie.split(';')[0]?.split('=')[1] ?? '').split('.')[0]
    expect(token).toBeTruthy()
    const signIns = await identity.workspace.listDeviceSignIns({ limit: 10 })
    expect(signIns.total).toBe(1)
    expect(JSON.stringify(signIns)).not.toContain(token)
  })

  test('on the same machine over plain HTTP the cookie is the loopback one, without Secure', async () => {
    await identity.credentials.setPassword(admin, PASSWORD)
    const res = await makeApp().request('http://127.0.0.1:18787/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-podium-peer-address': '127.0.0.1' },
      body: JSON.stringify({ password: PASSWORD }),
    })
    expect(res.status).toBe(200)
    const cookie = res.headers.getSetCookie().find((c) => c.includes('session_token')) ?? ''
    expect(cookie).toMatch(/^podium\.session_token=/)
    expect(cookie).not.toMatch(/;\s*Secure/i)
  })

  test('over plain HTTP from another machine nobody signs in', async () => {
    await identity.credentials.setPassword(admin, PASSWORD)
    const res = await makeApp().request('http://192.168.1.20:18787/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-podium-peer-address': '192.168.1.44' },
      body: JSON.stringify({ password: PASSWORD }),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'https_required' })
    expect(res.headers.getSetCookie()).toEqual([])
  })

  test('the wrong password is a 401 and sets no cookie', async () => {
    await identity.credentials.setPassword(admin, PASSWORD)
    const res = await post(makeApp(), '/auth/login', { password: 'not it' })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'invalid password' })
    expect(res.headers.getSetCookie()).toEqual([])
  })

  test('signs each person in as their own member, by their address', async () => {
    await identity.credentials.setPassword(admin, PASSWORD)
    await identity.credentials.setEmail(admin, 'alice@example.test')
    const bob = await identity.addMember({
      name: 'Bob',
      email: 'bob@example.test',
      password: 'bob password 1',
    })
    const app = makeApp()
    const asBob = await post(app, '/auth/login', {
      email: ' BOB@example.test ',
      password: 'bob password 1',
    })
    expect(await asBob.json()).toMatchObject({ ok: true, userId: bob, memberId: bob })
    // A body that names another member changes nothing: the field is not read.
    const naming = await post(app, '/auth/login', {
      email: 'bob@example.test',
      password: 'bob password 1',
      userId: admin,
      memberId: admin,
    })
    expect(await naming.json()).toMatchObject({ userId: bob, memberId: bob })
    // Bob's password with Alice's address signs nobody in.
    expect(
      (await post(app, '/auth/login', { email: 'alice@example.test', password: 'bob password 1' }))
        .status,
    ).toBe(401)
    expect((await post(app, '/auth/login', { email: 42, password: PASSWORD })).status).toBe(400)
  })

  test('a disabled member cannot sign in, and can again once enabled', async () => {
    await identity.credentials.setPassword(admin, PASSWORD)
    const bob = await identity.addMember({
      name: 'Bob',
      email: 'bob@example.test',
      password: 'bob password 1',
    })
    const app = makeApp()
    const login = () =>
      post(app, '/auth/login', { email: 'bob@example.test', password: 'bob password 1' })
    const before = await login()
    expect(before.status).toBe(200)
    const cookie = cookieOf(before) ?? ''
    await identity.workspace.memberships.disable({ actor: { memberId: admin }, memberId: bob })
    expect((await login()).status).toBe(401)
    expect(await (await get(app, '/auth/status', { cookie })).json()).toMatchObject({
      authed: false,
    })
    await identity.workspace.memberships.enable({ actor: { memberId: admin }, memberId: bob })
    expect((await login()).status).toBe(200)
    // Enabling does not bring the old sign-in back.
    expect(await (await get(app, '/auth/status', { cookie })).json()).toMatchObject({
      authed: false,
    })
  })

  test('eight wrong passwords for one address lock that address, and nobody else', async () => {
    await identity.credentials.setPassword(admin, PASSWORD)
    await identity.credentials.setEmail(admin, 'alice@example.test')
    await identity.addMember({ name: 'Bob', email: 'bob@example.test', password: 'bob password 1' })
    const app = makeApp()
    for (let i = 0; i < 8; i++) {
      const res = await post(app, '/auth/login', { email: 'bob@example.test', password: 'wrong' })
      expect(res.status).toBe(401)
    }
    const locked = await post(app, '/auth/login', {
      email: 'BOB@example.test',
      password: 'bob password 1',
    })
    expect(locked.status).toBe(429)
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0)
    const alice = await post(app, '/auth/login', {
      email: 'alice@example.test',
      password: PASSWORD,
    })
    expect(alice.status).toBe(200)
  })

  test('refuses a foreign Origin before anything is checked', async () => {
    await identity.credentials.setPassword(admin, PASSWORD)
    const app = makeApp()
    const foreign = await post(
      app,
      '/auth/login',
      { password: PASSWORD },
      { origin: 'https://evil.example' },
    )
    expect(foreign.status).toBe(403)
    expect(foreign.headers.getSetCookie()).toEqual([])
    const own = await post(app, '/auth/login', { password: PASSWORD }, { origin: ORIGIN })
    expect(own.status).toBe(200)
    const listed = await post(
      makeApp({ allowedOrigins: new Set(['https://app.example']) }),
      '/auth/login',
      { password: PASSWORD },
      { origin: 'https://app.example' },
    )
    expect(listed.status).toBe(200)
  })

  test('native delivery answers one signed bearer over HTTPS and sets no cookie', async () => {
    await identity.credentials.setPassword(admin, PASSWORD)
    const app = makeApp()
    const res = await post(app, '/auth/login', {
      password: PASSWORD,
      delivery: 'native',
      deviceId: 'phone-1',
      deviceName: 'My phone',
      platform: 'ios',
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { token: string; userId: string; delivery: string }
    expect(body).toMatchObject({ ok: true, delivery: 'native', userId: admin, memberId: admin })
    expect(body.token).toMatch(/\./)
    expect(res.headers.getSetCookie()).toEqual([])
    const status = await get(app, '/auth/status', { authorization: `Bearer ${body.token}` })
    expect(await status.json()).toMatchObject({ authed: true, userId: admin })
    const [signIn] = (await identity.workspace.listDeviceSignIns({ limit: 10 })).signIns
    expect(signIn).toMatchObject({ kind: 'phone', deviceName: 'My phone', platform: 'ios' })
  })

  test('a browser cannot opt into the bearer: a request with an Origin stays on the cookie', async () => {
    await identity.credentials.setPassword(admin, PASSWORD)
    const res = await post(
      makeApp(),
      '/auth/login',
      { password: PASSWORD, delivery: 'native', deviceId: 'd', deviceName: 'n', platform: 'ios' },
      { origin: ORIGIN },
    )
    expect(res.status).toBe(400)
    expect(JSON.stringify(await res.json())).not.toContain('token')
  })

  test('reports a successful sign-in to the observer, never a refused one, and survives a throwing one', async () => {
    await identity.credentials.setPassword(admin, PASSWORD)
    const seen: unknown[] = []
    const app = makeApp({ onLogin: (event) => void seen.push(event) })
    await post(app, '/auth/login', { password: 'wrong' })
    expect(seen).toEqual([])
    await post(app, '/auth/login', { password: PASSWORD })
    expect(seen).toEqual([{ userId: admin, delivery: 'cookie' }])
    const throwing = makeApp({
      onLogin: () => {
        throw new Error('observer broke')
      },
    })
    expect((await post(throwing, '/auth/login', { password: PASSWORD })).status).toBe(200)
  })

  test('the phone app signs in against the real route and its bearer resolves to its member', async () => {
    await identity.credentials.setPassword(admin, PASSWORD)
    await identity.credentials.setEmail(admin, 'admin@example.com')
    const app = makeApp()
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) =>
      app.request(url, {
        ...init,
        headers: { ...(init?.headers as Record<string, string>), 'x-podium-peer-address': peer() },
      }),
    )
    // The actual client, loaded at runtime so React Native's ambient globals
    // stay out of the server's compilation.
    const clientPath = '../../mobile/src/client/auth'
    const { login } = await import(clientPath)
    const result = await login(
      ORIGIN,
      PASSWORD,
      { id: 'phone', name: 'My phone' },
      ' ADMIN@example.com ',
    )
    expect(result).toMatchObject({ ok: true })
    const status = await get(app, '/auth/status', { authorization: `Bearer ${result.bearer}` })
    expect(await status.json()).toMatchObject({ authed: true, userId: admin })
    expect(
      await login(ORIGIN, PASSWORD, { id: 'phone', name: 'My phone' }, 'unknown@example.com'),
    ).toMatchObject({
      ok: false,
    })
  })
})

describe('POST /auth/logout', () => {
  test('ends that device and no other, clears its cookie, and reports which sign-in ended', async () => {
    await identity.credentials.setPassword(admin, PASSWORD)
    const ended: string[] = []
    const app = makeApp({ onDeviceSignInEnded: (id) => void ended.push(id) })
    const laptop = cookieOf(await post(app, '/auth/login', { password: PASSWORD })) ?? ''
    const desktop = cookieOf(await post(app, '/auth/login', { password: PASSWORD })) ?? ''
    const before = (await identity.workspace.listDeviceSignIns({ limit: 10 })).signIns
    expect(before).toHaveLength(2)

    const res = await post(app, '/auth/logout', {}, { cookie: laptop })
    expect(res.status).toBe(200)
    expect(res.headers.getSetCookie().join('\n')).toMatch(/session_token=;|Max-Age=0/i)
    const after = (await identity.workspace.listDeviceSignIns({ limit: 10 })).signIns
    expect(after).toHaveLength(1)
    expect(ended).toEqual(before.filter((s) => s.id !== after[0]?.id).map((s) => s.id))

    expect(await (await get(app, '/auth/status', { cookie: laptop })).json()).toMatchObject({
      authed: false,
    })
    expect(await (await get(app, '/auth/status', { cookie: desktop })).json()).toMatchObject({
      authed: true,
      userId: admin,
    })
  })

  test('refuses a foreign Origin and ends nothing', async () => {
    await identity.credentials.setPassword(admin, PASSWORD)
    const app = makeApp()
    const cookie = cookieOf(await post(app, '/auth/login', { password: PASSWORD })) ?? ''
    const res = await post(app, '/auth/logout', {}, { cookie, origin: 'https://evil.example' })
    expect(res.status).toBe(403)
    expect(await (await get(app, '/auth/status', { cookie })).json()).toMatchObject({
      authed: true,
    })
  })

  test('without a sign-in it ends nothing and still answers ok', async () => {
    const ended: string[] = []
    const app = makeApp({ onDeviceSignInEnded: (id) => void ended.push(id) })
    expect((await post(app, '/auth/logout', {})).status).toBe(200)
    expect(ended).toEqual([])
  })
})

describe('the server-transfer claim (old client sessions, until POD-6748)', () => {
  test('is exchanged once and refuses a replay and an open redirect', async () => {
    const claim = 'transfer-claim-token-abcdefghijklmnopqrstuvwxyz'
    await store.auth.createClientSession(
      hashToken(claim),
      admin,
      new Date(Date.now() + 60_000).toISOString(),
      'server-transfer-claim',
    )
    const app = makeApp()
    const exchange = (next: string) =>
      app.request(`${ORIGIN}/auth/server-transfer-claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: claim, next }).toString(),
      })
    const response = await exchange('/issues?moved=1')
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/issues?moved=1')
    expect(await store.auth.getClientSession(hashToken(claim))).toBeUndefined()
    const replay = await exchange('//attacker.example')
    expect(replay.headers.get('location')).toBe('/?serverTransferClaim=invalid')
    expect(replay.headers.get('set-cookie')).toBeNull()
  })
})

test('direct member creation is retired in favor of invite-and-claim', async () => {
  const response = await post(makeApp(), '/auth/users', {
    userId: 'chosen-id',
    displayName: 'Chosen',
    role: 'admin',
    password: 'password123',
  })
  expect(response.status).toBe(410)
  expect(await store.users.get(asUserId('chosen-id'))).toBeUndefined()
})

describe('clientAuthGuard', () => {
  function guarded(memberOfRequest = identity.memberOfRequest, renew = identity.workspace.renew) {
    const app = new Hono()
    app.use('/trpc/*', clientAuthGuard({ memberOfRequest, renew }))
    app.all('/trpc/ping', (c) => c.json({ pong: true }))
    return app
  }
  const ping = (app: Hono, headers: Record<string, string> = {}, method = 'GET') =>
    app.request(`${ORIGIN}/trpc/ping`, {
      method,
      headers: { 'x-podium-peer-address': peer(), ...headers },
    })

  test('answers 401 without a sign-in and continues with a valid one', async () => {
    await identity.credentials.setPassword(admin, PASSWORD)
    const app = guarded()
    const refused = await ping(app)
    expect(refused.status).toBe(401)
    expect(await refused.json()).toEqual({ error: 'unauthorized' })
    const cookie = cookieOf(await post(makeApp(), '/auth/login', { password: PASSWORD })) ?? ''
    const served = await ping(app, { cookie })
    expect(served.status).toBe(200)
    // No renewal is due on a fresh sign-in, so no cookie is set again.
    expect(served.headers.getSetCookie()).toEqual([])
  })

  test('a forged or unsigned cookie signs nobody in', async () => {
    await identity.credentials.setPassword(admin, PASSWORD)
    const cookie = cookieOf(await post(makeApp(), '/auth/login', { password: PASSWORD })) ?? ''
    const [name, value] = cookie.split('=') as [string, string]
    const token = decodeURIComponent(value).split('.')[0]
    const app = guarded()
    for (const forged of [`${name}=${token}`, `${name}=${token}.AAAA`, `${name}=nonsense`]) {
      expect((await ping(app, { cookie: forged })).status).toBe(401)
    }
    // The cookie of the removed hand-written sign-in is not read at all.
    expect((await ping(app, { cookie: `podium_session=${token}` })).status).toBe(401)
  })

  test('answers 403 for a signed-in caller who is not a member, and 400 over plain HTTP', async () => {
    const notMember = guarded(
      stubMemberOfRequest(() => ({ kind: 'not-a-member', accountId: 'acct' })),
    )
    const refused = await ping(notMember)
    expect(refused.status).toBe(403)
    expect(await refused.json()).toEqual({ error: 'not_workspace_member' })
    const plain = await guarded().request('http://192.168.1.20:18787/trpc/ping', {
      headers: { 'x-podium-peer-address': '192.168.1.44', authorization: 'Bearer secret' },
    })
    expect(plain.status).toBe(400)
    expect(await plain.json()).toEqual({ error: 'https_required' })
  })

  test('lets a CORS preflight through without a sign-in', async () => {
    await identity.credentials.setPassword(admin, PASSWORD)
    expect((await ping(guarded(), {}, 'OPTIONS')).status).toBe(200)
  })

  test('refuses a client opened for another member, with the fence code', async () => {
    const app = guarded(stubMemberOfRequest(() => memberResolution('mem_alice', 'admin')))
    expect((await ping(app, { [MEMBER_FENCE_HEADER]: 'mem_alice' })).status).toBe(200)
    const refused = await ping(app, { [MEMBER_FENCE_HEADER]: 'mem_bob' })
    expect(refused.status).toBe(401)
    expect(await refused.json()).toMatchObject({ code: MEMBER_FENCE_REFUSAL })
  })

  test('renews a sign-in that is due and adds its cookie to the response; never otherwise', async () => {
    const renew = vi.fn(async () => {
      const headers = new Headers()
      headers.append('set-cookie', '__Secure-podium.session_token=renewed; Path=/; HttpOnly')
      return headers
    })
    const due = guarded(
      stubMemberOfRequest(() => ({ ...memberResolution('mem_alice', 'admin'), renewDue: true })),
      renew,
    )
    const res = await ping(due)
    expect(res.status).toBe(200)
    expect(res.headers.getSetCookie()).toEqual([
      '__Secure-podium.session_token=renewed; Path=/; HttpOnly',
    ])
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(renew).toHaveBeenCalledTimes(1)

    renew.mockClear()
    const notDue = guarded(
      stubMemberOfRequest(() => memberResolution('mem_alice', 'admin')),
      renew,
    )
    expect((await ping(notDue)).headers.getSetCookie()).toEqual([])
    expect(renew).not.toHaveBeenCalled()
  })
})
