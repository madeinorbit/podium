/**
 * THE MEMBERSHIP OF A FRESH DATABASE'S FIRST ADMIN (POD-6746).
 *
 * A person enters only through an active membership. A fresh database already
 * holds one member row, the first admin a migration inserts, and no
 * membership; without one that person could not use their own one-person
 * server. This step gives exactly that row its membership and an account with
 * no login method (docs/design/people-and-sign-in.md, section 8.2), so the
 * same-machine rule serves them as before.
 *
 * It runs at boot, and only when the server built its own identity core: a
 * hosted workspace database must never get local accounts.
 *
 * IT COVERS THE FRESH INSTALL AND NOTHING ELSE. The row is adopted only when
 * all of these hold:
 *
 *   - the workspace has no membership at all;
 *   - the database holds exactly one member row;
 *   - that row is enabled;
 *   - it has no password in `user_credentials`.
 *
 * Every other database is an existing server. It is left exactly as it is and
 * the boot log says so.
 *
 * POD-6750 (Existing server upgrade) EXTENDS THIS FUNCTION IN PLACE: the
 * `left-untouched` outcomes below are the cases it takes over. Keep the file
 * and the name `ensureLocalIdentity`; specification section 14 names them.
 *
 * Running it twice changes nothing the second time: a workspace that has any
 * membership is not touched.
 */
import type { WorkspaceIdentity } from '@podium/identity'
import { asUserId } from '@podium/model'
import type { SessionStore } from '../store'

export type EnsureLocalIdentityOutcome =
  /** The workspace already has memberships, or the database has no member row. */
  | { kind: 'nothing-to-do' }
  /** The sole member of a fresh database got its membership and account. */
  | { kind: 'adopted-first-admin'; memberId: string }
  /** Member rows exist without memberships and this step does not cover them. */
  | {
      kind: 'left-untouched'
      reason: 'several-members' | 'disabled-member' | 'member-has-password'
      /** How many member rows the database holds. */
      members: number
    }

export async function ensureLocalIdentity(
  store: SessionStore,
  workspace: WorkspaceIdentity,
): Promise<EnsureLocalIdentityOutcome> {
  return await store.transact(async (): Promise<EnsureLocalIdentityOutcome> => {
    if ((await workspace.memberships.list()).length > 0) return { kind: 'nothing-to-do' }
    const members = await store.users.listIncludingDisabled()
    const [only] = members
    if (!only) return { kind: 'nothing-to-do' }
    const untouched = (
      reason: Extract<EnsureLocalIdentityOutcome, { kind: 'left-untouched' }>['reason'],
    ): EnsureLocalIdentityOutcome => ({ kind: 'left-untouched', reason, members: members.length })
    if (members.length !== 1) return untouched('several-members')
    if (only.disabledAt !== null) return untouched('disabled-member')
    if ((await store.users.credentialFor(asUserId(only.id)))?.passwordHash) {
      return untouched('member-has-password')
    }
    await workspace.memberships.adopt({
      by: 'upgrade',
      memberId: only.id,
      role: only.role,
      status: 'active',
      account: {
        kind: 'new',
        name: only.displayName,
        ...(only.email ? { email: only.email } : {}),
      },
    })
    return { kind: 'adopted-first-admin', memberId: only.id }
  })
}
