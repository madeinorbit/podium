import type { WorkspaceIdentity } from '@podium/identity'
import { importLegacyLink } from '@podium/identity/upgrade'
import { asUserId } from '@podium/model'
import { DrizzleQueryError } from 'drizzle-orm'
import type { SessionStore } from '../store'

/**
 * Install local memberships before serving requests. Existing member ids are
 * adopted in place. An error rolls back the entire data step so boot can retry.
 */
export async function ensureLocalIdentity(store: SessionStore, workspace: WorkspaceIdentity) {
  const { accounts } = workspace.core
  const { memberships } = workspace
  return await store
    .transact(async () => {
      const counts = {
        members: 0,
        invitations: 0,
        passwordResets: 0,
        skippedSoleMemberInvitations: 0,
        retiredClientSessions: 0,
      }
      const existing = new Map(
        (await memberships.list()).map((member) => [member.memberId, member]),
      )
      const members = await store.users.listIncludingDisabled()
      const missing = members.filter((member) => !existing.has(member.id))
      const importLinks = !(await store.settings.legacyIdentityLinksImported())
      if (missing.length === 0 && !importLinks) return counts

      const passwords = await store.users.legacyPasswordHashes()
      const enabledMembers = members.filter((member) => member.disabledAt === null).length
      for (const member of missing) {
        const passwordHash = passwords.get(asUserId(member.id))
        const status =
          member.disabledAt !== null
            ? 'disabled'
            : passwordHash || enabledMembers === 1
              ? 'active'
              : 'invited'
        const account =
          passwordHash || status === 'active'
            ? await accounts.create({
                name: member.displayName,
                ...(member.email ? { email: member.email } : {}),
                ...(passwordHash ? { passwordHash } : {}),
              })
            : null
        if (account && member.avatar)
          await accounts.updateProfile(account.id, { image: member.avatar })
        const adopted = await memberships.adopt({
          by: 'upgrade',
          memberId: member.id,
          role: member.role,
          status,
          account: account ? { kind: 'existing', accountId: account.id } : null,
        })
        existing.set(adopted.memberId, adopted)
        counts.members += 1
      }

      if (!importLinks) return counts
      const now = Date.now()
      const membersById = new Map(members.map((member) => [member.id, member]))
      for (const invite of await store.users.pendingInvites()) {
        const expiresAt = new Date(invite.expiresAt)
        if (!(expiresAt.getTime() > now)) continue
        const storedLink = {
          id: invite.id,
          tokenHash: invite.tokenHash,
          createdBy: invite.createdBy,
          createdAt: new Date(invite.createdAt),
          expiresAt,
        }
        const target = invite.memberId === null ? undefined : existing.get(invite.memberId)
        if (invite.memberId === null || target?.status === 'invited') {
          const imported = await importLegacyLink(workspace, {
            ...storedLink,
            kind: 'invitation',
            memberId: invite.memberId,
            role: target?.role ?? invite.role,
            email:
              invite.email ??
              (invite.memberId ? (membersById.get(invite.memberId)?.email ?? null) : null),
          })
          if (imported) counts.invitations += 1
        } else if (target?.account && passwords.has(invite.memberId)) {
          const imported = await importLegacyLink(workspace, {
            ...storedLink,
            kind: 'password-reset',
            accountId: target.account.id,
          })
          if (imported) counts.passwordResets += 1
        } else if (target?.status === 'active' && enabledMembers === 1) {
          // The sole member keeps open access. They can set a password from Settings.
          counts.skippedSoleMemberInvitations += 1
        }
      }
      counts.retiredClientSessions = await store.users.deleteRetiredClientSessions()
      // The old links stay on disk for rollback. This prevents resurrecting
      // an imported link that is consumed or removed before the next boot.
      await store.settings.recordLegacyIdentityLinksImported()
      return counts
    })
    .catch((error: unknown) => {
      // Drizzle's error includes bound password and token hashes. Report the
      // SQLite cause without including the query parameters in the boot log.
      if (error instanceof DrizzleQueryError) {
        throw new Error('Local identity upgrade database error', { cause: error.cause })
      }
      throw error
    })
}
