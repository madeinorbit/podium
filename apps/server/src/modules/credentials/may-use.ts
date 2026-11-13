/**
 * WHO MAY USE A CREDENTIAL (credential management spec §12).
 *
 * Its owner, today. Epic Task 4 adds the `use` and `manage` grants; every
 * caller already goes through here, so a grant counts everywhere once it lands.
 */

import type { CredentialId, UserId } from '@podium/model'
import type { SessionStore } from '../../store'

/** What Task 4 reads the grants from. A SessionStore satisfies it. */
export type MayUseDeps = Pick<SessionStore, 'grants'>

export type CredentialAccessLevel = 'owner' | 'manage' | 'use'

export async function mayUse(
  _deps: MayUseDeps,
  userId: UserId,
  credential: { id: CredentialId; ownerUserId: UserId },
): Promise<CredentialAccessLevel | null> {
  return credential.ownerUserId === userId ? 'owner' : null
}
