import { httpsRequiredRefusal } from '@podium/protocol'
import { Hono } from 'hono'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { clientAuthGuard, registerAuthRoute } from './auth-route'
import { httpsSignInWarning, registerHttpsRequiredPage } from './https-required'
import { createMemberOfRequest } from './identity/member-of-request'
import type { SessionStore } from './store'
import { openTestStore } from './test-support/open-test-store'
import { openTestIdentity, type TestIdentity } from './test-support/test-identity'

let store: SessionStore
let identity: TestIdentity
beforeEach(async () => {
  store = await openTestStore(':memory:')
  identity = await openTestIdentity(store)
})
afterEach(async () => {
  await store.close()
})

function appFor(publicUrl?: string, trustedProxyHops = 0) {
  const app = new Hono()
  const memberOfRequest = createMemberOfRequest({
    identity: identity.workspace,
    users: store.users,
    trustedProxyHops,
    publicUrl: () => publicUrl,
  })
  registerAuthRoute(app, {
    identity: identity.workspace,
    memberOfRequest,
    publicUrl: () => publicUrl,
    memberOfAccount: (id) => store.users.findMemberByAccount(id),
  })
  app.use('/trpc/*', clientAuthGuard({ memberOfRequest, renew: identity.workspace.renew }))
  app.get('/trpc/ping', (c) => c.json({ ok: true }))
  registerHttpsRequiredPage(app, memberOfRequest)
  app.get('*', (c) => c.html('<h1>Normal sign-in</h1>'))
  return app
}

test('remote browser navigation receives an HTML page with the configured HTTPS destination', async () => {
  const app = appFor('https://podium.example')
  for (const path of ['/', '/desktop', '/mobile', '/sessions/a']) {
    const response = await app.request(`http://192.0.2.8:18787${path}`, {
      headers: { 'x-podium-peer-address': '192.0.2.9', accept: 'text/html' },
    })
    expect(response.status).toBe(400)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = await response.text()
    expect(body).toContain('HTTPS for sign-in from other computers')
    expect(body).toContain('href="https://podium.example"')
    expect(body).toContain('#https-for-sign-in')
    expect(body).not.toContain('<form')
  }
})

test('a missing or HTTP public address offers admin instructions without guessing an HTTPS link', async () => {
  for (const publicUrl of [undefined, 'http://192.0.2.8:18787']) {
    const response = await appFor(publicUrl).request('http://192.0.2.8:18787/', {
      headers: { 'x-podium-peer-address': '192.0.2.9' },
    })
    const body = await response.text()
    expect(body).toContain('Ask the server admin')
    expect(body).toContain('podium setup')
    expect(body).not.toContain('Open HTTPS address')
    expect(body).not.toContain('https://192.0.2.8')
  }
})

test.each([
  'localhost',
  '127.0.0.1',
  '[::1]',
])('HTTP %s stays on the normal page and signed-in API', async (host) => {
  const app = appFor('https://podium.example')
  const headers = { 'x-podium-peer-address': host === '[::1]' ? '::1' : '127.0.0.1' }
  const page = await app.request(`http://${host}:18787/`, { headers })
  expect(page.status).toBe(200)
  expect(await page.text()).toBe('<h1>Normal sign-in</h1>')
  const status = await app.request(`http://${host}:18787/auth/status`, { headers })
  expect(status.status).toBe(200)
  expect(await status.json()).toMatchObject({ authed: true })
})

test('status, password and data API refusals carry the same message and known address', async () => {
  const app = appFor('https://podium.example')
  for (const path of ['/auth/status', '/auth/login', '/trpc/ping']) {
    const response = await app.request(`http://192.0.2.8:18787${path}`, {
      method: path.endsWith('login') ? 'POST' : 'GET',
      headers: { 'x-podium-peer-address': '192.0.2.9' },
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual(httpsRequiredRefusal('https://podium.example'))
  }
})

test('HTTPS and a trusted HTTPS proxy keep the normal page', async () => {
  for (const [url, trustedProxyHops, forwardedProto] of [
    ['https://podium.example/', 0, 'http'],
    ['http://localhost:18787/', 1, 'https'],
  ] as const) {
    const response = await appFor('https://podium.example', trustedProxyHops).request(url, {
      headers: { 'x-podium-peer-address': '127.0.0.1', 'x-forwarded-proto': forwardedProto },
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('Normal sign-in')
  }
})

test('startup warning names the effect and setup command only for exposed HTTP', () => {
  const opts = { loopback: false, tls: false, trustedProxyHops: 0 }
  expect(httpsSignInWarning(opts)).toMatch(/other computers.*sign in.*HTTPS.*podium setup/)
  expect(httpsSignInWarning(opts)).not.toContain('\n')
  expect(httpsSignInWarning({ ...opts, loopback: true })).toBeUndefined()
  expect(httpsSignInWarning({ ...opts, tls: true })).toBeUndefined()
  expect(
    httpsSignInWarning({ ...opts, trustedProxyHops: 1, publicUrl: 'https://podium.example' }),
  ).toBeUndefined()
  expect(httpsSignInWarning({ ...opts, publicUrl: 'https://podium.example' })).toBeDefined()
})
