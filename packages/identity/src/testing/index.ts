/**
 * The shared identity suite (people and sign-in specification, section 10).
 *
 * One suite, two legs: the open-source repository runs it on SQLite with the
 * server's own store, podium-cloud runs it on Postgres. Every case runs on both
 * databases, under the self-hosted and under the cloud configuration.
 *
 * The suite imports no test runner. The leg passes its runner's functions, so a
 * leg in another repository registers the cases with its own runner.
 *
 * Two people throughout: Alice and Bob. Alice is the untouched control wherever
 * a case changes Bob, and the other way round.
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { buildIdentity } from '../core'
import type { Runtime } from '../runtime'
import { isGeneratedIdentifier, sha256Hex, signToken, storedTokenForm } from '../secrets'
import {
  type Account,
  type Capabilities,
  type ConnectionFacts,
  type IdentityConfig,
  type IdentityCore,
  type IdentityDatabase,
  IdentityRefused,
  type IssuedSignIn,
  type MemberRows,
  type WorkspaceIdentity,
} from '../types'
import { MEMBERSHIP_SUITE_CASES, membershipCases } from './memberships'

export const IDENTITY_SUITE_CASES = [
  'self sign-up off refuses the library sign-up; an account is created server-side',
  'password sign-in, a wrong password and sign-out; an existing edition hash verifies',
  'the stored device sign-in token opens nothing',
  'a cookie and a signed bearer resolve to the same account in one statement',
  'renewal extends the expiry and keeps the token; a fixed expiry is never renewed',
  'the device list marks the current sign-in; revoking one ends that one only',
  'a one-time code works once and expires; an account with no login method signs in by code',
  'a receiver-bound code needs the right verifier; the fifth wrong one denies it',
  'a hand-over: begin, authorise, redeem; it ends with the authorising sign-in',
  'a password-reset code sets the password once and ends the device sign-ins',
  'the capability list of the self-hosted and of the cloud configuration',
  'plain HTTP that is not same-machine is refused; the two cookie names',
  'library writes inside a package transaction roll back with it',
  ...MEMBERSHIP_SUITE_CASES,
] as const

/** The test functions of whichever runner executes the leg. The suite imports no runner. */
export interface SuiteRunner {
  describe(name: string, fn: () => void): void
  it(name: string, fn: () => Promise<void>): void
  beforeEach(fn: () => Promise<void>): void
  afterEach(fn: () => Promise<void>): void
  // biome-ignore lint/suspicious/noExplicitAny: the matcher object of the leg's runner
  expect: (value: unknown) => any
}

export interface MemberRowState {
  memberId: string
  /** A leg whose member rows cannot tell removed from disabled answers 'disabled' for both. */
  state: 'active' | 'disabled' | 'removed'
  role: 'admin' | 'member'
  accountId: string | null
  /** The membership version last applied to the row. */
  version: number
  /** The member's authorization generation. */
  generation: number
  name: string
  email: string | null
}

/** The logical tables a leg can read raw, to assert what is stored. */
export type StoredTable =
  | 'user'
  | 'account'
  | 'session'
  | 'oneTimeCode'
  | 'membership'
  | 'invitation'

export interface OpenedDatabase {
  database: IdentityDatabase
  memberRows: MemberRows & { read(memberId: string): Promise<MemberRowState | undefined> }
  /** Raw read of a column (its database name), to assert what is stored. */
  stored(table: StoredTable, column: string): Promise<unknown[]>
  /** How many statements reached the driver so far. */
  statements(): number
  /** PostgreSQL legs expose overlap, so concurrent accepts cannot silently serialize. */
  maximumConcurrentTransactions?(): number
  /** Hold the next two PostgreSQL transactions open until both begin. */
  armConcurrentTransactions?(): void
  close(): Promise<void>
}

export interface SuiteHarness {
  name: 'sqlite' | 'postgres'
  /** A fresh, migrated, empty database for one case, and its member rows. */
  open(): Promise<OpenedDatabase>
  /**
   * The self-hosted edition's password functions. The SQLite leg passes the
   * server's own; without them the suite uses a stand-in of the same shape.
   */
  passwordHashing?: NonNullable<IdentityConfig['passwordHashing']>
  /**
   * How the leg's member rows mint an id. The SQLite leg passes the server's
   * own; without it the suite uses a stand-in of the same shape.
   */
  newMemberId?: () => string
}

export interface IdentitySuiteRun {
  /**
   * The names of the cases that ran to their end under both configurations,
   * for the leg's own "every case ran" test.
   */
  casesRun(): string[]
}

const SECRET = 'identity-suite-secret-identity-suite-secret-01'
const ALICE_PASSWORD = 'alice correct horse battery'
const BOB_PASSWORD = 'bob staple tractor window'
const DAY = 86_400_000

/** A stand-in for an edition's own password functions: scrypt, in its own format. */
const standInHashing: NonNullable<IdentityConfig['passwordHashing']> = {
  hash: (password) =>
    new Promise((resolve, reject) => {
      const salt = randomBytes(16)
      scrypt(password, salt, 32, (error, key) =>
        error ? reject(error) : resolve(`suite$${salt.toString('hex')}$${key.toString('hex')}`),
      )
    }),
  isHash: (value) => /^suite\$[0-9a-f]{32}\$[0-9a-f]{64}$/.test(value),
  verify: ({ password, hash }) =>
    new Promise((resolve, reject) => {
      const [tag, salt, key] = hash.split('$')
      if (tag !== 'suite' || !salt || !key) return resolve(false)
      scrypt(password, Buffer.from(salt, 'hex'), 32, (error, derived) =>
        error ? reject(error) : resolve(timingSafeEqual(derived, Buffer.from(key, 'hex'))),
      )
    }),
}

/** A stand-in for the server's member ids: the prefix and 27 characters. */
const standInMemberId = () => `mem_${randomBytes(21).toString('base64url').slice(0, 27)}`

type Edition = 'self-hosted' | 'cloud'

interface Sent {
  to: string
  subject: string
  text: string
}

export const SUITE_SELF_HOSTED_CAPABILITIES: Capabilities = {
  version: 1,
  passwordSignIn: true,
  providers: [],
  selfSignUp: false,
  invitationDelivery: 'link',
  passwordReset: 'admin-link',
  emailVerification: false,
  organisations: false,
  sameMachineSignIn: true,
  adminSignOutEverywhere: true,
  adminEndDeviceSignIn: true,
  accountUrl: null,
}

export const SUITE_CLOUD_CAPABILITIES: Capabilities = {
  version: 1,
  passwordSignIn: true,
  providers: ['google', 'github'],
  selfSignUp: true,
  invitationDelivery: 'mail',
  passwordReset: 'mail',
  emailVerification: true,
  organisations: true,
  sameMachineSignIn: false,
  adminSignOutEverywhere: false,
  adminEndDeviceSignIn: false,
  accountUrl: 'https://app.podium.test/account',
}

/** The two edition configurations of specification section 2.1, on the leg's database. */
function editionConfig(
  edition: Edition,
  harness: SuiteHarness,
  database: IdentityDatabase,
  clock: () => Date,
  mailbox: Sent[],
): IdentityConfig {
  if (edition === 'self-hosted') {
    return {
      database,
      secret: SECRET,
      loginMethods: { password: true },
      mail: null,
      selfSignUp: false,
      accounts: 'local',
      hosts: { kind: 'self-hosted' },
      sameMachine: { waived: () => false },
      passwordHashing: harness.passwordHashing ?? standInHashing,
      rateLimit: { storage: 'memory' },
      newMemberId: harness.newMemberId ?? standInMemberId,
      now: clock,
    }
  }
  let minted = 0
  return {
    database,
    secret: SECRET,
    loginMethods: {
      password: true,
      google: { clientId: 'suite-google', clientSecret: 'suite-google-secret' },
      github: { clientId: 'suite-github', clientSecret: 'suite-github-secret' },
    },
    mail: {
      async send(message) {
        mailbox.push(message)
      },
    },
    selfSignUp: true,
    accounts: 'shared',
    hosts: {
      kind: 'fixed',
      authUrl: 'https://api.podium.test',
      appOrigin: 'https://app.podium.test',
      cookieDomain: 'podium.test',
    },
    sameMachine: null,
    // The rate limit table exists only on Postgres.
    rateLimit: { storage: harness.name === 'postgres' ? 'database' : 'memory' },
    libraryRoutes: {
      basePath: '/platform/auth',
      // The capability list reads the organisation extension by its id. The
      // extension itself needs the cloud's organisation tables, which are not
      // this package's, so the suite stands a bare one in.
      extensions: [{ id: 'organization' }],
    },
    generateId: (model) => `${model}_${++minted}_${randomBytes(9).toString('base64url')}`,
    newMemberId: harness.newMemberId ?? standInMemberId,
    now: clock,
  }
}

export function identitySuite(runner: SuiteRunner, harness: SuiteHarness): IdentitySuiteRun {
  const { describe, it, beforeEach, afterEach, expect } = runner
  /** Case name to the editions it ran under. */
  const ran = new Map<string, Set<string>>()

  for (const edition of ['self-hosted', 'cloud'] as const) {
    describe(`identity suite on ${harness.name}, ${edition} configuration`, () => {
      let opened: Awaited<ReturnType<SuiteHarness['open']>>
      let core: IdentityCore
      let runtime: Runtime
      let workspace: WorkspaceIdentity
      let alice: Account
      let bob: Account
      let mailbox: Sent[]
      /** Milliseconds the package's clock runs ahead of the real one. */
      let ahead = 0
      let addresses = 0

      const clock = () => new Date(Date.now() + ahead)
      /** An HTTPS request from a client address of its own, so one case never exhausts another's budget. */
      const https = (): ConnectionFacts => {
        addresses += 1
        return {
          scheme: 'https',
          sameMachine: false,
          clientAddress: `10.${(addresses >> 16) & 255}.${(addresses >> 8) & 255}.${addresses & 255}`,
        }
      }
      const loopback = (): ConnectionFacts => ({
        scheme: 'http',
        sameMachine: true,
        clientAddress: '127.0.0.1',
      })
      const plainNetwork = (): ConnectionFacts => ({
        scheme: 'http',
        sameMachine: false,
        clientAddress: '192.168.1.20',
      })

      const issued = (value: unknown): IssuedSignIn => {
        expect(typeof value === 'object' && value !== null && 'deviceSignInId' in value).toBe(true)
        return value as IssuedSignIn
      }
      /** The `name=value` pair of the session cookie an issued sign-in set. */
      const cookiePair = (signIn: IssuedSignIn): string => {
        const cookie = signIn.headers.getSetCookie().find((c) => c.includes('session_token'))
        expect(cookie === undefined).toBe(false)
        return (cookie as string).split(';')[0] as string
      }
      /** The signed value (token.signature) of a sign-in, however it was delivered. */
      const signedValue = (signIn: IssuedSignIn): string => {
        if (signIn.bearer) return signIn.bearer
        const pair = cookiePair(signIn)
        return decodeURIComponent(pair.slice(pair.indexOf('=') + 1))
      }
      const rawToken = (signIn: IssuedSignIn): string => {
        const signed = signedValue(signIn)
        return signed.slice(0, signed.lastIndexOf('.'))
      }
      const withCookie = (pair: string) =>
        new Request('https://unused.invalid/', { headers: { cookie: pair } })
      const withBearer = (signed: string) =>
        new Request('https://unused.invalid/', { headers: { authorization: `Bearer ${signed}` } })
      const requestOf = (signIn: IssuedSignIn) =>
        signIn.bearer ? withBearer(signIn.bearer) : withCookie(cookiePair(signIn))
      /** The account a sign-in resolves to over HTTPS, or the kind of refusal. */
      const resolved = async (signIn: IssuedSignIn): Promise<string> => {
        const resolution = await core.credentials.resolve(requestOf(signIn), https())
        return resolution.kind === 'device-sign-in' ? resolution.accountId : resolution.kind
      }
      const signInAs = async (
        email: string,
        password: string,
        delivery: 'cookie' | 'bearer' = 'cookie',
      ) =>
        await core.signIn.password(
          {
            email,
            password,
            device: { kind: delivery === 'bearer' ? 'phone' : 'browser' },
            delivery,
          },
          https(),
        )
      const refusedWith = async (run: () => Promise<unknown>): Promise<string> => {
        try {
          await run()
        } catch (error) {
          return error instanceof IdentityRefused ? error.code : `threw ${String(error)}`
        }
        return 'did not throw'
      }

      /**
       * Makes an account an active member of the workspace. A local account
       * signs in only while it has an active membership, so every person of
       * these cases is a member: Alice the first admin, the others invited by
       * the host and accepted.
       */
      const admit = async (account: Account): Promise<void> => {
        if (edition === 'cloud')
          await runtime.library.internalAdapter.updateUser(account.id, { emailVerified: true })
        const ref = { kind: 'existing' as const, accountId: account.id }
        if ((await workspace.memberships.list()).length === 0) {
          await workspace.memberships.adopt({
            by: 'setup',
            role: 'admin',
            status: 'active',
            account: ref,
          })
          return
        }
        const { invitation } = await workspace.memberships.invite({
          actor: { system: 'host' },
          role: 'member',
          ...(edition === 'cloud' ? { email: account.email! } : {}),
        })
        await workspace.memberships.accept({ token: invitation.token, account: ref })
      }

      beforeEach(async () => {
        ahead = 0
        mailbox = []
        opened = await harness.open()
        const built = await buildIdentity(
          editionConfig(edition, harness, opened.database, clock, mailbox),
        )
        core = built.core
        runtime = built.runtime
        workspace = core.workspace('local', { rows: opened.memberRows, sameDatabase: true })
        alice = await core.accounts.create({
          name: 'Alice',
          email: 'alice@example.test',
          password: ALICE_PASSWORD,
        })
        bob = await core.accounts.create({
          name: 'Bob',
          email: 'bob@example.test',
          password: BOB_PASSWORD,
        })
        await admit(alice)
        await admit(bob)
      })
      afterEach(async () => {
        await opened.close()
      })

      const test = (index: number, fn: () => Promise<void>) => {
        const name = IDENTITY_SUITE_CASES[index] as string
        it(name, async () => {
          await fn()
          ran.set(name, (ran.get(name) ?? new Set()).add(edition))
        })
      }

      // 1 -----------------------------------------------------------------
      test(0, async () => {
        const before = (await opened.stored('user', 'email')).length
        const configuration = runtime.configurationFor(https())
        expect(configuration === undefined).toBe(false)
        const { response } = await runtime.callLibrary(configuration as never, {
          method: 'POST',
          path: '/sign-up/email',
          facts: https(),
          body: { name: 'Mallory', email: 'mallory@example.test', password: 'mallory password 1' },
        })
        if (edition === 'self-hosted') {
          // Self sign-up is off: the library refuses and creates no row.
          expect(response.ok).toBe(false)
          expect((await opened.stored('user', 'email')).length).toBe(before)
          expect(await core.accounts.byEmail('mallory@example.test')).toBe(undefined)
        } else {
          // The cloud lets a person sign up, and mails them to verify.
          expect(response.ok).toBe(true)
          expect((await opened.stored('user', 'email')).length).toBe(before + 1)
          expect(mailbox.some((mail) => mail.to === 'mallory@example.test')).toBe(true)
        }

        // Server-side creation needs no sign-up, in either edition.
        const carol = await core.accounts.create({ name: 'Carol', email: ' Carol@Example.Test ' })
        expect(carol.email).toBe('carol@example.test')
        expect((await core.accounts.get(carol.id))?.name).toBe('Carol')
        expect(await core.accounts.hasPassword(carol.id)).toBe(false)

        // A person without an address gets a generated identifier that is never shown.
        const dave = await core.accounts.create({ name: 'Dave' })
        expect(dave.email).toBe(null)
        const identifiers = (await opened.stored('user', 'email')) as string[]
        expect(identifiers.filter((value) => isGeneratedIdentifier(value)).length).toBe(1)
        expect(
          await refusedWith(() =>
            core.accounts.create({ name: 'Eve', email: 'eve@no-email.invalid' }),
          ),
        ).toBe('email-invalid')
        expect(
          await refusedWith(() =>
            core.accounts.create({ name: 'Al', email: 'alice@example.test' }),
          ),
        ).toBe('email-taken')
        // A generated identifier becomes a real address, and never the reverse.
        await core.accounts.setEmail(dave.id, 'dave@example.test')
        expect((await core.accounts.get(dave.id))?.email).toBe('dave@example.test')
        expect(await refusedWith(() => core.accounts.setEmail(dave.id, 'bob@example.test'))).toBe(
          'email-taken',
        )
        // Alice is untouched.
        expect((await core.accounts.get(alice.id))?.email).toBe('alice@example.test')
      })

      // 2 -----------------------------------------------------------------
      test(1, async () => {
        const aliceSignIn = issued(await signInAs('alice@example.test', ALICE_PASSWORD))
        const bobSignIn = issued(await signInAs('BOB@example.test', BOB_PASSWORD))
        expect(aliceSignIn.accountId).toBe(alice.id)
        expect(await resolved(aliceSignIn)).toBe(alice.id)
        expect(await resolved(bobSignIn)).toBe(bob.id)

        // A wrong password, and another person's password, get the same answer.
        expect(await signInAs('alice@example.test', 'not her password')).toEqual({
          refused: 'invalid',
        })
        expect(await signInAs('alice@example.test', BOB_PASSWORD)).toEqual({ refused: 'invalid' })
        expect(await signInAs('nobody@example.test', ALICE_PASSWORD)).toEqual({
          refused: 'invalid',
        })
        // Two accounts have a password, so a sign-in without an email means nobody.
        expect(await core.signIn.prompt()).toBe('email-password')
        expect(
          await core.signIn.password(
            { password: ALICE_PASSWORD, device: { kind: 'browser' }, delivery: 'cookie' },
            https(),
          ),
        ).toEqual({ refused: 'invalid' })

        // A hash made earlier by the edition's own functions keeps working.
        const earlier = await runtime.hashPassword('a password from before')
        const erin = await core.accounts.create({
          name: 'Erin',
          email: 'erin@example.test',
          passwordHash: earlier,
        })
        await admit(erin)
        expect(((await opened.stored('account', 'password')) as string[]).includes(earlier)).toBe(
          true,
        )
        expect(await core.accounts.verifyPassword(erin.id, 'a password from before')).toBe(true)
        expect(await core.accounts.verifyPassword(erin.id, 'another password')).toBe(false)
        const erinSignIn = issued(await signInAs('erin@example.test', 'a password from before'))
        expect(await resolved(erinSignIn)).toBe(erin.id)

        // Sign-out ends the one device sign-in the request carries.
        const out = await core.signIn.signOut(requestOf(bobSignIn), https())
        expect(out.deviceSignInId).toBe(bobSignIn.deviceSignInId)
        expect(out.headers.getSetCookie().some((cookie) => /max-age=0/i.test(cookie))).toBe(true)
        expect(await resolved(bobSignIn)).toBe('unauthenticated')
        expect(await resolved(aliceSignIn)).toBe(alice.id)

        // Eight failures lock one identifier; another identifier is not affected.
        for (let attempt = 0; attempt < 8; attempt++) {
          expect(await signInAs('bob@example.test', 'wrong')).toEqual({ refused: 'invalid' })
        }
        const locked = (await signInAs('bob@example.test', BOB_PASSWORD)) as {
          refused: string
          retryAfterSeconds: number
        }
        expect(locked.refused).toBe('throttled')
        expect(locked.retryAfterSeconds > 0).toBe(true)
        expect(issued(await signInAs('alice@example.test', ALICE_PASSWORD)).accountId).toBe(
          alice.id,
        )
      })

      // 3 -----------------------------------------------------------------
      test(2, async () => {
        const signIn = issued(await signInAs('alice@example.test', ALICE_PASSWORD))
        const token = rawToken(signIn)
        const stored = (await opened.stored('session', 'token')) as string[]
        expect(stored.length).toBe(1)
        expect(stored[0] === token).toBe(false)
        expect(stored[0]).toBe(storedTokenForm(token))

        const name = cookiePair(signIn).split('=')[0] as string
        const attempts: Request[] = [
          // What a copy of the database holds, as it is.
          withCookie(`${name}=${stored[0]}`),
          withBearer(stored[0] as string),
          // The same, signed by someone who also holds the signing secret.
          withCookie(`${name}=${encodeURIComponent(signToken(stored[0] as string, SECRET))}`),
          withBearer(signToken(stored[0] as string, SECRET)),
          // The real token without its signature.
          withCookie(`${name}=${token}`),
          withBearer(token),
          // The real token signed with another secret.
          withBearer(signToken(token, 'another-secret-another-secret-another-000')),
        ]
        for (const request of attempts) {
          expect((await core.credentials.resolve(request, https())).kind).toBe('unauthenticated')
        }
        // The signed token itself still opens Alice's account.
        expect(await resolved(signIn)).toBe(alice.id)
        // A sign-in made without the library's handler is stored hashed as well.
        const direct = await core.deviceSignIns.create(
          bob.id,
          { kind: 'desktop' },
          'bearer',
          https(),
        )
        const all = (await opened.stored('session', 'token')) as string[]
        expect(all.includes(storedTokenForm(rawToken(direct)))).toBe(true)
        expect(all.includes(rawToken(direct))).toBe(false)
      })

      // 4 -----------------------------------------------------------------
      test(3, async () => {
        const byCookie = issued(await signInAs('alice@example.test', ALICE_PASSWORD, 'cookie'))
        const byBearer = issued(await signInAs('alice@example.test', ALICE_PASSWORD, 'bearer'))
        expect(byBearer.headers.getSetCookie().length).toBe(0)
        expect(byCookie.bearer).toBe(null)
        expect(byCookie.deviceSignInId === byBearer.deviceSignInId).toBe(false)

        const first = await core.credentials.resolve(requestOf(byCookie), https())
        const second = await core.credentials.resolve(requestOf(byBearer), https())
        expect(first.kind).toBe('device-sign-in')
        expect(second.kind).toBe('device-sign-in')
        if (first.kind !== 'device-sign-in' || second.kind !== 'device-sign-in') return
        expect(first.accountId).toBe(alice.id)
        expect(second.accountId).toBe(alice.id)
        expect(first.deviceSignIn.id).toBe(byCookie.deviceSignInId)
        expect(second.deviceSignIn.id).toBe(byBearer.deviceSignInId)
        expect(first.deviceSignIn.kind).toBe('browser')
        expect(second.deviceSignIn.kind).toBe('phone')
        expect(first.renewDue).toBe(false)

        // Resolving is one statement. (The first resolution above also wrote
        // "last seen", which happens at most once per five minutes.)
        for (const signIn of [byCookie, byBearer]) {
          const before = opened.statements()
          await core.credentials.resolve(requestOf(signIn), https())
          expect(opened.statements() - before).toBe(1)
        }
        // A request that carries both uses the bearer.
        const both = new Request('https://unused.invalid/', {
          headers: {
            cookie: cookiePair(byCookie),
            authorization: `Bearer ${byBearer.bearer}`,
          },
        })
        const chosen = await core.credentials.resolve(both, https())
        expect(chosen.kind === 'device-sign-in' && chosen.deviceSignIn.id).toBe(
          byBearer.deviceSignInId,
        )
        // A bearer that is malformed, unsigned or unknown is never rescued by
        // a valid cookie beside it: the request named its credential.
        for (const bad of ['garbage', rawToken(byBearer), `${rawToken(byBearer)}.AAAA`]) {
          const rescued = await core.credentials.resolve(
            new Request('https://unused.invalid/', {
              headers: { cookie: cookiePair(byCookie), authorization: `Bearer ${bad}` },
            }),
            https(),
          )
          expect(rescued.kind === 'device-sign-in').toBe(false)
        }
        // No credential at all.
        expect(
          (await core.credentials.resolve(new Request('https://unused.invalid/'), https())).kind,
        ).toBe('unauthenticated')
        // Bob's own sign-in resolves to Bob.
        expect(await resolved(issued(await signInAs('bob@example.test', BOB_PASSWORD)))).toBe(
          bob.id,
        )
      })

      // 5 -----------------------------------------------------------------
      test(4, async () => {
        const tenDays = new Date(Date.now() + 10 * DAY)
        // Twenty days into its thirty: last renewed long ago.
        const sliding = await core.deviceSignIns.create(
          alice.id,
          { kind: 'browser' },
          'cookie',
          https(),
          {
            expiresAt: tenDays,
            fixed: false,
          },
        )
        const fixed = await core.deviceSignIns.create(bob.id, { kind: 'host' }, 'cookie', https(), {
          expiresAt: tenDays,
          fixed: true,
        })
        const due = await core.credentials.resolve(requestOf(sliding), https())
        expect(due.kind === 'device-sign-in' && due.renewDue).toBe(true)
        const notDue = await core.credentials.resolve(requestOf(fixed), https())
        expect(notDue.kind === 'device-sign-in' && notDue.renewDue).toBe(false)

        const renewed = await core.credentials.renew(requestOf(sliding), https())
        const cookie = renewed.getSetCookie().find((c) => c.includes('session_token'))
        expect(cookie === undefined).toBe(false)
        const value = decodeURIComponent(
          ((cookie as string).split(';')[0] as string).split('=')[1] as string,
        )
        // The same token, and still only its hash in the table.
        expect(value.slice(0, value.lastIndexOf('.'))).toBe(rawToken(sliding))
        expect(((await opened.stored('session', 'token')) as string[]).sort()).toEqual(
          [storedTokenForm(rawToken(sliding)), storedTokenForm(rawToken(fixed))].sort(),
        )
        const [aliceSignIn] = await core.deviceSignIns.listForAccount(alice.id)
        expect((aliceSignIn?.expiresAt.getTime() ?? 0) > Date.now() + 29 * DAY).toBe(true)
        const after = await core.credentials.resolve(requestOf(sliding), https())
        expect(after.kind === 'device-sign-in' && after.renewDue).toBe(false)

        // A fixed expiry is never renewed, however it is asked.
        expect(
          (await core.credentials.renew(requestOf(fixed), https())).getSetCookie().length,
        ).toBe(0)
        const [bobSignIn] = await core.deviceSignIns.listForAccount(bob.id)
        expect(bobSignIn?.expiresAt.getTime()).toBe(tenDays.getTime())
        // A sign-in past its expiry resolves to nobody.
        const past = await core.deviceSignIns.create(
          bob.id,
          { kind: 'browser' },
          'cookie',
          https(),
          {
            expiresAt: new Date(Date.now() - 1000),
            fixed: true,
          },
        )
        expect(await resolved(past)).toBe('unauthenticated')
      })

      // 6 -----------------------------------------------------------------
      test(5, async () => {
        const laptop = await core.deviceSignIns.create(
          alice.id,
          { kind: 'browser', name: 'Firefox on Linux', platform: 'linux' },
          'cookie',
          https(),
        )
        const phone = await core.deviceSignIns.create(
          alice.id,
          { kind: 'phone', name: "Alice's Pixel", deviceId: 'pixel-1', platform: 'android' },
          'bearer',
          https(),
        )
        const bobs = await core.deviceSignIns.create(bob.id, { kind: 'desktop' }, 'cookie', https())

        const list = await core.deviceSignIns.listForAccount(alice.id, laptop.deviceSignInId)
        expect(list.map((entry) => entry.id).sort()).toEqual(
          [laptop.deviceSignInId, phone.deviceSignInId].sort(),
        )
        const listedPhone = list.find((entry) => entry.id === phone.deviceSignInId)
        expect(listedPhone?.kind).toBe('phone')
        expect(listedPhone?.deviceName).toBe("Alice's Pixel")
        expect(listedPhone?.platform).toBe('android')
        expect(listedPhone?.current).toBe(false)
        expect(list.find((entry) => entry.id === laptop.deviceSignInId)?.current).toBe(true)
        // No token and no hash leaves the list.
        const shown = JSON.stringify(list)
        for (const signIn of [laptop, phone]) {
          expect(shown.includes(rawToken(signIn))).toBe(false)
          expect(shown.includes(storedTokenForm(rawToken(signIn)))).toBe(false)
        }

        // Bob cannot end Alice's sign-in through the guarded form.
        expect(
          await core.deviceSignIns.revoke(phone.deviceSignInId, { byAccount: bob.id }),
        ).toEqual({
          revoked: false,
          accountId: null,
        })
        expect(await resolved(phone)).toBe(alice.id)
        // Alice ends her phone; her laptop and Bob's device stay signed in.
        expect(
          await core.deviceSignIns.revoke(phone.deviceSignInId, { byAccount: alice.id }),
        ).toEqual({
          revoked: true,
          accountId: alice.id,
        })
        expect(await resolved(phone)).toBe('unauthenticated')
        expect(await resolved(laptop)).toBe(alice.id)
        expect(await resolved(bobs)).toBe(bob.id)
        expect((await core.deviceSignIns.revoke(phone.deviceSignInId)).revoked).toBe(false)

        // The same phone signing in again replaces its earlier sign-in.
        const again = await core.deviceSignIns.create(
          alice.id,
          { kind: 'phone', deviceId: 'pixel-2' },
          'bearer',
          https(),
        )
        const replaced = await core.deviceSignIns.create(
          alice.id,
          { kind: 'phone', deviceId: 'pixel-2' },
          'bearer',
          https(),
        )
        expect(await resolved(again)).toBe('unauthenticated')
        expect(await resolved(replaced)).toBe(alice.id)

        // Everything of Alice but the laptop ends; Bob is untouched.
        const ended = await core.deviceSignIns.revokeAllForAccount(alice.id, laptop.deviceSignInId)
        expect(ended).toEqual([replaced.deviceSignInId])
        expect(await resolved(laptop)).toBe(alice.id)
        expect(await resolved(bobs)).toBe(bob.id)
        expect((await core.deviceSignIns.revokeAllForAccount(alice.id)).length).toBe(1)
        expect(await resolved(laptop)).toBe('unauthenticated')
      })

      // 7 -----------------------------------------------------------------
      test(6, async () => {
        // Carol has no login method at all.
        const carol = await core.accounts.create({
          name: 'Carol',
          ...(edition === 'cloud' ? { email: 'carol@example.test' } : {}),
        })
        await admit(carol)
        expect(await core.accounts.hasPassword(carol.id)).toBe(false)
        const first = await core.codes.issue({
          purpose: 'transfer-claim',
          accountId: carol.id,
          createdBy: 'host',
        })
        // Only the hash of a code is stored.
        const hashes = (await opened.stored('oneTimeCode', 'code_hash')) as string[]
        expect(hashes).toEqual([sha256Hex(first.code)])
        // Before it is redeemed no device sign-in exists for it.
        expect((await core.deviceSignIns.listForAccount(carol.id)).length).toBe(0)

        const signIn = issued(
          await core.codes.redeem({ code: first.code }, { kind: 'browser' }, 'cookie', https()),
        )
        expect(await resolved(signIn)).toBe(carol.id)
        expect((await opened.stored('oneTimeCode', 'id')).length).toBe(0)
        expect((await opened.stored('account', 'id')).length).toBe(2) // Alice's and Bob's passwords only
        // It works once.
        expect(
          await core.codes.redeem({ code: first.code }, { kind: 'browser' }, 'cookie', https()),
        ).toBe(undefined)
        expect(
          await core.codes.redeem({ code: 'no such code' }, { kind: 'browser' }, 'cookie', https()),
        ).toBe(undefined)

        // It expires: ten minutes for this purpose.
        const stale = await core.codes.issue({
          purpose: 'transfer-claim',
          accountId: carol.id,
          createdBy: 'host',
        })
        ahead = 11 * 60_000
        expect(
          await core.codes.redeem({ code: stale.code }, { kind: 'browser' }, 'cookie', https()),
        ).toBe(undefined)
        // The sweep deletes what expired.
        expect((await opened.stored('oneTimeCode', 'id')).length).toBe(1)
        await core.sweep()
        expect((await opened.stored('oneTimeCode', 'id')).length).toBe(0)
        ahead = 0

        const cancelled = await core.codes.issue({
          purpose: 'transfer-claim',
          accountId: carol.id,
          createdBy: 'host',
        })
        await core.codes.discardTransferClaim(cancelled.id)
        expect(
          await core.codes.redeem(
            { code: cancelled.code, purpose: 'transfer-claim' },
            { kind: 'browser' },
            'cookie',
            https(),
          ),
        ).toBe(undefined)

        // Two redemptions at the same moment yield one sign-in.
        const raced = await core.codes.issue({
          purpose: 'transfer-claim',
          accountId: bob.id,
          createdBy: 'host',
        })
        const outcomes = await Promise.all([
          core.codes.redeem({ code: raced.code }, { kind: 'desktop' }, 'cookie', https()),
          core.codes.redeem({ code: raced.code }, { kind: 'desktop' }, 'cookie', https()),
        ])
        expect(outcomes.filter((outcome) => outcome !== undefined).length).toBe(1)
        expect((await core.deviceSignIns.listForAccount(bob.id)).length).toBe(1)

        // A host session keeps the lifetime the operator chose and is never renewed.
        const host = await core.codes.issue({
          purpose: 'host-sign-in',
          accountId: alice.id,
          createdBy: 'host',
          signInLife: { ttlMs: 60 * 60_000, fixed: true },
        })
        const hostSignIn = issued(
          await core.codes.redeem({ code: host.code }, { kind: 'browser' }, 'bearer', https()),
        )
        const [listed] = await core.deviceSignIns.listForAccount(alice.id)
        expect(listed?.kind).toBe('host')
        expect((await opened.stored('oneTimeCode', 'id')).length).toBe(0)
        expect(Math.abs(hostSignIn.expiresAt.getTime() - (Date.now() + 60 * 60_000)) < 60_000).toBe(
          true,
        )
        const resolution = await core.credentials.resolve(requestOf(hostSignIn), https())
        expect(resolution.kind === 'device-sign-in' && resolution.renewDue).toBe(false)
      })

      // 8 -----------------------------------------------------------------
      test(7, async () => {
        const aliceDevice = await core.deviceSignIns.create(
          alice.id,
          { kind: 'browser' },
          'cookie',
          https(),
        )
        const verifier = randomBytes(32).toString('base64url')
        const challenge = sha256Hex(verifier)
        const pairing = await core.codes.issue({
          purpose: 'pair-device',
          accountId: alice.id,
          createdBy: alice.id,
        })
        expect(await core.codes.status(pairing.id, alice.id)).toEqual({
          state: 'pending',
          expiresAt: pairing.expiresAt,
        })
        // Another account learns nothing about the attempt.
        expect(await core.codes.status(pairing.id, bob.id)).toEqual({ state: 'expired' })

        const phone = {
          kind: 'phone' as const,
          name: 'Pixel',
          deviceId: 'pixel',
          platform: 'android',
        }
        const claim = await core.codes.claim({
          code: pairing.code,
          challenge,
          device: phone,
          delivery: 'bearer',
        })
        expect(claim === undefined).toBe(false)
        if (!claim) return
        expect(claim.phrase.length).toBe(3)
        // A claimed code no longer works as a code, and cannot be claimed twice.
        expect(await core.codes.redeem({ code: pairing.code }, phone, 'bearer', https())).toBe(
          undefined,
        )
        expect(
          await core.codes.claim({
            code: pairing.code,
            challenge,
            device: phone,
            delivery: 'bearer',
          }),
        ).toBe(undefined)
        const waiting = await core.codes.status(pairing.id, alice.id)
        expect(waiting.state).toBe('claimed')
        expect(waiting.state === 'claimed' && waiting.phrase).toEqual(claim.phrase)
        expect(waiting.state === 'claimed' && waiting.device.name).toBe('Pixel')

        // Until the signed-in device approves, the claim is pending, even with the right verifier.
        expect(
          await core.codes.redeem({ claimId: claim.claimId, verifier }, phone, 'bearer', https()),
        ).toBe('pending')
        // Bob cannot approve Alice's attempt.
        expect(await core.codes.decide(pairing.id, bob.id, 'approved')).toBe(false)
        expect(await core.codes.decide(pairing.id, alice.id, 'approved')).toBe(true)

        // A wrong verifier is refused and consumes nothing.
        expect(
          await core.codes.redeem(
            { claimId: claim.claimId, verifier: 'wrong' },
            phone,
            'bearer',
            https(),
          ),
        ).toBe(undefined)
        const paired = issued(
          await core.codes.redeem({ claimId: claim.claimId, verifier }, phone, 'bearer', https()),
        )
        expect(await resolved(paired)).toBe(alice.id)
        expect(
          (await core.deviceSignIns.listForAccount(alice.id)).find(
            (entry) => entry.kind === 'phone',
          )?.deviceName,
        ).toBe('Pixel')
        expect(await core.codes.status(pairing.id, alice.id)).toEqual({ state: 'completed' })
        expect(await resolved(aliceDevice)).toBe(alice.id)

        // The fifth wrong verifier denies the attempt, also for the right one.
        const second = await core.codes.issue({
          purpose: 'pair-device',
          accountId: bob.id,
          createdBy: bob.id,
        })
        const secondClaim = await core.codes.claim({
          code: second.code,
          challenge,
          device: phone,
          delivery: 'bearer',
        })
        if (!secondClaim) return expect(secondClaim === undefined).toBe(false)
        expect(await core.codes.decide(second.id, bob.id, 'approved')).toBe(true)
        for (let attempt = 0; attempt < 5; attempt++) {
          expect(
            await core.codes.redeem(
              { claimId: secondClaim.claimId, verifier: `wrong-${attempt}` },
              phone,
              'bearer',
              https(),
            ),
          ).toBe(undefined)
        }
        expect(
          await core.codes.redeem(
            { claimId: secondClaim.claimId, verifier },
            phone,
            'bearer',
            https(),
          ),
        ).toBe(undefined)
        expect(await core.codes.status(second.id, bob.id)).toEqual({ state: 'denied' })
        expect((await core.deviceSignIns.listForAccount(bob.id)).length).toBe(0)

        // A denied attempt cannot be redeemed.
        const third = await core.codes.issue({
          purpose: 'pair-device',
          accountId: bob.id,
          createdBy: bob.id,
        })
        const thirdClaim = await core.codes.claim({
          code: third.code,
          challenge,
          device: phone,
          delivery: 'bearer',
        })
        expect(await core.codes.decide(third.id, bob.id, 'denied')).toBe(true)
        expect(
          await core.codes.redeem(
            { claimId: thirdClaim?.claimId ?? '', verifier },
            phone,
            'bearer',
            https(),
          ),
        ).toBe(undefined)
      })

      // 9 -----------------------------------------------------------------
      it('an edition hand-over code is stored hashed and redeemed exactly once', async () => {
        const code = `edition_${randomBytes(32).toString('base64url')}`
        const configured = await buildIdentity({ ...runtime.config, handOverCode: () => code })
        const source = await configured.core.deviceSignIns.create(
          alice.id,
          { kind: 'browser' },
          'cookie',
          https(),
        )
        const verifier = randomBytes(32).toString('base64url')
        const challenge = sha256Hex(verifier)
        await configured.core.codes.begin({ purpose: 'hand-over', challenge })
        const authorised = await configured.core.codes.authorise({
          challenge,
          accountId: alice.id,
          sourceSignInId: source.deviceSignInId,
        })
        expect(authorised).toMatchObject({ code })
        expect(await opened.stored('oneTimeCode', 'code_hash')).toContain(sha256Hex(code))
        const redeem = () =>
          configured.core.codes.redeem(
            { code, verifier, purpose: 'hand-over' },
            { kind: 'desktop' },
            'bearer',
            https(),
          )
        const signIn = issued(await redeem())
        expect(signIn.accountId).toBe(alice.id)
        expect(await redeem()).toBe(undefined)
      })

      test(8, async () => {
        const source = await core.deviceSignIns.create(
          alice.id,
          { kind: 'browser' },
          'cookie',
          https(),
          {
            expiresAt: new Date(Date.now() + 12 * DAY),
            fixed: false,
          },
        )
        const verifier = randomBytes(32).toString('base64url')
        const challenge = sha256Hex(verifier)
        const attempt = await core.codes.begin({ purpose: 'hand-over', challenge })
        expect(attempt.expiresAt.getTime() > Date.now() + 9 * 60_000).toBe(true)

        // Nobody can authorise with another account's sign-in, or an attempt that does not exist.
        expect(
          await core.codes.authorise({
            challenge,
            accountId: bob.id,
            sourceSignInId: source.deviceSignInId,
          }),
        ).toBe(undefined)
        expect(
          await core.codes.authorise({
            challenge: sha256Hex('another attempt'),
            accountId: alice.id,
            sourceSignInId: source.deviceSignInId,
          }),
        ).toBe('ended')
        const authorised = await core.codes.authorise({
          challenge,
          accountId: alice.id,
          sourceSignInId: source.deviceSignInId,
        })
        expect(typeof authorised === 'object').toBe(true)
        if (typeof authorised !== 'object') return
        expect(authorised.code).toMatch(/^[A-Za-z0-9_-]{43}$/)
        expect(Buffer.from(authorised.code, 'base64url')).toHaveLength(32)
        // The code lives at most three minutes.
        expect(authorised.expiresAt.getTime() <= Date.now() + 3 * 60_000 + 1000).toBe(true)
        // An attempt is authorised once.
        expect(
          await core.codes.authorise({
            challenge,
            accountId: alice.id,
            sourceSignInId: source.deviceSignInId,
          }),
        ).toBe('ended')

        // Without the receiver's verifier, and with a wrong one, the code is refused and stays usable.
        expect(
          await core.codes.redeem(
            { code: authorised.code },
            { kind: 'desktop' },
            'cookie',
            https(),
          ),
        ).toBe(undefined)
        expect(
          await core.codes.redeem(
            { code: authorised.code, verifier: 'wrong' },
            { kind: 'desktop' },
            'cookie',
            https(),
          ),
        ).toBe(undefined)
        const handed = issued(
          await core.codes.redeem(
            { code: authorised.code, verifier },
            { kind: 'desktop' },
            'cookie',
            https(),
          ),
        )
        expect(await resolved(handed)).toBe(alice.id)
        expect(handed.deviceSignInId === source.deviceSignInId).toBe(false)
        // The new sign-in expires when the authorising one would, and is never renewed past it.
        const list = await core.deviceSignIns.listForAccount(alice.id)
        const sourceRow = list.find((entry) => entry.id === source.deviceSignInId)
        const handedRow = list.find((entry) => entry.id === handed.deviceSignInId)
        expect(handedRow?.kind).toBe('desktop')
        expect(handedRow?.expiresAt.getTime()).toBe(sourceRow?.expiresAt.getTime())
        const resolution = await core.credentials.resolve(requestOf(handed), https())
        expect(resolution.kind === 'device-sign-in' && resolution.renewDue).toBe(false)
        // The code and the attempt are spent together.
        expect(
          await core.codes.redeem(
            { code: authorised.code, verifier },
            { kind: 'desktop' },
            'cookie',
            https(),
          ),
        ).toBe(undefined)

        // Refused when the authorising sign-in has ended.
        const bobSource = await core.deviceSignIns.create(
          bob.id,
          { kind: 'browser' },
          'cookie',
          https(),
        )
        const bobVerifier = randomBytes(32).toString('base64url')
        await core.codes.begin({ purpose: 'hand-over', challenge: sha256Hex(bobVerifier) })
        const bobCode = await core.codes.authorise({
          challenge: sha256Hex(bobVerifier),
          accountId: bob.id,
          sourceSignInId: bobSource.deviceSignInId,
        })
        if (typeof bobCode !== 'object') return expect(typeof bobCode).toBe('object')
        await core.deviceSignIns.revoke(bobSource.deviceSignInId)
        expect(
          await core.codes.redeem(
            { code: bobCode.code, verifier: bobVerifier },
            { kind: 'desktop' },
            'cookie',
            https(),
          ),
        ).toBe(undefined)
        expect((await core.deviceSignIns.listForAccount(bob.id)).length).toBe(0)
        // Alice keeps both of hers.
        expect((await core.deviceSignIns.listForAccount(alice.id)).length).toBe(2)
      })

      // 10 ----------------------------------------------------------------
      test(9, async () => {
        const bobBrowser = issued(await signInAs('bob@example.test', BOB_PASSWORD))
        const bobPhone = issued(await signInAs('bob@example.test', BOB_PASSWORD, 'bearer'))
        const aliceBrowser = issued(await signInAs('alice@example.test', ALICE_PASSWORD))

        const reset = await core.codes.issue({
          purpose: 'password-reset',
          accountId: bob.id,
          createdBy: alice.id,
        })
        expect(reset.expiresAt.getTime() > Date.now() + 23 * 60 * 60_000).toBe(true)
        const inspected = await core.codes.inspectPasswordReset(reset.code)
        expect(inspected?.email).toBe('bob@example.test')
        // It names Bob's account and nobody else's.
        expect(inspected?.accountId).toBe(bob.id)
        expect(await core.codes.inspectPasswordReset('no such code')).toBe(undefined)
        // A reset code is not a sign-in code, and trying it as one does not spend it.
        expect(
          await core.codes.redeem({ code: reset.code }, { kind: 'browser' }, 'cookie', https()),
        ).toBe(undefined)

        const redeemed = await core.codes.redeemPasswordReset({
          code: reset.code,
          password: 'bob has a new password',
        })
        expect(redeemed?.accountId).toBe(bob.id)
        expect(redeemed?.endedSignInIds.slice().sort()).toEqual(
          [bobBrowser.deviceSignInId, bobPhone.deviceSignInId].sort(),
        )
        // Every device sign-in of Bob's ended; Alice's did not.
        expect(await resolved(bobBrowser)).toBe('unauthenticated')
        expect(await resolved(bobPhone)).toBe('unauthenticated')
        expect(await resolved(aliceBrowser)).toBe(alice.id)
        // The old password is gone, the new one works, and the code is spent.
        expect(await signInAs('bob@example.test', BOB_PASSWORD)).toEqual({ refused: 'invalid' })
        expect(issued(await signInAs('bob@example.test', 'bob has a new password')).accountId).toBe(
          bob.id,
        )
        expect(
          await core.codes.redeemPasswordReset({ code: reset.code, password: 'a third password' }),
        ).toBe(undefined)
        expect(await core.accounts.verifyPassword(bob.id, 'a third password')).toBe(false)
        expect(await core.accounts.verifyPassword(alice.id, ALICE_PASSWORD)).toBe(true)

        // An account with no login method gets its first password by a reset code.
        const carol = await core.accounts.create({ name: 'Carol' })
        const first = await core.codes.issue({
          purpose: 'password-reset',
          accountId: carol.id,
          createdBy: 'host',
        })
        expect((await core.codes.inspectPasswordReset(first.code))?.email).toBe(null)
        expect(
          await core.codes.redeemPasswordReset({
            code: first.code,
            password: 'carol first password',
          }),
        ).toEqual({ accountId: carol.id, endedSignInIds: [] })
        expect(await core.accounts.verifyPassword(carol.id, 'carol first password')).toBe(true)
        // setPassword replaces a password and ends no device sign-in.
        await core.accounts.setPassword(alice.id, 'alice changed it')
        expect(await core.accounts.verifyPassword(alice.id, 'alice changed it')).toBe(true)
        expect(await resolved(aliceBrowser)).toBe(alice.id)
        // setPasswordHash does the same from a hash the edition's functions made.
        await core.accounts.setPasswordHash(carol.id, await runtime.hashPassword('carol staged it'))
        expect(await core.accounts.verifyPassword(carol.id, 'carol staged it')).toBe(true)
        expect(await core.accounts.verifyPassword(carol.id, 'carol first password')).toBe(false)
        // Anything that is not a hash of this edition is refused and changes
        // nothing: a password in clear, an empty string, another format.
        for (const notAHash of ['carol in clear', '', 'bcrypt$2b$10$abcdefghijklmnopqrstuv']) {
          expect(await refusedWith(() => core.accounts.setPasswordHash(carol.id, notAHash))).toBe(
            'password-hash-invalid',
          )
        }
        expect(await core.accounts.verifyPassword(carol.id, 'carol staged it')).toBe(true)
        expect(await core.accounts.verifyPassword(carol.id, 'carol in clear')).toBe(false)
      })

      // 11 ----------------------------------------------------------------
      test(10, async () => {
        const { database } = opened
        const selfHosted = await buildIdentity(
          editionConfig('self-hosted', harness, database, clock, []),
        )
        const cloud = await buildIdentity(editionConfig('cloud', harness, database, clock, []))
        expect(selfHosted.core.capabilities()).toEqual(SUITE_SELF_HOSTED_CAPABILITIES)
        expect(cloud.core.capabilities()).toEqual(SUITE_CLOUD_CAPABILITIES)
        // The library's own routes are reachable only where the edition mounts them.
        expect(selfHosted.core.libraryHandler).toBe(undefined)
        expect(typeof cloud.core.libraryHandler).toBe('function')
        // The list is the same object for the life of the core.
        expect(core.capabilities()).toBe(core.capabilities())
        expect(core.capabilities()).toEqual(
          edition === 'self-hosted' ? SUITE_SELF_HOSTED_CAPABILITIES : SUITE_CLOUD_CAPABILITIES,
        )
      })

      // 12 ----------------------------------------------------------------
      test(11, async () => {
        // Plain HTTP from another machine: refused before anything is read.
        expect(
          await core.signIn.password(
            {
              email: 'alice@example.test',
              password: ALICE_PASSWORD,
              device: { kind: 'browser' },
              delivery: 'cookie',
            },
            plainNetwork(),
          ),
        ).toEqual({ refused: 'https_required' })
        const overHttps = issued(await signInAs('alice@example.test', ALICE_PASSWORD))
        const before = opened.statements()
        expect((await core.credentials.resolve(requestOf(overHttps), plainNetwork())).kind).toBe(
          'https_required',
        )
        expect(opened.statements() - before).toBe(0)
        expect(
          await refusedWith(() =>
            core.deviceSignIns.create(alice.id, { kind: 'browser' }, 'cookie', plainNetwork()),
          ),
        ).toBe('https_required')
        expect(
          (await core.signIn.signOut(requestOf(overHttps), plainNetwork())).deviceSignInId,
        ).toBe(null)
        expect(await resolved(overHttps)).toBe(alice.id)

        const secure = overHttps.headers
          .getSetCookie()
          .find((c) => c.includes('session_token')) as string
        expect(secure.startsWith('__Secure-podium.session_token=')).toBe(true)
        expect(/;\s*secure/i.test(secure)).toBe(true)
        expect(/;\s*httponly/i.test(secure)).toBe(true)
        expect(/;\s*samesite=lax/i.test(secure)).toBe(true)
        const made = await core.deviceSignIns.create(bob.id, { kind: 'browser' }, 'cookie', https())
        const madeCookie = made.headers.getSetCookie()[0] as string
        expect(madeCookie.startsWith('__Secure-podium.session_token=')).toBe(true)

        if (edition === 'self-hosted') {
          // Host-only cookies: no Domain.
          expect(/domain=/i.test(secure)).toBe(false)
          expect(/domain=/i.test(madeCookie)).toBe(false)
          // Plain HTTP on the same machine signs in, with the loopback cookie.
          const local = issued(
            await core.signIn.password(
              {
                email: 'bob@example.test',
                password: BOB_PASSWORD,
                device: { kind: 'desktop' },
                delivery: 'cookie',
              },
              loopback(),
            ),
          )
          const plain = local.headers
            .getSetCookie()
            .find((c) => c.includes('session_token')) as string
          expect(plain.startsWith('podium.session_token=')).toBe(true)
          expect(/;\s*secure/i.test(plain)).toBe(false)
          expect(/;\s*httponly/i.test(plain)).toBe(true)
          expect(/domain=/i.test(plain)).toBe(false)
          const onLoopback = await core.credentials.resolve(
            withCookie(cookiePair(local)),
            loopback(),
          )
          expect(onLoopback.kind === 'device-sign-in' && onLoopback.accountId).toBe(bob.id)
          // A bearer is never delivered or read over plain HTTP, same machine or not.
          expect(
            await core.signIn.password(
              {
                email: 'bob@example.test',
                password: BOB_PASSWORD,
                device: { kind: 'phone' },
                delivery: 'bearer',
              },
              loopback(),
            ),
          ).toEqual({ refused: 'https_required' })
          const bearer = issued(await signInAs('bob@example.test', BOB_PASSWORD, 'bearer'))
          expect((await core.credentials.resolve(requestOf(bearer), loopback())).kind).toBe(
            'unauthenticated',
          )
        } else {
          // One cookie shared by the subdomains of the fixed domain; no plain HTTP at all.
          expect(/domain=podium\.test/i.test(secure)).toBe(true)
          expect(/domain=podium\.test/i.test(madeCookie)).toBe(true)
          expect((await core.credentials.resolve(requestOf(overHttps), loopback())).kind).toBe(
            'https_required',
          )
        }
      })

      // 13 ----------------------------------------------------------------
      test(12, async () => {
        const counts = async () => ({
          accounts: (await opened.stored('user', 'id')).length,
          methods: (await opened.stored('account', 'id')).length,
          signIns: (await opened.stored('session', 'id')).length,
          codes: (await opened.stored('oneTimeCode', 'id')).length,
        })
        const before = await counts()
        let inside: Awaited<ReturnType<typeof counts>> | undefined
        let message = ''
        try {
          await runtime.transaction(async () => {
            // The library writes the account and the device sign-in; the package
            // writes the login method and the code.
            const carol = await core.accounts.create({
              name: 'Carol',
              email: 'carol@example.test',
              passwordHash: await runtime.hashPassword('carol password'),
            })
            await core.deviceSignIns.create(carol.id, { kind: 'browser' }, 'cookie', https())
            await core.codes.issue({
              purpose: 'transfer-claim',
              accountId: carol.id,
              createdBy: 'host',
            })
            await core.accounts.updateProfile(alice.id, { name: 'Alice Changed' })
            inside = {
              accounts: (await core.accounts.byEmail('carol@example.test'))
                ? before.accounts + 1
                : 0,
              methods: (await core.accounts.hasPassword(carol.id)) ? before.methods + 1 : 0,
              signIns: before.signIns + (await core.deviceSignIns.listForAccount(carol.id)).length,
              codes: before.codes + 1,
            }
            throw new Error('roll back')
          })
        } catch (error) {
          message = (error as Error).message
        }
        expect(message).toBe('roll back')
        // Inside the transaction the writes were visible to it.
        expect(inside).toEqual({
          accounts: before.accounts + 1,
          methods: before.methods + 1,
          signIns: before.signIns + 1,
          codes: before.codes + 1,
        })
        // After the rollback none of them exists, and Alice is as she was.
        expect(await counts()).toEqual(before)
        expect(await core.accounts.byEmail('carol@example.test')).toBe(undefined)
        expect((await core.accounts.get(alice.id))?.name).toBe('Alice')

        // The same writes, committed, all stay.
        await runtime.transaction(async () => {
          const carol = await core.accounts.create({
            name: 'Carol',
            email: 'carol@example.test',
            passwordHash: await runtime.hashPassword('carol password'),
          })
          await core.deviceSignIns.create(carol.id, { kind: 'browser' }, 'cookie', https())
          await core.codes.issue({
            purpose: 'transfer-claim',
            accountId: carol.id,
            createdBy: 'host',
          })
        })
        expect(await counts()).toEqual({
          accounts: before.accounts + 1,
          methods: before.methods + 1,
          signIns: before.signIns + 1,
          codes: before.codes + 1,
        })
        // An operation that fails half-way leaves nothing behind: the address is taken
        // only after the library would have written, so the check runs first and no row is made.
        expect(
          await refusedWith(() =>
            core.accounts.create({ name: 'Carol Again', email: 'carol@example.test' }),
          ),
        ).toBe('email-taken')
        expect((await counts()).accounts).toBe(before.accounts + 1)
      })
    })

    membershipCases({
      runner,
      harness,
      edition,
      configOf: (database, clock) => editionConfig(edition, harness, database, clock, []),
      record: (name) => {
        ran.set(name, (ran.get(name) ?? new Set()).add(edition))
      },
    })
  }

  // A case counts only when it ran under both configurations.
  return {
    casesRun: () => [...ran].filter(([, editions]) => editions.size === 2).map(([name]) => name),
  }
}
