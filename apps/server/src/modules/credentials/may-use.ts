/**
 * WHO MAY USE A CREDENTIAL (credential management spec §12).
 *
 * Its owner; a person holding a `manage` grant; and a person holding a `use`
 * grant, to them or to all members. A grant counts only while its granter still
 * may give it: the owner, or someone who holds `manage` through a chain that
 * starts at the owner, and who is still a member. Every answer is read from the
 * grant table at the call: take a grant away, or remove the person who gave it,
 * and the next call says no. Being an admin gives nothing.
 */

import { ALL_MEMBERS_GRANTEE, type CredentialId, type UserId } from '@podium/model'
import type { SessionStore } from '../../store'
import type { GrantRow } from '../../store/grants'

/** What the answer is read from. A SessionStore satisfies it. */
export type MayUseDeps = Pick<SessionStore, 'grants' | 'users'>

export type CredentialAccessLevel = 'owner' | 'manage' | 'use'

/** The resource kind of a credential's grant edges. */
export const CREDENTIAL_RESOURCE_KIND = 'credential'

export async function mayUse(
  deps: MayUseDeps,
  userId: UserId,
  credential: { id: CredentialId; ownerUserId: UserId },
): Promise<CredentialAccessLevel | null> {
  const edges = await deps.grants.loadForResource(CREDENTIAL_RESOURCE_KIND, credential.id)
  return await accessFrom(deps, userId, credential, edges)
}

/**
 * {@link mayUse} over edges the caller already read (one grants read for many
 * credentials). The granters' standing is read once, together.
 */
export async function accessFrom(
  deps: Pick<SessionStore, 'users'>,
  userId: UserId,
  credential: { id: CredentialId; ownerUserId: UserId },
  edges: readonly GrantRow[],
): Promise<CredentialAccessLevel | null> {
  if (userId === credential.ownerUserId) return 'owner'
  const people = [
    credential.ownerUserId,
    ...new Set(edges.map((edge) => edge.owner as UserId)),
  ] as UserId[]
  const accounts = await Promise.all(people.map((id) => deps.users.get(id)))
  const live = new Set(people.filter((_, i) => accounts[i] !== undefined))
  // Nobody else may use the credential of an owner who is no longer a member.
  if (!live.has(credential.ownerUserId)) return null

  // Who may give grants: the owner, then whoever a live manager gave `manage`.
  const managers = new Set<string>([credential.ownerUserId])
  let grew = true
  while (grew) {
    grew = false
    for (const edge of edges) {
      if (
        edge.verb === 'manage' &&
        !managers.has(edge.grantee) &&
        edge.grantee !== ALL_MEMBERS_GRANTEE &&
        managers.has(edge.owner) &&
        live.has(edge.owner as UserId)
      ) {
        managers.add(edge.grantee)
        grew = true
      }
    }
  }
  if (managers.has(userId)) return 'manage'
  const used = edges.some(
    (edge) =>
      edge.verb === 'use' &&
      (edge.grantee === userId || edge.grantee === ALL_MEMBERS_GRANTEE) &&
      managers.has(edge.owner) &&
      live.has(edge.owner as UserId),
  )
  return used ? 'use' : null
}
