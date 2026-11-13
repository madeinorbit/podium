/**
 * From a request to a member, and the answer for everybody else (POD-6746;
 * docs/design/people-and-sign-in.md, sections 5.1 and 5.2).
 *
 * The server's real store and a real identity core on it: Alice is the admin,
 * Bob a member, each signed in through the package.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createIdentityCore, type IssuedSignIn, type WorkspaceIdentity } from '@podium/identity'
import { asUserId, newMemberId } from '@podium/model'
import { httpsRequiredRefusal } from '@podium/protocol'
import { hashPassword, isPasswordHash, verifyPasswordHash } from '@podium/runtime/auth-store'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionStore } from '../store'
import { openTestStore } from '../test-support/open-test-store'
import {
  createMemberOfRequest,
  isNearbyProxyAddress,
  type MemberRefusal,
  refusalAnswer,
} from './member-of-request'

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

/** Password hashes made and checked, so a test can compare the work of two refusals. */
let hashingWork = 0

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
        hash: (password) => {
          hashingWork += 1
          return hashPassword(password)
        },
        verify: ({ password, hash }) => {
          hashingWork += 1
          return verifyPasswordHash(password, hash)
        },
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
      body: httpsRequiredRefusal(),
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

  it('refuses a bearer over loopback HTTP even with a valid device cookie', async () => {
    const accountId = (await store.users.get(asUserId(alice)))?.accountId
    if (!accountId) throw new Error('Alice has no account')
    const loopback = await workspace.core.deviceSignIns.create(
      accountId,
      { kind: 'browser' },
      'cookie',
      { scheme: 'http', sameMachine: true, clientAddress: '127.0.0.1' },
    )
    const memberOfRequest = resolver()
    const cookie = cookieOf(loopback)
    const url = 'http://127.0.0.1:18787/auth/client-sessions'
    expect(await memberOfRequest(request(url, { cookie }, '127.0.0.1'))).toMatchObject({
      kind: 'member',
      memberId: alice,
    })
    expect(
      await memberOfRequest(
        request(
          url,
          {
            cookie,
            authorization: 'Bearer malformed',
          },
          '127.0.0.1',
        ),
      ),
    ).toEqual({ kind: 'https_required' })
  })

  it('a password reset ends every other live reset code of the account', async () => {
    // Two recovery links exist for Bob. Redeeming the first after a presumed
    // compromise must end the second, or whoever still holds it could replace
    // the password again after Bob recovers (POD-6754 finding F3).
    const bobAccount = (await workspace.memberships.list()).find(
      (member) => member.memberId === bob,
    )?.account?.id
    expect(bobAccount).toBeDefined()
    const first = await workspace.core.codes.issue({
      purpose: 'password-reset',
      accountId: bobAccount as string,
      createdBy: 'reset-test',
    })
    const second = await workspace.core.codes.issue({
      purpose: 'password-reset',
      accountId: bobAccount as string,
      createdBy: 'reset-test',
    })
    expect(
      await workspace.core.codes.redeemPasswordReset({
        code: first.code,
        password: 'recovered password one',
      }),
    ).toBeDefined()
    expect(
      await workspace.core.codes.redeemPasswordReset({
        code: second.code,
        password: 'recovered password two',
      }),
    ).toBeUndefined()
  })

  it('a password reset ends an approved pairing before it signs in', async () => {
    // A phone pairing is approved, then Bob resets his password to recover from
    // a compromise. The approved pairing is not a device sign-in yet; the reset
    // must still end it, or completing it afterwards mints a fresh 30-day phone
    // sign-in (POD-6754 finding F3).
    const bobAccount = (await workspace.memberships.list()).find(
      (member) => member.memberId === bob,
    )?.account?.id
    expect(bobAccount).toBeDefined()
    const verifier = 'phone-verifier-for-the-reset'
    const challenge = createHash('sha256').update(verifier).digest('hex')
    const pairing = await workspace.core.codes.issue({
      purpose: 'pair-device',
      accountId: bobAccount as string,
      createdBy: 'reset-test',
    })
    const claimed = await workspace.core.codes.claim({
      code: pairing.code,
      challenge,
      device: { kind: 'phone', deviceId: 'reset-phone', name: 'Reset phone' },
      delivery: 'bearer',
    })
    expect(claimed).toBeDefined()
    expect(await workspace.core.codes.decide(pairing.id, bobAccount as string, 'approved')).toBe(
      true,
    )
    const reset = await workspace.core.codes.issue({
      purpose: 'password-reset',
      accountId: bobAccount as string,
      createdBy: 'reset-test',
    })
    expect(
      await workspace.core.codes.redeemPasswordReset({
        code: reset.code,
        password: 'recovered password',
      }),
    ).toBeDefined()
    expect(
      await workspace.core.codes.redeem(
        { claimId: claimed?.claimId as string, verifier },
        { kind: 'phone' },
        'bearer',
        { scheme: 'https', sameMachine: false, clientAddress: '198.51.100.9' },
      ),
    ).toBeUndefined()
  })

  it("a password reset ends the account's unclaimed codes and leaves other accounts' codes", async () => {
    const members = await workspace.memberships.list()
    const accountOf = (memberId: string) =>
      members.find((member) => member.memberId === memberId)?.account?.id as string
    const pairing = await workspace.core.codes.issue({
      purpose: 'pair-device',
      accountId: accountOf(bob),
      createdBy: 'reset-test',
    })
    const hostSignIn = await workspace.core.codes.issue({
      purpose: 'host-sign-in',
      accountId: accountOf(bob),
      createdBy: 'reset-test',
    })
    const alicesReset = await workspace.core.codes.issue({
      purpose: 'password-reset',
      accountId: accountOf(alice),
      createdBy: 'reset-test',
    })
    const reset = await workspace.core.codes.issue({
      purpose: 'password-reset',
      accountId: accountOf(bob),
      createdBy: 'reset-test',
    })
    expect(
      await workspace.core.codes.redeemPasswordReset({ code: reset.code, password: 'recovered' }),
    ).toBeDefined()
    const afterReset = {
      pairing: await workspace.core.codes.status(pairing.id, accountOf(bob)),
      hostSignIn: await workspace.core.codes.redeem(
        { code: hostSignIn.code, purpose: 'host-sign-in' },
        { kind: 'browser' },
        'cookie',
        { scheme: 'https', sameMachine: true, clientAddress: '127.0.0.1' },
      ),
    }
    expect(afterReset).toEqual({ pairing: { state: 'expired' }, hostSignIn: undefined })
    expect(await workspace.core.codes.inspectPasswordReset(alicesReset.code)).toMatchObject({
      accountId: accountOf(alice),
    })
  })

  it('a refused sign-in costs the same password work for a member and anybody else', async () => {
    // The answer is the same 401 either way; the work must be too, or the
    // response time tells an active member's address from any other (POD-6754
    // finding F4).
    const workOf = async (email: string) => {
      const before = hashingWork
      const answer = await workspace.core.signIn.password(
        { email, password: 'a wrong guess', device: { kind: 'browser' }, delivery: 'cookie' },
        https(),
      )
      expect(answer).toEqual({ refused: 'invalid' })
      return hashingWork - before
    }
    // The stand-in hash is made once, on first use.
    await workOf('warm-up@example.test')
    const member = await workOf('bob@example.test')
    expect(member).toBeGreaterThan(0)
    await workspace.memberships.disable({ actor: { memberId: alice }, memberId: bob })
    expect({
      unknown: await workOf('nobody@example.test'),
      disabled: await workOf('bob@example.test'),
      reserved: await workOf('someone@no-email.invalid'),
    }).toEqual({ unknown: member, disabled: member, reserved: member })
  })

  it('a source churning made-up addresses is throttled alone; members elsewhere still sign in', async () => {
    // Without a source budget, made-up addresses fill the lock table; a full
    // table must deny nobody else (POD-6754 finding F1, review).
    const from = (clientAddress: string) =>
      ({ scheme: 'https', sameMachine: false, clientAddress }) as const
    const attempt = (email: string, password: string, clientAddress: string) =>
      workspace.core.signIn.password(
        { email, password, device: { kind: 'browser' }, delivery: 'cookie' },
        from(clientAddress),
      )
    const answers = []
    for (let n = 0; n < 40; n += 1) {
      answers.push(await attempt(`made-up-${n}@example.test`, 'guess', '198.51.100.77'))
    }
    expect(
      answers.slice(0, 30).every((answer) => 'refused' in answer && answer.refused === 'invalid'),
    ).toBe(true)
    expect(
      answers.slice(30).every((answer) => 'refused' in answer && answer.refused === 'throttled'),
    ).toBe(true)
    // The attacking source is refused even with the right password...
    expect(await attempt('bob@example.test', 'bob pw 22', '198.51.100.77')).toMatchObject({
      refused: 'throttled',
    })
    // ...and Bob, from his own address, is not.
    expect('refused' in (await attempt('bob@example.test', 'bob pw 22', '198.51.100.78'))).toBe(
      false,
    )
  })

  it('a spoofed X-Forwarded-For does not opt a client out of its source budget', async () => {
    // Podium ends TLS itself and the peer is public: forwarding headers are the
    // client's own word, so the peer is budgeted (POD-6754 finding F1, review).
    const { factsOf } = resolver()
    const attempt = (email: string, password: string, peer: string, spoofed: string) =>
      workspace.core.signIn.password(
        { email, password, device: { kind: 'browser' }, delivery: 'cookie' },
        factsOf(
          request(
            'https://podium.example/auth/login',
            { 'x-forwarded-for': spoofed, 'x-real-ip': spoofed },
            peer,
          ),
        ),
      )
    const answers = []
    for (let n = 0; n < 31; n += 1) {
      answers.push(
        await attempt(`made-up-${n}@example.test`, 'guess', '203.0.113.66', `10.0.0.${n}`),
      )
    }
    expect(
      answers.slice(0, 30).every((answer) => 'refused' in answer && answer.refused === 'invalid'),
    ).toBe(true)
    expect(answers[30]).toMatchObject({ refused: 'throttled' })
    // Another client is not affected.
    expect(
      'refused' in (await attempt('bob@example.test', 'bob pw 22', '198.51.100.20', '10.0.0.1')),
    ).toBe(false)
  })

  it('an unknown source keeps the per-identifier budget and no shared library bucket', async () => {
    // A source is unknown behind a nearby proxy no hop is trusted for. Its
    // failures charge no source, and the library must not fall back to one
    // bucket shared by every caller (POD-6754 finding F1, review).
    const attempt = (email: string, password: string) =>
      workspace.core.signIn.password(
        { email, password, device: { kind: 'browser' }, delivery: 'cookie' },
        { scheme: 'https', sameMachine: false, clientAddress: null },
      )
    const answers = []
    for (let n = 0; n < 40; n += 1)
      answers.push(await attempt(`made-up-${n}@example.test`, 'guess'))
    expect(answers.every((answer) => 'refused' in answer && answer.refused === 'invalid')).toBe(
      true,
    )
    for (let n = 0; n < 4; n += 1) {
      expect(await attempt('alice@example.test', 'not alice')).toEqual({ refused: 'invalid' })
    }
    expect('refused' in (await attempt('bob@example.test', 'bob pw 22'))).toBe(false)
    // The per-identifier layer still holds on its own.
    for (let n = 0; n < 4; n += 1) await attempt('alice@example.test', 'not alice')
    expect(await attempt('alice@example.test', 'alice pw 1')).toMatchObject({
      refused: 'throttled',
    })
  })

  it('knows which peers can only be a nearby proxy', () => {
    const nearby = [
      '10.1.2.3',
      '127.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.20',
      '100.64.0.1',
      '100.127.255.254',
      '169.254.1.1',
      '::ffff:10.0.0.1',
      '::1',
      'fd12:3456::1',
      'fc00::1',
      'fe80::1',
      '[fe80::1%eth0]',
      'febf::1',
    ]
    const other = [
      '172.15.0.1',
      '172.32.0.1',
      '100.63.255.255',
      '100.128.0.1',
      '203.0.113.5',
      '8.8.8.8',
      '::ffff:203.0.113.5',
      '2001:db8::1',
      'fc::1',
      'fe7f::1',
      'fec0::1',
      '',
      'not an address',
    ]
    expect(nearby.filter((address) => !isNearbyProxyAddress(address))).toEqual([])
    expect(other.filter((address) => isNearbyProxyAddress(address))).toEqual([])
    expect(isNearbyProxyAddress(undefined)).toBe(false)
  })

  it('works out the connection facts at the server boundary', () => {
    const { factsOf } = resolver()
    expect(factsOf(request('http://127.0.0.1:18787/x', {}, '127.0.0.1'))).toEqual({
      scheme: 'http',
      sameMachine: true,
      clientAddress: '127.0.0.1',
    })
    // No trusted hop: a forwarded scheme is not read, and it marks the request as
    // proxied. Over plain HTTP from a nearby proxy's address, the peer is shared
    // by every client behind it, so the source is unknown.
    expect(
      factsOf(request('http://127.0.0.1:18787/x', { 'x-forwarded-proto': 'https' }, '127.0.0.1')),
    ).toEqual({ scheme: 'http', sameMachine: false, clientAddress: null })
    expect(
      factsOf(
        request('http://podium.example/x', { 'x-forwarded-for': '203.0.113.5' }, '172.18.0.2'),
      ),
    ).toEqual({ scheme: 'http', sameMachine: false, clientAddress: null })
    // A public peer is budgeted by itself, whatever it sends.
    expect(
      factsOf(request('http://podium.example/x', { 'x-forwarded-for': '10.0.0.1' }, '203.0.113.5')),
    ).toEqual({ scheme: 'http', sameMachine: false, clientAddress: '203.0.113.5' })
    // Podium ended TLS itself: the peer is budgeted, even a nearby one.
    expect(
      factsOf(
        request('https://podium.example/x', { 'x-forwarded-for': '203.0.113.5' }, '172.18.0.2'),
      ),
    ).toEqual({ scheme: 'https', sameMachine: false, clientAddress: '172.18.0.2' })
    // A direct client keeps its own address.
    expect(factsOf(request('https://podium.example/x', {}, '203.0.113.5'))).toEqual({
      scheme: 'https',
      sameMachine: false,
      clientAddress: '203.0.113.5',
    })
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
