import {
  type MemberRoster,
  type MemberRosterAnswer,
  memberRoster,
} from '@podium/client-graph/member-roster'
import { useEffect } from 'react'
import { demoEnabled } from './demoData'
import { useMobilePool } from './mobile-pool'
import { useOptionalServerProfile } from './server-profile-context'
import { fetchMobileTransport } from './trpc'
import { followPhoneRequest } from './visible-request'

/** Members change rarely and nothing pushes them; refresh while shown. */
const REFRESH_MS = 5 * 60_000

/**
 * `/auth/members/directory` with the profile's credential: the instance's
 * active members, and who is asking (POD-6294). Every signed-in member reads
 * it; another member's email comes back only to admins.
 */
export async function readMemberDirectory(
  httpOrigin: string,
  bearer: string | null,
  fetcher: typeof fetchMobileTransport = fetchMobileTransport,
): Promise<MemberRosterAnswer> {
  const response = await fetcher(
    `${httpOrigin.replace(/\/+$/, '')}/auth/members/directory`,
    { cache: 'no-store', headers: { accept: 'application/json' } },
    bearer,
  )
  if (!response.ok) throw new Error(`member directory failed: ${response.status}`)
  const body = (await response.json()) as Partial<MemberRosterAnswer>
  if (!Array.isArray(body.members) || typeof body.currentMemberId !== 'string')
    throw new Error('member directory answered an unexpected shape')
  return { members: body.members, currentMemberId: body.currentMemberId }
}

/** The pool's member roster, read only: for leaves (rows, badges, sheets). */
export function useMemberRosterReader(): MemberRoster | undefined {
  const pool = useMobilePool()
  return pool ? memberRoster(pool) : undefined
}

/**
 * THE PHONE'S MEMBER ROSTER (POD-6297; design §2.2), the same pool roster the
 * web reads, loaded while the calling screen is mounted and the app is in
 * front (`followPhoneRequest`; a read already in flight is not repeated). The
 * screens that own the demand call this: the Work tab (the phone's sidebar),
 * the Tasks tab and the task page. Leaves use `useMemberRosterReader`. A plain
 * effect, not Expo Router's focus hook: leaves and their tests must not reach
 * the router.
 *
 * A roster that cannot load (demo mode, an older server, no network) stays
 * empty, which is the one-member answer: Tasks lists every task, Work keeps
 * its former rule, and no screen names an assignee it cannot resolve.
 */
export function useMobileMemberRoster(): MemberRoster | undefined {
  const roster = useMemberRosterReader()
  const profile = useOptionalServerProfile()
  const httpOrigin = profile?.profile.httpOrigin
  const bearer = profile?.bearer ?? null
  useEffect(() => {
    if (!roster || !httpOrigin || demoEnabled()) return
    return followPhoneRequest(() => {
      if (!roster.loading) void roster.read(() => readMemberDirectory(httpOrigin, bearer))
    }, REFRESH_MS)
  }, [roster, httpOrigin, bearer])
  return roster
}

/**
 * A member's display name where a task names its assignee. Until the roster
 * knows the member, `fallback` (a legacy free-text label) or a neutral word,
 * never the raw member id.
 */
export function memberDisplayName(
  roster: Pick<MemberRoster, 'nameOf'> | undefined,
  memberId: string | null | undefined,
  fallback?: string | null,
): string {
  return roster?.nameOf(memberId) ?? fallback ?? (memberId ? 'Member' : 'Unassigned')
}
