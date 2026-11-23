/**
 * ONE SIGN-IN AT A TIME, WITH TWO MEMBERS (POD-6701).
 *
 * Through the production HTTP routes with each member's own login cookies:
 *
 * - A member lists every sign-in of theirs (browser, desktop, phone) with
 *   `GET /auth/client-sessions`, the current one marked, and
 *   revokes any one of them. That device is signed out at once: its open
 *   socket closes and its cookie stops working; the member's other devices
 *   stay signed in. Nobody else's sign-in can be revoked this way.
 * - An admin ends any single sign-in from Access with
 *   `POST /auth/admin/sign-ins/revoke {id}`. The device is signed out at once,
 *   the member's other sign-ins survive, and Audit shows the event. A member
 *   who is not an admin is refused.
 * - Access says how many sign-ins exist in all, so the page can say
 *   "showing N of M".
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  MEMBERS,
  type MemberName,
  startTwoMemberInstance,
  type TwoMemberInstance,
} from './test-support/two-member-instance'

let f: TwoMemberInstance

type Json = Record<string, unknown>

interface SignInView {
  id: string
  kind: string
  deviceName: string
  platform: string
  createdAt: string
  lastSeenAt: string | null
  current: boolean
}

/** A fresh browser sign-in of `who`, separate from the fixture's cached one. */
async function signIn(who: MemberName, userAgent?: string, desktop = false): Promise<string> {
  if (!userAgent && !desktop) return await f.signInDevice(who)
  const response = await fetch(new URL('/auth/login', f.origin), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(userAgent ? { 'user-agent': userAgent } : {}),
    },
    body: JSON.stringify({
      email: MEMBERS[who].email,
      password: MEMBERS[who].password,
      ...(desktop ? { deviceKind: 'desktop' } : {}),
    }),
  })
  expect(response.status).toBe(200)
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0]
  if (!cookie) throw new Error('login returned no cookie')
  return cookie
}

async function call(
  cookie: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Json }> {
  const response = await fetch(new URL(path, f.origin), {
    method: body === undefined ? 'GET' : 'POST',
    headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, body: (await response.json().catch(() => ({}))) as Json }
}

async function mySignIns(cookie: string): Promise<SignInView[]> {
  const answer = await call(cookie, '/auth/client-sessions')
  expect(answer.status).toBe(200)
  return answer.body.signIns as SignInView[]
}

beforeAll(async () => {
  f = await startTwoMemberInstance()
  await f.as('alice')
  await f.as('bob')
}, 60_000)
afterAll(async () => {
  await f?.close()
})

describe('a member’s own sign-ins', () => {
  it('lists every browser sign-in of the caller, current one marked, and nobody else’s', async () => {
    const laptop = await signIn(
      'bob',
      'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0',
    )
    const sessions = await mySignIns(laptop)
    const bob = await f.as('bob')
    expect(sessions.length).toBeGreaterThanOrEqual(2)
    const alice = await f.as('alice')
    const aliceId = (await mySignIns(alice.cookie)).find((s) => s.current)!.id
    expect(sessions.map((s) => s.id)).not.toContain(aliceId)
    expect(sessions.filter((s) => s.current)).toHaveLength(1)
    const current = sessions.find((s) => s.current)!
    expect(current).toEqual(
      expect.objectContaining({
        kind: 'browser',
        deviceName: 'Firefox on Linux',
        platform: 'linux',
        lastSeenAt: expect.any(String),
      }),
    )
    expect(current.id).toMatch(/^[A-Za-z0-9_-]{20,64}$/)
    const text = JSON.stringify(sessions)
    expect(text).not.toContain(laptop.split('=')[1])
    expect(sessions.every((s) => !('accountId' in s) && !('label' in s) && !('token' in s))).toBe(
      true,
    )
    // The fixture's cached cookie is a second, separate sign-in of Bob's.
    expect((await mySignIns(bob.cookie)).filter((s) => s.current)).toHaveLength(1)
  })

  it('lists browser, desktop and phone sign-ins from the same endpoint', async () => {
    const bob = await f.as('bob')
    const answer = await call(bob.cookie, '/auth/client-sessions')
    expect(answer.status).toBe(200)
    expect(answer.body.signIns).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'browser', current: true })]),
    )
    const desktop = await signIn('bob', 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0.0.0', true)
    const membership = (await f.handle.identity.memberships.list()).find(
      (row) => row.memberId === MEMBERS.bob.id,
    )!
    await f.handle.identity.core.deviceSignIns.create(
      membership.account!.id,
      { kind: 'phone', name: "Bob's phone", platform: 'ios', deviceId: 'bob-phone' },
      'bearer',
      { scheme: 'https', sameMachine: false, clientAddress: '198.51.100.60' },
    )
    const listed = await mySignIns(desktop)
    expect(listed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'desktop',
          current: true,
          deviceName: 'Podium desktop on Windows',
        }),
        expect.objectContaining({ kind: 'phone', current: false, deviceName: "Bob's phone" }),
        expect.objectContaining({ kind: 'browser', current: false }),
      ]),
    )
    expect(listed.filter((row) => row.current)).toHaveLength(1)
  })

  it('revokes one browser sign-in at once and leaves the member’s others signed in', async () => {
    const bob = await f.as('bob')
    const spare = await signIn('bob')
    const feed = await f.feedWith(spare)
    const id = (await mySignIns(spare)).find((s) => s.current)!.id
    expect((await call(bob.cookie, '/auth/client-sessions/revoke', { id: id })).status).toBe(200)
    await feed.until(() => feed.closed(), 5_000)
    expect((await call(spare, '/auth/client-sessions')).status).toBe(401)
    expect((await mySignIns(bob.cookie)).map((s) => s.id)).not.toContain(id)
  })

  it('refuses to revoke another member’s sign-in', async () => {
    const alice = await f.as('alice')
    const bob = await f.as('bob')
    const aliceId = (await mySignIns(alice.cookie)).find((s) => s.current)!.id
    expect((await call(bob.cookie, '/auth/client-sessions/revoke', { id: aliceId })).status).toBe(
      404,
    )
    expect((await mySignIns(alice.cookie)).map((s) => s.id)).toContain(aliceId)
  })
})

describe('an admin ends one sign-in from Access', () => {
  it('Access carries each sign-in’s id and the total', async () => {
    const alice = await f.as('alice')
    const answer = await call(alice.cookie, '/auth/admin/sign-ins')
    expect(answer.status).toBe(200)
    const signIns = answer.body.signIns as { id: string | null; memberId: string }[]
    expect(signIns.length).toBeGreaterThanOrEqual(2)
    expect(signIns.every((s) => typeof s.id === 'string')).toBe(true)
    expect(answer.body.signInsTotal).toBe(signIns.length)
  })

  it('signs that device out immediately, keeps the member’s others, and audits it', async () => {
    const alice = await f.as('alice')
    const bob = await f.as('bob')
    const target = await signIn('bob')
    const feed = await f.feedWith(target)
    const aliceFeed = await f.feedWith(alice.cookie)
    const bobFeed = await f.feedWith(bob.cookie)
    const id = (await mySignIns(target)).find((s) => s.current)!.id

    const refused = await call(bob.cookie, '/auth/admin/sign-ins/revoke', { id })
    expect(refused.status).toBe(403)
    expect(feed.closed()).toBe(false)

    const revoked = await call(alice.cookie, '/auth/admin/sign-ins/revoke', { id })
    expect(revoked.status).toBe(200)
    await feed.until(() => feed.closed(), 5_000)
    expect((await call(target, '/auth/client-sessions')).status).toBe(401)
    expect((await call(bob.cookie, '/auth/client-sessions')).status).toBe(200)

    expect(aliceFeed.closed()).toBe(false)
    expect(bobFeed.closed()).toBe(false)
    const access = await call(alice.cookie, '/auth/admin/sign-ins')
    expect((access.body.signIns as { id: string }[]).map((s) => s.id)).not.toContain(id)

    expect((await call(alice.cookie, '/auth/admin/sign-ins/revoke', { id })).status).toBe(404)

    const audit = await call(alice.cookie, '/auth/admin/audit')
    expect(audit.body.events).toContainEqual(
      expect.objectContaining({
        command: 'members.revokeSignIn',
        result: 'applied',
        actor: expect.objectContaining({ kind: 'member', id: MEMBERS.alice.id }),
        target: expect.objectContaining({ kind: 'member', id: MEMBERS.bob.id, name: 'Bob' }),
      }),
    )
    expect(JSON.stringify(audit.body)).not.toContain(id)
  })
})
