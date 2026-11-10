import { readFileSync } from 'node:fs'
import { request } from 'node:http'
import { serverControlSocketPath } from '@podium/runtime/user-socket'
import { afterEach, expect, it } from 'vitest'
import { authCliMain } from '../../cli/src/auth-cli'
import { startTwoMemberInstance, type TwoMemberInstance } from './test-support/two-member-instance'

let instance: TwoMemberInstance | undefined
afterEach(async () => {
  await instance?.close()
  instance = undefined
})
async function boot() {
  instance = await startTwoMemberInstance()
  return instance
}
async function post(f: TwoMemberInstance, action: string, body: unknown, cookie?: string) {
  const response = await fetch(`${f.origin}/auth/members/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}
function host(
  f: TwoMemberInstance,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: serverControlSocketPath({ instanceId: f.handle.instanceId }),
        path,
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json' },
      },
      (res) => {
        let text = ''
        res.on('data', (chunk) => {
          text += chunk
        })
        res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(text) }))
      },
    )
    req.on('error', reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}

it('an invitation race creates exactly one active membership and the People list uses it', async () => {
  const f = await boot()
  const alice = await f.as('alice')
  const issued = await post(f, 'invite', { email: 'dave@example.com' }, alice.cookie)
  expect(issued.status).toBe(200)
  const { token, memberId } = issued.body.invite
  const before = await f.handle.identity.memberships.list()
  expect(before.find((m) => m.memberId === memberId)).toMatchObject({
    status: 'invited',
    account: null,
  })
  expect(await f.handle.registry.sessionStore.users.get(memberId)).toBeUndefined()
  expect((await post(f, 'inspect', { token })).body).toMatchObject({ kind: 'invitation' })
  const claim = { token, email: 'dave@example.com', password: 'dave-password', displayName: 'Dave' }
  const results = await Promise.all([post(f, 'complete', claim), post(f, 'complete', claim)])
  expect(results.map((r) => r.status).sort()).toEqual([200, 400])
  expect(
    (await f.handle.identity.memberships.list()).filter((m) => m.account?.email === claim.email),
  ).toHaveLength(1)
  const signed = await fetch(`${f.origin}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(claim),
  })
  expect(signed.status).toBe(200)
  const people = await (await alice.fetch('/auth/members/list')).json()
  expect(people.members).toContainEqual(
    expect.objectContaining({ id: memberId, status: 'active', displayName: 'Dave' }),
  )
  expect(people).not.toHaveProperty('mailAvailable')
  expect(JSON.stringify(people)).not.toContain(token)
  const unused = await post(f, 'invite', { email: 'revoked@example.com' }, alice.cookie)
  expect(unused.status).toBe(200)
  expect((await post(f, 'revoke', { id: unused.body.invite.id }, alice.cookie)).status).toBe(200)
  const rows = await f.handle.registry.sessionStore.settingsAudit.list(1000)
  expect(rows.map((row) => row.command)).toEqual(
    expect.arrayContaining(['members.invite', 'members.join', 'members.inviteRevoked']),
  )
  const raw = JSON.stringify(rows)
  for (const secret of [token, unused.body.invite.token, '@example.com'])
    expect(raw).not.toContain(secret)
})

it('role, disable, enable and remove use memberships, close Bob sockets and leave Alice connected', async () => {
  const f = await boot()
  const alice = await f.as('alice')
  const bob = await f.as('bob')
  const aliceFeed = await alice.feed()
  const bobFeed = await bob.feed()
  const change = (action: string, extra = {}) =>
    post(
      f,
      action,
      { id: f.members.bob.id, current: f.members.alice.password, ...extra },
      alice.cookie,
    )
  expect((await change('role', { role: 'admin' })).status).toBe(200)
  await bobFeed.until(() => bobFeed.closed())
  expect((await (await bob.fetch('/auth/admin/viewer')).json()).sections).toContain('people')
  let memberships = await f.handle.identity.memberships.list()
  expect(memberships.find((m) => m.memberId === f.members.bob.id)?.role).toBe('admin')
  const secondBobFeed = await f.feedWith(await f.signInDevice('bob'))
  expect((await change('disable')).status).toBe(200)
  await secondBobFeed.until(() => secondBobFeed.closed())
  expect((await bob.fetch('/auth/members/directory')).status).toBe(401)
  expect((await change('enable')).status).toBe(200)
  const thirdBobCookie = await f.signInDevice('bob')
  const thirdBobFeed = await f.feedWith(thirdBobCookie)
  expect((await change('remove')).status).toBe(200)
  await thirdBobFeed.until(() => thirdBobFeed.closed())
  memberships = await f.handle.identity.memberships.list()
  expect(memberships.find((m) => m.memberId === f.members.bob.id)?.status).toBe('removed')
  expect(
    (await fetch(`${f.origin}/auth/members/directory`, { headers: { cookie: thirdBobCookie } }))
      .status,
  ).toBe(401)
  expect(aliceFeed.closed()).toBe(false)
  expect((await alice.fetch('/auth/admin/access')).status).toBe(200)
  const rows = await f.handle.registry.sessionStore.settingsAudit.list(1000)
  expect(rows.map((row) => row.command)).toEqual(
    expect.arrayContaining([
      'members.setRole',
      'members.disable',
      'members.enable',
      'members.remove',
    ]),
  )
  expect(JSON.stringify(rows)).not.toContain('@example.com')
})

it('the last admin receives a clear refusal for demotion, disable and removal', async () => {
  const f = await boot()
  const alice = await f.as('alice')
  for (const action of ['role', 'disable', 'remove']) {
    const answer = await post(
      f,
      action,
      { id: f.members.alice.id, role: 'member', current: f.members.alice.password },
      alice.cookie,
    )
    expect(answer.status).toBe(409)
    expect(answer.body).toMatchObject({
      code: 'last-admin',
      error: expect.stringMatching(/last administrator/i),
    })
  }
})

it('a reset code works once, closes every Bob device, leaves Alice and writes safe audit rows', async () => {
  const f = await boot()
  const alice = await f.as('alice')
  const bob = await f.as('bob')
  const aliceFeed = await alice.feed()
  const first = await bob.feed()
  const second = await f.feedWith(await f.signInDevice('bob'))
  const generation = await f.handle.registry.sessionStore.users.authzGenerationOf(f.members.bob.id)
  const issued = await post(
    f,
    'recovery',
    { id: f.members.bob.id, current: f.members.alice.password },
    alice.cookie,
  )
  expect(issued.status).toBe(200)
  const token = issued.body.invite.token
  expect((await post(f, 'inspect', { token })).body).toMatchObject({ kind: 'password-reset' })
  const claim = {
    token,
    email: f.members.bob.email,
    password: 'bob-replaced-password',
    displayName: 'Bob',
  }
  const results = await Promise.all([post(f, 'complete', claim), post(f, 'complete', claim)])
  expect(results.map((r) => r.status).sort()).toEqual([200, 400])
  await first.until(() => first.closed() && second.closed())
  expect(aliceFeed.closed()).toBe(false)
  expect(await f.handle.registry.sessionStore.users.authzGenerationOf(f.members.bob.id)).toBe(
    generation,
  )
  expect((await f.login('bob')).status).toBe(401)
  const login = await fetch(`${f.origin}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: f.members.bob.email, password: claim.password }),
  })
  expect(login.status).toBe(200)
  const rows = await f.handle.registry.sessionStore.settingsAudit.list(1000)
  expect(rows.map((row) => row.command)).toEqual(
    expect.arrayContaining(['members.recoveryIssued', 'members.recover']),
  )
  const serialized = JSON.stringify(rows)
  for (const secret of [token, f.members.alice.email, f.members.bob.email, claim.password])
    expect(serialized).not.toContain(secret)
})

it('the host command recovers the last admin and its socket routes are absent from HTTP', async () => {
  const f = await boot()
  const issued = await host(f, '/v1/member-recovery', { email: f.members.alice.email })
  expect(issued.status).toBe(200)
  const printed: string[] = []
  await authCliMain(
    ['recovery-link', f.members.alice.email],
    { print: (line) => printed.push(line), printErr: () => {} },
    async () => issued.body,
  )
  const token = String(printed[0]).split('#invite=')[1]!
  expect((await post(f, 'inspect', { token })).body).toMatchObject({ kind: 'password-reset' })
  expect(
    (
      await post(f, 'complete', {
        token,
        email: f.members.alice.email,
        password: 'host-reset-password',
        displayName: 'Alice',
      })
    ).status,
  ).toBe(200)
  expect((await host(f, '/v1/login-password')).body).toMatchObject({ set: true })
  expect((await host(f, '/v1/login-password', { password: 'host-setup-password' })).status).toBe(
    200,
  )
  expect(
    await f.handle.identity.core.accounts.verifyPassword(
      (await f.handle.registry.sessionStore.users.get(f.members.alice.id))!.accountId!,
      'host-setup-password',
    ),
  ).toBe(true)
  for (const path of ['/v1/member-recovery', '/v1/login-password']) {
    expect(
      (
        await fetch(`${f.origin}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: f.members.alice.email, password: 'network-password' }),
        })
      ).ok,
    ).toBe(false)
  }
})

it('People routes have no legacy member writers', () => {
  for (const file of ['member-routes.ts', 'member-invites.ts']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8')
    expect(source, file).not.toMatch(
      /\busers\.(?:setRole|disable|enable|removeMember|createUnclaimed|attachAccount|writeProfile|setEmail|recoverPassword|signOutEverywhere)\s*\(/,
    )
  }
})
