import { observer } from '@podium/client-graph/react'
import { type RosterFacts, rosterFacts } from '@podium/client-graph/worklist/view-model'
import { useEffect } from 'react'
import { useWorklistPool } from '@/app/store-worklist-pool'
import { throughRestarts } from '@/lib/chunk-recovery'

/**
 * The pool's member roster (POD-6294). `load` is for the surfaces that own the
 * demand, the sidebar and the Tasks view: they read `/auth/members/directory`
 * when shown and every few minutes after. Leaves pass nothing and only read.
 *
 * The answer is the startup roster facts the worklist reads; the directory
 * request and its visibility follower load behind a dynamic import, so the
 * first paint carries no request code (POD-6299).
 *
 * A roster that cannot load (an older server, demo mode, no network) stays
 * empty, which is the one-member answer: the views keep their former rules.
 */
export function useMemberRoster(load = false): RosterFacts | undefined {
  const pool = useWorklistPool()
  const roster = pool ? rosterFacts(pool) : undefined
  useEffect(() => {
    if (!load || !pool || typeof window === 'undefined' || typeof document === 'undefined') return
    let stop: (() => void) | undefined
    let stopped = false
    void throughRestarts(() => import('./member-roster-loader'))
      .then(({ followMemberRoster }) => {
        if (!stopped) stop = followMemberRoster(pool)
      })
      .catch(() => {})
    return () => {
      stopped = true
      stop?.()
    }
  }, [load, pool])
  return roster
}

/**
 * A member's display name where a task names its assignee. Until the roster
 * knows the member, `fallback` (a legacy free-text label) or a neutral word,
 * never the raw member id.
 */
export const MemberName = observer(function MemberName({
  memberId,
  fallback,
}: {
  memberId: string | null | undefined
  fallback?: string
}) {
  const roster = useMemberRoster()
  return <>{memberDisplayName(roster, memberId, fallback)}</>
})

export function memberDisplayName(
  roster: Pick<RosterFacts, 'nameOf'> | undefined,
  memberId: string | null | undefined,
  fallback?: string,
): string {
  return roster?.nameOf(memberId) ?? fallback ?? (memberId ? 'Member' : 'Unassigned')
}
