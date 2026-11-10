/**
 * The membership operations of one workspace (people and sign-in
 * specification, section 2.6): who is in it, with which role, and how they
 * are invited.
 *
 * Every operation runs in one transaction and does, in this order: check the
 * actor, check the rule, change the membership. The engine's `write` then
 * steps the workspace revision and applies the membership to the member row.
 * A refusal throws inside the transaction, so nothing of a refused operation
 * stays.
 */
import { toAccount } from '../accounts'
import {
  inGeneratedDomain,
  isGeneratedIdentifier,
  newPublicId,
  newSecret,
  normaliseEmail,
  sha256Hex,
} from '../secrets'
import { accountByEmail, accountById, deleteSignInsOfAccount, insertCode } from '../statements'
import {
  type Account,
  type AccountOperations,
  type AccountRef,
  type Actor,
  IdentityRefused,
  type MembershipOperations,
  MembershipRefused,
  type MembershipView,
} from '../types'
import type { BoundWorkspace, MembershipEngine } from './engine'
import { type LegacyLinkImporter, legacyLinkImport } from './legacy-link'
import {
  anyMembership,
  consumeInvitation,
  deleteAccount,
  deleteCodesOfAccount,
  deleteLoginMethodsOfAccount,
  type InvitationRow,
  insertInvitation,
  invitationByHash,
  invitationById,
  liveMembershipOfAccount,
  liveMembershipsOfAccount,
  type MembershipRole,
  type MembershipRow,
  type MembershipStatus,
  membershipOf,
  membershipsOfWorkspace,
  otherActiveAdmin,
  passwordMembersOfWorkspace,
  pendingInvitationsOfWorkspace,
  revokeInvitationById,
  revokeInvitationsOfMember,
} from './statements'

const DAY_MS = 86_400_000
const DEFAULT_INVITATION_DAYS = 7
const MAX_INVITATION_DAYS = 30

const refuse = (code: MembershipRefused['code']): never => {
  throw new MembershipRefused(code)
}

/** An account reference whose password, if any, is already hashed. */
type PreparedAccount =
  | { kind: 'existing'; accountId: string }
  | { kind: 'new'; name: string; email?: string; passwordHash?: string }

export function membershipOperations(
  engine: MembershipEngine,
  workspace: BoundWorkspace,
  accounts: AccountOperations,
): MembershipOperations & LegacyLinkImporter {
  const { runtime } = engine
  const { workspaceId } = workspace
  const rows = workspace.binding.rows
  const localAccounts = runtime.config.accounts === 'local'
  const db = () => runtime.db()

  const change = <T>(fn: () => Promise<T>) => engine.change(workspaceId, fn)

  async function membership(memberId: string): Promise<MembershipRow | undefined> {
    return (await membershipOf(db()).run({ workspaceId, memberId }))[0]
  }

  /** A member actor must be an active admin, read inside the transaction. */
  async function requireActor(actor: Actor): Promise<void> {
    if ('system' in actor) return
    const row = await membership(actor.memberId)
    if (row?.status !== 'active' || row.role !== 'admin') refuse('admin-required')
  }

  /** Whether `row` is the only active admin of the workspace. */
  async function isLastAdmin(row: MembershipRow): Promise<boolean> {
    if (row.status !== 'active' || row.role !== 'admin') return false
    const others = await otherActiveAdmin(db()).run({ workspaceId, memberId: row.memberId })
    return others.length === 0
  }

  /** A password is hashed before the transaction opens: a hash takes long on purpose. */
  async function prepare(ref: AccountRef): Promise<PreparedAccount> {
    if (ref.kind === 'existing') return ref
    const passwordHash =
      ref.passwordHash ??
      (ref.password === undefined ? undefined : await runtime.hashPassword(ref.password))
    return {
      kind: 'new',
      name: ref.name,
      ...(ref.email === undefined ? {} : { email: ref.email }),
      ...(passwordHash === undefined ? {} : { passwordHash }),
    }
  }

  /** The account a reference names, created when it is new. Inside the transaction. */
  async function take(ref: PreparedAccount): Promise<Account> {
    if (ref.kind === 'new') return await accounts.create(ref)
    const [row] = await accountById(db()).run({ id: ref.accountId })
    if (!row) throw new IdentityRefused('unknown-account')
    return toAccount(row)
  }

  /** An account is at most one live member of a workspace. */
  async function refuseLiveMember(accountId: string): Promise<void> {
    const live = await liveMembershipOfAccount(db()).run({ workspaceId, accountId })
    if (live.length > 0) refuse('already-a-member')
  }

  /** A real address an admin typed for an invitation, normalised. */
  function invitedAddress(value: string | undefined): string | null {
    if (value === undefined) return null
    const email = normaliseEmail(value)
    if (email === '' || inGeneratedDomain(email)) throw new IdentityRefused('email-invalid')
    return email
  }

  function usable(invitation: InvitationRow | undefined, now: Date): invitation is InvitationRow {
    return (
      invitation !== undefined &&
      invitation.workspaceId === workspaceId &&
      invitation.consumedAt === null &&
      invitation.revokedAt === null &&
      invitation.expiresAt.getTime() > now.getTime()
    )
  }

  async function list(): Promise<MembershipView[]> {
    const memberships = await membershipsOfWorkspace(db()).run({ workspaceId })
    const withPassword = new Set(
      (await passwordMembersOfWorkspace(db()).run({ workspaceId })).map((row) => row.memberId),
    )
    const pending = new Map<string, { id: string; expiresAt: Date }>()
    // Newest first: the first one seen for a member is its current invitation.
    for (const row of await pendingInvitationsOfWorkspace(db()).run({
      workspaceId,
      now: runtime.now(),
    })) {
      if (!pending.has(row.memberId)) {
        pending.set(row.memberId, { id: row.id, expiresAt: row.expiresAt })
      }
    }
    return memberships.map((row) => ({
      memberId: row.memberId,
      role: row.role as MembershipRole,
      status: row.status as MembershipStatus,
      version: row.version,
      account:
        row.accountId === null || row.accountName === null || row.accountEmail === null
          ? null
          : {
              id: row.accountId,
              name: row.accountName,
              email: isGeneratedIdentifier(row.accountEmail) ? null : row.accountEmail,
              image: row.accountImage,
            },
      invitedEmail: row.invitedEmail,
      hasPassword: withPassword.has(row.memberId),
      pendingInvitation: row.status === 'invited' ? (pending.get(row.memberId) ?? null) : null,
    }))
  }

  async function viewOf(memberId: string): Promise<MembershipView> {
    const view = (await list()).find((entry) => entry.memberId === memberId)
    if (!view) throw new Error(`identity: membership ${memberId} is missing after its own write`)
    return view
  }

  /** Ends a local account with its membership: sign-ins, login methods, codes, the account. */
  async function deleteLocalAccount(accountId: string): Promise<void> {
    await deleteSignInsOfAccount(db()).run({ accountId })
    await deleteLoginMethodsOfAccount(db()).run({ accountId })
    await deleteCodesOfAccount(db()).run({ accountId })
    await deleteAccount(db()).run({ accountId })
  }

  return {
    list,

    async adopt(input) {
      const account = input.account === null ? null : await prepare(input.account)
      const memberId = await change(async () => {
        const actor: Actor = { system: input.by }
        let id = input.memberId
        if (input.by === 'upgrade') {
          // A member row that exists and has no membership (section 8.2).
          if (id === undefined || (await membership(id))) return refuse('not-allowed')
          if (!(await rows.exists?.(id))) return refuse('not-allowed')
        } else {
          // The first membership of a workspace that has none: its admin.
          if (input.role !== 'admin' || input.status !== 'active') return refuse('not-allowed')
          if ((await anyMembership(db()).run({ workspaceId })).length > 0) {
            return refuse('not-allowed')
          }
          id ??= runtime.config.newMemberId()
        }
        // An active member is a person who can enter; an invited one is nobody yet.
        if (input.status === 'active' && account === null) return refuse('not-allowed')
        if (input.status === 'invited' && account !== null) return refuse('not-allowed')
        let accountId: string | null = null
        if (account !== null) {
          accountId = (await take(account)).id
          await refuseLiveMember(accountId)
        }
        await engine.write(
          {
            workspaceId,
            memberId: id,
            accountId,
            role: input.role,
            status: input.status,
            invitedEmail: null,
            createdBy: input.by,
          },
          'insert',
          actor,
        )
        return id
      })
      return await viewOf(memberId)
    },

    async [legacyLinkImport](link) {
      if (!/^[0-9a-f]{64}$/.test(link.tokenHash)) return false
      return await change(async () => {
        if (!(link.expiresAt.getTime() > runtime.now().getTime())) return false
        if (link.kind === 'password-reset') {
          await insertCode(db()).run({
            id: link.id,
            purpose: 'password-reset',
            accountId: link.accountId,
            codeHash: link.tokenHash,
            receiverChallenge: null,
            device: null,
            createdBy: link.createdBy,
            now: link.createdAt,
            expiresAt: link.expiresAt,
          })
          return true
        }

        const actor = { system: 'upgrade' } as const
        const email = invitedAddress(link.email ?? undefined)
        const memberId = link.memberId ?? runtime.config.newMemberId()
        const existing = link.memberId === null ? undefined : await membership(memberId)
        if (existing && existing.status !== 'invited') return refuse('not-allowed')
        if (!existing) {
          if (link.memberId !== null && !(await rows.exists?.(memberId)))
            return refuse('not-allowed')
          await engine.write(
            {
              workspaceId,
              memberId,
              accountId: null,
              role: link.role,
              status: 'invited',
              invitedEmail: email,
              createdBy: link.createdBy,
            },
            'insert',
            actor,
          )
        } else if (existing.invitedEmail === null && email !== null) {
          await engine.write({ ...existing, invitedEmail: email }, 'update', actor, false)
        }
        await insertInvitation(db()).run({
          id: link.id,
          workspaceId,
          memberId,
          tokenHash: link.tokenHash,
          email,
          expiresAt: link.expiresAt,
          createdBy: link.createdBy,
          now: link.createdAt,
        })
        return true
      })
    },

    async invite(input) {
      const email = invitedAddress(input.email)
      const days = input.expiresInDays ?? DEFAULT_INVITATION_DAYS
      if (!Number.isInteger(days) || days < 1 || days > MAX_INVITATION_DAYS) refuse('not-allowed')
      const token = newSecret()
      const issued = await change(async () => {
        await requireActor(input.actor)
        const now = runtime.now()
        const createdBy = 'system' in input.actor ? input.actor.system : input.actor.memberId
        const facts = {
          workspaceId,
          accountId: null,
          role: input.role,
          status: 'invited',
          invitedEmail: email,
          createdBy,
        }
        let memberId: string
        if (input.memberId === undefined) {
          // A new person: the member id is minted now; no member row exists
          // until the invitation is accepted.
          memberId = runtime.config.newMemberId()
          await engine.write({ ...facts, memberId }, 'insert', input.actor)
        } else {
          memberId = input.memberId
          const existing = await membership(memberId)
          if (!existing) {
            // A member row without a membership (a move): the invitation binds to it.
            if (!(await rows.exists?.(memberId))) return refuse('not-allowed')
            await engine.write({ ...facts, memberId }, 'insert', input.actor)
          } else if (
            existing.status === 'removed' ||
            existing.status === 'invited' ||
            (existing.status === 'disabled' && existing.accountId === null)
          ) {
            // The membership keeps its row and its member id.
            await engine.write(
              { ...facts, memberId },
              'update',
              input.actor,
              existing.authorizationVersion !== 0,
            )
          } else {
            return refuse('not-allowed')
          }
        }
        // A new invitation for a membership revokes the earlier ones.
        await revokeInvitationsOfMember(db()).run({ workspaceId, memberId, now })
        const invitation = {
          id: newPublicId(),
          token,
          expiresAt: new Date(now.getTime() + days * DAY_MS),
        }
        await insertInvitation(db()).run({
          id: invitation.id,
          workspaceId,
          memberId,
          tokenHash: sha256Hex(token),
          email,
          expiresAt: invitation.expiresAt,
          createdBy,
          now,
        })
        return { memberId, invitation }
      })

      // Mailed after the commit, and only by an edition that says where the
      // link leads. A mail that fails leaves the invitation for the admin to copy.
      let mailed = false
      const { mail, invitationUrl } = runtime.config
      if (email !== null && mail && invitationUrl) {
        try {
          await mail.send({
            to: email,
            subject: 'You are invited to Podium',
            text: `Accept your invitation: ${invitationUrl(token, workspaceId)}`,
          })
          mailed = true
        } catch {
          mailed = false
        }
      }
      return { membership: await viewOf(issued.memberId), invitation: issued.invitation, mailed }
    },

    async revokeInvitation(input) {
      await change(async () => {
        await requireActor(input.actor)
        const now = runtime.now()
        const [invitation] = await invitationById(db()).run({ id: input.invitationId })
        if (!invitation || invitation.workspaceId !== workspaceId) {
          return refuse('invitation-invalid')
        }
        const revoked = await revokeInvitationById(db()).run({ id: invitation.id, now })
        if (revoked.length === 0) return refuse('invitation-invalid')
        const row = await membership(invitation.memberId)
        // A membership that waited for this invitation has no way in any more.
        if (row?.status === 'invited') {
          await engine.write(
            { ...row, status: 'removed' },
            'update',
            input.actor,
            row.authorizationVersion !== 0,
          )
        }
      })
    },

    async inspectInvitation(token) {
      const now = runtime.now()
      const [invitation] = await invitationByHash(db()).run({ tokenHash: sha256Hex(token) })
      if (!usable(invitation, now)) return refuse('invitation-invalid')
      const row = await membership(invitation.memberId)
      if (row?.status !== 'invited') return refuse('invitation-invalid')
      // A local account is made by accepting; a shared one may exist already.
      const needsAccount =
        localAccounts ||
        invitation.email === null ||
        (await accountByEmail(db()).run({ email: invitation.email })).length === 0
      return { email: invitation.email, expiresAt: invitation.expiresAt, needsAccount }
    },

    async accept(input) {
      const account = await prepare(input.account)
      return await change(async () => {
        const now = runtime.now()
        const [invitation] = await invitationByHash(db()).run({
          tokenHash: sha256Hex(input.token),
        })
        if (!invitation || invitation.workspaceId !== workspaceId) {
          return refuse('invitation-invalid')
        }
        // The one statement that consumes. Of two accepts at the same moment
        // one changes the row; the other changes none and stops here.
        const consumed = await consumeInvitation(db()).run({ id: invitation.id, now })
        if (consumed.length === 0) return refuse('invitation-invalid')
        const row = await membership(invitation.memberId)
        if (row?.status !== 'invited') return refuse('invitation-invalid')

        // An invitation issued for an address is accepted only by that address.
        if (account.kind === 'new' && invitation.email !== null) {
          const typed = account.email === undefined ? '' : normaliseEmail(account.email)
          if (typed !== invitation.email) return refuse('email-mismatch')
        }
        const taken = await take(account)
        if (account.kind === 'existing') {
          if (invitation.email !== null && taken.email !== invitation.email) {
            return refuse('email-mismatch')
          }
          await refuseLiveMember(taken.id)
        }
        await engine.write(
          { ...row, status: 'active', accountId: taken.id },
          'update',
          // The person who accepted is the member they became.
          { memberId: row.memberId },
          // First acceptance binds an account; it does not revoke existing member rights.
          row.authorizationVersion !== 0,
        )
        return { memberId: row.memberId, accountId: taken.id }
      })
    },

    async setRole(input) {
      await change(async () => {
        await requireActor(input.actor)
        const row = await membership(input.memberId)
        if (row?.status !== 'active') return refuse('unavailable')
        if (row.role === input.role) return
        if (input.role === 'member' && (await isLastAdmin(row))) return refuse('last-admin')
        await engine.write({ ...row, role: input.role }, 'update', input.actor)
      })
    },

    async disable(input) {
      await change(async () => {
        await requireActor(input.actor)
        const row = await membership(input.memberId)
        if (!row || (row.status !== 'active' && row.status !== 'disabled')) {
          return refuse('unavailable')
        }
        if (row.status === 'disabled') return
        if (await isLastAdmin(row)) return refuse('last-admin')
        if ('memberId' in input.actor && input.actor.memberId === row.memberId) {
          return refuse('self')
        }
        await engine.write({ ...row, status: 'disabled' }, 'update', input.actor)
        // A local account exists for this membership alone: its devices sign out.
        if (localAccounts && row.accountId !== null) {
          await deleteSignInsOfAccount(db()).run({ accountId: row.accountId })
        }
      })
    },

    async enable(input) {
      await change(async () => {
        await requireActor(input.actor)
        const row = await membership(input.memberId)
        if (!row || (row.status !== 'active' && row.status !== 'disabled')) {
          return refuse('unavailable')
        }
        if (row.status === 'active') return
        // Without an account nobody could enter; such a member is invited again.
        if (row.accountId === null) return refuse('unavailable')
        await engine.write({ ...row, status: 'active' }, 'update', input.actor)
      })
    },

    async remove(input) {
      await change(async () => {
        await requireActor(input.actor)
        const row = await membership(input.memberId)
        if (!row || (row.status !== 'active' && row.status !== 'disabled')) {
          return refuse('unavailable')
        }
        if (await isLastAdmin(row)) return refuse('last-admin')
        if ('memberId' in input.actor && input.actor.memberId === row.memberId) {
          return refuse('self')
        }
        const now = runtime.now()
        await revokeInvitationsOfMember(db()).run({ workspaceId, memberId: row.memberId, now })
        // A local account ends with its membership; a shared one is the person's own.
        const endsAccount = localAccounts && row.accountId !== null
        await engine.write(
          { ...row, status: 'removed', accountId: endsAccount ? null : row.accountId },
          'update',
          input.actor,
        )
        if (endsAccount) await deleteLocalAccount(row.accountId as string)
      })
    },

    async endForAccount(input) {
      const live = await liveMembershipsOfAccount(db()).run({ accountId: input.accountId })
      const ids = [...new Set(live.map((row) => row.workspaceId))]
        .filter((id) => input.workspaceIds === 'all' || input.workspaceIds.includes(id))
        .sort()
      for (const id of ids) {
        await engine.change(id, async () => {
          // Read again inside the transaction: it may have ended meanwhile.
          const [row] = await liveMembershipOfAccount(db()).run({
            workspaceId: id,
            accountId: input.accountId,
          })
          if (!row) return
          await revokeInvitationsOfMember(db()).run({
            workspaceId: id,
            memberId: row.memberId,
            now: runtime.now(),
          })
          await engine.write({ ...row, status: 'removed' }, 'update', { system: 'organisation' })
        })
      }
    },

    async accountOfActiveMember() {
      // Built by the sign-in carry-over (POD-6751), which is its only caller.
      throw new IdentityRefused('not-built', 'identity: accountOfActiveMember is not built yet')
    },
  }
}
