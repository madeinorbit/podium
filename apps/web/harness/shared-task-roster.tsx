/**
 * THE SHARED TASK HARNESS'S ROSTER (POD-6295): three active members, and the
 * reader is Bob. Stands in for `src/lib/member-roster.tsx`, with the same
 * exports, so the page's leaf components name members without a pool.
 */
import type { MemberRoster } from '@podium/client-graph/member-roster'
import type { JSX } from 'react'

export const HARNESS_MEMBERS = [
  { id: 'mem_alice', displayName: 'Alice Martin' },
  { id: 'mem_bob', displayName: 'Bob Keller' },
  { id: 'mem_carol', displayName: 'Carol Diaz' },
]

export const harnessRoster = {
  shared: true,
  currentMemberId: 'mem_bob',
  members: HARNESS_MEMBERS,
  nameOf: (id: string | null | undefined) => HARNESS_MEMBERS.find((m) => m.id === id)?.displayName,
} as unknown as MemberRoster

export function useMemberRoster(_load = false): MemberRoster | undefined {
  return harnessRoster
}

export function memberDisplayName(
  roster: Pick<MemberRoster, 'nameOf'> | undefined,
  memberId: string | null | undefined,
  fallback?: string,
): string {
  return roster?.nameOf(memberId) ?? fallback ?? (memberId ? 'Member' : 'Unassigned')
}

export function MemberName({
  memberId,
  fallback,
}: {
  memberId: string | null | undefined
  fallback?: string
}): JSX.Element {
  return <>{memberDisplayName(harnessRoster, memberId, fallback)}</>
}
