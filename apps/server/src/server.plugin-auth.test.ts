import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { firstAdminMemberId } from '@podium/model'
import { WIRE_VERSION } from '@podium/protocol'
import { hashToken } from './auth-route'
import { afterAll, beforeAll, expect, test, vi } from 'vitest'
import { WebSocket } from 'ws'
import { noJanitorWorkerForTests } from './janitor-host'
import { startServer } from './server'
import type { PrincipalRequest } from './plugin-auth'
const prior = process.env.PODIUM_STATE_DIR
let dir: string
let handle: Awaited<ReturnType<typeof startServer>>
let memberId: string
let principalValid = true
const maintainPrincipal = vi.fn(async () => principalValid)
const source = vi.fn(async (request: PrincipalRequest) =>
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
