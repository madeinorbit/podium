/**
 * The membership cases of the shared identity suite (people and sign-in
 * specification, section 10.2, cases 14 to 23).
 *
 * Two people, Alice and Bob. Alice is the first admin of the workspace and the
 * untouched control: wherever a case changes Bob, her membership, her member
 * row and her authorization generation are compared with what they were.
 *
 * Under the self-hosted configuration the member rows share the database and
 * change in the membership's transaction. Under the cloud configuration they
 * are bound as "elsewhere", so every change reaches them through catch-up, as
 * in a hosted workspace.
 */
import { buildIdentity } from '../core'
import { sha256Hex } from '../secrets'
import {
  type AccountRef,
  type Actor,
  type ConnectionFacts,
  type IdentityConfig,
  type IdentityCore,
  type IdentityDatabase,
  IdentityRefused,
  type IssuedSignIn,
  MembershipRefused,
  type MembershipView,
  type MemberWrite,
  type WorkspaceIdentity,
} from '../types'
import { importLegacyLink } from '../upgrade'
import type { MemberRowState, OpenedDatabase, SuiteHarness, SuiteRunner } from './index'

export const MEMBERSHIP_SUITE_CASES = [
  'Bob is invited, accepts, is demoted, disabled, enabled and removed; his member row follows and Alice is unchanged',
  'no member row exists before an invitation is accepted',
  'one invitation accepted twice at the same moment succeeds once; an expired or revoked one is refused',
  'a second account cannot accept the invitation of another or attach to their member; an address binds an invitation',
  'an invitation that names an existing member attaches the account to that member and creates none',
  'the last active admin cannot be demoted, disabled or removed; nobody disables or removes themselves',
  'resolve answers not-a-member for an invited, disabled or removed membership and unauthenticated for no credential',
  'every membership change steps the workspace revision by one; applying a membership twice changes nothing',
  'local accounts end with their membership and sign in only with an active one; shared accounts do neither',
  'the same-machine rule admits the sole active member and nobody else',
  'disable then enable between two catch-ups still moves the member generation',
  'imports legacy links by hash, redeems each once and refuses expired links',
  'accountOfActiveMember names the account of an active member and of nobody else',
] as const

const WORKSPACE = 'local'
const ALICE_PASSWORD = 'alice correct horse battery'
const BOB_PASSWORD = 'bob staple tractor window'
const MALLORY_PASSWORD = 'mallory umbrella saddle quartz'
const DAY = 86_400_000

type Edition = 'self-hosted' | 'cloud'

export interface MembershipCasesContext {
  runner: SuiteRunner
  harness: SuiteHarness
  edition: Edition
  /** The edition configuration of the suite, on this database. */
  configOf(database: IdentityDatabase, clock: () => Date): IdentityConfig
  /** Tells the suite that a case ran to its end. */
  record(name: string): void
}

interface Person {
  memberId: string
  accountId: string
}

export function membershipCases(context: MembershipCasesContext): void {
  const { runner, harness, edition } = context
  const { describe, it, beforeEach, afterEach, expect } = runner
  const local = edition === 'self-hosted'

  describe(`identity suite on ${harness.name}, ${edition} configuration: memberships`, () => {
    let opened: OpenedDatabase
    let core: IdentityCore
    let workspace: WorkspaceIdentity
    let alice: Person
    let aliceBefore: { view: MembershipView; row: MemberRowState | undefined }
    let ahead = 0
    let addresses = 0
    /** The server's "sign-in waived on its own machine" setting. */
    let waived = false

    const clock = () => new Date(Date.now() + ahead)
    const https = (): ConnectionFacts => {
      addresses += 1
      return {
        scheme: 'https',
        sameMachine: false,
        clientAddress: `10.1.${(addresses >> 8) & 255}.${addresses & 255}`,
      }
    }
    const loopback = (): ConnectionFacts => ({
      scheme: 'http',
      sameMachine: true,
      clientAddress: '127.0.0.1',
    })
    const noCredential = () => new Request('https://unused.invalid/')
    const requestOf = (signIn: IssuedSignIn) => {
      if (signIn.bearer) {
        return new Request('https://unused.invalid/', {
          headers: { authorization: `Bearer ${signIn.bearer}` },
        })
      }
      const cookie = signIn.headers.getSetCookie().find((c) => c.includes('session_token'))
      return new Request('https://unused.invalid/', {
        headers: { cookie: (cookie ?? '').split(';')[0] as string },
      })
    }
    const issued = (value: unknown): IssuedSignIn => {
      expect(typeof value === 'object' && value !== null && 'deviceSignInId' in value).toBe(true)
      return value as IssuedSignIn
    }
    const refusedWith = async (run: () => Promise<unknown>): Promise<string> => {
      try {
        await run()
      } catch (error) {
        if (error instanceof MembershipRefused || error instanceof IdentityRefused) {
          return error.code
        }
        return `threw ${String(error)}`
      }
      return 'did not throw'
    }

    /** A workspace of `core` on `database`, bound as this edition binds its member rows. */
    const bind = (of: IdentityCore, database: OpenedDatabase): WorkspaceIdentity => {
      if (local) return of.workspace(WORKSPACE, { rows: database.memberRows, sameDatabase: true })
      let cursor = 0
      return of.workspace(WORKSPACE, {
        rows: database.memberRows,
        sameDatabase: false,
        cursor: {
          read: async () => cursor,
          write: async (version) => {
            cursor = version
          },
        },
      })
    }
    const configOf = (database: IdentityDatabase): IdentityConfig => {
      const config = context.configOf(database, clock)
      return config.sameMachine ? { ...config, sameMachine: { waived: () => waived } } : config
    }

    const asAlice = (): Actor => ({ memberId: alice.memberId })
    const viewOf = async (memberId: string): Promise<MembershipView> => {
      const view = (await workspace.memberships.list()).find((m) => m.memberId === memberId)
      expect(view === undefined).toBe(false)
      return view as MembershipView
    }
    const revision = async (): Promise<number> =>
      Math.max(...(await workspace.memberships.list()).map((m) => m.version))
    const rowOf = (memberId: string) => opened.memberRows.read(memberId)

    /**
     * A person's account as this edition makes it: a local account is created
     * by accepting; a shared one exists before and is named.
     */
    const accountFor = async (name: string, password: string): Promise<AccountRef> => {
      const email = `${name.toLowerCase()}@example.test`
      if (local) return { kind: 'new', name, email, password }
      const account = await core.accounts.create({ name, email, password })
      return { kind: 'existing', accountId: account.id }
    }
    const invite = (input: { role?: 'admin' | 'member'; email?: string; memberId?: string }) =>
      workspace.memberships.invite({ actor: asAlice(), role: input.role ?? 'member', ...input })
    /** Bob invited by Alice and accepted: an active member. */
    const join = async (
      name = 'Bob',
      password = BOB_PASSWORD,
      role: 'admin' | 'member' = 'member',
    ): Promise<Person> => {
      const { invitation } = await invite({ role })
      return await workspace.memberships.accept({
        token: invitation.token,
        account: await accountFor(name, password),
      })
    }
    const signIn = async (name: string, password: string) =>
      await core.signIn.password(
        {
          email: `${name.toLowerCase()}@example.test`,
          password,
          device: { kind: 'browser' },
          delivery: 'cookie',
        },
        https(),
      )

    /** Alice's membership, member row and authorization generation are what they were. */
    const aliceUnchanged = async () => {
      expect(await viewOf(alice.memberId)).toEqual(aliceBefore.view)
      expect(await rowOf(alice.memberId)).toEqual(aliceBefore.row)
    }
    /** The member row agrees with the membership it was applied from. */
    const rowMatches = async (memberId: string): Promise<MemberRowState> => {
      const view = await viewOf(memberId)
      const row = await rowOf(memberId)
      expect(row === undefined).toBe(false)
      const state = row as MemberRowState
      expect(state.version).toBe(view.version)
      expect(state.role).toBe(view.role)
      expect(state.state === 'active').toBe(view.status === 'active')
      return state
    }

    beforeEach(async () => {
      ahead = 0
      waived = false
      opened = await harness.open()
      const built = await buildIdentity(configOf(opened.database))
      core = built.core
      workspace = bind(core, opened)
      const first = await workspace.memberships.adopt({
        by: 'setup',
        role: 'admin',
        status: 'active',
        account: {
          kind: 'new',
          name: 'Alice',
          email: 'alice@example.test',
          password: ALICE_PASSWORD,
        },
      })
      alice = { memberId: first.memberId, accountId: first.account?.id as string }
      aliceBefore = { view: await viewOf(alice.memberId), row: await rowOf(alice.memberId) }
    })
    afterEach(async () => {
      await opened.close()
    })

    const test = (index: number, fn: () => Promise<void>) => {
      const name = MEMBERSHIP_SUITE_CASES[index] as string
      it(name, async () => {
        await fn()
        context.record(name)
      })
    }

    test(11, async () => {
      const createdAt = clock()
      const expiresAt = new Date(createdAt.getTime() + DAY)
      const inviteToken = 'a'.repeat(43)
      const resetToken = 'b'.repeat(43)
      const expiredToken = 'c'.repeat(43)
      const source = { createdAt, expiresAt, createdBy: alice.memberId }
      const invitation = {
        ...source,
        id: 'legacy-invitation',
        kind: 'invitation' as const,
        tokenHash: sha256Hex(inviteToken),
        memberId: null,
        role: 'member' as const,
        email: 'bob@example.test',
      }
      expect(await importLegacyLink(workspace, invitation)).toBe(true)
      expect(
        await importLegacyLink(workspace, {
          ...invitation,
          id: 'legacy-expired',
          tokenHash: sha256Hex(expiredToken),
          expiresAt: createdAt,
        }),
      ).toBe(false)
      expect(await refusedWith(() => workspace.memberships.inspectInvitation(expiredToken))).toBe(
        'invitation-invalid',
      )
      expect(await workspace.memberships.inspectInvitation(inviteToken)).toEqual({
        email: invitation.email,
        expiresAt,
        needsAccount: true,
      })
      const account = await accountFor('Bob', BOB_PASSWORD)
      const accept = () => workspace.memberships.accept({ token: inviteToken, account })
      const bob = await accept()
      expect((await viewOf(bob.memberId)).role).toBe('member')
      expect(await refusedWith(accept)).toBe('invitation-invalid')

      expect(
        await importLegacyLink(workspace, {
          ...source,
          id: 'legacy-reset',
          kind: 'password-reset',
          tokenHash: sha256Hex(resetToken),
          accountId: bob.accountId,
        }),
      ).toBe(true)
      expect(await core.codes.inspectPasswordReset(resetToken)).toEqual({
        email: invitation.email,
        expiresAt,
      })
      const reset = () =>
        core.codes.redeemPasswordReset({ code: resetToken, password: 'Bob’s new password' })
      expect((await reset())?.accountId).toBe(bob.accountId)
      expect(await reset()).toBe(undefined)
      await aliceUnchanged()
    })

    // The one read of the sign-in carry-over (POD-6751).
    test(12, async () => {
      const { accountOfActiveMember } = workspace.memberships
      expect(await accountOfActiveMember(alice.memberId)).toBe(alice.accountId)
      expect(await accountOfActiveMember('mem_nobody')).toBe(undefined)
      // An invited membership names no account yet.
      const { membership: invited } = await invite({ email: 'carol@example.test' })
      expect(await accountOfActiveMember(invited.memberId)).toBe(undefined)
      const bob = await join()
      expect(await accountOfActiveMember(bob.memberId)).toBe(bob.accountId)
      // Bob's id never answers Alice's account, nor hers his.
      expect(bob.accountId === alice.accountId).toBe(false)
      await workspace.memberships.disable({ actor: asAlice(), memberId: bob.memberId })
      expect(await accountOfActiveMember(bob.memberId)).toBe(undefined)
      await workspace.memberships.enable({ actor: asAlice(), memberId: bob.memberId })
      expect(await accountOfActiveMember(bob.memberId)).toBe(bob.accountId)
      await workspace.memberships.remove({ actor: asAlice(), memberId: bob.memberId })
      expect(await accountOfActiveMember(bob.memberId)).toBe(undefined)
      expect(await accountOfActiveMember(alice.memberId)).toBe(alice.accountId)
      await aliceUnchanged()
    })

    // 14 ------------------------------------------------------------------
    test(0, async () => {
      // Alice herself: the first membership made her member row.
      expect(aliceBefore.view.status).toBe('active')
      expect(aliceBefore.view.role).toBe('admin')
      expect(aliceBefore.row?.state).toBe('active')
      expect(aliceBefore.row?.role).toBe('admin')
      expect(aliceBefore.row?.accountId).toBe(alice.accountId)
      expect(aliceBefore.row?.version).toBe(aliceBefore.view.version)
      expect(aliceBefore.row?.name).toBe('Alice')
      expect(aliceBefore.row?.email).toBe('alice@example.test')

      // Invited: a membership, and nobody yet.
      const { membership, invitation } = await invite({ role: 'admin' })
      expect(membership.status).toBe('invited')
      expect(membership.role).toBe('admin')
      expect(membership.account).toBe(null)
      expect(membership.pendingInvitation?.id).toBe(invitation.id)
      expect(await rowOf(membership.memberId)).toBe(undefined)
      await aliceUnchanged()

      // Accepted: an active member with the invited role.
      const bob = await workspace.memberships.accept({
        token: invitation.token,
        account: await accountFor('Bob', BOB_PASSWORD),
      })
      expect(bob.memberId).toBe(membership.memberId)
      expect((await viewOf(bob.memberId)).status).toBe('active')
      expect((await viewOf(bob.memberId)).account?.id).toBe(bob.accountId)
      expect((await viewOf(bob.memberId)).pendingInvitation).toBe(null)
      const joined = await rowMatches(bob.memberId)
      expect(joined.state).toBe('active')
      expect(joined.role).toBe('admin')
      expect(joined.accountId).toBe(bob.accountId)
      expect(joined.name).toBe('Bob')
      expect(joined.email).toBe('bob@example.test')
      // A member row that was just made has no authority change behind it.
      const generation = joined.generation
      await aliceUnchanged()

      // Demoted: the role changes and the generation steps.
      await workspace.memberships.setRole({
        actor: asAlice(),
        memberId: bob.memberId,
        role: 'member',
      })
      expect((await viewOf(bob.memberId)).role).toBe('member')
      const demoted = await rowMatches(bob.memberId)
      expect(demoted.role).toBe('member')
      expect(demoted.state).toBe('active')
      expect(demoted.generation).toBe(generation + 1)
      await aliceUnchanged()

      // Disabled.
      await workspace.memberships.disable({ actor: asAlice(), memberId: bob.memberId })
      expect((await viewOf(bob.memberId)).status).toBe('disabled')
      const disabled = await rowMatches(bob.memberId)
      expect(disabled.state === 'active').toBe(false)
      expect(disabled.generation).toBe(generation + 2)
      await aliceUnchanged()

      // Enabled.
      await workspace.memberships.enable({ actor: asAlice(), memberId: bob.memberId })
      expect((await viewOf(bob.memberId)).status).toBe('active')
      const enabled = await rowMatches(bob.memberId)
      expect(enabled.state).toBe('active')
      expect(enabled.role).toBe('member')
      expect(enabled.generation).toBe(generation + 3)
      await aliceUnchanged()

      // Removed: the membership says removed, the member row can no longer act.
      await workspace.memberships.remove({ actor: asAlice(), memberId: bob.memberId })
      expect((await viewOf(bob.memberId)).status).toBe('removed')
      const removed = await rowMatches(bob.memberId)
      expect(removed.state === 'active').toBe(false)
      expect(removed.generation).toBe(generation + 4)
      await aliceUnchanged()

      // A change that repeats the present state changes nothing.
      const before = await revision()
      await workspace.memberships.setRole({
        actor: asAlice(),
        memberId: alice.memberId,
        role: 'admin',
      })
      expect(await revision()).toBe(before)
      await aliceUnchanged()
    })

    // 15 ------------------------------------------------------------------
    test(1, async () => {
      const first = await invite({})
      expect(await rowOf(first.membership.memberId)).toBe(undefined)
      // Looking at the invitation creates nobody either.
      const seen = await workspace.memberships.inspectInvitation(first.invitation.token)
      expect(seen.email).toBe(null)
      expect(await rowOf(first.membership.memberId)).toBe(undefined)

      // An invitation that is revoked, and one that expires, never made a member.
      await workspace.memberships.revokeInvitation({
        actor: asAlice(),
        invitationId: first.invitation.id,
      })
      expect((await viewOf(first.membership.memberId)).status).toBe('removed')
      expect(await rowOf(first.membership.memberId)).toBe(undefined)
      const second = await invite({})
      ahead = 8 * DAY
      await core.sweep()
      expect(await rowOf(second.membership.memberId)).toBe(undefined)
      ahead = 0

      // Accepting makes the member row, in the same step.
      const third = await invite({})
      expect(await rowOf(third.membership.memberId)).toBe(undefined)
      const bob = await workspace.memberships.accept({
        token: third.invitation.token,
        account: await accountFor('Bob', BOB_PASSWORD),
      })
      expect((await rowOf(bob.memberId))?.state).toBe('active')
      await aliceUnchanged()
    })

    // 16 ------------------------------------------------------------------
    test(2, async () => {
      const { membership, invitation } = await invite({})
      const bobAccount = await accountFor('Bob', BOB_PASSWORD)
      const malloryAccount = await accountFor('Mallory', MALLORY_PASSWORD)
      // Two accepts of one invitation at the same moment.
      opened.armConcurrentTransactions?.()
      const outcomes = await Promise.allSettled([
        workspace.memberships.accept({ token: invitation.token, account: bobAccount }),
        workspace.memberships.accept({ token: invitation.token, account: malloryAccount }),
      ])
      if (opened.maximumConcurrentTransactions)
        expect(opened.maximumConcurrentTransactions() >= 2).toBe(true)
      const won = outcomes.filter((outcome) => outcome.status === 'fulfilled')
      const lost = outcomes.filter((outcome) => outcome.status === 'rejected')
      expect(won.length).toBe(1)
      expect(lost.length).toBe(1)
      expect((lost[0] as PromiseRejectedResult).reason instanceof MembershipRefused).toBe(true)
      expect(((lost[0] as PromiseRejectedResult).reason as MembershipRefused).code).toBe(
        'invitation-invalid',
      )
      const winner = (won[0] as PromiseFulfilledResult<Person>).value
      expect(winner.memberId).toBe(membership.memberId)
      // One member, with the winner's account; the loser left nothing behind.
      const members = await workspace.memberships.list()
      expect(members.length).toBe(2)
      expect((await rowOf(membership.memberId))?.accountId).toBe(winner.accountId)
      if (local) {
        const made = [
          await core.accounts.byEmail('bob@example.test'),
          await core.accounts.byEmail('mallory@example.test'),
        ].filter((account) => account !== undefined)
        expect(made.length).toBe(1)
        expect(made[0]?.id).toBe(winner.accountId)
      }
      // And once more, later: an invitation works once.
      expect(
        await refusedWith(async () =>
          workspace.memberships.accept({
            token: invitation.token,
            account: await accountFor('Carol', 'carol password 123'),
          }),
        ),
      ).toBe('invitation-invalid')

      // An expired invitation.
      const expiring = await invite({})
      ahead = 7 * DAY + 1000
      // The People/Access view retains the expired pending invitation for
      // reissue and expiry counts; inspection and acceptance still refuse it.
      expect((await viewOf(expiring.membership.memberId)).pendingInvitation).toEqual({
        id: expiring.invitation.id,
        expiresAt: expiring.invitation.expiresAt,
      })
      expect(
        await refusedWith(() => workspace.memberships.inspectInvitation(expiring.invitation.token)),
      ).toBe('invitation-invalid')
      expect(
        await refusedWith(async () =>
          workspace.memberships.accept({
            token: expiring.invitation.token,
            account: await accountFor('Dave', 'dave password 123'),
          }),
        ),
      ).toBe('invitation-invalid')
      expect(await rowOf(expiring.membership.memberId)).toBe(undefined)
      ahead = 0

      // A revoked invitation.
      const revoked = await invite({})
      await workspace.memberships.revokeInvitation({
        actor: asAlice(),
        invitationId: revoked.invitation.id,
      })
      expect(
        await refusedWith(async () =>
          workspace.memberships.accept({
            token: revoked.invitation.token,
            account: await accountFor('Erin', 'erin password 123'),
          }),
        ),
      ).toBe('invitation-invalid')
      expect(await rowOf(revoked.membership.memberId)).toBe(undefined)
      // Revoking it again, or revoking one that was accepted, is refused.
      expect(
        await refusedWith(() =>
          workspace.memberships.revokeInvitation({
            actor: asAlice(),
            invitationId: revoked.invitation.id,
          }),
        ),
      ).toBe('invitation-invalid')
      expect(
        await refusedWith(() =>
          workspace.memberships.revokeInvitation({ actor: asAlice(), invitationId: invitation.id }),
        ),
      ).toBe('invitation-invalid')
      // A new invitation for the same membership revokes the earlier one.
      const earlier = await invite({})
      const later = await invite({ memberId: earlier.membership.memberId })
      expect(later.membership.memberId).toBe(earlier.membership.memberId)
      expect(
        await refusedWith(() => workspace.memberships.inspectInvitation(earlier.invitation.token)),
      ).toBe('invitation-invalid')
      expect(
        (await workspace.memberships.inspectInvitation(later.invitation.token)).expiresAt > clock(),
      ).toBe(true)
      // No invitation token is stored.
      const stored = (await opened.stored('invitation', 'token_hash')) as string[]
      expect(stored.length > 0).toBe(true)
      expect(stored.includes(invitation.token)).toBe(false)
      expect(stored.includes(later.invitation.token)).toBe(false)
      await aliceUnchanged()
    })

    // 17 ------------------------------------------------------------------
    test(3, async () => {
      const { membership, invitation } = await invite({})
      const bob = await workspace.memberships.accept({
        token: invitation.token,
        account: await accountFor('Bob', BOB_PASSWORD),
      })
      const bobRow = await rowOf(bob.memberId)
      const malloryAccount = await accountFor('Mallory', MALLORY_PASSWORD)

      // Mallory holds Bob's link: it was used, and it opens nothing.
      expect(
        await refusedWith(() =>
          workspace.memberships.accept({ token: invitation.token, account: malloryAccount }),
        ),
      ).toBe('invitation-invalid')
      // Nobody can be invited onto Bob's member while Bob is a member.
      expect(await refusedWith(() => invite({ memberId: membership.memberId }))).toBe('not-allowed')
      expect(await rowOf(bob.memberId)).toEqual(bobRow)
      expect((await viewOf(bob.memberId)).account?.id).toBe(bob.accountId)

      // An account that is a member already cannot take a second membership.
      const spare = await invite({})
      expect(
        await refusedWith(() =>
          workspace.memberships.accept({
            token: spare.invitation.token,
            account: { kind: 'existing', accountId: bob.accountId },
          }),
        ),
      ).toBe('already-a-member')
      expect(await rowOf(spare.membership.memberId)).toBe(undefined)
      // The refusal consumed nothing: the invitation is still there.
      expect((await workspace.memberships.inspectInvitation(spare.invitation.token)).email).toBe(
        null,
      )

      // An invitation issued for an address is accepted only by that address.
      const addressed = await invite({ email: ' Carol@Example.Test ' })
      expect(addressed.membership.invitedEmail).toBe('carol@example.test')
      expect(
        await refusedWith(() =>
          workspace.memberships.accept({
            token: addressed.invitation.token,
            account: malloryAccount,
          }),
        ),
      ).toBe('email-mismatch')
      expect(
        await refusedWith(() =>
          workspace.memberships.accept({
            token: addressed.invitation.token,
            account: { kind: 'new', name: 'No Address', password: 'no address password' },
          }),
        ),
      ).toBe('email-mismatch')
      expect(await rowOf(addressed.membership.memberId)).toBe(undefined)
      const carol = await workspace.memberships.accept({
        token: addressed.invitation.token,
        account: await accountFor('Carol', 'carol password 123'),
      })
      expect(carol.memberId).toBe(addressed.membership.memberId)
      expect((await rowOf(carol.memberId))?.email).toBe('carol@example.test')

      // A member who is not an admin can use none of the operations.
      const asBob: Actor = { memberId: bob.memberId }
      const attempts: Array<() => Promise<unknown>> = [
        () => workspace.memberships.invite({ actor: asBob, role: 'admin' }),
        () =>
          workspace.memberships.setRole({ actor: asBob, memberId: bob.memberId, role: 'admin' }),
        () => workspace.memberships.disable({ actor: asBob, memberId: alice.memberId }),
        () => workspace.memberships.remove({ actor: asBob, memberId: alice.memberId }),
        () => workspace.memberships.enable({ actor: asBob, memberId: alice.memberId }),
        () =>
          workspace.memberships.revokeInvitation({
            actor: asBob,
            invitationId: spare.invitation.id,
          }),
      ]
      for (const attempt of attempts) expect(await refusedWith(attempt)).toBe('admin-required')
      expect((await viewOf(bob.memberId)).role).toBe('member')
      await aliceUnchanged()
    })

    // 18 ------------------------------------------------------------------
    test(4, async () => {
      const bob = await join()
      await workspace.memberships.remove({ actor: asAlice(), memberId: bob.memberId })
      const removed = (await rowOf(bob.memberId)) as MemberRowState
      expect(removed.state === 'active').toBe(false)
      const count = (await workspace.memberships.list()).length

      // Bob is invited again onto the member he was.
      const again = await invite({ memberId: bob.memberId, role: 'member' })
      expect(again.membership.memberId).toBe(bob.memberId)
      expect(again.membership.status).toBe('invited')
      // Still no way in, and no second member.
      expect(((await rowOf(bob.memberId)) as MemberRowState).state === 'active').toBe(false)
      expect((await workspace.memberships.list()).length).toBe(count)

      const back = await workspace.memberships.accept({
        token: again.invitation.token,
        // A local account ended with the first membership; this is a new one.
        account: local
          ? { kind: 'new', name: 'Bob', email: 'bob@example.test', password: BOB_PASSWORD }
          : { kind: 'existing', accountId: bob.accountId },
      })
      expect(back.memberId).toBe(bob.memberId)
      expect((await workspace.memberships.list()).length).toBe(count)
      const row = await rowMatches(bob.memberId)
      expect(row.state).toBe('active')
      expect(row.accountId).toBe(back.accountId)
      expect(row.generation).toBe(removed.generation + 1)

      // A member row that has no membership yet (a move): the invitation binds to it.
      const moved: MemberWrite = {
        memberId: 'mem_moved_from_another_server',
        version: 1,
        state: 'active',
        role: 'member',
        accountId: null,
        profile: { name: 'Carol', image: null, email: null },
        actor: { system: 'upgrade' },
      }
      await opened.memberRows.write(moved)
      const before = (await rowOf(moved.memberId)) as MemberRowState
      const binding = await invite({ memberId: moved.memberId })
      expect(binding.membership.memberId).toBe(moved.memberId)
      expect(await rowOf(moved.memberId)).toEqual(before)
      const carol = await workspace.memberships.accept({
        token: binding.invitation.token,
        account: await accountFor('Carol', 'carol password 123'),
      })
      expect(carol.memberId).toBe(moved.memberId)
      const bound = await rowMatches(moved.memberId)
      expect(bound.accountId).toBe(carol.accountId)
      expect(bound.generation).toBe(before.generation)
      expect((await workspace.memberships.list()).length).toBe(count + 1)

      // A member id that names nobody is refused.
      expect(await refusedWith(() => invite({ memberId: 'mem_nobody_at_all' }))).toBe('not-allowed')

      // A move can be tried again. After a revoked invitation that named a
      // member row, a new invitation names the same row and acceptance restores it.
      const retried: MemberWrite = { ...moved, memberId: 'mem_moved_and_retried' }
      await opened.memberRows.write(retried)
      const firstTry = await invite({ memberId: retried.memberId })
      await workspace.memberships.revokeInvitation({
        actor: asAlice(),
        invitationId: firstTry.invitation.id,
      })
      expect((await viewOf(retried.memberId)).status).toBe('removed')
      expect(((await rowOf(retried.memberId)) as MemberRowState).state === 'active').toBe(false)
      const secondTry = await invite({ memberId: retried.memberId })
      expect(secondTry.membership.memberId).toBe(retried.memberId)
      const dave = await workspace.memberships.accept({
        token: secondTry.invitation.token,
        account: await accountFor('Dave', 'dave password 123'),
      })
      expect(dave.memberId).toBe(retried.memberId)
      const restored = await rowMatches(retried.memberId)
      expect(restored.state).toBe('active')
      expect(restored.accountId).toBe(dave.accountId)

      // The same after an invitation that expired: the row was left as it was,
      // and a new invitation for it is accepted.
      const late: MemberWrite = { ...moved, memberId: 'mem_moved_and_expired' }
      await opened.memberRows.write(late)
      const lateBefore = (await rowOf(late.memberId)) as MemberRowState
      const lapsed = await invite({ memberId: late.memberId })
      ahead = 8 * DAY
      expect(
        await refusedWith(async () =>
          workspace.memberships.accept({
            token: lapsed.invitation.token,
            account: await accountFor('Erin', 'erin password 123'),
          }),
        ),
      ).toBe('invitation-invalid')
      expect(await rowOf(late.memberId)).toEqual(lateBefore)
      const renewed = await invite({ memberId: late.memberId })
      const frank = await workspace.memberships.accept({
        token: renewed.invitation.token,
        account: await accountFor('Frank', 'frank password 123'),
      })
      expect(frank.memberId).toBe(late.memberId)
      const kept = await rowMatches(late.memberId)
      expect(kept.state).toBe('active')
      expect(kept.accountId).toBe(frank.accountId)
      expect(kept.generation).toBe(lateBefore.generation)
      expect((await workspace.memberships.list()).length).toBe(count + 3)
      await aliceUnchanged()
    })

    // 19 ------------------------------------------------------------------
    test(5, async () => {
      const host: Actor = { system: 'host' }
      // Alice is the only admin: nothing may take that away, whoever asks.
      const lastAdmin: Array<() => Promise<unknown>> = [
        () =>
          workspace.memberships.setRole({
            actor: asAlice(),
            memberId: alice.memberId,
            role: 'member',
          }),
        () =>
          workspace.memberships.setRole({ actor: host, memberId: alice.memberId, role: 'member' }),
        () => workspace.memberships.disable({ actor: host, memberId: alice.memberId }),
        () => workspace.memberships.remove({ actor: host, memberId: alice.memberId }),
      ]
      for (const attempt of lastAdmin) expect(await refusedWith(attempt)).toBe('last-admin')
      await aliceUnchanged()

      // An ordinary member beside her changes nothing about that.
      const bob = await join()
      for (const attempt of lastAdmin) expect(await refusedWith(attempt)).toBe('last-admin')
      // A sole admin gets the last-admin explanation, even when acting on themselves.
      expect(
        await refusedWith(() =>
          workspace.memberships.disable({ actor: asAlice(), memberId: alice.memberId }),
        ),
      ).toBe('last-admin')
      expect(
        await refusedWith(() =>
          workspace.memberships.remove({ actor: asAlice(), memberId: alice.memberId }),
        ),
      ).toBe('last-admin')
      await aliceUnchanged()

      // A disabled admin does not count as one.
      await workspace.memberships.setRole({
        actor: asAlice(),
        memberId: bob.memberId,
        role: 'admin',
      })
      await workspace.memberships.disable({ actor: asAlice(), memberId: bob.memberId })
      for (const attempt of lastAdmin) expect(await refusedWith(attempt)).toBe('last-admin')
      await aliceUnchanged()

      // With Bob an active admin, Bob is not the last, and Alice is not either.
      await workspace.memberships.enable({ actor: asAlice(), memberId: bob.memberId })
      const asBob: Actor = { memberId: bob.memberId }
      await workspace.memberships.setRole({
        actor: asBob,
        memberId: alice.memberId,
        role: 'member',
      })
      expect((await rowOf(alice.memberId))?.role).toBe('member')
      // Now Bob is the last admin.
      expect(
        await refusedWith(() =>
          workspace.memberships.setRole({ actor: asBob, memberId: bob.memberId, role: 'member' }),
        ),
      ).toBe('last-admin')
      expect(
        await refusedWith(() =>
          workspace.memberships.remove({ actor: host, memberId: bob.memberId }),
        ),
      ).toBe('last-admin')
      expect((await rowOf(bob.memberId))?.role).toBe('admin')
      expect((await rowOf(bob.memberId))?.state).toBe('active')
    })

    // 20 ------------------------------------------------------------------
    test(6, async () => {
      const bob = await join()
      const bobSignIn = issued(await signIn('Bob', BOB_PASSWORD))
      const aliceSignIn = issued(await signIn('Alice', ALICE_PASSWORD))

      // No credential: not signed in.
      expect(await workspace.resolve(noCredential(), https())).toEqual({ kind: 'unauthenticated' })

      // An active membership: the member, with its role.
      const asMember = await workspace.resolve(requestOf(bobSignIn), https())
      expect(asMember.kind).toBe('member')
      if (asMember.kind !== 'member') return
      expect(asMember.memberId).toBe(bob.memberId)
      expect(asMember.role).toBe('member')
      expect(asMember.accountId).toBe(bob.accountId)
      expect(asMember.deviceSignIn?.id).toBe(bobSignIn.deviceSignInId)
      const held = {
        deviceSignInId: bobSignIn.deviceSignInId,
        memberId: bob.memberId,
        role: asMember.role,
      }
      expect(await workspace.revalidate(held)).toBe(true)

      // Resolving a member is one statement, and so is revalidating one.
      const before = opened.statements()
      await workspace.resolve(requestOf(bobSignIn), https())
      expect(opened.statements() - before).toBe(1)
      await workspace.revalidate(held)
      expect(opened.statements() - before).toBe(2)

      // Signed in, with no membership here.
      const carol = await core.accounts.create({ name: 'Carol', email: 'carol@example.test' })
      const carolSignIn = await core.deviceSignIns.create(
        carol.id,
        { kind: 'browser' },
        'cookie',
        https(),
      )
      expect(await workspace.resolve(requestOf(carolSignIn), https())).toEqual({
        kind: 'not-a-member',
        accountId: carol.id,
        membership: 'none',
      })
      // Invited, and not yet accepted.
      const carolInvitation = await invite({ email: 'carol@example.test' })
      expect(await workspace.resolve(requestOf(carolSignIn), https())).toEqual({
        kind: 'not-a-member',
        accountId: carol.id,
        membership: 'invited',
      })
      expect(await rowOf(carolInvitation.membership.memberId)).toBe(undefined)

      // A role change ends what was held under the old role.
      await workspace.memberships.setRole({
        actor: asAlice(),
        memberId: bob.memberId,
        role: 'admin',
      })
      expect(await workspace.revalidate(held)).toBe(false)
      expect(await workspace.revalidate({ ...held, role: 'admin' })).toBe(true)

      // Disabled. A local account's devices were signed out with it; a sign-in
      // made afterwards, and a shared account's own, are refused as not a member.
      await workspace.memberships.disable({ actor: asAlice(), memberId: bob.memberId })
      expect(await workspace.revalidate({ ...held, role: 'admin' })).toBe(false)
      const whileDisabled = local
        ? await core.deviceSignIns.create(bob.accountId, { kind: 'browser' }, 'cookie', https())
        : bobSignIn
      if (local) {
        expect(await workspace.resolve(requestOf(bobSignIn), https())).toEqual({
          kind: 'unauthenticated',
        })
      }
      expect(await workspace.resolve(requestOf(whileDisabled), https())).toEqual({
        kind: 'not-a-member',
        accountId: bob.accountId,
        membership: 'disabled',
      })

      // Removed. A local account is gone; a shared one is told it is not a member.
      await workspace.memberships.remove({ actor: asAlice(), memberId: bob.memberId })
      expect(await workspace.resolve(requestOf(whileDisabled), https())).toEqual(
        local
          ? { kind: 'unauthenticated' }
          : { kind: 'not-a-member', accountId: bob.accountId, membership: 'removed' },
      )

      // Alice enters as before.
      const stillAlice = await workspace.resolve(requestOf(aliceSignIn), https())
      expect(stillAlice.kind).toBe('member')
      if (stillAlice.kind === 'member') {
        expect(stillAlice.memberId).toBe(alice.memberId)
        expect(stillAlice.role).toBe('admin')
      }
      await aliceUnchanged()
    })

    // 21 ------------------------------------------------------------------
    test(7, async () => {
      let expected = await revision()
      const stepped = async (memberId: string) => {
        expected += 1
        expect((await viewOf(memberId)).version).toBe(expected)
        expect(await revision()).toBe(expected)
      }
      const { membership, invitation } = await invite({})
      await stepped(membership.memberId)
      const bob = await workspace.memberships.accept({
        token: invitation.token,
        account: await accountFor('Bob', BOB_PASSWORD),
      })
      await stepped(bob.memberId)
      await workspace.memberships.setRole({
        actor: asAlice(),
        memberId: bob.memberId,
        role: 'admin',
      })
      await stepped(bob.memberId)
      await workspace.memberships.disable({ actor: asAlice(), memberId: bob.memberId })
      await stepped(bob.memberId)
      await workspace.memberships.enable({ actor: asAlice(), memberId: bob.memberId })
      await stepped(bob.memberId)

      // A change of the account's name reaches the member row and steps nothing else.
      const generation = ((await rowOf(bob.memberId)) as MemberRowState).generation
      await core.accounts.updateProfile(bob.accountId, { name: 'Bob Renamed' })
      await stepped(bob.memberId)
      // Member rows that live elsewhere learn of an account's change at the next catch-up.
      expect(await workspace.catchUp()).toEqual({ applied: local ? 0 : 1 })
      const renamed = await rowMatches(bob.memberId)
      expect(renamed.name).toBe('Bob Renamed')
      expect(renamed.generation).toBe(generation)

      // A refused operation and one that changes nothing step nothing.
      expect(
        await refusedWith(() =>
          workspace.memberships.disable({ actor: asAlice(), memberId: alice.memberId }),
        ),
      ).toBe('self')
      await workspace.memberships.enable({ actor: asAlice(), memberId: bob.memberId })
      expect(await revision()).toBe(expected)

      // Applying the same membership again, or an older one, changes nothing.
      const row = (await rowOf(bob.memberId)) as MemberRowState
      const stale: MemberWrite = {
        memberId: bob.memberId,
        version: row.version,
        state: 'disabled',
        role: 'member',
        accountId: null,
        profile: { name: 'Somebody Else', image: null, email: null },
        actor: { system: 'host' },
      }
      await opened.memberRows.write(stale)
      expect(await rowOf(bob.memberId)).toEqual(row)
      await opened.memberRows.write({ ...stale, version: row.version - 2, state: 'removed' })
      expect(await rowOf(bob.memberId)).toEqual(row)
      // Catching up again finds nothing left to apply.
      expect(await workspace.catchUp()).toEqual({ applied: 0 })
      expect(await rowOf(bob.memberId)).toEqual(row)

      await workspace.memberships.remove({ actor: asAlice(), memberId: bob.memberId })
      await stepped(bob.memberId)
      await aliceUnchanged()
    })

    test(10, async () => {
      const bob = await join()
      const before = (await rowOf(bob.memberId)) as MemberRowState
      let cursor = await revision()
      const elsewhere = (await buildIdentity(configOf(opened.database))).core.workspace(WORKSPACE, {
        rows: opened.memberRows,
        sameDatabase: false,
        cursor: { read: async () => 2_147_483_647, write: async () => {} },
      })
      const reader = (await buildIdentity(configOf(opened.database))).core.workspace(WORKSPACE, {
        rows: opened.memberRows,
        sameDatabase: false,
        cursor: {
          read: async () => cursor,
          write: async (version) => {
            cursor = version
          },
        },
      })
      await elsewhere.memberships.disable({ actor: asAlice(), memberId: bob.memberId })
      await elsewhere.memberships.enable({ actor: asAlice(), memberId: bob.memberId })
      expect(await rowOf(bob.memberId)).toEqual(before)
      await reader.catchUp()
      const after = (await rowOf(bob.memberId)) as MemberRowState
      expect(after.state).toBe('active')
      expect(after.generation > before.generation).toBe(true)
      await reader.catchUp()
      expect(await rowOf(bob.memberId)).toEqual(after)
      await aliceUnchanged()
    })

    // 22 ------------------------------------------------------------------
    test(8, async () => {
      const bob = await join()
      const first = issued(await signIn('Bob', BOB_PASSWORD))
      const second = issued(await signIn('Bob', BOB_PASSWORD))
      const aliceSignIn = issued(await signIn('Alice', ALICE_PASSWORD))
      const byCode = async (accountId: string) => {
        const { code } = await core.codes.issue({
          purpose: 'host-sign-in',
          accountId,
          createdBy: 'host',
        })
        return await core.codes.redeem({ code }, { kind: 'host' }, 'bearer', https())
      }
      const signInsOf = async (accountId: string) =>
        (await core.deviceSignIns.listForAccount(accountId)).length
      expect(await signInsOf(bob.accountId)).toBe(2)

      // An account that never had a membership.
      const carol = await core.accounts.create({
        name: 'Carol',
        email: 'carol@example.test',
        password: 'carol password 123',
      })
      if (local) {
        // It is refused at password sign-in, with the answer of a wrong
        // password, and at code sign-in.
        expect(await signIn('Carol', 'carol password 123')).toEqual({ refused: 'invalid' })
        expect(await byCode(carol.id)).toBe(undefined)
        expect(await signInsOf(carol.id)).toBe(0)
      } else {
        // A shared account is the person's own, with or without this workspace.
        expect(issued(await signIn('Carol', 'carol password 123')).accountId).toBe(carol.id)
        expect(issued(await byCode(carol.id)).accountId).toBe(carol.id)
      }

      // Disabling.
      await workspace.memberships.disable({ actor: asAlice(), memberId: bob.memberId })
      if (local) {
        expect(await signInsOf(bob.accountId)).toBe(0)
        expect((await workspace.resolve(requestOf(first), https())).kind).toBe('unauthenticated')
        expect((await workspace.resolve(requestOf(second), https())).kind).toBe('unauthenticated')
        expect(await signIn('Bob', BOB_PASSWORD)).toEqual({ refused: 'invalid' })
        expect(await byCode(bob.accountId)).toBe(undefined)
      } else {
        expect(await signInsOf(bob.accountId)).toBe(2)
        expect((await workspace.resolve(requestOf(first), https())).kind).toBe('not-a-member')
        expect(issued(await signIn('Bob', BOB_PASSWORD)).accountId).toBe(bob.accountId)
      }

      // Enabling brings the rights back, never a sign-in that was ended.
      await workspace.memberships.enable({ actor: asAlice(), memberId: bob.memberId })
      expect((await workspace.resolve(requestOf(first), https())).kind).toBe(
        local ? 'unauthenticated' : 'member',
      )
      const again = issued(await signIn('Bob', BOB_PASSWORD))
      expect((await workspace.resolve(requestOf(again), https())).kind).toBe('member')
      expect(issued(await byCode(bob.accountId)).accountId).toBe(bob.accountId)

      // Removing.
      const accountsBefore = (await opened.stored('user', 'id')).length
      await workspace.memberships.remove({ actor: asAlice(), memberId: bob.memberId })
      if (local) {
        expect(await core.accounts.get(bob.accountId)).toBe(undefined)
        expect((await opened.stored('user', 'id')).length).toBe(accountsBefore - 1)
        expect(
          ((await opened.stored('session', 'user_id')) as string[]).includes(bob.accountId),
        ).toBe(false)
        expect(
          ((await opened.stored('account', 'user_id')) as string[]).includes(bob.accountId),
        ).toBe(false)
        expect(await signIn('Bob', BOB_PASSWORD)).toEqual({ refused: 'invalid' })
        expect((await viewOf(bob.memberId)).account).toBe(null)
      } else {
        expect((await core.accounts.get(bob.accountId))?.name).toBe('Bob')
        expect((await opened.stored('user', 'id')).length).toBe(accountsBefore)
        expect(issued(await signIn('Bob', BOB_PASSWORD)).accountId).toBe(bob.accountId)
        expect((await workspace.resolve(requestOf(again), https())).kind).toBe('not-a-member')
      }

      // Alice kept her sign-in through all of it.
      expect((await workspace.resolve(requestOf(aliceSignIn), https())).kind).toBe('member')
      await aliceUnchanged()
    })

    // 23 ------------------------------------------------------------------
    test(9, async () => {
      if (!local) {
        // The cloud has no same-machine rule: a request without a credential is nobody.
        expect(await workspace.signInRequired()).toBe(true)
        expect(
          await workspace.resolve(noCredential(), {
            scheme: 'https',
            sameMachine: true,
            clientAddress: '127.0.0.1',
          }),
        ).toEqual({ kind: 'unauthenticated' })
        expect(
          await workspace.revalidate({
            sameMachine: true,
            memberId: alice.memberId,
            role: 'admin',
          }),
        ).toBe(false)
        return
      }
      // A one-person server whose person never set a password.
      const solo = await harness.open()
      try {
        const built = await buildIdentity(configOf(solo.database))
        const only = bind(built.core, solo)
        const sole = await only.memberships.adopt({
          by: 'setup',
          role: 'admin',
          status: 'active',
          account: { kind: 'new', name: 'Alice' },
        })
        const held = { sameMachine: true as const, memberId: sole.memberId, role: 'admin' as const }

        // One active member and no password: this machine's own request is that member.
        expect(await only.signInRequired()).toBe(false)
        const admitted = await only.resolve(noCredential(), loopback())
        expect(admitted).toEqual({
          kind: 'member',
          memberId: sole.memberId,
          role: 'admin',
          accountId: sole.account?.id,
          deviceSignIn: null,
          renewDue: false,
        })
        expect(await only.revalidate(held)).toBe(true)
        // One statement.
        const before = solo.statements()
        await only.resolve(noCredential(), loopback())
        expect(solo.statements() - before).toBe(1)
        // A request that is not from this machine is nobody.
        expect(await only.resolve(noCredential(), https())).toEqual({ kind: 'unauthenticated' })

        // A password without the waiver ends it; the waiver brings it back.
        await built.core.accounts.setPassword(sole.account?.id as string, ALICE_PASSWORD)
        expect(await only.signInRequired()).toBe(true)
        expect(await only.resolve(noCredential(), loopback())).toEqual({ kind: 'unauthenticated' })
        expect(await only.revalidate(held)).toBe(false)
        waived = true
        expect(await only.signInRequired()).toBe(false)
        expect((await only.resolve(noCredential(), loopback())).kind).toBe('member')
        expect(await only.revalidate(held)).toBe(true)

        // An invitation alone changes nothing; a second active member ends the rule.
        const { invitation } = await only.memberships.invite({
          actor: { memberId: sole.memberId },
          role: 'member',
        })
        expect((await only.resolve(noCredential(), loopback())).kind).toBe('member')
        await only.memberships.accept({
          token: invitation.token,
          account: { kind: 'new', name: 'Bob', email: 'bob@example.test', password: BOB_PASSWORD },
        })
        expect(await only.signInRequired()).toBe(true)
        expect(await only.resolve(noCredential(), loopback())).toEqual({ kind: 'unauthenticated' })
        expect(await only.revalidate(held)).toBe(false)
      } finally {
        await solo.close()
      }
      // The workspace of this case, with Alice's password and no waiver, admits nobody.
      waived = false
      expect(await workspace.resolve(noCredential(), loopback())).toEqual({
        kind: 'unauthenticated',
      })
    })
  })
}
