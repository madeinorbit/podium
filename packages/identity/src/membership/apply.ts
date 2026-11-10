/**
 * APPLY-MEMBERSHIP: the only function that changes a member row's identity
 * facts (people and sign-in specification, section 2.6).
 *
 * A membership says who is in a workspace and with which role; the member row
 * (`users`) is what every gate of the server reads. This function turns the
 * one into the other. It calls `rows.write` once, and the server's
 * implementation of that method steps the member's authorization generation,
 * which is what stops a disabled or removed person's sockets, agents, daemons
 * and queued work.
 *
 * Nothing else may call `MemberRows.write`.
 */
import type { MemberRows, MembershipSnapshot } from '../types'

export async function applyMembership(
  rows: MemberRows,
  membership: MembershipSnapshot,
): Promise<void> {
  // Inviting does not write a member row. During an upgrade the writer stamps
  // the version on a pre-existing row without changing its member facts.
  const upgrade = 'system' in membership.actor && membership.actor.system === 'upgrade'
  if (membership.status === 'invited' && !upgrade) return
  await rows.write({
    memberId: membership.memberId,
    version: membership.version,
    authorizationVersion: membership.authorizationVersion ?? 0,
    state: membership.status,
    role: membership.role,
    accountId: membership.accountId,
    profile: membership.profile,
    actor: membership.actor,
  })
}
