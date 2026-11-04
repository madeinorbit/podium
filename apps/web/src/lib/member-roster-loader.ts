import { type MemberRosterAnswer, memberRoster } from '@podium/client-graph/member-roster'
import type { MobxPool } from '@podium/client-graph/pool'
import { followVisibleRequest } from '@podium/client-graph/visible-request'
import { serverConfig } from '@/app/trpc'
import { memberRequest } from '@/features/setup/member-api'

/** Members change rarely and nothing pushes them; refresh while shown. */
const REFRESH_MS = 5 * 60_000

/**
 * Read `/auth/members/directory` into the pool's roster while the page is
 * visible, and every few minutes after (POD-6294). Loaded behind the views
 * that own the demand, never at startup (POD-6299): the startup worklist
 * reads only the roster facts this answer writes.
 */
export function followMemberRoster(pool: MobxPool): () => void {
  const roster = memberRoster(pool)
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
}
