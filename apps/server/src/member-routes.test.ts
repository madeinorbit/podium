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
