import { randomBytes } from 'node:crypto'
import {
  InviteId,
  LoginEmail,
  newInviteId,
  newMemberId,
  type UserId,
  type UserRole,
  userIdFromMemberId,
} from '@podium/model'
import { hashPassword } from '@podium/runtime/auth-store'
import { z } from 'zod'
import { hashToken } from './auth-route'
import type { UsersRepository } from './store/users'

export const InvitePassword = z.string().min(8).max(1024)
export const CreateMemberInvite = z.object({
  memberId: z.string().min(1).optional(),
  email: LoginEmail.optional(),
  role: z.enum(['admin', 'member']).default('member'),
  expiresInDays: z.number().int().min(1).max(30).default(7),
})
export type InviteIdentity =
  | { kind: 'password'; password: string; email: string; displayName: string }
  | { kind: 'account'; accountId: string; displayName?: string }
/** How long a link that resets an existing member's password stays usable. */
export const ADMIN_RECOVERY_TTL_MS = 24 * 60 * 60 * 1000
export const MAILED_RESET_TTL_MS = 60 * 60 * 1000
/** A member asking for a mailed reset again within this window gets no second mail. */
export const MAILED_RESET_THROTTLE_MS = 10 * 60 * 1000

export type InviteClaim =
  | { token: string; identity: InviteIdentity }
  // Only a trusted in-process hook may construct this arm. Never accepted over HTTP.
  | { preAuthorizedMemberId: UserId; identity: Extract<InviteIdentity, { kind: 'account' }> }

/** Shared by local invite completion and the hosted principal source. */
export class MemberInvites {
  constructor(
    private readonly users: UsersRepository,
    private readonly now = () => Date.now(),
  ) {}

  async create(actor: UserId, input: z.input<typeof CreateMemberInvite>) {
    const data = CreateMemberInvite.parse(input)
    return await this.users.claimTransaction(async () => {
      if ((await this.users.roleOf(actor)) !== 'admin') throw new Error('Administrator required')
      const member = data.memberId ? await this.users.get(data.memberId as UserId) : undefined
      if (data.memberId && !member) throw new Error('Member unavailable')
      if (member?.accountId) throw new Error('Member is already claimed')
      // A member who signs in with a password is re-admitted by a recovery
      // link, which replaces that password and says so; an invite never does.
      if (member && (await this.users.credentialFor(member.id as UserId)))
        throw new Error('Member already has a password; issue a recovery link instead')
      if (member?.email && data.email && member.email !== data.email)
        throw new Error('Use the member’s existing email')
      return await this.issue({
        memberId: member ? (member.id as UserId) : null,
        email: member?.email ?? data.email ?? null,
        role: member?.role ?? data.role,
        createdBy: actor,
        ttlMs: data.expiresInDays * 86_400_000,
      })
    })
  }

  /**
   * AN ADMIN-ISSUED RECOVERY LINK (POD-6298; design §2.1): a single-use link
   * that sets a new password for an existing member who has one. Completing it
   * signs the member out everywhere. The member keeps their id, role and
   * history; the admin sees the link once, to hand over.
   */
  async createRecovery(actor: UserId, memberId: UserId) {
    return await this.users.claimTransaction(async () => {
      if ((await this.users.roleOf(actor)) !== 'admin') throw new Error('Administrator required')
      const invite = await this.recoveryFor(memberId, actor, ADMIN_RECOVERY_TTL_MS)
      await this.users.audit('members.recoveryIssued', actor, { memberId })
      return invite
    })
  }

  /**
   * A MAILED RESET, ASKED FOR BY EMAIL ALONE (POD-6298). The answer is the
   * same whether or not the address names a member, so the caller learns
   * nothing; a link is made only for an enabled member with a password, and at
   * most once per throttle window. `undefined` means: send nothing.
   */
  async requestMailedReset(email: string) {
    const parsed = LoginEmail.safeParse(email)
    if (!parsed.success) return undefined
    return await this.users.claimTransaction(async () => {
      const member = await this.users.byEmail(parsed.data)
      if (!member?.email || !(await this.users.credentialFor(member.id as UserId))) return undefined
      const recent = (await this.users.pendingInvites()).some(
        (invite) =>
          invite.memberId === member.id &&
          invite.createdBy === member.id &&
          this.now() - Date.parse(invite.createdAt) < MAILED_RESET_THROTTLE_MS,
      )
      if (recent) return undefined
      const invite = await this.recoveryFor(
        member.id as UserId,
        member.id as UserId,
        MAILED_RESET_TTL_MS,
      )
      await this.users.audit('members.resetMailed', null, { memberId: member.id })
      return invite
    })
  }

  /**
   * A recovery link minted on this host (POD-6298): the operator who owns the
   * server's state directory, through the control socket. Audited as the host.
   */
  async createHostRecovery(email: string) {
    return await this.users.claimTransaction(async () => {
      const member = await this.users.byEmail(email)
      if (!member) throw new Error('No enabled member has that email')
      const invite = await this.recoveryFor(
        member.id as UserId,
        member.id as UserId,
        ADMIN_RECOVERY_TTL_MS,
      )
      await this.users.audit('members.recoveryIssued', null, { memberId: member.id, by: 'host' })
      return invite
    })
  }

  private async recoveryFor(memberId: UserId, createdBy: UserId, ttlMs: number) {
    const member = await this.users.get(memberId)
    if (!member) throw new Error('Member unavailable')
    if (!(await this.users.credentialFor(memberId)))
      throw new Error('Member has no password to recover; send an invite instead')
    return await this.issue({ memberId, email: member.email, role: member.role, createdBy, ttlMs })
  }

  private async issue(input: {
    memberId: UserId | null
    email: string | null
    role: UserRole
    createdBy: UserId
    ttlMs: number
  }) {
    const token = randomBytes(32).toString('base64url')
    const invite = {
      id: newInviteId(),
      tokenHash: hashToken(token),
      memberId: input.memberId,
      email: input.email,
      role: input.role,
      createdBy: input.createdBy,
      createdAt: new Date(this.now()).toISOString(),
      expiresAt: new Date(this.now() + input.ttlMs).toISOString(),
    }
    await this.users.insertInvite(invite)
    const { tokenHash: _, ...publicInvite } = invite
    return { ...publicInvite, token }
  }

  async list(actor: UserId) {
    if ((await this.users.roleOf(actor)) !== 'admin') throw new Error('Administrator required')
    return (await this.users.pendingInvites()).map(({ tokenHash: _, ...invite }) => invite)
  }

  async revoke(actor: UserId, id: string): Promise<void> {
    await this.users.claimTransaction(async () => {
      if ((await this.users.roleOf(actor)) !== 'admin') throw new Error('Administrator required')
      await this.users.deleteInvite(InviteId.parse(id))
    })
  }

  async inspect(token: string) {
    const invite = await this.validInvite(token)
    return {
      email: invite.email,
      expiresAt: invite.expiresAt,
      recovery: await this.isRecovery(invite.memberId),
    }
  }

  /** A link for a member who already signs in with a password resets it. */
  private async isRecovery(memberId: UserId | null): Promise<boolean> {
    return Boolean(memberId && (await this.users.credentialFor(memberId)))
  }

  private async validInvite(token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new Error('Invite is invalid or no longer available')
    const invite = await this.users.inviteByHash(hashToken(token))
    if (!invite || Date.parse(invite.expiresAt) <= this.now())
      throw new Error('Invite is invalid or no longer available')
    return invite
  }

  async complete(claim: InviteClaim) {
    const identity = claim.identity
    if ('preAuthorizedMemberId' in claim && identity.kind !== 'account')
      throw new Error('Trusted claims require an account')
    // Hash before entering the serialized write transaction. Recheck the token inside it.
    if ('token' in claim) await this.validInvite(claim.token)
    const passwordHash =
      identity.kind === 'password'
        ? await hashPassword(InvitePassword.parse(identity.password))
        : undefined
    const email = identity.kind === 'password' ? LoginEmail.parse(identity.email) : undefined
    if (
      identity.kind === 'account' &&
      (!identity.accountId.trim() || identity.accountId.length > 255)
    )
      throw new Error('Account id is required')
    return await this.users.claimTransaction(async () => {
      const invite = 'token' in claim ? await this.validInvite(claim.token) : undefined
      const memberId =
        invite?.memberId ??
        ('preAuthorizedMemberId' in claim ? claim.preAuthorizedMemberId : undefined)
      let member = memberId ? await this.users.get(memberId) : undefined
      if (memberId && !member) throw new Error('Member unavailable')
      if (member?.accountId) throw new Error('Member is already claimed')
      if (email && (invite?.email ?? member?.email) && email !== (invite?.email ?? member?.email))
        throw new Error('Use the invited email')
      if (
        identity.kind === 'password' &&
        member &&
        invite &&
        (await this.isRecovery(invite.memberId))
      ) {
        // A RECOVERY LINK: the invited email must be the member's own, the
        // password is replaced, and every sign-in of theirs ends (POD-6298).
        if (!email || email !== member.email) throw new Error('Use the invited email')
        if (!(await this.users.deleteInvite(invite.id)))
          throw new Error('Invite is no longer available')
        await this.users.recoverPassword(
          member.id as UserId,
          passwordHash!,
          new Date(this.now()).toISOString(),
        )
        return (await this.users.get(member.id as UserId))!
      }
      if (
        identity.kind === 'password' &&
        member &&
        (await this.users.credentialFor(member.id as UserId))
      )
        throw new Error('Member already has a password')
      if (!member) {
        member = {
          id: userIdFromMemberId(newMemberId()),
          email: email ?? invite?.email ?? null,
          displayName:
            identity.displayName?.trim().slice(0, 200) || email || invite?.email || 'Member',
          role: invite?.role ?? ('member' as UserRole),
          createdAt: new Date(this.now()).toISOString(),
          disabledAt: null,
        }
        await this.users.createUnclaimed(member)
      } else if (email && !member.email) {
        await this.users.setEmail(member.id as UserId, email)
      }
      if (identity.kind === 'account')
        await this.users.attachAccount(member.id as UserId, identity.accountId)
      else
        await this.users.setPasswordHash(
          member.id as UserId,
          passwordHash!,
          new Date(this.now()).toISOString(),
        )
      if (invite && !(await this.users.deleteInvite(invite.id)))
        throw new Error('Invite is no longer available')
      return (await this.users.get(member.id as UserId))!
    })
  }
}
