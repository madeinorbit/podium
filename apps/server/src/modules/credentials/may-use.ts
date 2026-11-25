/**
 * WHO MAY USE A CREDENTIAL (credential management spec §12).
 *
 * Its owner; a person holding a `manage` grant; and a person holding a `use`
 * grant, to them or to all members. A grant counts only while its granter still
 * may give it: the owner, or someone who holds `manage` through a chain that
 * starts at the owner, and who still has a member row. Every answer is read
 * from the grant table at the call: take a grant away and the next call says
 * no. Being an admin gives nothing.
 *
 * Only a member who may act uses anything (POD-7594): a person removed or
 * disabled is refused every credential, their own included, so a refresh or a
 * re-judge of a running session they own says no. What they shared stays
 * shared while they are disabled, which is temporary: the owner and the
 * granters count while their member row exists. A removal deletes the
 * credentials they own everywhere and ends their shares; what they gave as a
 * manager on someone else's key is handed to that key's owner, who can revoke
 * it (spec §12).
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
  const givers = [
    ...new Set([credential.ownerUserId, ...edges.map((edge) => edge.owner as UserId)]),
  ] as UserId[]
  // One batched account read: `users.get` answers undefined for a removed or a
  // disabled account; `hasMemberRow` is true for both.
  const [acting, ...rows] = await Promise.all([
    deps.users.get(userId),
    ...givers.map((id) => deps.users.hasMemberRow(id)),
  ])
  // Someone who may not act uses nothing, their own included.
  if (acting === undefined) return null
  if (userId === credential.ownerUserId) return 'owner'
  // A grant outlives the person who gave it (spec §12, operator decision
  // POD-7594): a disabled member's row counts here, and a removal hands what
  // they gave on someone else's key to that key's owner (users.ts), so no edge
  // needs them. Only their own keys and sessions go; the key's owner can revoke
  // what they gave, like any other share.
  const live = new Set(givers.filter((_, i) => rows[i] === true))
  // Nobody else may use the credential of an owner with no member row.
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
