import { asUserId, firstAdminMemberId } from '@podium/model'
import { Hono } from 'hono'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { MemberInvites } from './member-invites'
import { registerMemberRoutes } from './member-routes'
import type { SessionStore } from './store'
import { openTestStore } from './test-support/open-test-store'

type CreatedInvite = {
  url: string
  invite: { id: string; token: string; expiresAt: string }
  mailSent: boolean
}
let store: SessionStore
beforeEach(async () => {
  store = await openTestStore(':memory:')
})
afterEach(async () => {
  await store.close()
})
function app(options: { admin?: boolean; mail?: boolean; mailFails?: boolean } = {}) {
  const hono = new Hono()
  const sendMail = vi.fn(async () => {
    if (options.mailFails) throw new Error('offline')
  })
  registerMemberRoutes(hono, {
    users: store.users,
    invites: new MemberInvites(store.users),
    resolveUserId: async () => (options.admin ? firstAdminMemberId() : undefined),
    appUrl: () => 'https://workspace.example/',
    ...(options.mail ? { sendMail } : {}),
  })
  return { hono, sendMail }
}
function post(hono: Hono, action: string, body: unknown, origin?: string) {
  return hono.request(`https://workspace.example/auth/members/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
    body: JSON.stringify(body),
  })
}
test('admin creates a copyable link; unauthenticated invitee completes and cannot reuse it', async () => {
  const { hono } = app({ admin: true })
  const created = await post(hono, 'invite', { email: 'anna@example.com' })
  expect(created.status).toBe(200)
  const invite = (await created.json()) as CreatedInvite
  expect(invite.url).toBe(`https://workspace.example/#invite=${invite.invite.token}`)
  const publicApp = app().hono
  const body = {
    token: invite.invite.token,
    email: 'anna@example.com',
    displayName: 'Anna',
    password: 'password123',
  }
  expect((await post(publicApp, 'inspect', { token: body.token })).status).toBe(200)
  const completed = await post(publicApp, 'complete', body)
  expect(completed.status).toBe(200)
  const { userId } = (await completed.json()) as { userId: string }
  expect(await store.users.byEmail(body.email)).toMatchObject({ id: userId })
  expect((await post(publicApp, 'complete', body)).status).toBe(400)
  expect((await post(hono, 'remove', { id: userId })).status).toBe(200)
  expect(await store.users.get(asUserId(userId))).toBeUndefined()
})
test('management requires admin and refuses cross-origin mutations', async () => {
  expect((await app().hono.request('https://workspace.example/auth/members/list')).status).toBe(403)
  for (const action of ['invite', 'revoke', 'remove'])
    expect((await post(app().hono, action, {})).status).toBe(403)
  expect((await post(app({ admin: true }).hono, 'invite', {}, 'https://evil.example')).status).toBe(
    403,
  )
})
test('public completion refuses forged account ids and tokenless trusted claims', async () => {
  const invite = await new MemberInvites(store.users).create(firstAdminMemberId(), {})
  for (const body of [
    { token: invite.token, accountId: 'acct_attacker' },
    { preAuthorizedMemberId: firstAdminMemberId(), accountId: 'acct_attacker' },
  ]) {
    expect((await post(app().hono, 'complete', body)).status).toBe(400)
  }
  expect((await store.users.get(firstAdminMemberId()))?.accountId).toBeNull()
})
test('revocation and optional mail delivery retain a copyable link on provider failure', async () => {
  const { hono, sendMail } = app({ admin: true, mail: true, mailFails: true })
  const result = (await (
    await post(hono, 'invite', { email: 'anna@example.com', sendEmail: true })
  ).json()) as CreatedInvite
  expect(sendMail).toHaveBeenCalledWith({
    email: 'anna@example.com',
    url: result.url,
    expiresAt: result.invite.expiresAt,
  })
  expect(result.mailSent).toBe(false)
  expect((await post(hono, 'revoke', { id: result.invite.id })).status).toBe(200)
  expect((await post(hono, 'inspect', { token: result.invite.token })).status).toBe(400)
  const sent = await post(app({ admin: true, mail: true }).hono, 'invite', {
    email: 'bob@example.com',
    sendEmail: true,
  })
  expect(((await sent.json()) as CreatedInvite).mailSent).toBe(true)
  expect(
    (await post(app({ admin: true }).hono, 'invite', { email: 'bob@example.com', sendEmail: true }))
      .status,
  ).toBe(400)
})

test('without a configured URL, desktop requests get an HTTP invite link', async () => {
  const hono = new Hono()
  registerMemberRoutes(hono, {
    users: store.users,
    invites: new MemberInvites(store.users),
    resolveUserId: async () => firstAdminMemberId(),
    appUrl: () => undefined,
  })
  const response = await post(hono, 'invite', {}, 'tauri://localhost')
  expect(response.status).toBe(200)
  expect(((await response.json()) as CreatedInvite).url).toMatch(
    /^https:\/\/workspace.example\/#invite=/,
  )
})
test('every signed-in member reads the directory; only admins see other members’ emails (POD-6294)', async () => {
  const alice = firstAdminMemberId()
  const bob = asUserId('mem_bob_directory')
  const carol = asUserId('mem_carol_directory')
  const at = new Date().toISOString()
  await store.users.create(
    {
      id: bob,
      displayName: 'Bob',
      email: 'bob@example.com',
      role: 'member',
      createdAt: at,
      disabledAt: null,
    },
    'hash',
  )
  await store.users.create(
    {
      id: carol,
      displayName: 'Carol',
      email: 'carol@example.com',
      role: 'member',
      createdAt: at,
      disabledAt: null,
    },
    'hash',
  )
  await store.users.disable(carol, at)
  const read = async (as: string | undefined) => {
    const hono = new Hono()
    registerMemberRoutes(hono, {
      users: store.users,
      invites: new MemberInvites(store.users),
      resolveUserId: async () => (as === undefined ? undefined : asUserId(as)),
      appUrl: () => undefined,
    })
    return await hono.request('https://workspace.example/auth/members/directory')
  }
  type Directory = {
    members: { id: string; displayName: string; email: string | null; disabledAt: string | null }[]
    currentMemberId: string
  }
  const asBob = (await (await read(bob)).json()) as Directory
  expect(asBob.currentMemberId).toBe(bob)
  const byId = new Map(asBob.members.map((member) => [member.id, member]))
  expect(byId.get(bob)).toMatchObject({ displayName: 'Bob', email: 'bob@example.com' })
  expect(byId.get(alice)?.email).toBeNull()
  // A disabled member is not one to assign or filter by.
  expect(byId.has(carol)).toBe(false)
  const asAlice = (await (await read(alice)).json()) as Directory
  expect(asAlice.members.find((member) => member.id === bob)?.email).toBe('bob@example.com')
  // No caller, or a disabled one, reads nothing.
  expect((await read(undefined)).status).toBe(401)
  expect((await read(carol)).status).toBe(401)
})

test('a mailed reset goes only to a member with a password, once per window, and says nothing either way (POD-6298)', async () => {
  const bob = asUserId('mem_bob_reset')
  await store.users.create(
    {
      id: bob,
      displayName: 'Bob',
      email: 'bob@example.com',
      role: 'member',
      createdAt: new Date().toISOString(),
      disabledAt: null,
    },
    'hash',
  )
  const hono = new Hono()
  const sendRecoveryMail = vi.fn(async () => {})
  registerMemberRoutes(hono, {
    users: store.users,
    invites: new MemberInvites(store.users),
    resolveUserId: async () => undefined,
    appUrl: () => 'https://workspace.example/',
    sendRecoveryMail,
  })
  const options = await hono.request('https://workspace.example/auth/members/recovery-options')
  expect(await options.json()).toEqual({ mailReset: true })
  // An unknown address and a known one get the same answer.
  for (const email of ['nobody@example.com', 'bob@example.com', 'bob@example.com']) {
    const response = await post(hono, 'reset-request', { email })
    expect(response.status, email).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
  }
  // One mail: none for the unknown address, none for the repeat inside the window.
  expect(sendRecoveryMail).toHaveBeenCalledTimes(1)
  const sent = (
    sendRecoveryMail.mock.calls[0] as unknown as [{ email: string; url: string; expiresAt: string }]
  )[0]
  expect(sent.email).toBe('bob@example.com')
  expect(Date.parse(sent.expiresAt) - Date.now()).toBeLessThanOrEqual(60 * 60 * 1000)
  const token = sent.url.split('#invite=')[1]!
  expect((await (await post(hono, 'inspect', { token })).json()) as object).toMatchObject({
    email: 'bob@example.com',
    recovery: true,
  })
  const completed = await post(hono, 'complete', {
    token,
    email: 'bob@example.com',
    password: 'bob-new-password',
    displayName: 'Bob',
  })
  expect(completed.status).toBe(200)
  expect(((await completed.json()) as { userId: string }).userId).toBe(bob)
  expect((await store.users.credentialFor(bob))?.passwordHash).not.toBe('hash')
  expect((await store.settingsAudit.list()).map((row) => row.command)).toEqual([
    'members.resetMailed',
    'members.recover',
  ])
})

test('an invite cannot reset a member who has a password; that takes a recovery link', async () => {
  const bob = asUserId('mem_bob_reinvite')
  await store.users.create(
    {
      id: bob,
      displayName: 'Bob',
      email: 'bob@example.com',
      role: 'member',
      createdAt: new Date().toISOString(),
      disabledAt: null,
    },
    'hash',
  )
  const { hono } = app({ admin: true })
  expect((await post(hono, 'invite', { memberId: bob })).status).toBe(400)
  const recovery = await post(hono, 'recovery', { id: bob })
  expect(recovery.status).toBe(200)
})
