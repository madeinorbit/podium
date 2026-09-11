import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { firstAdminMemberId } from '@podium/model'
import { hashPassword } from '@podium/runtime/auth-store'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { noJanitorWorkerForTests } from './janitor-host'
import { startServer } from './server'

const priorStateDir = process.env.PODIUM_STATE_DIR
let stateDir: string
let handle: Awaited<ReturnType<typeof startServer>>
const adminEmail = 'admin@example.com'
const adminPassword = 'admin-roundtrip-password'
const url = (path: string) => `http://127.0.0.1:${handle.port}${path}`
const post = (path: string, body: unknown, cookie?: string) =>
  fetch(url(path), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  })

beforeAll(async () => {
  stateDir = mkdtempSync(join(tmpdir(), 'podium-invite-login-'))
  writeFileSync(
    join(stateDir, 'config.json'),
    JSON.stringify({ configVersion: 2, mode: 'all-in-one', persistence: 'systemd' }),
  )
  process.env.PODIUM_STATE_DIR = stateDir
  handle = await startServer({ port: 0, janitorWorkerForTests: noJanitorWorkerForTests })
  // Bootstrap only the existing admin's credentials. Every invite and session is
  // created over HTTP through the production server's own identity resolver.
  const users = handle.registry.sessionStore.users
  await users.setEmail(firstAdminMemberId(), adminEmail)
  await users.setPasswordHash(
    firstAdminMemberId(),
    await hashPassword(adminPassword),
    new Date().toISOString(),
  )
})

afterAll(async () => {
  await handle?.close()
  if (priorStateDir === undefined) delete process.env.PODIUM_STATE_DIR
  else process.env.PODIUM_STATE_DIR = priorStateDir
  if (stateDir) rmSync(stateDir, { recursive: true, force: true })
})

async function login(email: string, password: string, userId: string) {
  const response = await post('/auth/login', { email, password })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ ok: true, userId })
  const cookie = response.headers.get('set-cookie')?.split(';')[0]
  expect(cookie).toMatch(/^podium_session=.+/)
  return cookie!
}

async function createInvite(cookie: string, email: string) {
  const response = await post('/auth/members/invite', { email, role: 'member' }, cookie)
  expect(response.status).toBe(200)
  const result = (await response.json()) as { url: string; invite: { id: string; token: string } }
  expect(new URL(result.url).hash).toBe(`#invite=${result.invite.token}`)
  return result.invite
}

// Phase A §12: keep this on startServer + fetch. Route-only fixtures with a
// supplied resolveUserId cannot detect missing production auth/context wiring.
test('an admin invite becomes a member login accepted by protected workspace operations', async () => {
  expect((await fetch(url('/trpc/auth.profile'))).status).toBe(401)
  expect((await post('/auth/members/invite', { email: 'anna@example.com' })).status).toBe(403)
  const adminCookie = await login(adminEmail, adminPassword, firstAdminMemberId())
  const adminStatus = await fetch(url('/trpc/auth.status'), { headers: { cookie: adminCookie } })
  expect(adminStatus.status).toBe(200)
  expect(await adminStatus.json()).toMatchObject({ result: { data: { canManageInstance: true } } })

  const invite = await createInvite(adminCookie, 'anna@example.com')
  const claim = {
    token: invite.token,
    email: 'anna@example.com',
    displayName: 'Anna',
    password: 'anna-roundtrip-password',
  }
  expect((await post('/auth/members/inspect', { token: invite.token })).status).toBe(200)
  const completed = await post('/auth/members/complete', claim)
  expect(completed.status).toBe(200)
  const { userId } = (await completed.json()) as { userId: string }
  expect(userId).toBeTruthy()
  expect(userId).not.toBe(firstAdminMemberId())
  const memberCookie = await login(claim.email, claim.password, userId)
  const headers = { cookie: memberCookie }
  const identity = await fetch(url('/auth/status'), { headers })
  expect(identity.status).toBe(200)
  expect(await identity.json()).toMatchObject({ authed: true, userId })
  const profile = await fetch(url('/trpc/auth.profile'), { headers })
  expect(profile.status).toBe(200)
  expect(await profile.json()).toMatchObject({ result: { data: { email: claim.email } } })
  const status = await fetch(url('/trpc/auth.status'), { headers })
  expect(status.status).toBe(200)
  expect(await status.json()).toMatchObject({
    result: { data: { loginRequired: true, hasOwnCredential: true, canManageInstance: false } },
  })

  const revoked = await createInvite(adminCookie, 'revoked@example.com')
  expect((await fetch(url('/auth/members/list'), { headers })).status).toBe(403)
  for (const [action, body] of [
    ['invite', { email: 'forbidden@example.com', role: 'admin' }],
    ['revoke', { id: revoked.id }],
    ['remove', { id: firstAdminMemberId() }],
  ] as const) {
    expect((await post(`/auth/members/${action}`, body, memberCookie)).status).toBe(403)
  }
  const members = await fetch(url('/auth/members/list'), { headers: { cookie: adminCookie } })
  expect(members.status).toBe(200)
  expect(await members.json()).toMatchObject({
    currentMemberId: firstAdminMemberId(),
    members: expect.arrayContaining([
      expect.objectContaining({ id: userId, email: claim.email, role: 'member' }),
    ]),
  })
  // A refused member revocation left the invite usable; the admin can revoke it.
  expect((await post('/auth/members/inspect', { token: revoked.token })).status).toBe(200)
  expect((await post('/auth/members/revoke', { id: revoked.id }, adminCookie)).status).toBe(200)
  for (const body of [claim, { ...claim, token: revoked.token, email: 'revoked@example.com' }]) {
    expect((await post('/auth/members/inspect', { token: body.token })).status).toBe(400)
    expect((await post('/auth/members/complete', body)).status).toBe(400)
  }
  expect(
    (await post('/auth/login', { email: 'revoked@example.com', password: claim.password })).status,
  ).toBe(401)
  // Failed reuse cannot replace the invited member's working credential.
  await login(claim.email, claim.password, userId)
})
