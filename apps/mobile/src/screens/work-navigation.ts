import type { SessionView } from '@podium/client-core/session-values'
import { taskOpenSeat } from '@podium/client-core/values'
import { omitGone } from '@podium/client-graph/lookup'
import { missionView, requireLoaded, settled } from '@podium/client-graph/mission-view'
import type { MobxPool } from '@podium/client-graph/pool'
import type { PhoneWorkFilterSnapshot, PhoneWorkLane } from '@podium/client-graph/worklist/phone'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { allowImperativeRead } from '@podium/mobx-helpers'

/** Work, Tasks and their search results open the same desktop-selected chat.
 * A new row tap has no current pane; a present coordinator therefore wins.
 * Unsettled membership is resolved by the chat route's existing load boundary. */
export function workTaskHref(pool: MobxPool | null, issueId: string) {
  const chat = `/mission/${encodeURIComponent(issueId)}` as const
  const details = `/issue/${encodeURIComponent(issueId)}` as const
  if (!pool) return chat
  const target = allowImperativeRead(() =>
    settled(() => {
      const reader = missionView(pool)
      const rootId = requireLoaded(reader.rootFor(issueId))
      if (!rootId) return details
      const members = requireLoaded(reader.deck(rootId, 'full').members)
      const sessions: SessionView[] = []
      for (const member of members) sessions.push(...requireLoaded(reader.roster(member)))
      const issue = requireLoaded(omitGone(pool.row('issue', issueId)))
      const root = requireLoaded(omitGone(pool.row('issue', rootId)))
      const sessionId = taskOpenSeat({
        members: sessions,
        remembered: null,
        taskCoordinatorSessionId: issue?.coordinatorSessionId,
        rootCoordinatorSessionId: root?.coordinatorSessionId,
      })
      return sessionId ? (`${chat}?sessionId=${encodeURIComponent(sessionId)}` as const) : details
    }),
  )
  return target === LOADING ? chat : target
}

export type WorkRouteParams = {
  workLane?: string | string[]
  workQuery?: string | string[]
  workOffset?: string | string[]
  workFocus?: string | string[]
}
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)
export function readWorkNavigation(params: WorkRouteParams) {
  const value = first(params.workLane)
  const lane: PhoneWorkLane = value === 'snoozed' || value === 'closed' ? value : 'open'
  const offset = Number(first(params.workOffset) ?? 0)
  return {
    lane,
    query: first(params.workQuery) ?? '',
    offset: Number.isFinite(offset) && offset >= 0 ? offset : 0,
    focus: first(params.workFocus),
  }
}
export function workFilterParams(snapshot: PhoneWorkFilterSnapshot) {
  return {
    workLane: snapshot.lane === 'open' ? undefined : snapshot.lane,
    workQuery: snapshot.query || undefined,
    workOffset: undefined,
    workFocus: undefined,
  }
}
