import { createHash } from 'node:crypto'
import { FIRST_ADMIN_USER_ID } from '@podium/model'
import { decodePairingEnvelope } from '@podium/protocol'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { hashToken, resolveClientCredential } from './auth-route'
import { MobilePairingManager } from './mobile-pairing'
import {
  clientAddressForRequest,
  PairingFailureThrottle,
  registerMobilePairingRoutes,
} from './mobile-pairing-route'
import { AuthRepository } from './store/auth'
import { createBunStoreExecutor } from './store/executor'
import { openMigratedTestDatabase } from './test-support/migrated-database'

const AUTH_TOKEN = 'browser-session-token-abcdefghijklmnopqrstuvwxyz'
const SECRET = Buffer.alloc(32, 11)
const CLAIM_HASH = createHash('sha256').update(SECRET).digest('hex')
const HTTPS = {
  'content-type': 'application/json',
  'x-forwarded-for': '198.51.100.10',
  'x-forwarded-proto': 'https',
}

let store: AuthRepository
let pairing: MobilePairingManager
let app: Hono
let peerAddress: string

function authHeaders() {
  return { ...HTTPS, cookie: `podium_session=${AUTH_TOKEN}` }
}

async function post(path: string, body: unknown, headers: Record<string, string> = HTTPS) {
  return app.request(path, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

beforeEach(async () => {
  const stage = createBunStoreExecutor({ database: openMigratedTestDatabase() }).syncQueries
  if (!stage) throw new Error('the test database is not bun-backed')
  store = new AuthRepository(stage)
  await store.createClientSession(
    hashToken(AUTH_TOKEN),
    FIRST_ADMIN_USER_ID,
    '2999-01-01T00:00:00.000Z',
  )
  pairing = new MobilePairingManager()
  peerAddress = '198.51.100.10'
  app = new Hono()
  registerMobilePairingRoutes(app, {
    store,
    pairing,
    serverIdentity: () => ({
      publicUrl: 'https://podium.example',
      instanceId: 'instance-one',
    }),
    loginRequired: () => true,
    resolveUserId: (headers) => resolveClientCredential(store, headers)?.session.userId,
    trustedProxyHops: 1,
    requestPeerAddress: () => peerAddress,
  })
})

describe('mobile pairing routes', () => {
  it('runs the native start/claim/status/approve/complete ceremony', async () => {
    const start = await post('/auth/mobile-pair/start', {}, authHeaders())
    expect(start.status).toBe(200)
    const started = (await start.json()) as {
      pairingId: string
      envelope: string
      pairingUrl: string
      canonicalOrigin: string
    }
    const envelope = decodePairingEnvelope(started.envelope)
    expect(envelope).toMatchObject({
      v: 2,
      kind: 'mobile-client',
      mode: 'pair',
      serverUrl: 'https://podium.example',
      instanceId: 'instance-one',
    })
    expect(started).toMatchObject({ canonicalOrigin: 'https://podium.example' })
    if (envelope.v !== 2 || envelope.mode !== 'pair') throw new Error('wrong envelope')

    const claim = await post('/auth/mobile-pair/claim', {
      pairCode: envelope.pairCode,
      claimHash: CLAIM_HASH,
      deviceId: 'device-1',
      deviceName: "Sam's iPhone",
      platform: 'ios',
      delivery: 'browser',
    })
    expect(claim.status).toBe(200)
    const claimed = (await claim.json()) as {
      claimId: string
      phrase: string[]
    }
    expect(claimed.phrase).toHaveLength(3)

    const status = await post(
      '/auth/mobile-pair/status',
      { pairingId: started.pairingId },
      authHeaders(),
    )
    expect(await status.json()).toMatchObject({
      state: 'claimed',
      deviceName: "Sam's iPhone",
      phrase: claimed.phrase,
    })
    expect(
      (
        await post('/auth/mobile-pair/complete', {
          claimId: claimed.claimId,
          claimSecret: SECRET.toString('base64url'),
        })
      ).status,
    ).toBe(202)
    expect(
      (await post('/auth/mobile-pair/approve', { pairingId: started.pairingId }, authHeaders()))
        .status,
    ).toBe(200)
    const complete = await post('/auth/mobile-pair/complete', {
      claimId: claimed.claimId,
      claimSecret: SECRET.toString('base64url'),
    })
    const completed = (await complete.json()) as {
      token: string
      delivery: string
    }
    expect(completed).toMatchObject({ delivery: 'native' })
    expect(completed.token).toBeTruthy()
    expect(await store.getClientSession(hashToken(completed.token))).toMatchObject({
      userId: FIRST_ADMIN_USER_ID,
      label: 'mobile',
      sessionId: expect.any(String),
      deviceId: 'device-1',
      deviceName: "Sam's iPhone",
      platform: 'ios',
    })
  })

  it('returns URL-only open mode without creating a grant or session', async () => {
    app = new Hono()
    registerMobilePairingRoutes(app, {
      store,
      pairing,
      serverIdentity: () => ({
        publicUrl: 'http://podium.lan:18787',
        instanceId: 'open-one',
      }),
      loginRequired: () => false,
      resolveUserId: () => undefined,
      requestPeerAddress: () => peerAddress,
    })
    const response = await post(
      '/auth/mobile-pair/start',
      {},
      { 'content-type': 'application/json' },
    )
    expect(await response.json()).toMatchObject({
      mode: 'open',
      instanceId: 'open-one',
      canonicalOrigin: 'http://podium.lan:18787',
      mobileUrl: 'http://podium.lan:18787/mobile',
      transport: { grade: 'insecure' },
    })
    expect(await store.listMobileClientSessions(FIRST_ADMIN_USER_ID)).toHaveLength(0)
  })

  it('delivers browser completion only as the existing HttpOnly session cookie', async () => {
    const started = (await (await post('/auth/mobile-pair/start', {}, authHeaders())).json()) as {
      pairingId: string
      envelope: string
    }
    const envelope = decodePairingEnvelope(started.envelope)
    if (envelope.v !== 2 || envelope.mode !== 'pair') throw new Error('wrong envelope')
    const claimed = (await (
      await post(
        '/auth/mobile-pair/claim',
        {
          pairCode: envelope.pairCode,
          claimHash: CLAIM_HASH,
          deviceId: 'browser-1',
          deviceName: 'Mobile Safari',
          platform: 'ios',
          delivery: 'native',
        },
        { ...HTTPS, origin: 'https://podium.example' },
      )
    ).json()) as { claimId: string }
    await post('/auth/mobile-pair/approve', { pairingId: started.pairingId }, authHeaders())
    const response = await post('/auth/mobile-pair/complete', {
      claimId: claimed.claimId,
      claimSecret: SECRET.toString('base64url'),
    })
    const body = (await response.json()) as Record<string, unknown>
    expect(body).toMatchObject({ status: 'complete', delivery: 'browser' })
    expect(body).not.toHaveProperty('token')
    expect(response.headers.get('set-cookie')).toMatch(/podium_session=.*HttpOnly.*Secure/i)
  })

  it('requires HTTPS and returns one uniform refusal for malformed, unknown, and used grants', async () => {
    expect(
      (
        await app.request('/auth/mobile-pair/claim', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(400)
    const malformed = await post('/auth/mobile-pair/claim', {})
    const unknown = await post('/auth/mobile-pair/claim', {
      pairCode: 'abcdefghijklmnopqrstuvwxyz012345',
      claimHash: CLAIM_HASH,
      deviceId: 'device-1',
      deviceName: 'Phone',
      platform: 'ios',
    })
    expect(await malformed.json()).toEqual({ error: 'pairing unavailable' })
    expect(await unknown.json()).toEqual({ error: 'pairing unavailable' })
  })

  it('throttles pairing failures in its own bucket', async () => {
    app = new Hono()
    registerMobilePairingRoutes(app, {
      store,
      pairing,
      serverIdentity: () => ({
        publicUrl: 'https://podium.example',
        instanceId: 'one',
      }),
      loginRequired: () => true,
      resolveUserId: () => undefined,
      trustedProxyHops: 1,
      requestPeerAddress: () => peerAddress,
      throttle: { maxFailures: 1, lockoutMs: 60_000 },
    })
    expect((await post('/auth/mobile-pair/claim', {})).status).toBe(400)
    const locked = await post('/auth/mobile-pair/claim', {})
    expect(locked.status).toBe(429)
    expect(locked.headers.get('retry-after')).toBeTruthy()
  })

  it('uses real TLS by default and ignores a forged forwarded protocol', async () => {
    app = new Hono()
    registerMobilePairingRoutes(app, {
      store,
      pairing,
      serverIdentity: () => ({ publicUrl: 'https://podium.example', instanceId: 'one' }),
      loginRequired: () => true,
      resolveUserId: () => undefined,
      requestPeerAddress: () => peerAddress,
    })
    const forged = await post('/auth/mobile-pair/claim', {}, HTTPS)
    expect(await forged.json()).toEqual({ error: 'secure HTTPS is required' })
    const remoteStart = await post('/auth/mobile-pair/start', {}, authHeaders())
    expect(await remoteStart.json()).toEqual({
      error: 'secure HTTPS is required for mobile pairing',
    })
    const directTls = await app.request('https://podium.example/auth/mobile-pair/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(await directTls.json()).toEqual({ error: 'pairing unavailable' })
  })

  it('allows a verified loopback controller while phone traffic remains HTTPS-only', async () => {
    app = new Hono()
    registerMobilePairingRoutes(app, {
      store,
      pairing,
      serverIdentity: () => ({ publicUrl: 'https://podium.example.ts.net', instanceId: 'one' }),
      loginRequired: () => true,
      resolveUserId: (headers) => resolveClientCredential(store, headers)?.session.userId,
      trustedProxyHops: 1,
      localControlRequest: (request) => request.headers.get('x-test-local') === 'yes',
      requestPeerAddress: () => peerAddress,
    })
    const localHeaders = {
      'content-type': 'application/json',
      cookie: `podium_session=${AUTH_TOKEN}`,
      'x-test-local': 'yes',
    }
    const start = await post('/auth/mobile-pair/start', {}, localHeaders)
    expect(start.status).toBe(200)
    const started = (await start.json()) as { pairingId: string; envelope: string }
    const envelope = decodePairingEnvelope(started.envelope)
    if (envelope.v !== 2 || envelope.mode !== 'pair') throw new Error('wrong envelope')

    const insecureClaim = await post(
      '/auth/mobile-pair/claim',
      {
        pairCode: envelope.pairCode,
        claimHash: CLAIM_HASH,
        deviceId: 'phone',
        deviceName: 'Phone',
        platform: 'ios',
      },
      { 'content-type': 'application/json', 'x-test-local': 'yes' },
    )
    expect(insecureClaim.status).toBe(400)

    const claim = await post(
      '/auth/mobile-pair/claim',
      {
        pairCode: envelope.pairCode,
        claimHash: CLAIM_HASH,
        deviceId: 'phone',
        deviceName: 'Phone',
        platform: 'ios',
      },
      {
        'content-type': 'application/json',
        'x-forwarded-for': '100.64.0.2',
        'x-forwarded-host': 'podium.example.ts.net',
        'x-forwarded-proto': 'https',
      },
    )
    expect(claim.status).toBe(200)
    expect(
      (await post('/auth/mobile-pair/status', { pairingId: started.pairingId }, localHeaders))
        .status,
    ).toBe(200)
    expect(
      (await post('/auth/mobile-pair/approve', { pairingId: started.pairingId }, localHeaders))
        .status,
    ).toBe(200)
  })

  it('keys failures on the socket peer unless proxy trust is explicitly configured', async () => {
    app = new Hono()
    registerMobilePairingRoutes(app, {
      store,
      pairing,
      serverIdentity: () => ({ publicUrl: 'https://podium.example', instanceId: 'one' }),
      loginRequired: () => true,
      resolveUserId: () => undefined,
      requestPeerAddress: () => peerAddress,
      throttle: { maxFailures: 1, lockoutMs: 60_000 },
    })
    const headers = {
      'content-type': 'application/json',
      'x-forwarded-for': '203.0.113.1',
      'x-forwarded-proto': 'https',
      'x-real-ip': '203.0.113.2',
    }
    expect(
      (
        await app.request('https://podium.example/auth/mobile-pair/claim', {
          method: 'POST',
          headers,
          body: '{}',
        })
      ).status,
    ).toBe(400)
    peerAddress = '198.51.100.11'
    expect(
      (
        await app.request('https://podium.example/auth/mobile-pair/claim', {
          method: 'POST',
          headers: { ...headers, 'x-real-ip': '203.0.113.99' },
          body: '{}',
        })
      ).status,
    ).toBe(400)
    peerAddress = '198.51.100.10'
    expect(
      (
        await app.request('https://podium.example/auth/mobile-pair/claim', {
          method: 'POST',
          headers: { ...headers, 'x-forwarded-for': '203.0.113.200' },
          body: '{}',
        })
      ).status,
    ).toBe(429)
  })

  it('does not charge unavailable completion polls against the peer throttle', async () => {
    app = new Hono()
    registerMobilePairingRoutes(app, {
      store,
      pairing,
      serverIdentity: () => ({ publicUrl: 'https://podium.example', instanceId: 'one' }),
      loginRequired: () => true,
      resolveUserId: () => undefined,
      trustedProxyHops: 1,
      requestPeerAddress: () => peerAddress,
      throttle: { maxFailures: 1, lockoutMs: 60_000 },
    })
    const body = {
      claimId: 'expired-or-restarted-claim',
      claimSecret: SECRET.toString('base64url'),
    }
    expect((await post('/auth/mobile-pair/complete', body)).status).toBe(400)
    expect((await post('/auth/mobile-pair/complete', body)).status).toBe(400)
  })

  it('lists and remotely revokes only the caller-owned mobile row', async () => {
    await store.createClientSession(
      'a'.repeat(64),
      FIRST_ADMIN_USER_ID,
      '2999-01-01T00:00:00.000Z',
      'mobile',
      {
        sessionId: 'mobile-session-aaaaaaaa',
        deviceId: 'phone',
        deviceName: 'Phone',
        platform: 'ios',
      },
    )
    await store.createClientSession(
      'b'.repeat(64),
      FIRST_ADMIN_USER_ID,
      '2999-01-01T00:00:00.000Z',
      'break-glass',
    )
    const listed = await app.request('/auth/client-sessions', {
      headers: authHeaders(),
    })
    const sessions = ((await listed.json()) as { sessions: { sessionId: string }[] }).sessions
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.sessionId).toBe('mobile-session-aaaaaaaa')
    expect(sessions[0]?.sessionId).not.toBe('a'.repeat(64))
    expect(
      (
        await post(
          '/auth/client-sessions/revoke',
          { sessionId: 'mobile-session-aaaaaaaa' },
          authHeaders(),
        )
      ).status,
    ).toBe(200)
    expect(await store.getClientSession('a'.repeat(64))).toBeUndefined()
    expect((await store.getClientSession('b'.repeat(64)))?.label).toBe('break-glass')
  })
})

describe('pairing throttle primitives', () => {
  it('takes the trusted address from the right side of an appending proxy chain', () => {
    const request = new Request('http://podium.test', {
      headers: { 'x-forwarded-for': 'spoofed, 198.51.100.20' },
    })
    expect(clientAddressForRequest(request, '127.0.0.1', 0)).toBe('127.0.0.1')
    expect(clientAddressForRequest(request, '127.0.0.1', 1)).toBe('198.51.100.20')
    expect(clientAddressForRequest(request, '127.0.0.1', 2)).toBe('spoofed')
  })

  it('bounds and expires peer buckets', () => {
    const throttle = new PairingFailureThrottle({
      maxFailures: 2,
      lockoutMs: 50,
      retentionMs: 50,
      maxEntries: 2,
    })
    throttle.fail('one', 0)
    throttle.fail('two', 1)
    throttle.fail('three', 2)
    expect(throttle.size).toBe(2)
    for (let operation = 0; operation < 61; operation += 1) {
      throttle.retryAfter('missing', 100)
    }
    expect(throttle.size).toBe(0)
    throttle.fail('fresh', 100)
    expect(throttle.size).toBe(1)
  })
})
