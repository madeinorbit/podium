import { LOADING } from '@podium/client-graph/loading'
import type { FullDeck } from '@podium/client-graph/mission-full-deck'
import { settled } from '@podium/client-graph/mission-view'
import { observer } from '@podium/client-graph/react'
import { useContext } from 'react'
import { type TipCard, useTipMoment } from '@/features/tips'
import { TipContext } from '@/features/tips/tip-context'

/** The coordinator card's `data-tip-anchor`. */
export const TEAM_FORMS_LEAD_ANCHOR = 'team-forms-lead'
/** Every sub-task session row carries this anchor; the engine resolves the
 * first one in document order, which is the first visible sub-task session. */
export const TEAM_FORMS_SESSION_ANCHOR = 'team-forms-session'

const LEAD_CARD: TipCard = {
  anchor: TEAM_FORMS_LEAD_ANCHOR,
  title: 'One agent leads.',
  body: 'Any agent can run a team. On big tasks, you talk to the lead.',
}
const CREW_CARD: TipCard = {
  anchor: TEAM_FORMS_SESSION_ANCHOR,
  title: 'Step in anytime.',
  body: "Open any agent's session and talk to it directly.",
}

/** First Flights moment 4: the open task's deck gains a claimed coordinator
 * seat, or its first sub-task with a session row. Each card needs its own
 * anchor: the lead card the coordinator's, the step-in card a drawn sub-task
 * session. A deck with no coordinator tells the step-in card alone; nothing is
 * claimed or opened to make the other one.
 *
 * Once the moment is seen the sub-task roster is not read again: the
 * registration stays for the guide's replay with both cards it could show. */
export const TeamFormsTip = observer(function TeamFormsTip({ full }: { full: FullDeck }) {
  const log = useContext(TipContext)?.log
  const watching = log?.enabled !== false && !log?.isSeen('team-forms')
  const state = settled(() => {
    const lead = full.coordinatorSessionId !== null
    if (!watching) return { lead, crew: true }
    const crew = full.rowIds.some((id) => {
      const task = full.task(id)
      return task.open && task.sessionIds.length > 0
    })
    return { lead, crew }
  })
  const { lead, crew } = state === LOADING ? { lead: false, crew: false } : state
  const cards: TipCard[] = []
  if (lead) cards.push(LEAD_CARD)
  if (crew) cards.push(CREW_CARD)
  useTipMoment('team-forms', { active: watching && (lead || crew), cards })
  return null
})
