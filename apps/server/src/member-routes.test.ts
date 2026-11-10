import { createIdentityCore, type WorkspaceIdentity } from '@podium/identity'
import { asUserId, firstAdminMemberId, newMemberId } from '@podium/model'
import { hashPassword, verifyPasswordHash } from '@podium/runtime/auth-store'
import { Hono } from 'hono'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { registerMemberRoutes } from './member-routes'
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
function app(options: { admin?: boolean; workspace?: WorkspaceIdentity } = {}) {
  const hono = new Hono()
  registerMemberRoutes(hono, {
    users: store.users,
    identity: options.workspace ?? identity.workspace,
    resolveUserId: async () => (options.admin ? firstAdminMemberId() : undefined),
    appUrl: () => 'https://workspace.example/',
  })
  return hono
}
function post(hono: Hono, action: string, body: unknown, origin?: string) {
  return hono.request(`https://workspace.example/auth/members/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
    body: JSON.stringify(body),
  })
}

test('admin creates a copyable link; unauthenticated invitee completes and cannot reuse it', async () => {
  const hono = app({ admin: true })
  const created = await post(hono, 'invite', { email: 'anna@example.com' })
  expect(created.status).toBe(200)
  const { invite, url } = await created.json()
  expect(url).toBe(`https://workspace.example/#invite=${invite.token}`)
  const body = {
    token: invite.token,
    email: 'anna@example.com',
    displayName: 'Anna',
    password: 'password123',
  }
  expect((await post(app(), 'inspect', { token: body.token })).status).toBe(200)
  const completed = await post(app(), 'complete', body)
  expect(completed.status).toBe(200)
  const { userId } = await completed.json()
  expect(await store.users.byEmail(body.email)).toMatchObject({ id: userId })
  expect((await post(app(), 'complete', body)).status).toBe(400)
  expect((await post(hono, 'remove', { id: userId })).status).toBe(200)
  expect(await store.users.get(asUserId(userId))).toBeUndefined()
})

test('management requires admin and refuses cross-origin mutations', async () => {
  expect((await app().request('https://workspace.example/auth/members/list')).status).toBe(403)
  for (const action of ['invite', 'revoke', 'remove', 'role', 'disable', 'enable', 'recovery'])
    expect((await post(app(), action, {})).status).toBe(403)
  expect((await post(app({ admin: true }), 'invite', {}, 'https://evil.example')).status).toBe(403)
})

test('member list reports whether the acting admin account has a password', async () => {
  const hono = app({ admin: true })
  const read = async () =>
    (await hono.request('https://workspace.example/auth/members/list')).json()
  expect(await read()).toMatchObject({ hasOwnCredential: false })
  await identity.addMember({ name: 'Anna', email: 'anna@example.com', password: 'anna-password' })
  expect(await read()).toMatchObject({ hasOwnCredential: false })
  await identity.credentials.setPassword(firstAdminMemberId(), 'admin-password')
  expect(await read()).toMatchObject({ hasOwnCredential: true })
})

test('public completion refuses forged account ids and tokenless trusted claims', async () => {
  const invite = await (await post(app({ admin: true }), 'invite', {})).json()
  const before = await store.users.get(firstAdminMemberId())
  for (const body of [
    { token: invite.invite.token, accountId: 'acct_attacker' },
    { preAuthorizedMemberId: firstAdminMemberId(), accountId: 'acct_attacker' },
  ])
    expect((await post(app(), 'complete', body)).status).toBe(400)
  expect((await store.users.get(firstAdminMemberId()))?.accountId).toBe(before?.accountId)
})

test('revocation and configured identity mail retain a copyable link on provider failure', async () => {
  let fails = true
  const send = vi.fn(async () => {
    if (fails) throw new Error('offline')
  })
  const core = await createIdentityCore({
    database: store.identityDatabase(),
    secret: 'test-secret-at-least-thirty-two-characters',
    accounts: 'shared',
    loginMethods: { password: true },
    mail: { send },
    selfSignUp: false,
    hosts: { kind: 'self-hosted' },
    sameMachine: null,
    rateLimit: { storage: 'memory' },
    newMemberId,
    passwordHashing: {
      hash: hashPassword,
      verify: ({ password, hash }) => verifyPasswordHash(password, hash),
    },
    invitationUrl: (token) => `https://workspace.example/#invite=${token}`,
  })
  const workspace = core.workspace('local', { rows: store.users.memberRows, sameDatabase: true })
  const hono = app({ admin: true, workspace })
  const result = await (await post(hono, 'invite', { email: 'anna@example.com' })).json()
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({ to: 'anna@example.com', text: expect.stringContaining(result.url) }),
  )
  expect(result.mailSent).toBe(false)
  expect((await post(hono, 'revoke', { id: result.invite.id })).status).toBe(200)
  expect((await post(hono, 'inspect', { token: result.invite.token })).status).toBe(400)
  fails = false
  expect((await (await post(hono, 'invite', { email: 'bob@example.com' })).json()).mailSent).toBe(
    true,
  )
  const local = await (
    await post(app({ admin: true }), 'invite', { email: 'local@example.com' })
  ).json()
  expect(local.mailSent).toBe(false)
})

test('without a configured URL, desktop requests get an HTTP invite link', async () => {
  const hono = new Hono()
  registerMemberRoutes(hono, {
    users: store.users,
    identity: identity.workspace,
    resolveUserId: async () => firstAdminMemberId(),
    appUrl: () => undefined,
  })
  const response = await post(hono, 'invite', {}, 'tauri://localhost')
  expect(response.status).toBe(200)
  expect((await response.json()).url).toMatch(/^https:\/\/workspace.example\/#invite=/)
})

test('members read active names and roles; only the admin list carries emails', async () => {
  const bob = await identity.addMember({
    name: 'Bob',
    email: 'bob@example.com',
    password: 'bob-password',
  })
  const carol = await identity.addMember({ name: 'Carol', email: 'carol@example.com' })
  await identity.workspace.memberships.disable({
    actor: { memberId: firstAdminMemberId() },
    memberId: carol,
  })
  const read = async (actor: string | undefined, action = 'directory') => {
    const hono = new Hono()
    registerMemberRoutes(hono, {
      users: store.users,
      identity: identity.workspace,
      resolveUserId: async () => (actor ? asUserId(actor) : undefined),
      appUrl: () => undefined,
    })
    return hono.request(`https://workspace.example/auth/members/${action}`)
  }
  const asBob = await (await read(bob)).json()
  expect(asBob.currentMemberId).toBe(bob)
  expect(asBob.members).toContainEqual({ id: bob, displayName: 'Bob', role: 'member' })
  expect(asBob.members.some((m: { id: string }) => m.id === carol)).toBe(false)
  expect((await (await read(firstAdminMemberId())).json()).members).toEqual(asBob.members)
  expect(Object.keys(asBob).sort()).toEqual(['currentMemberId', 'members'])
  expect((await read(bob, 'list')).status).toBe(403)
  expect((await (await read(firstAdminMemberId(), 'list')).json()).members).toContainEqual(
    expect.objectContaining({ id: bob, email: 'bob@example.com' }),
  )
  expect((await read(undefined)).status).toBe(401)
  expect((await read(carol)).status).toBe(401)
})

test('local mailed reset routes are absent and capabilities offer the admin link', async () => {
  const hono = app()
  expect(
    (await hono.request('https://workspace.example/auth/members/recovery-options')).status,
  ).toBe(404)
  expect((await post(hono, 'reset-request', { email: 'bob@example.com' })).status).toBe(404)
  expect(identity.workspace.core.capabilities()).toMatchObject({
    selfSignUp: false,
    passwordReset: 'admin-link',
    invitationDelivery: 'link',
  })
})

test('an invite cannot reset an active member with a password; that takes a recovery code', async () => {
  const bob = await identity.addMember({
    name: 'Bob',
    email: 'bob@example.com',
    password: 'bob-password',
  })
  const hono = app({ admin: true })
  expect((await post(hono, 'invite', { memberId: bob })).status).toBe(403)
  expect((await post(hono, 'recovery', { id: bob })).status).toBe(200)
})
