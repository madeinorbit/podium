/**
 * ONE SIGN-IN AT A TIME, WITH TWO MEMBERS (POD-6701).
 *
 * Through the production HTTP routes with each member's own login cookies:
 *
 * - A member lists every sign-in of theirs (browser, desktop, phone) with
 *   `GET /auth/client-sessions?include=all`, the current one marked, and
 *   revokes any one of them. That device is signed out at once: its open
 *   socket closes and its cookie stops working; the member's other devices
 *   stay signed in. Nobody else's sign-in can be revoked this way.
 * - Without `include=all` the list stays phones only, so a phone app built
 *   before this change still parses the answer.
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
  sessionId: string
  userId: string
  label: string
  kind: string
  deviceName: string
  platform: string
  createdAt: string
  lastSeenAt: string | null
  current: boolean
}

/** A fresh browser sign-in of `who`, separate from the fixture's cached one. */
async function signIn(who: MemberName, userAgent?: string): Promise<string> {
  const response = await fetch(new URL('/auth/login', f.origin), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(userAgent ? { 'user-agent': userAgent } : {}),
    },
    body: JSON.stringify({ email: MEMBERS[who].email, password: MEMBERS[who].password }),
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
  const answer = await call(cookie, '/auth/client-sessions?include=all')
  expect(answer.status).toBe(200)
  return answer.body.sessions as SignInView[]
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
    expect(sessions.every((s) => s.userId === MEMBERS.bob.id)).toBe(true)
    expect(sessions.filter((s) => s.current)).toHaveLength(1)
    const current = sessions.find((s) => s.current)!
    expect(current).toEqual(
      expect.objectContaining({
        label: 'login',
        kind: 'browser',
        deviceName: 'Firefox on Linux',
        platform: 'linux',
        lastSeenAt: expect.any(String),
      }),
    )
    expect(current.sessionId).toMatch(/^[A-Za-z0-9_-]{20,64}$/)
    const text = JSON.stringify(sessions)
    for (const row of await f.handle.registry.sessionStore.auth.listClientSessionsOfUser(
      MEMBERS.bob.id,
    )) {
      expect(text).not.toContain(row.tokenHash)
    }
    // The fixture's cached cookie is a second, separate sign-in of Bob's.
    expect((await mySignIns(bob.cookie)).filter((s) => s.current)).toHaveLength(1)
  })

  it('keeps the plain list to phones, as phone apps built before this change expect', async () => {
    const bob = await f.as('bob')
    const answer = await call(bob.cookie, '/auth/client-sessions')
    expect(answer.status).toBe(200)
    expect(answer.body.sessions).toEqual([])
  })

  it('revokes one browser sign-in at once and leaves the member’s others signed in', async () => {
    const bob = await f.as('bob')
    const spare = await signIn('bob')
    const feed = await f.feedWith(spare)
    const id = (await mySignIns(spare)).find((s) => s.current)!.sessionId
    expect((await call(bob.cookie, '/auth/client-sessions/revoke', { sessionId: id })).status).toBe(
      200,
    )
    await feed.until(() => feed.closed(), 5_000)
    expect((await call(spare, '/auth/client-sessions?include=all')).status).toBe(401)
    expect((await mySignIns(bob.cookie)).map((s) => s.sessionId)).not.toContain(id)
  })

  it('refuses to revoke another member’s sign-in', async () => {
    const alice = await f.as('alice')
    const bob = await f.as('bob')
    const aliceId = (await mySignIns(alice.cookie)).find((s) => s.current)!.sessionId
    expect(
      (await call(bob.cookie, '/auth/client-sessions/revoke', { sessionId: aliceId })).status,
    ).toBe(404)
    expect((await mySignIns(alice.cookie)).map((s) => s.sessionId)).toContain(aliceId)
  })
})

describe('an admin ends one sign-in from Access', () => {
  it('Access carries each sign-in’s id and the total', async () => {
    const alice = await f.as('alice')
    const answer = await call(alice.cookie, '/auth/admin/access')
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
    const id = (await mySignIns(target)).find((s) => s.current)!.sessionId

    const refused = await call(bob.cookie, '/auth/admin/sign-ins/revoke', { id })
    expect(refused.status).toBe(403)
    expect(feed.closed()).toBe(false)

    const revoked = await call(alice.cookie, '/auth/admin/sign-ins/revoke', { id })
    expect(revoked.status).toBe(200)
    await feed.until(() => feed.closed(), 5_000)
    expect((await call(target, '/auth/client-sessions?include=all')).status).toBe(401)
    expect((await call(bob.cookie, '/auth/client-sessions?include=all')).status).toBe(200)

    const access = await call(alice.cookie, '/auth/admin/access')
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
