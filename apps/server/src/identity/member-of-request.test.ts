/**
 * From a request to a member, and the answer for everybody else (POD-6746;
 * docs/design/people-and-sign-in.md, sections 5.1 and 5.2).
 *
 * The server's real store and a real identity core on it: Alice is the admin,
 * Bob a member, each signed in through the package.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createIdentityCore, type IssuedSignIn, type WorkspaceIdentity } from '@podium/identity'
import { asUserId, newMemberId } from '@podium/model'
import { hashPassword, isPasswordHash, verifyPasswordHash } from '@podium/runtime/auth-store'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionStore } from '../store'
import { openTestStore } from '../test-support/open-test-store'
import { createMemberOfRequest, type MemberRefusal, refusalAnswer } from './member-of-request'

/** Each sign-in comes from an address of its own: the library limits sign-ins per address. */
let addresses = 0
const https = () => {
  addresses += 1
  return {
    scheme: 'https',
    sameMachine: false,
    clientAddress: `10.9.${addresses >> 8}.${addresses & 255}`,
  } as const
}

/** A request as the HTTP app sees it: the peer header is the server's own. */
const request = (url: string, headers: Record<string, string> = {}, peer = '203.0.113.7') =>
  new Request(url, { headers: { 'x-podium-peer-address': peer, ...headers } })

const cookieOf = (signIn: IssuedSignIn): string => {
  const cookie = signIn.headers.getSetCookie().find((c) => c.includes('session_token'))
  if (!cookie) throw new Error('the sign-in set no cookie')
  return cookie.split(';')[0] as string
}

describe('memberOfRequest', () => {
  let dir: string
  let store: SessionStore
  let workspace: WorkspaceIdentity
  let alice: string
  let bob: string

  const signIn = async (email: string, password: string): Promise<IssuedSignIn> => {
    const issued = await workspace.core.signIn.password(
      { email, password, device: { kind: 'browser' }, delivery: 'cookie' },
      https(),
    )
    if ('refused' in issued) throw new Error(`sign-in refused: ${issued.refused}`)
    return issued
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'podium-member-of-request-'))
    store = await openTestStore(join(dir, 'podium.db'))
    const core = await createIdentityCore({
      database: store.identityDatabase(),
      secret: 'member-of-request-test-secret-0123456789',
      loginMethods: { password: true },
      mail: null,
      selfSignUp: false,
      accounts: 'local',
      hosts: { kind: 'self-hosted' },
      sameMachine: { waived: () => false },
      passwordHashing: {
        hash: hashPassword,
        verify: ({ password, hash }) => verifyPasswordHash(password, hash),
        isHash: isPasswordHash,
      },
      rateLimit: { storage: 'memory' },
      newMemberId,
    })
    workspace = core.workspace('local', { rows: store.users.memberRows, sameDatabase: true })
    alice = (
      await workspace.memberships.adopt({
        by: 'setup',
        role: 'admin',
        status: 'active',
        account: {
          kind: 'new',
          name: 'Alice',
          email: 'alice@example.test',
          password: 'alice pw 1',
        },
      })
    ).memberId
    const { invitation } = await workspace.memberships.invite({
      actor: { memberId: alice },
      role: 'member',
      email: 'bob@example.test',
    })
    bob = (
      await workspace.memberships.accept({
        token: invitation.token,
        account: { kind: 'new', name: 'Bob', email: 'bob@example.test', password: 'bob pw 22' },
      })
    ).memberId
  })

  afterEach(async () => {
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const resolver = (identity: WorkspaceIdentity = workspace) =>
    createMemberOfRequest({ identity, users: store.users, trustedProxyHops: 0 })

  it("resolves each caller's own member from their own sign-in", async () => {
    const memberOfRequest = resolver()
    const asAlice = await memberOfRequest(
      request('https://podium.example.test/trpc/x', {
        cookie: cookieOf(await signIn('alice@example.test', 'alice pw 1')),
      }),
    )
    const bobSignIn = await signIn('bob@example.test', 'bob pw 22')
    const asBob = await memberOfRequest(
      request('https://podium.example.test/trpc/x', { cookie: cookieOf(bobSignIn) }),
    )
    expect(asAlice).toMatchObject({ kind: 'member', memberId: alice, role: 'admin' })
    expect(asBob).toMatchObject({
      kind: 'member',
      memberId: bob,
      role: 'member',
      principal: { kind: 'user', user: bob },
      deviceSignIn: { id: bobSignIn.deviceSignInId, kind: 'browser' },
    })
  })

  it('answers 401 unauthorized for a request without a sign-in', async () => {
    const resolution = await resolver()(request('https://podium.example.test/trpc/x'))
    expect(resolution).toEqual({ kind: 'unauthenticated' })
    expect(refusalAnswer(resolution as MemberRefusal)).toEqual({
      status: 401,
      body: { error: 'unauthorized' },
    })
  })

  it('refuses a malformed or unknown bearer even when a valid cookie comes with it', async () => {
    const cookie = cookieOf(await signIn('alice@example.test', 'alice pw 1'))
    const memberOfRequest = resolver()
    // Control: the cookie alone is Alice.
    expect(
      await memberOfRequest(request('https://podium.example.test/trpc/x', { cookie })),
    ).toMatchObject({ kind: 'member', memberId: alice })
    for (const bearer of ['garbage', 'not.signed', 'Zm9v.YmFy']) {
      const resolution = await memberOfRequest(
        request('https://podium.example.test/trpc/x', {
          cookie,
          authorization: `Bearer ${bearer}`,
        }),
      )
      // The request named its credential; a bad one is not rescued by the cookie.
      expect(resolution).toEqual({ kind: 'unauthenticated' })
      expect(refusalAnswer(resolution as MemberRefusal).status).toBe(401)
    }
  })

  it('answers 400 https_required over plain HTTP from another machine, whatever it carries', async () => {
    const cookie = cookieOf(await signIn('alice@example.test', 'alice pw 1'))
    const resolution = await resolver()(request('http://192.168.1.20:18787/trpc/x', { cookie }))
    expect(resolution).toEqual({ kind: 'https_required' })
    expect(refusalAnswer(resolution as MemberRefusal)).toEqual({
      status: 400,
      body: { error: 'https_required' },
    })
  })

  it('answers 403 not_workspace_member for a signed-in account whose member row is missing or disabled', async () => {
    const cookie = cookieOf(await signIn('bob@example.test', 'bob pw 22'))
    // The hosted window before a membership is applied: the membership is
    // active and the workspace database has no usable row for it yet.
    const memberOfRequest = createMemberOfRequest({
      identity: workspace,
      users: { get: async () => undefined },
      trustedProxyHops: 0,
    })
    const resolution = await memberOfRequest(
      request('https://podium.example.test/trpc/x', { cookie }),
    )
    expect(resolution).toMatchObject({ kind: 'not-a-member' })
    expect(refusalAnswer(resolution as MemberRefusal)).toEqual({
      status: 403,
      body: { error: 'not_workspace_member' },
    })
  })

  it('answers 403 for a membership the package reports as not active', async () => {
    const identity: WorkspaceIdentity = {
      ...workspace,
      resolve: async () => ({ kind: 'not-a-member', accountId: 'acct', membership: 'disabled' }),
    }
    const resolution = await resolver(identity)(request('https://podium.example.test/trpc/x'))
    expect(resolution).toEqual({ kind: 'not-a-member', accountId: 'acct' })
    expect(refusalAnswer(resolution as MemberRefusal).status).toBe(403)
  })

  it('refuses a disabled member: the sign-in is gone and the answer is 401', async () => {
    const cookie = cookieOf(await signIn('bob@example.test', 'bob pw 22'))
    await workspace.memberships.disable({ actor: { memberId: alice }, memberId: bob })
    const resolution = await resolver()(request('https://podium.example.test/trpc/x', { cookie }))
    expect(resolution).toEqual({ kind: 'unauthenticated' })
  })

  it('takes the role from the member row, which every gate behind it reads', async () => {
    const cookie = cookieOf(await signIn('bob@example.test', 'bob pw 22'))
    const memberOfRequest = createMemberOfRequest({
      identity: workspace,
      users: { get: async (id) => (id === asUserId(bob) ? { role: 'admin' } : undefined) },
      trustedProxyHops: 0,
    })
    expect(
      await memberOfRequest(request('https://podium.example.test/trpc/x', { cookie })),
    ).toMatchObject({ kind: 'member', memberId: bob, role: 'admin' })
  })

  it('resolves once per Request object', async () => {
    let calls = 0
    const identity: WorkspaceIdentity = {
      ...workspace,
      resolve: (req, facts) => {
        calls += 1
        return workspace.resolve(req, facts)
      },
    }
    const memberOfRequest = resolver(identity)
    const one = request('https://podium.example.test/trpc/x')
    await Promise.all([memberOfRequest(one), memberOfRequest(one)])
    await memberOfRequest(one)
    expect(calls).toBe(1)
    await memberOfRequest(request('https://podium.example.test/trpc/x'))
    expect(calls).toBe(2)
  })

  it('works out the connection facts at the server boundary', () => {
    const { factsOf } = resolver()
    expect(factsOf(request('http://127.0.0.1:18787/x', {}, '127.0.0.1'))).toEqual({
      scheme: 'http',
      sameMachine: true,
      clientAddress: '127.0.0.1',
    })
    // No trusted hop: a forwarded scheme is not read, and it marks the request as proxied.
    expect(
      factsOf(request('http://127.0.0.1:18787/x', { 'x-forwarded-proto': 'https' }, '127.0.0.1')),
    ).toEqual({ scheme: 'http', sameMachine: false, clientAddress: '127.0.0.1' })
    const trusting = createMemberOfRequest({
      identity: workspace,
      users: store.users,
      trustedProxyHops: 1,
    })
    expect(
      trusting.factsOf(
        request(
          'http://127.0.0.1:18787/x',
          { 'x-forwarded-proto': 'https', 'x-forwarded-for': '198.51.100.4' },
          '127.0.0.1',
        ),
      ),
    ).toEqual({ scheme: 'https', sameMachine: false, clientAddress: '198.51.100.4' })
  })
})
