import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asUserId, firstAdminMemberId } from '@podium/model'
import { forgetConfig } from '@podium/runtime/config'
import { decodePairingEnvelope, WIRE_VERSION } from '@podium/protocol'
import { hashToken } from './auth-route'
import { afterAll, beforeAll, expect, test, vi } from 'vitest'
import { WebSocket } from 'ws'
import { noJanitorWorkerForTests } from './janitor-host'
import { startServer } from './server'
import type { Principal, PrincipalRequest } from './plugin-auth'
const prior = process.env.PODIUM_STATE_DIR
let dir: string
let handle: Awaited<ReturnType<typeof startServer>>
let memberId: string
let principalValid = true
const maintainPrincipal = vi.fn(async () => principalValid)
const source = vi.fn(
  async (request: PrincipalRequest): Promise<Principal | null> =>
    request.cookieHeader?.includes('cloud=yes') || request.authorizationHeader === 'Bearer cloud'
      ? { memberId, role: 'member' as const }
      : null,
)
const url = (path: string) => `http://127.0.0.1:${handle.port}${path}`
const localCookie = 'podium_session=local-token'
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'podium-plugin-auth-'))
  process.env.PODIUM_STATE_DIR = dir
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({
      configVersion: 2,
      mode: 'all-in-one',
      persistence: 'systemd',
      publicUrl: 'https://podium.example',
      auth: { mode: 'cloud' },
    }),
  )
  handle = await startServer({
    port: 0,
    trustedProxyHops: 1,
    janitorWorkerForTests: noJanitorWorkerForTests,
    plugins: [
      {
        name: 'fake-identity',
        async register({ auth }) {
          memberId = (await auth.createMemberForAccount('acct_test', 'member', 'Test', null)).id
          auth.principalSource = source
          auth.maintainPrincipal = maintainPrincipal
        },
      },
    ],
  })
  await handle.registry.sessionStore.auth.createClientSession(
    hashToken('local-token'),
    firstAdminMemberId(),
    '2999-01-01T00:00:00.000Z',
  )
})
afterAll(async () => {
  await handle?.close()
  if (prior === undefined) delete process.env.PODIUM_STATE_DIR
  else process.env.PODIUM_STATE_DIR = prior
  rmSync(dir, { recursive: true, force: true })
})
async function socket(cookie: string, bearer = false): Promise<boolean> {
  return await new Promise((resolve) => {
    const ws = new WebSocket(
      url(`/client?v=${WIRE_VERSION}&workspace=ignored`).replace('http:', 'ws:'),
      {
        headers: {
          cookie,
          ...(bearer ? { authorization: 'Bearer cloud', 'x-forwarded-proto': 'https' } : {}),
        },
      },
    )
    ws.on('open', () => {
      ws.close()
      resolve(true)
    })
    ws.on('error', () => resolve(false))
    ws.on('unexpected-response', (_request, response) => {
      response.resume()
      ws.terminate()
      resolve(false)
    })
  })
}
test('cloud mode requires login even without local passwords', async () => {
  expect(await (await fetch(url('/auth/status'))).json()).toMatchObject({
    needsAuth: true,
    authed: false,
    mode: 'cloud',
  })
})
test('environment cloud mode overrides local open mode and advertises its sign-in destination', async () => {
  const configPath = join(dir, 'config.json')
  writeFileSync(
    configPath,
    JSON.stringify({
      configVersion: 2,
      mode: 'all-in-one',
      persistence: 'systemd',
      auth: { mode: 'local', openMode: true },
    }),
  )
  forgetConfig(configPath)
  vi.stubEnv('PODIUM_AUTH_MODE', 'cloud')
  vi.stubEnv('PODIUM_AUTH_SIGN_IN_URL', 'https://accounts.example/login?org=one')
  try {
    expect(await (await fetch(url('/auth/status'))).json()).toMatchObject({
      needsAuth: true,
      authed: false,
      mode: 'cloud',
      signInUrl: 'https://accounts.example/login?org=one',
    })
    expect((await fetch(url('/files/missing'))).status).toBe(401)
    expect(await socket('')).toBe(false)
  } finally {
    vi.unstubAllEnvs()
    forgetConfig(configPath)
    writeFileSync(
      configPath,
      JSON.stringify({
        configVersion: 2,
        mode: 'all-in-one',
        persistence: 'systemd',
        auth: { mode: 'cloud' },
      }),
    )
  }
})
const pairPost = (action: string, body: unknown, cookie = 'cloud=yes') =>
  fetch(url(`/auth/mobile-pair/${action}`), {
    method: 'POST',
    headers: {
      cookie,
      'content-type': 'application/json',
      'x-forwarded-proto': 'https',
      'x-forwarded-for': '192.0.2.10',
    },
    body: JSON.stringify(body),
  })

test('provider credentials own pairing and device management before local sessions', async () => {
  // Restore the public URL after the preceding config-override test.
  const configPath = join(dir, 'config.json')
  writeFileSync(
    configPath,
    JSON.stringify({
      configVersion: 2,
      mode: 'all-in-one',
      persistence: 'systemd',
      publicUrl: 'https://podium.example',
      auth: { mode: 'cloud' },
    }),
  )
  forgetConfig(configPath)
  const cookie = `cloud=yes; ${localCookie}`
  for (const decision of ['approve', 'deny']) {
    source.mockClear()
    const start = await pairPost('start', {}, cookie)
    expect(start.status).toBe(200)
    expect(source).toHaveBeenCalledTimes(1)
    expect(source).toHaveBeenCalledWith(
      expect.objectContaining({
        cookieHeader: cookie,
        url: url('/auth/mobile-pair/start'),
      }),
    )
    const started = (await start.json()) as { pairingId: string; envelope: string }
    const envelope = decodePairingEnvelope(started.envelope)
    if (envelope.v !== 2 || envelope.mode !== 'pair') throw new Error('wrong envelope')
    expect(
      (
        await pairPost(
          'claim',
          {
            pairCode: envelope.pairCode,
            claimHash: hashToken('pairing-secret'),
            deviceId: 'provider-phone',
            deviceName: 'Provider phone',
            platform: 'ios',
            delivery: 'native',
          },
          '',
        )
      ).status,
    ).toBe(200)
    expect(await (await pairPost('status', { pairingId: started.pairingId })).json()).toMatchObject(
      { state: 'claimed' },
    )
    expect((await pairPost(decision, { pairingId: started.pairingId }, localCookie)).status).toBe(
      400,
    )
    expect((await pairPost(decision, { pairingId: started.pairingId })).status).toBe(200)
  }
  const store = handle.registry.sessionStore.auth
  for (const [sessionId, owner] of [
    ['provider-device-session-id', memberId],
    ['admin-device-session-id', firstAdminMemberId()],
  ]) {
    await store.createClientSession(
      hashToken(sessionId!),
      asUserId(owner!),
      '2999-01-01T00:00:00.000Z',
      'mobile',
      { sessionId: sessionId!, deviceId: sessionId!, deviceName: 'Phone', platform: 'ios' },
    )
  }
  const headers = { cookie }
  const listed = await fetch(url('/auth/client-sessions'), { headers })
  expect(listed.status).toBe(200)
  expect(await listed.json()).toMatchObject({
    sessions: [{ sessionId: 'provider-device-session-id', userId: memberId, current: false }],
  })
  const revoke = (sessionId: string) =>
    fetch(url('/auth/client-sessions/revoke'), {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    })
  expect((await revoke('admin-device-session-id')).status).toBe(404)
  expect((await revoke('provider-device-session-id')).status).toBe(200)
  expect(await store.getClientSession(hashToken('provider-device-session-id'))).toBeUndefined()
  expect(
    (await fetch(url('/auth/client-sessions'), { headers: { cookie: localCookie } })).status,
  ).toBe(200)
  expect(
    (
      await fetch(url('/auth/client-sessions'), {
        headers: {
          authorization: 'Bearer cloud',
          'x-forwarded-proto': 'https',
        },
      })
    ).status,
  ).toBe(200)
  expect((await pairPost('start', {}, localCookie)).status).toBe(200)
})

test('provider identity wins over a local admin session in tRPC and status', async () => {
  const headers = { cookie: `cloud=yes; ${localCookie}`, 'Podium-Workspace': 'ignored' }
  expect(await (await fetch(url('/auth/status'), { headers })).json()).toMatchObject({
    userId: memberId,
  })
  source.mockClear()
  const response = await fetch(url('/trpc/auth.status'), { headers })
  expect(source).toHaveBeenCalledTimes(1)
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ result: { data: { canManageInstance: false } } })
  expect(source).toHaveBeenCalledWith(
    expect.objectContaining({
      cookieHeader: headers.cookie,
      url: expect.stringContaining('/trpc/auth.status'),
    }),
  )
})
test('provider grants file and socket access without looking up local credentials', async () => {
  const lookup = vi.spyOn(handle.registry.sessionStore.auth, 'getClientSession')
  lookup.mockClear()
  const response = await fetch(url('/files/missing'), { headers: { cookie: 'cloud=yes' } })
  expect(response.status).not.toBe(401)
  expect(source).toHaveBeenCalledWith(
    expect.objectContaining({ url: expect.stringContaining('/files/missing') }),
  )
  expect(await socket('cloud=yes')).toBe(true)
  expect(source).toHaveBeenCalledWith(
    expect.objectContaining({ url: expect.stringContaining('/client?') }),
  )
  expect(lookup).not.toHaveBeenCalled()
  lookup.mockRestore()
})
test('null source falls back to client sessions on all three paths', async () => {
  const headers = { cookie: localCookie }
  expect((await fetch(url('/trpc/auth.status'), { headers })).status).toBe(200)
  expect((await fetch(url('/files/missing'), { headers })).status).not.toBe(401)
  expect(await socket(localCookie)).toBe(true)
  expect((await fetch(url('/trpc/auth.status'))).status).toBe(401)
  expect((await fetch(url('/files/missing'))).status).toBe(401)
  expect(await socket('')).toBe(false)
})

test('passes bearer credentials and request URLs to the provider on all transports', async () => {
  const headers = { authorization: 'Bearer cloud', 'x-forwarded-proto': 'https' }
  expect((await fetch(url('/trpc/auth.status'), { headers })).status).toBe(200)
  expect((await fetch(url('/files/missing'), { headers })).status).not.toBe(401)
  expect(await socket('', true)).toBe(true)
  expect(source).toHaveBeenCalledWith(
    expect.objectContaining({ authorizationHeader: 'Bearer cloud' }),
  )
})

// Exercise the server-to-gateway hook with the real client heartbeat and socket.
test('host revocation disconnects an already open provider socket', async () => {
  principalValid = true
  maintainPrincipal.mockClear()
  const ws = new WebSocket(url(`/client?v=${WIRE_VERSION}`).replace('http:', 'ws:'), {
    headers: { cookie: `cloud=yes; ${localCookie}` },
  })
  try {
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })
    principalValid = false
    await new Promise<void>((resolve) => ws.once('close', () => resolve()))
    expect(ws.readyState).toBe(WebSocket.CLOSED)
    expect(maintainPrincipal).toHaveBeenCalledWith(
      expect.objectContaining({ cookieHeader: `cloud=yes; ${localCookie}` }),
      { memberId, role: 'member' },
    )
  } finally {
    principalValid = true
    ws.terminate()
  }
}, 20_000)

test('uses workspace membership instead of an inflated provider role', async () => {
  await source.withImplementation(
    async () => ({ memberId, role: 'admin' }),
    async () => {
      source.mockClear()
      const headers = { cookie: 'cloud=yes' }
      const response = await fetch(url('/trpc/auth.status'), { headers })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        result: { data: { canManageInstance: false } },
      })
      expect(source).toHaveBeenCalledTimes(1)
      expect((await fetch(url('/files/missing'), { headers })).status).not.toBe(401)
      expect(await socket(headers.cookie)).toBe(true)
    },
  )
})

for (const identity of ['non-member', 'disabled member', 'missing member id'] as const) {
  test(`rejects a provider ${identity} on files, commands and sockets`, async () => {
    let rejectedId = identity === 'non-member' ? 'acct_not_a_workspace_member' : ''
    if (identity === 'disabled member') {
      const users = handle.registry.sessionStore.users
      // Disable a real workspace member, preserving the stale provider identity.
      const member = await users.findMemberByAccount('acct_test')
      expect(member).toBeDefined()
      rejectedId = member!.id
      await users.removeMember(asUserId(rejectedId), firstAdminMemberId())
    }
    await source.withImplementation(
      async () => ({ memberId: rejectedId, role: 'member' }),
      async () => {
        // An invalid provider identity must not fall back to this local admin cookie.
        const headers = { cookie: `cloud=yes; ${localCookie}` }
        expect((await fetch(url('/files/missing'), { headers })).status).toBe(401)
        expect((await fetch(url('/trpc/auth.status'), { headers })).status).toBe(401)
        expect(await socket(headers.cookie)).toBe(false)
        for (const action of ['start', 'status', 'approve', 'deny']) {
          expect((await pairPost(action, {}, headers.cookie)).status).toBe(401)
        }
        expect((await fetch(url('/auth/client-sessions'), { headers })).status).toBe(401)
        expect(
          (
            await fetch(url('/auth/client-sessions/revoke'), {
              method: 'POST',
              headers,
              body: '{}',
            })
          ).status,
        ).toBe(401)
      },
    )
  })
}
