import { createHash } from 'node:crypto'
import { claimMobilePairing, pollMobilePairing } from '@podium/client-core/accounts/pairing'
import { firstAdminMemberId } from '@podium/model'
import { decodePairingEnvelope, mobilePairingPhraseFromDigest } from '@podium/protocol'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemberOfRequest } from './identity/member-of-request'
import { PairingFailureThrottle, registerMobilePairingRoutes } from './mobile-pairing-route'
import { clientAddressForRequest } from './request-scheme'
import { registerSignInRoutes } from './sign-in-routes'
import type { SessionStore } from './store'
import { openTestStore } from './test-support/open-test-store'
import { cookieOf, openTestIdentity, type TestIdentity } from './test-support/test-identity'

const INSTALLATION_ID = `pdm_${'a'.repeat(43)}`
const INSTALLATION_KEY = `ed25519:${'B'.repeat(43)}`
const SECRET = Buffer.alloc(32, 11)
const CLAIM_HASH = createHash('sha256').update(SECRET).digest('hex')
const HTTPS = {
  'content-type': 'application/json',
  'x-forwarded-for': '198.51.100.10',
  'x-forwarded-proto': 'https',
}

const PASSWORD = 'pairing test password'
let store: SessionStore
let identity: TestIdentity
let accountId: string
let browserCookie: string
let app: Hono
let peerAddress: string

function authHeaders() {
  return { ...HTTPS, cookie: browserCookie }
}

async function post(path: string, body: unknown, headers: Record<string, string> = HTTPS) {
  return app.request(path, {
    method: 'POST',
    headers: { 'x-podium-peer-address': peerAddress, ...headers },
    body: JSON.stringify(body),
  })
}

function mount(
  opts: {
    publicUrl?: string
    instanceId?: string
    trustedProxyHops?: number
    maxFailures?: number
  } = {},
) {
  app = new Hono()
  const memberOfRequest = createMemberOfRequest({
    identity: identity.workspace,
    users: store.users,
    trustedProxyHops: opts.trustedProxyHops ?? 1,
  })
  registerMobilePairingRoutes(app, {
    identity: identity.workspace,
    memberOfRequest,
    memberOfAccount: (id) => store.users.findMemberByAccount(id),
    allowedOrigins: new Set(['https://podium.example']),
    serverIdentity: () => ({
      publicUrl: opts.publicUrl ?? 'https://podium.example',
      instanceId: opts.instanceId ?? 'instance-one',
      installationId: INSTALLATION_ID,
      installationPublicKey: INSTALLATION_KEY,
    }),
    throttle: { maxFailures: opts.maxFailures },
  })
  registerSignInRoutes(app, {
    identity: identity.workspace,
    memberOfRequest,
    audit: store.settingsAudit,
  })
}

beforeEach(async () => {
  store = await openTestStore(':memory:')
  identity = await openTestIdentity(store)
  accountId = (await identity.workspace.memberships.list())[0]!.account!.id
  await identity.credentials.setPassword(firstAdminMemberId(), PASSWORD)
  browserCookie = cookieOf(await identity.signIn({ password: PASSWORD }))
  peerAddress = '198.51.100.10'
  mount()
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await store.close()
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
      installationId: INSTALLATION_ID,
      installationPublicKey: INSTALLATION_KEY,
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
    expect(claimed.phrase).toEqual(
      mobilePairingPhraseFromDigest(
        createHash('sha256')
          .update(`podium-mobile-phrase\0${claimed.claimId}\0${CLAIM_HASH}`)
          .digest(),
      ),
    )

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
    expect(completed.token).toMatch(/^[^.]+\.[A-Za-z0-9+/]+=*$/)
    const caller = await identity.memberOfRequest(
      new Request('https://podium.example/auth/status', {
        headers: { authorization: `Bearer ${completed.token}` },
      }),
    )
    expect(caller).toMatchObject({
      kind: 'member',
      memberId: firstAdminMemberId(),
      deviceSignIn: { kind: 'phone' },
    })
    expect(await identity.workspace.core.deviceSignIns.listForAccount(accountId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'phone', deviceName: "Sam's iPhone", platform: 'ios' }),
      ]),
    )
  })

  it('returns URL-only open mode without creating a grant or session', async () => {
    const openIdentity = {
      ...identity.workspace,
      signInRequired: async () => false,
    }
    identity = { ...identity, workspace: openIdentity }
    mount({ publicUrl: 'http://podium.lan:18787', instanceId: 'open-one', trustedProxyHops: 0 })
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
    expect(
      (await identity.workspace.core.deviceSignIns.listForAccount(accountId)).map((s) => s.kind),
    ).toEqual(['browser'])
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
    expect(response.headers.get('set-cookie')).toMatch(
      /__Secure-podium\.session_token=.*HttpOnly.*Secure/i,
    )
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
    mount({ maxFailures: 1 })
    expect((await post('/auth/mobile-pair/claim', {})).status).toBe(400)
    const locked = await post('/auth/mobile-pair/claim', {})
    expect(locked.status).toBe(429)
    expect(locked.headers.get('retry-after')).toBeTruthy()
  })

  it('uses real TLS by default and ignores a forged forwarded protocol', async () => {
    mount({ trustedProxyHops: 0 })
    const forged = await post('/auth/mobile-pair/claim', {}, HTTPS)
    expect(await forged.json()).toEqual({ error: 'secure HTTPS is required' })
    const remoteStart = await post('/auth/mobile-pair/start', {}, authHeaders())
    expect(await remoteStart.json()).toEqual({
      error: 'secure HTTPS is required for mobile pairing',
    })
    const directTls = await app.request('https://podium.example/auth/mobile-pair/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-podium-peer-address': peerAddress },
      body: '{}',
    })
    expect(await directTls.json()).toEqual({ error: 'pairing unavailable' })
  })

  it('allows a verified loopback controller while phone traffic remains HTTPS-only', async () => {
    mount({ publicUrl: 'https://podium.example.ts.net' })
    const localHeaders = {
      'content-type': 'application/json',
      cookie: cookieOf(
        await identity.signIn(
          { password: PASSWORD },
          {
            scheme: 'http',
            sameMachine: true,
            clientAddress: '127.0.0.1',
          },
        ),
      ),
      'x-podium-peer-address': '127.0.0.1',
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
      { 'content-type': 'application/json', 'x-podium-peer-address': '127.0.0.1' },
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

  it('keys failures on the socket peer, whatever forwarding headers it sends', async () => {
    mount({ trustedProxyHops: 0, maxFailures: 1 })
    const claim = (headers: Record<string, string>) =>
      app.request('https://podium.example/auth/mobile-pair/claim', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: '{}',
      })
    // Podium ends TLS and no hop is trusted: forwarding headers are the client's
    // own word and cannot buy it a fresh budget (POD-6754 F1, review).
    const spoofing = (forwardedFor: string) => ({
      'x-forwarded-for': forwardedFor,
      'x-forwarded-proto': 'https',
      'x-real-ip': forwardedFor,
      'x-podium-peer-address': '198.51.100.10',
    })
    expect((await claim(spoofing('203.0.113.1'))).status).toBe(400)
    expect((await claim(spoofing('203.0.113.200'))).status).toBe(429)
    // Another peer is another client.
    expect((await claim({ 'x-podium-peer-address': '198.51.100.11' })).status).toBe(400)
  })

  it('does not charge unavailable completion polls against the peer throttle', async () => {
    mount({ maxFailures: 1 })
    const body = {
      claimId: 'expired-or-restarted-claim',
      claimSecret: SECRET.toString('base64url'),
    }
    expect((await post('/auth/mobile-pair/complete', body)).status).toBe(400)
    expect((await post('/auth/mobile-pair/complete', body)).status).toBe(400)
  })

  it('pairs through the phone client transport, survives route remount, and expires or refuses replay', async () => {
    const started = await (await post('/auth/mobile-pair/start', {}, authHeaders())).json()
    const envelope = decodePairingEnvelope(started.envelope)
    if (envelope.v !== 2 || envelope.mode !== 'pair') throw new Error('wrong envelope')
    vi.stubGlobal('fetch', (url: string, init: RequestInit) =>
      app.request(url, {
        ...init,
        headers: {
          ...init.headers,
          'x-podium-peer-address': peerAddress,
          'x-forwarded-for': peerAddress,
        },
      }),
    )
    const phone = await claimMobilePairing(envelope, 'test-phone', 'My iPhone', 'ios')
    await expect(
      claimMobilePairing(envelope, 'another-phone', 'Another iPhone', 'ios'),
    ).rejects.toThrow(/unavailable/i)
    // Claim, approve and complete can be served by different handlers.
    mount()
    expect(await pollMobilePairing(envelope.serverUrl, phone)).toEqual({ status: 'pending' })
    const wrong = { ...phone, claimSecret: Buffer.alloc(32, 2).toString('base64url') }
    expect(await pollMobilePairing(envelope.serverUrl, wrong)).toMatchObject({ status: 'denied' })
    expect(
      (await post('/auth/mobile-pair/approve', { pairingId: started.pairingId }, authHeaders()))
        .status,
    ).toBe(200)
    const fromWeb = await post(
      '/auth/mobile-pair/complete',
      {
        claimId: phone.claimId,
        claimSecret: phone.claimSecret,
      },
      { ...HTTPS, origin: 'https://podium.example' },
    )
    expect(fromWeb.status).toBe(400)
    const attempts = await Promise.all([
      pollMobilePairing(envelope.serverUrl, phone),
      pollMobilePairing(envelope.serverUrl, phone),
    ])
    expect(attempts.map((result) => result.status).sort()).toEqual(['complete', 'denied'])
    const paired = attempts.find((result) => result.status === 'complete')
    if (!paired?.bearer) throw new Error('phone received no bearer')
    const listed = await app.request('https://podium.example/auth/client-sessions', {
      headers: { authorization: `Bearer ${paired.bearer}` },
    })
    const { signIns } = await listed.json()
    const ownPhone = signIns.find((row: { current: boolean }) => row.current)
    expect(ownPhone).toMatchObject({ kind: 'phone', deviceName: 'My iPhone' })
    expect(signIns).toHaveLength(2)
    expect(
      (await post('/auth/client-sessions/revoke', { id: ownPhone.id }, authHeaders())).status,
    ).toBe(200)
    expect(
      (
        await app.request('https://podium.example/auth/client-sessions', {
          headers: { authorization: `Bearer ${paired.bearer}` },
        })
      ).status,
    ).toBe(401)

    const stale = await identity.workspace.core.codes.issue({
      purpose: 'pair-device',
      accountId,
      createdBy: 'test',
      ttlMs: 1,
    })
    // Wait just past the issued deadline, independent of the wall-clock tick.
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(1, stale.expiresAt.getTime() - Date.now() + 1)),
    )
    await expect(
      claimMobilePairing(
        { ...envelope, pairCode: stale.code },
        'expired-phone',
        'Expired phone',
        'ios',
      ),
    ).rejects.toThrow(/unavailable/i)
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

  it('never evicts a live lockout, and a full table denies no other peer', () => {
    const throttle = new PairingFailureThrottle({
      maxFailures: 1,
      lockoutMs: 60_000,
      retentionMs: 60_000,
      maxEntries: 2,
    })
    throttle.fail('victim', 0)
    expect(throttle.retryAfter('victim', 0)).toBe(60)
    throttle.fail('peer-1', 1_000)
    // Every bucket is a live lockout. Another peer is not refused for that...
    expect(throttle.retryAfter('peer-2', 1_000)).toBeUndefined()
    // ...and its failure cannot evict a lockout to make room.
    throttle.fail('peer-2', 1_000)
    expect(throttle.retryAfter('victim', 1_000)).toBe(59)
    expect(throttle.retryAfter('peer-1', 1_000)).toBe(60)
    expect(throttle.size).toBe(2)
    // When the first lockout ends, its slot takes the next failure.
    throttle.fail('peer-2', 60_000)
    expect(throttle.retryAfter('peer-2', 60_000)).toBe(60)
  })
})
