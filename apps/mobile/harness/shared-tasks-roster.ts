/**
 * THE SHARED-TASKS HARNESS'S ROSTER (POD-6297): three active members, and the
 * reader is Bob. Stands in for `src/client/member-roster.ts`, with the same
 * exports, so the phone's leaves name members without a pool or a server.
 */
import type { MemberRoster } from '@podium/client-graph/member-roster'

export const HARNESS_MEMBERS = [
  { id: 'mem_alice', displayName: 'Alice Martin' },
  { id: 'mem_bob', displayName: 'Bob Keller' },
  { id: 'mem_carol', displayName: 'Carol Diaz' },
]

export const harnessRoster = {
  shared: true,
  loading: false,
  currentMemberId: 'mem_bob',
  members: HARNESS_MEMBERS,
  nameOf: (id: string | null | undefined) => HARNESS_MEMBERS.find((m) => m.id === id)?.displayName,
} as unknown as MemberRoster

export const useMemberRosterReader = (): MemberRoster | undefined => harnessRoster
export const useMobileMemberRoster = (): MemberRoster | undefined => harnessRoster

export function memberDisplayName(
  roster: Pick<MemberRoster, 'nameOf'> | undefined,
  memberId: string | null | undefined,
  fallback?: string | null,
): string {
  return roster?.nameOf(memberId) ?? fallback ?? (memberId ? 'Member' : 'Unassigned')
}
