import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LOCAL_DEVICE_SIGN_IN_COOKIE } from '@podium/protocol'
import { serverControlSocketPath } from '@podium/runtime/user-socket'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { noJanitorWorkerForTests } from './janitor-host'
import { startServer } from './server'

let dir: string
let server: Awaited<ReturnType<typeof startServer>>
const origin = () => `http://127.0.0.1:${server.port}`
const control = (path: string, body?: object) => {
  const init: RequestInit & { unix: string } = {
    unix: serverControlSocketPath({ instanceId: server.instanceId }),
    ...(body
      ? {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}),
  }
  return fetch('http://localhost' + path, init)
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'podium-host-sign-in-'))
  vi.stubEnv('PODIUM_STATE_DIR', dir)
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({
      configVersion: 2,
      mode: 'all-in-one',
      persistence: 'systemd',
    }),
  )
  server = await startServer({ janitorWorkerForTests: noJanitorWorkerForTests, port: 0 })
}, 30_000)

afterAll(async () => {
  await server?.close()
  vi.unstubAllEnvs()
  if (dir) rmSync(dir, { recursive: true, force: true })
})

it('issues one local recovery code, redeems it once and revokes only host devices', async () => {
  const password = 'test-password-for-the-host'
  expect((await control('/v1/login-password', { password })).status).toBe(200)
  const before = Date.now()
  const issued = await control('/v1/host-sign-in', { ttlMs: 60_000 })
  expect(issued.status).toBe(200)
  const { code, expiresAt } = await issued.json()
  expect(expiresAt).toBeTruthy()
  expect(await (await control('/v1/sign-ins')).json()).toMatchObject({ signIns: [] })

  const login = await fetch(origin() + '/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  })
  expect(login.status).toBe(200)
  const browser = login.headers.get('set-cookie')!.split(';')[0]!

  const noNetworkMint = await fetch(origin() + '/v1/host-sign-in', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  expect(noNetworkMint.status).toBe(404)
  const noNetworkRedeem = await fetch(origin() + '/v1/host-sign-in/redeem', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  })
  expect(noNetworkRedeem.status).toBe(404)
  const redeemed = await control('/v1/host-sign-in/redeem', { code })
  expect(redeemed.status).toBe(200)
  const signIn = await redeemed.json()
  expect(signIn.token).not.toContain(code)
  expect(Date.parse(signIn.expiresAt)).toBeGreaterThanOrEqual(before + 60_000)
  expect(Date.parse(signIn.expiresAt)).toBeLessThanOrEqual(Date.now() + 60_000)
  expect((await control('/v1/host-sign-in/redeem', { code })).status).toBe(409)

  const host = `${LOCAL_DEVICE_SIGN_IN_COOKIE}=${encodeURIComponent(signIn.token)}`
  const status = async (cookie: string) =>
    await (await fetch(origin() + '/auth/status', { headers: { cookie } })).json()
  const hostMember = await status(host)
  expect(hostMember).toMatchObject({ authed: true })
  expect(await status(browser)).toMatchObject({ authed: true, memberId: hostMember.memberId })
  const list = await (await control('/v1/sign-ins')).json()
  expect(list.signIns.map((row: { kind: string }) => row.kind).sort()).toEqual(['browser', 'host'])
  expect(JSON.stringify(list)).not.toContain(signIn.token)
  expect(await (await control('/v1/sign-ins/revoke', {})).json()).toMatchObject({ revoked: 1 })
  expect(await status(host)).toMatchObject({ authed: false })
  expect(await status(browser)).toMatchObject({ authed: true })
})

it('refuses host mint once there is a second membership, even if only invited', async () => {
  await server.identity.memberships.invite({
    actor: { system: 'host' },
    email: 'bob@example.test',
    role: 'member',
  })
  const response = await control('/v1/host-sign-in', {})
  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ error: expect.stringMatching(/one member/i) })
})
