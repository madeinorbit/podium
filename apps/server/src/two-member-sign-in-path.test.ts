/**
 * THE SIGN-IN PATH ON EVERY TRANSPORT, WITH TWO REAL MEMBERS (POD-6746).
 *
 * One real server; Alice and Bob made through the identity package and signed
 * in through `POST /auth/login`. HTTP, tRPC, the file route, sync and the
 * `/client` socket all resolve the caller the same way: device sign-in,
 * account, active membership, member.
 *
 * Each transport is asked "who is this" in two ways: by what it serves (the
 * caller's own facts, never another member's), and by the member fence, which
 * passes only for the member the server itself resolved.
 */
import { CLIENT_WIRE_VERSION, MEMBER_FENCE_HEADER, MEMBER_FENCE_PARAM } from '@podium/protocol'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import {
  MEMBERS,
  type MemberName,
  startTwoMemberInstance,
  type TwoMemberInstance,
} from './test-support/two-member-instance'

let f: TwoMemberInstance
beforeAll(async () => {
  f = await startTwoMemberInstance()
}, 60_000)
afterAll(async () => {
  await f?.close()
})

const cookieOf = (response: Response): string => {
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0]
  if (!cookie) throw new Error(`no sign-in cookie (${response.status})`)
  return cookie
}

const get = (path: string, headers: Record<string, string> = {}) =>
  fetch(new URL(path, f.origin), { headers })

/** Open `/client` with these headers; the outcome of the upgrade, and the socket when it opened. */
const openSocket = async (
  headers: Record<string, string>,
  query = '',
): Promise<{ outcome: 'open' | number; ws?: WebSocket; closed: () => boolean }> => {
  const url = `ws://127.0.0.1:${f.handle.port}/client?v=${CLIENT_WIRE_VERSION}&cap=sync.http.v1${query}`
  return await new Promise((resolve) => {
    const ws = new WebSocket(url, { headers })
    let closed = false
    ws.on('close', () => {
      closed = true
    })
    ws.on('open', () => resolve({ outcome: 'open', ws, closed: () => closed }))
    ws.on('unexpected-response', (_req, res) => {
      resolve({ outcome: res.statusCode ?? 0, closed: () => true })
      ws.terminate()
    })
    ws.on('error', () => resolve({ outcome: 0, closed: () => true }))
  })
}

const until = async (pred: () => boolean, ms = 5_000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** The status of one request on each HTTP transport, with these headers. */
const everyHttpTransport = async (headers: Record<string, string>) => ({
  trpc: (await get('/trpc/auth.profile', headers)).status,
  files: (
    await get(
      `/files/asset?${new URLSearchParams({ sessionId: f.sessions.bob, path: 'probe.txt' })}`,
      headers,
    )
  ).status,
  sync: (await get('/sync/bootstrap', headers)).status,
})

describe('each transport resolves the caller’s own member', () => {
  const other = (name: MemberName): MemberName => (name === 'alice' ? 'bob' : 'alice')

  it.each(['alice', 'bob'] as const)('HTTP: %s is reported as themselves', async (name) => {
    const me = await f.as(name)
    const status = (await (await me.fetch('/auth/status')).json()) as Record<string, unknown>
    expect(status).toMatchObject({ authed: true, userId: me.member.id, memberId: me.member.id })
    // A request that names another member changes nothing.
    const naming = await me.fetch(
      `/auth/status?userId=${f.members[other(name)].id}&memberId=${f.members[other(name)].id}`,
    )
    expect(await naming.json()).toMatchObject({ userId: me.member.id })
  })

  it.each(['alice', 'bob'] as const)('tRPC: %s reads their own profile', async (name) => {
    const me = await f.as(name)
    expect(await me.trpc.auth.profile.query()).toMatchObject({
      id: me.member.id,
      email: me.member.email,
      role: me.member.role,
    })
    // An input that names another member is not a way to become them.
    const input = encodeURIComponent(
      JSON.stringify({ userId: f.members[other(name)].id, memberId: f.members[other(name)].id }),
    )
    const naming = await me.fetch(`/trpc/auth.profile?input=${input}`)
    expect(JSON.stringify(await naming.json())).toContain(me.member.email)
  })

  it('file route: Bob gets his own session’s file; Alice gets a not-found for it', async () => {
    const asset = `/files/asset?${new URLSearchParams({ sessionId: f.sessions.bob, path: 'sign-in-path.txt' })}`
    expect((await (await f.as('bob')).fetch(asset)).status).toBe(200)
    expect((await (await f.as('alice')).fetch(asset)).status).toBe(404)
  })

  it('sync: each member’s snapshot is their own', async () => {
    const alice = await (await (await f.as('alice')).feed()).bootstrap()
    const bob = await (await (await f.as('bob')).feed()).bootstrap()
    const text = (snapshot: unknown) => JSON.stringify(snapshot)
    expect(text(bob)).toContain(f.sessions.bob)
    expect(text(bob)).not.toContain(f.sessions.alice)
    expect(text(alice)).toContain(f.sessions.alice)
    expect(text(alice)).not.toContain(f.sessions.bob)
  })

  it.each([
    'alice',
    'bob',
  ] as const)('every transport passes the fence for %s and refuses it for the other member', async (name) => {
    const me = await f.as(name)
    const mine = { cookie: me.cookie, [MEMBER_FENCE_HEADER]: me.member.id }
    const theirs = { cookie: me.cookie, [MEMBER_FENCE_HEADER]: f.members[other(name)].id }
    const own = await everyHttpTransport(mine)
    expect(own.trpc).toBe(200)
    expect(own.sync).not.toBe(401)
    expect(own.files).not.toBe(401)
    expect(await everyHttpTransport(theirs)).toEqual({ trpc: 401, files: 401, sync: 401 })

    const fence = (id: string) => `&${MEMBER_FENCE_PARAM}=${encodeURIComponent(id)}`
    const socket = await openSocket({ cookie: me.cookie }, fence(me.member.id))
    expect(socket.outcome).toBe('open')
    socket.ws?.close()
    expect(
      (await openSocket({ cookie: me.cookie }, fence(f.members[other(name)].id))).outcome,
    ).toBe(401)
  })

  it('nobody is served without a sign-in, on any transport, although the request is local', async () => {
    expect(await everyHttpTransport({})).toEqual({ trpc: 401, files: 401, sync: 401 })
    expect((await openSocket({})).outcome).toBe(401)
    expect(await (await get('/auth/status')).json()).toMatchObject({
      needsAuth: true,
      authed: false,
    })
  })

  it('the cookie of the removed hand-written sign-in is not a way in', async () => {
    const headers = { cookie: 'podium_session=anything-at-all' }
    expect(await everyHttpTransport(headers)).toEqual({ trpc: 401, files: 401, sync: 401 })
    expect((await openSocket(headers)).outcome).toBe(401)
  })
})

describe('a disabled or removed member is refused on every transport', () => {
  const admin = () => ({ memberId: f.members.alice.id })
  let addresses = 0
  const signedIn = (cookie: string | { refused: string }): string => {
    if (typeof cookie !== 'string') throw new Error(`sign-in refused: ${cookie.refused}`)
    return cookie
  }
  /** A member of their own, so the fixture's Alice and Bob stay as they are. */
  const addMember = async (name: string) => {
    const email = `${name}@example.com`
    const password = `${name}-fixture-password`
    const { invitation } = await f.handle.identity.memberships.invite({
      actor: admin(),
      role: 'member',
      email,
    })
    const { memberId } = await f.handle.identity.memberships.accept({
      token: invitation.token,
      account: { kind: 'new', name, email, password },
    })
    /** A sign-in from an address of its own; the cookie, or the refusal. */
    const login = async (): Promise<string | { refused: string }> => {
      addresses += 1
      const issued = await f.handle.identity.core.signIn.password(
        { email, password, device: { kind: 'browser' }, delivery: 'cookie' },
        { scheme: 'http', sameMachine: true, clientAddress: `10.5.0.${addresses}` },
      )
      if ('refused' in issued) return { refused: issued.refused }
      return (
        issued.headers
          .getSetCookie()
          .find((c) => c.includes('session_token'))
          ?.split(';')[0] ?? ''
      )
    }
    return { memberId, login }
  }

  const refusedEverywhere = async (cookie: string) => {
    expect(await everyHttpTransport({ cookie })).toEqual({ trpc: 401, files: 401, sync: 401 })
    expect((await openSocket({ cookie })).outcome).toBe(401)
    expect(await (await get('/auth/status', { cookie })).json()).toMatchObject({ authed: false })
  }

  it('disabled: every transport refuses, the open socket closes, and enabling needs a new sign-in', async () => {
    const dave = await addMember('dave')
    const cookie = signedIn(await dave.login())
    // Control: Dave is served before he is disabled.
    expect((await everyHttpTransport({ cookie })).trpc).toBe(200)
    const socket = await openSocket({ cookie })
    expect(socket.outcome).toBe('open')

    await f.handle.identity.memberships.disable({ actor: admin(), memberId: dave.memberId })
    await until(() => socket.closed())
    await refusedEverywhere(cookie)
    expect(await dave.login()).toEqual({ refused: 'invalid' })

    await f.handle.identity.memberships.enable({ actor: admin(), memberId: dave.memberId })
    // The old sign-in does not come back; a new one works.
    await refusedEverywhere(cookie)
    const again = signedIn(await dave.login())
    expect((await everyHttpTransport({ cookie: again })).trpc).toBe(200)
  })

  it('removed: every transport refuses, the open socket closes, and the person cannot sign in', async () => {
    const erin = await addMember('erin')
    const cookie = signedIn(await erin.login())
    expect((await everyHttpTransport({ cookie })).trpc).toBe(200)
    const socket = await openSocket({ cookie })
    expect(socket.outcome).toBe('open')

    await f.handle.identity.memberships.remove({ actor: admin(), memberId: erin.memberId })
    await until(() => socket.closed())
    await refusedEverywhere(cookie)
    expect(await erin.login()).toEqual({ refused: 'invalid' })
  })

  it('Carol, disabled in the fixture, cannot sign in', async () => {
    expect((await f.login('carol')).status).toBe(401)
    expect(MEMBERS.carol.id).toBe(f.members.carol.id)
  })
})

describe('signing out a device', () => {
  it('ends that device’s requests and its open socket; the member’s other device keeps working', async () => {
    // The laptop signs in through the route itself; the desktop is a further device.
    const laptop = cookieOf(await f.login('bob'))
    const desktop = await f.signInDevice('bob')
    const laptopSocket = await openSocket({ cookie: laptop })
    const desktopSocket = await openSocket({ cookie: desktop })
    expect([laptopSocket.outcome, desktopSocket.outcome]).toEqual(['open', 'open'])

    const out = await fetch(new URL('/auth/logout', f.origin), {
      method: 'POST',
      headers: { cookie: laptop },
    })
    expect(out.status).toBe(200)

    await until(() => laptopSocket.closed())
    expect(await everyHttpTransport({ cookie: laptop })).toEqual({
      trpc: 401,
      files: 401,
      sync: 401,
    })
    expect((await openSocket({ cookie: laptop })).outcome).toBe(401)

    expect((await everyHttpTransport({ cookie: desktop })).trpc).toBe(200)
    expect(desktopSocket.closed()).toBe(false)
    expect(await (await get('/auth/status', { cookie: desktop })).json()).toMatchObject({
      authed: true,
      userId: f.members.bob.id,
    })
    desktopSocket.ws?.close()
  })
})
