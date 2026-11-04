/**
 * MU-03 AND MU-14: ADMISSION AND THE MEMBER LIFECYCLE, WITH TWO MEMBERS
 * (POD-6298; design §2.1, §2.4, §2.6, §4.1, acceptance matrix MU-03, MU-14).
 *
 * Everything here goes through the production HTTP routes with each member's
 * own login cookie: `/auth/members/*` for invites, roles, disable, removal,
 * recovery and sign-out, `/auth/login` and `/auth/logout`, and `/trpc` for the
 * instance commands Bob must not reach.
 *
 * - An invite is a single-use, expiring link whose token is stored hashed and
 *   consumed once, also by two concurrent completions.
 * - A disabled member sees nothing and cannot sign in.
 * - The last active admin can be neither demoted, disabled nor removed, also by
 *   two concurrent requests from two admins.
 * - Role and credential changes need the acting admin's current password.
 * - Removing a member releases their machines' custody with audit rows and
 *   rewrites no attribution.
 * - Disabling Bob keeps the use grants other members hold on Bob's machines.
 *
 * Each test boots its own instance: these tests change who may act.
 */

import { request } from 'node:http'
import { asUserId, type UserId } from '@podium/model'
import { serverControlSocketPath } from '@podium/runtime/user-socket'
import { afterEach, expect, it } from 'vitest'
import { hashToken } from './auth-route'
import {
  MEMBERS,
  startTwoMemberInstance,
  type TwoMemberInstance,
} from './test-support/two-member-instance'

const instances: TwoMemberInstance[] = []
afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.close()
})
async function boot(): Promise<TwoMemberInstance> {
  const instance = await startTwoMemberInstance()
  instances.push(instance)
  return instance
}

const ALICE_PASSWORD = MEMBERS.alice.password

type Json = Record<string, unknown>

/** POST a JSON body with a cookie (or none) and answer status and body. */
async function post(
  inst: TwoMemberInstance,
  path: string,
  body: unknown,
  cookie?: string,
): Promise<{ status: number; body: Json }> {
  const response = await fetch(new URL(path, inst.origin), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json().catch(() => ({}))) as Json }
}

async function get(
  inst: TwoMemberInstance,
  path: string,
  cookie?: string,
): Promise<{ status: number; body: Json }> {
  const response = await fetch(new URL(path, inst.origin), {
    headers: cookie ? { cookie } : {},
  })
  return { status: response.status, body: (await response.json().catch(() => ({}))) as Json }
}

/** Sign in by email and password; the session cookie, or the refused status. */
async function signIn(
  inst: TwoMemberInstance,
  email: string,
  password: string,
): Promise<{ status: number; cookie?: string }> {
  const response = await fetch(new URL('/auth/login', inst.origin), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0]
  return { status: response.status, ...(response.ok && cookie ? { cookie } : {}) }
}

interface Joined {
  readonly id: UserId
  readonly email: string
  readonly password: string
  readonly cookie: string
}

/** Alice invites someone and they accept the link and sign in, as a person does. */
async function join(
  inst: TwoMemberInstance,
  name: string,
  role: 'admin' | 'member' = 'member',
): Promise<Joined> {
  const alice = await inst.as('alice')
  const email = `${name}@example.com`
  const password = `${name}-password`
  const created = await post(
    inst,
    '/auth/members/invite',
    { email, role, current: ALICE_PASSWORD },
    alice.cookie,
  )
  expect(created.status, JSON.stringify(created.body)).toBe(200)
  const token = (created.body.invite as { token: string }).token
  const completed = await post(inst, '/auth/members/complete', {
    token,
    email,
    password,
    displayName: name,
  })
  expect(completed.status, JSON.stringify(completed.body)).toBe(200)
  const signedIn = await signIn(inst, email, password)
  expect(signedIn.status).toBe(200)
  return {
    id: asUserId(completed.body.userId as string),
    email,
    password,
    cookie: signedIn.cookie!,
  }
}

const store = (inst: TwoMemberInstance) => inst.handle.registry.sessionStore

/** Every `/client` connection the server holds for this member, right now. */
const connectionsOf = (inst: TwoMemberInstance, member: UserId) =>
  [...inst.handle.registry.clientGateway.registry.values()].filter(
    (conn) => conn.principal.user === member,
  )

/** The audit rows the member store wrote for one command, oldest first. */
async function auditRows(inst: TwoMemberInstance, command: string) {
  return (await store(inst).settingsAudit.list(1000)).filter((row) => row.command === command)
}

// ---------------------------------------------------------------------------
// MU-03: invites
// ---------------------------------------------------------------------------

it('an invite is a hashed, single-use link: two concurrent completions admit one person', async () => {
  const inst = await boot()
  const alice = await inst.as('alice')
  const created = await post(
    inst,
    '/auth/members/invite',
    { email: 'dave@example.com' },
    alice.cookie,
  )
  expect(created.status).toBe(200)
  const invite = created.body.invite as { id: string; token: string; expiresAt: string }
  expect(Date.parse(invite.expiresAt)).toBeGreaterThan(Date.now())

  // Stored as a hash: the plaintext token is nowhere in the database, and the
  // admin's list never carries it again.
  const stored = (await store(inst).users.pendingInvites()).map((row) => row.tokenHash)
  expect(stored).toEqual([hashToken(invite.token)])
  const listed = await get(inst, '/auth/members/list', alice.cookie)
  expect(JSON.stringify(listed.body)).not.toContain(invite.token)

  const body = (password: string) => ({
    token: invite.token,
    email: 'dave@example.com',
    password,
    displayName: 'Dave',
  })
  const results = await Promise.all([
    post(inst, '/auth/members/complete', body('dave-first-password')),
    post(inst, '/auth/members/complete', body('dave-second-password')),
  ])
  expect(results.map((r) => r.status).sort()).toEqual([200, 400])
  const winner = results[0]!.status === 200 ? 'dave-first-password' : 'dave-second-password'
  const loser = winner === 'dave-first-password' ? 'dave-second-password' : 'dave-first-password'
  expect((await signIn(inst, 'dave@example.com', winner)).status).toBe(200)
  expect((await signIn(inst, 'dave@example.com', loser)).status).toBe(401)
  // One Dave, and the link is spent.
  const daves = (await store(inst).users.list()).filter((m) => m.email === 'dave@example.com')
  expect(daves).toHaveLength(1)
  expect((await post(inst, '/auth/members/inspect', { token: invite.token })).status).toBe(400)
})

it('an invite addressed to an email admits only that email', async () => {
  const inst = await boot()
  const alice = await inst.as('alice')
  const created = await post(
    inst,
    '/auth/members/invite',
    { email: 'dave@example.com' },
    alice.cookie,
  )
  const token = (created.body.invite as { token: string }).token
  const wrong = await post(inst, '/auth/members/complete', {
    token,
    email: 'mallory@example.com',
    password: 'mallory-password',
    displayName: 'Mallory',
  })
  expect(wrong.status).toBe(400)
  expect(await store(inst).users.byEmail('mallory@example.com')).toBeUndefined()
  // Still usable by the person it was addressed to.
  expect((await post(inst, '/auth/members/inspect', { token })).body).toMatchObject({
    email: 'dave@example.com',
  })
})

it('an admin invite needs the acting admin’s current password', async () => {
  const inst = await boot()
  const alice = await inst.as('alice')
  const bare = await post(
    inst,
    '/auth/members/invite',
    { email: 'dave@example.com', role: 'admin' },
    alice.cookie,
  )
  expect(bare.status).toBe(403)
  expect(bare.body.code).toBe('reauth_required')
  const wrong = await post(
    inst,
    '/auth/members/invite',
    { email: 'dave@example.com', role: 'admin', current: 'not-alices-password' },
    alice.cookie,
  )
  expect(wrong.status).toBe(403)
  expect(wrong.body.code).toBe('reauth_required')
  const confirmed = await post(
    inst,
    '/auth/members/invite',
    { email: 'dave@example.com', role: 'admin', current: ALICE_PASSWORD },
    alice.cookie,
  )
  expect(confirmed.status).toBe(200)
})

// ---------------------------------------------------------------------------
// MU-03: Carol, disabled
// ---------------------------------------------------------------------------

it('Carol, disabled, cannot sign in and her open cookie and feed see nothing', async () => {
  const inst = await boot()
  const { carol } = inst.members
  expect((await inst.login('carol')).status).toBe(401)

  // A member signed in on a device, then disabled through the admin route:
  // that device's cookie and feed see nothing from the commit on.
  const dave = await join(inst, 'dave')
  const feed = await inst.feedWith(dave.cookie)
  expect(connectionsOf(inst, dave.id)).toHaveLength(1)
  const alice = await inst.as('alice')
  const disabled = await post(
    inst,
    '/auth/members/disable',
    { id: dave.id, current: ALICE_PASSWORD },
    alice.cookie,
  )
  expect(disabled.status, JSON.stringify(disabled.body)).toBe(200)
  expect(connectionsOf(inst, dave.id)).toHaveLength(0)
  await feed.until(() => feed.closed())

  expect((await get(inst, '/auth/members/directory', dave.cookie)).status).toBe(401)
  const trpc = await fetch(
    new URL('/trpc/sync.changesSince?input=%7B%22cursor%22%3Anull%7D', inst.origin),
    {
      headers: { cookie: dave.cookie },
    },
  )
  expect(trpc.status).toBe(401)
  expect((await signIn(inst, dave.email, dave.password)).status).toBe(401)
  // Carol and Dave appear to the admin as disabled, so the admin can enable them.
  const listed = await get(inst, '/auth/members/list', alice.cookie)
  const members = listed.body.members as Array<{ id: string; disabledAt: string | null }>
  expect(members.find((m) => m.id === carol.id)?.disabledAt).toEqual(expect.any(String))
  expect(members.find((m) => m.id === dave.id)?.disabledAt).toEqual(expect.any(String))

  // Enabling restores sign-in, never the old cookie.
  const enabled = await post(
    inst,
    '/auth/members/enable',
    { id: dave.id, current: ALICE_PASSWORD },
    alice.cookie,
  )
  expect(enabled.status).toBe(200)
  expect((await get(inst, '/auth/members/directory', dave.cookie)).status).toBe(401)
  expect((await signIn(inst, dave.email, dave.password)).status).toBe(200)
})

// ---------------------------------------------------------------------------
// MU-03: the last admin
// ---------------------------------------------------------------------------

it('the only admin cannot demote, disable or remove herself', async () => {
  const inst = await boot()
  const { alice } = inst.members
  const cookie = (await inst.as('alice')).cookie
  const demote = await post(
    inst,
    '/auth/members/role',
    { id: alice.id, role: 'member', current: ALICE_PASSWORD },
    cookie,
  )
  expect(demote.status).toBe(409)
  for (const action of ['disable', 'remove']) {
    const refused = await post(
      inst,
      `/auth/members/${action}`,
      { id: alice.id, current: ALICE_PASSWORD },
      cookie,
    )
    expect(refused.status, action).toBe(409)
  }
  expect(await store(inst).users.roleOf(alice.id)).toBe('admin')
})

it('two admins demoting each other at once leave exactly one admin', async () => {
  const inst = await boot()
  const { alice } = inst.members
  const dave = await join(inst, 'dave', 'admin')
  const aliceCookie = (await inst.as('alice')).cookie
  const results = await Promise.all([
    post(
      inst,
      '/auth/members/role',
      { id: dave.id, role: 'member', current: ALICE_PASSWORD },
      aliceCookie,
    ),
    post(
      inst,
      '/auth/members/role',
      { id: alice.id, role: 'member', current: dave.password },
      dave.cookie,
    ),
  ])
  expect(results.map((r) => r.status).sort()).toEqual([200, 403])
  const roles = [await store(inst).users.roleOf(alice.id), await store(inst).users.roleOf(dave.id)]
  expect(roles.filter((role) => role === 'admin')).toHaveLength(1)
})

it('two admins each demoting themselves at once leave exactly one admin', async () => {
  const inst = await boot()
  const { alice } = inst.members
  const dave = await join(inst, 'dave', 'admin')
  const aliceCookie = (await inst.as('alice')).cookie
  const results = await Promise.all([
    post(
      inst,
      '/auth/members/role',
      { id: alice.id, role: 'member', current: ALICE_PASSWORD },
      aliceCookie,
    ),
    post(
      inst,
      '/auth/members/role',
      { id: dave.id, role: 'member', current: dave.password },
      dave.cookie,
    ),
  ])
  expect(results.map((r) => r.status).sort()).toEqual([200, 409])
  const roles = [await store(inst).users.roleOf(alice.id), await store(inst).users.roleOf(dave.id)]
  expect(roles.filter((role) => role === 'admin')).toHaveLength(1)
})

it('two admins disabling or removing each other at once leave exactly one admin', async () => {
  for (const action of ['disable', 'remove'] as const) {
    const inst = await boot()
    const { alice } = inst.members
    const dave = await join(inst, 'dave', 'admin')
    const aliceCookie = (await inst.as('alice')).cookie
    const results = await Promise.all([
      post(inst, `/auth/members/${action}`, { id: dave.id, current: ALICE_PASSWORD }, aliceCookie),
      post(inst, `/auth/members/${action}`, { id: alice.id, current: dave.password }, dave.cookie),
    ])
    // The loser is no longer an admin (or no longer signed in) when its turn comes.
    expect(
      results.filter((r) => r.status === 200),
      action,
    ).toHaveLength(1)
    const active = [
      await store(inst).users.roleOf(alice.id),
      await store(inst).users.roleOf(dave.id),
    ]
    expect(
      active.filter((role) => role === 'admin'),
      action,
    ).toHaveLength(1)
  }
})

it('a role change needs the admin’s current password, and Bob cannot make himself admin', async () => {
  const inst = await boot()
  const { bob } = inst.members
  const alice = await inst.as('alice')
  const bobSession = await inst.as('bob')
  const self = await post(
    inst,
    '/auth/members/role',
    { id: bob.id, role: 'admin', current: bob.password },
    bobSession.cookie,
  )
  expect(self.status).toBe(403)
  expect(await store(inst).users.roleOf(bob.id)).toBe('member')

  const bare = await post(inst, '/auth/members/role', { id: bob.id, role: 'admin' }, alice.cookie)
  expect(bare.status).toBe(403)
  expect(bare.body.code).toBe('reauth_required')
  const wrong = await post(
    inst,
    '/auth/members/role',
    { id: bob.id, role: 'admin', current: 'not-alices-password' },
    alice.cookie,
  )
  expect(wrong.status).toBe(403)
  expect(await store(inst).users.roleOf(bob.id)).toBe('member')

  const promoted = await post(
    inst,
    '/auth/members/role',
    { id: bob.id, role: 'admin', current: ALICE_PASSWORD },
    alice.cookie,
  )
  expect(promoted.status).toBe(200)
  expect(await store(inst).users.roleOf(bob.id)).toBe('admin')
  expect((await auditRows(inst, 'members.setRole')).at(-1)).toMatchObject({
    actorId: inst.members.alice.id,
  })
})

// ---------------------------------------------------------------------------
// MU-14: removal
// ---------------------------------------------------------------------------

it('removing Bob releases his machine with an audit row and keeps his history attributed', async () => {
  const inst = await boot()
  const { alice, bob } = inst.members
  const cookie = (await inst.as('alice')).cookie
  const removed = await post(
    inst,
    '/auth/members/remove',
    { id: bob.id, current: ALICE_PASSWORD },
    cookie,
  )
  expect(removed.status, JSON.stringify(removed.body)).toBe(200)

  // Custody released, one audit row per machine.
  expect(await store(inst).machines.custodian(inst.machines.bob)).toBeNull()
  const audits = (await auditRows(inst, 'members.remove')).map((row) => ({
    actorId: row.actorId,
    ...(row.detail as Json),
  }))
  expect(audits).toEqual([
    {
      actorId: alice.id,
      memberId: bob.id,
      machineId: inst.machines.bob,
      previousOwnerUserId: bob.id,
      newOwnerUserId: null,
    },
  ])

  // History stays his: the task, its owner, and his sessions.
  const task = await store(inst).issues.getIssue(inst.tasks.bob)
  expect(task?.ownerUserId).toBe(bob.id)
  for (const sessionId of [inst.sessions.bob, inst.sessions.bobOnAliceTask]) {
    const session = await store(inst).sessions.getSession(sessionId)
    expect(session?.ownerUserId, sessionId).toBe(bob.id)
  }
  // Nothing else is offboarded: Alice's task, session and machine are untouched,
  // and Bob cannot sign in.
  expect((await store(inst).issues.getIssue(inst.tasks.alice))?.ownerUserId).toBe(alice.id)
  expect((await inst.login('bob')).status).toBe(401)
})

it('disabling Bob keeps the use grant Alice holds on Bob’s machine', async () => {
  const inst = await boot()
  const { alice, bob } = inst.members
  const bobSession = await inst.as('bob')
  await bobSession.trpc.machines.share.mutate({
    id: inst.machines.bob,
    grantee: alice.id,
    verb: 'use',
    acknowledgeSharedMachine: true,
  })
  const useGrants = async () =>
    (await store(inst).grants.listForResource('machine', inst.machines.bob))
      .filter((grant) => grant.verb === 'use' && grant.grantee !== bob.id)
      .map((grant) => grant.grantee)
  expect(await useGrants()).toEqual([alice.id])

  const cookie = (await inst.as('alice')).cookie
  const disabled = await post(
    inst,
    '/auth/members/disable',
    { id: bob.id, current: ALICE_PASSWORD },
    cookie,
  )
  expect(disabled.status).toBe(200)
  expect(await useGrants()).toEqual([alice.id])
  // Custody stays with Bob while he is only disabled.
  expect(await store(inst).machines.custodian(inst.machines.bob)).toBe(bob.id)
})

// ---------------------------------------------------------------------------
// Sign-out
// ---------------------------------------------------------------------------

it('signing out one device keeps the other; signing out everywhere ends both', async () => {
  const inst = await boot()
  const { bob } = inst.members
  const first = await signIn(inst, bob.email, bob.password)
  const second = await signIn(inst, bob.email, bob.password)
  const directory = async (cookie: string) =>
    (await get(inst, '/auth/members/directory', cookie)).status
  expect(await directory(first.cookie!)).toBe(200)
  expect(await directory(second.cookie!)).toBe(200)

  expect((await post(inst, '/auth/logout', {}, first.cookie)).status).toBe(200)
  expect(await directory(first.cookie!)).toBe(401)
  expect(await directory(second.cookie!)).toBe(200)

  const third = await signIn(inst, bob.email, bob.password)
  const feed = await inst.feedWith(third.cookie!)
  const everywhere = await post(inst, '/auth/members/sign-out-everywhere', {}, second.cookie)
  expect(everywhere.status).toBe(200)
  expect(await directory(second.cookie!)).toBe(401)
  expect(await directory(third.cookie!)).toBe(401)
  await feed.until(() => feed.closed())
  // He can sign in again.
  expect((await signIn(inst, bob.email, bob.password)).status).toBe(200)
})

it('an admin signs another member out everywhere; Bob cannot sign Alice out', async () => {
  const inst = await boot()
  const { alice, bob } = inst.members
  const bobSession = await inst.as('bob')
  const aliceSession = await inst.as('alice')
  const refused = await post(
    inst,
    '/auth/members/sign-out-everywhere',
    { id: alice.id },
    bobSession.cookie,
  )
  expect(refused.status).toBe(403)
  expect((await get(inst, '/auth/members/directory', aliceSession.cookie)).status).toBe(200)
  const done = await post(
    inst,
    '/auth/members/sign-out-everywhere',
    { id: bob.id },
    aliceSession.cookie,
  )
  expect(done.status).toBe(200)
  expect((await get(inst, '/auth/members/directory', bobSession.cookie)).status).toBe(401)
})

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

it('an admin-issued recovery link sets a new password once and signs the member out', async () => {
  const inst = await boot()
  const { bob } = inst.members
  const alice = await inst.as('alice')
  const bobSession = await inst.as('bob')
  const bare = await post(inst, '/auth/members/recovery', { id: bob.id }, alice.cookie)
  expect(bare.status).toBe(403)
  const issued = await post(
    inst,
    '/auth/members/recovery',
    { id: bob.id, current: ALICE_PASSWORD },
    alice.cookie,
  )
  expect(issued.status, JSON.stringify(issued.body)).toBe(200)
  const token = (issued.body.invite as { token: string }).token
  expect(issued.body.url).toBe(`${inst.origin}/#invite=${token}`)
  expect((await post(inst, '/auth/members/inspect', { token })).body).toMatchObject({
    email: bob.email,
    recovery: true,
  })

  const completed = await post(inst, '/auth/members/complete', {
    token,
    email: bob.email,
    password: 'bob-new-password',
    displayName: 'Bob',
  })
  expect(completed.status, JSON.stringify(completed.body)).toBe(200)
  expect(completed.body.userId).toBe(bob.id)
  expect((await get(inst, '/auth/members/directory', bobSession.cookie)).status).toBe(401)
  expect((await signIn(inst, bob.email, bob.password)).status).toBe(401)
  expect((await signIn(inst, bob.email, 'bob-new-password')).status).toBe(200)
  expect(await store(inst).users.roleOf(bob.id)).toBe('member')
  // Single use.
  const again = await post(inst, '/auth/members/complete', {
    token,
    email: bob.email,
    password: 'bob-third-password',
    displayName: 'Bob',
  })
  expect(again.status).toBe(400)
  // Bob cannot issue one for Alice.
  expect(
    (
      await post(
        inst,
        '/auth/members/recovery',
        { id: inst.members.alice.id, current: 'bob-new-password' },
        (
          await signIn(inst, bob.email, 'bob-new-password')
        ).cookie,
      )
    ).status,
  ).toBe(403)
})

it('without mail, the email reset is reported unavailable and sends nothing', async () => {
  const inst = await boot()
  expect((await get(inst, '/auth/members/recovery-options')).body).toEqual({ mailReset: false })
  const requested = await post(inst, '/auth/members/reset-request', { email: MEMBERS.bob.email })
  expect(requested.status).toBe(404)
  expect(await store(inst).users.pendingInvites()).toEqual([])
})

it('the only admin, password forgotten, gets back in with a host-local recovery link', async () => {
  const inst = await boot()
  const { alice } = inst.members
  const aliceCookie = (await inst.as('alice')).cookie
  // The server's own control socket, reachable only by its OS user.
  const answer = await new Promise<{ status: number; body: Json }>((resolve, reject) => {
    const req = request(
      {
        socketPath: serverControlSocketPath({ instanceId: inst.handle.instanceId }),
        path: '/v1/member-recovery',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      },
      (res) => {
        let text = ''
        res.on('data', (chunk: Buffer) => {
          text += chunk.toString('utf8')
        })
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) as Json }),
        )
      },
    )
    req.on('error', reject)
    req.end(JSON.stringify({ email: alice.email }))
  })
  expect(answer.status, JSON.stringify(answer.body)).toBe(200)
  const token = String(answer.body.url).split('#invite=')[1]!
  const completed = await post(inst, '/auth/members/complete', {
    token,
    email: alice.email,
    password: 'alice-new-password',
    displayName: 'Alice',
  })
  expect(completed.status, JSON.stringify(completed.body)).toBe(200)
  expect((await signIn(inst, alice.email, 'alice-new-password')).status).toBe(200)
  expect((await get(inst, '/auth/members/directory', aliceCookie)).status).toBe(401)
  expect(await store(inst).users.roleOf(alice.id)).toBe('admin')
  expect((await auditRows(inst, 'members.recoveryIssued')).at(-1)).toMatchObject({
    actorKind: 'system',
    actorId: null,
  })
})

// ---------------------------------------------------------------------------
// Bob is not an admin
// ---------------------------------------------------------------------------

it('Bob cannot change instance settings, roles or invites, or run server transfer', async () => {
  const inst = await boot()
  const { alice, bob, carol } = inst.members
  const bobSession = await inst.as('bob')
  const aliceSession = await inst.as('alice')
  const cookie = bobSession.cookie

  // Members and invites: every admin route refuses him, with his own password.
  expect((await get(inst, '/auth/members/list', cookie)).status).toBe(403)
  const memberRoutes: Array<[string, Json]> = [
    ['invite', { email: 'dave@example.com', current: bob.password }],
    ['revoke', { id: 'inv_000000000000000000000000', current: bob.password }],
    ['role', { id: carol.id, role: 'admin', current: bob.password }],
    ['role', { id: alice.id, role: 'member', current: bob.password }],
    ['disable', { id: alice.id, current: bob.password }],
    ['enable', { id: carol.id, current: bob.password }],
    ['remove', { id: alice.id, current: bob.password }],
    ['recovery', { id: alice.id, current: bob.password }],
  ]
  for (const [action, body] of memberRoutes) {
    expect((await post(inst, `/auth/members/${action}`, body, cookie)).status, action).toBe(403)
  }
  expect(await store(inst).users.roleOf(alice.id)).toBe('admin')
  expect(await store(inst).users.get(carol.id)).toBeUndefined()
  expect(await store(inst).users.pendingInvites()).toEqual([])

  // Instance settings, login policy, telemetry and server transfer.
  const refusals: Array<[string, () => Promise<unknown>]> = [
    [
      'settings.updateInstance',
      () =>
        bobSession.trpc.settings.updateInstance.mutate({ values: { 'hibernation.memoryPct': 85 } }),
    ],
    [
      'settings.setSecret',
      () =>
        bobSession.trpc.settings.setSecret.mutate({
          key: 'apiKeys.openai',
          value: 'sk-bob',
        } as never),
    ],
    [
      'auth.setLoginRequired',
      () =>
        bobSession.trpc.auth.setLoginRequired.mutate({
          required: false,
          current: bob.password,
          acknowledgeNoPassword: true,
        }),
    ],
    ['telemetry.set', () => bobSession.trpc.telemetry.set.mutate({ usage: 'off' })],
    ['telemetry.resetId', () => bobSession.trpc.telemetry.resetId.mutate({})],
    ['setup.setChannel', () => bobSession.trpc.setup.setChannel.mutate({ channel: 'edge' })],
    [
      'machines.moveServer',
      () =>
        bobSession.trpc.machines.moveServer.mutate({
          targetMachineId: inst.machines.bob,
          publicUrl: 'https://bob.example',
          bindHost: '0.0.0.0',
          confirmation: 'TRANSFER SERVER',
        }),
    ],
  ]
  for (const [name, call] of refusals) {
    const error = (await call().then(
      () => undefined,
      (e: unknown) => e,
    )) as { message?: string; data?: { code?: string } } | undefined
    expect(error?.data?.code, `${name}: ${error?.message}`).toBe('FORBIDDEN')
  }
  // The control arm: Alice's same settings write is applied.
  await expect(
    aliceSession.trpc.settings.updateInstance.mutate({ values: { 'hibernation.memoryPct': 85 } }),
  ).resolves.toBeDefined()
})
