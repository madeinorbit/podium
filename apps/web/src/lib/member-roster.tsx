import {
  type MemberRoster,
  type MemberRosterAnswer,
  memberRoster,
} from '@podium/client-graph/member-roster'
import { observer } from '@podium/client-graph/react'
import { followVisibleRequest } from '@podium/client-graph/visible-request'
import { createContext, useContext, useEffect } from 'react'
import { useWorklistPool } from '@/app/store-worklist-pool'
import { serverConfig } from '@/app/trpc'
import { memberRequest } from '@/features/setup/member-api'

/** Members change rarely and nothing pushes them; refresh while shown. */
const REFRESH_MS = 5 * 60_000

/**
 * The pool's member roster (POD-6294). `load` is for the surfaces that own the
 * demand, the sidebar and the Tasks view: they read `/auth/members/directory`
 * when shown and every few minutes after. Leaves pass nothing and only read.
 *
 * A roster that cannot load (an older server, demo mode, no network) stays
 * empty, which is the one-member answer: the views keep their former rules.
 */
export function useMemberRoster(load = false): MemberRoster | undefined {
  const pool = useWorklistPool()
  const roster = pool ? memberRoster(pool) : undefined
  useEffect(() => {
    if (!load || !roster || typeof window === 'undefined' || typeof document === 'undefined') return
    const origin = serverConfig(window.location).httpOrigin
    return followVisibleRequest(
      () => {
        if (!roster.loading)
          void roster.read(() => memberRequest<MemberRosterAnswer>(origin, 'directory'))
      },
      {
        visible: () => document.visibilityState !== 'hidden',
        subscribe: (changed) => {
          document.addEventListener('visibilitychange', changed)
          return () => document.removeEventListener('visibilitychange', changed)
        },
      },
      REFRESH_MS,
    )
  }, [load, roster])
  return roster
}

/**
 * The roster for PRESENTATIONAL views (POD-6294). The issue list renders
 * without a store in harnesses and tests, so its rows read the roster the Tasks
 * view provides here rather than the pool; with no provider a row names nobody.
 */
export const MemberRosterContext = createContext<Pick<MemberRoster, 'nameOf'> | undefined>(
  undefined,
)

export function useProvidedMemberRoster(): Pick<MemberRoster, 'nameOf'> | undefined {
  return useContext(MemberRosterContext)
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
  roster: Pick<MemberRoster, 'nameOf'> | undefined,
  memberId: string | null | undefined,
  fallback?: string,
): string {
  return roster?.nameOf(memberId) ?? fallback ?? (memberId ? 'Member' : 'Unassigned')
}
