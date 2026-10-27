import { LOADING } from '@podium/client-graph/loading'
import type { FullDeck } from '@podium/client-graph/mission-full-deck'
import { settled } from '@podium/client-graph/mission-view'
import { observer } from '@podium/client-graph/react'
import { type TipCard, useTipMoment } from '@/features/tips'

/** The coordinator card's `data-tip-anchor`. */
export const TEAM_FORMS_LEAD_ANCHOR = 'team-forms-lead'
/** Every sub-task session row carries this anchor; the engine resolves the
 * first one in document order, which is the first visible sub-task session. */
export const TEAM_FORMS_SESSION_ANCHOR = 'team-forms-session'

/** First Flights moment 4: the open task's deck gains a claimed coordinator
 * seat. The second card needs a sub-task's session row; until one is drawn the
 * moment is the lead card alone. */
export const TeamFormsTip = observer(function TeamFormsTip({ full }: { full: FullDeck }) {
  const state = settled(() => {
    if (full.coordinatorSessionId === null) return { lead: false, crew: false }
    const crew = full.rowIds.some((id) => {
      const task = full.task(id)
      return task.open && task.sessionIds.length > 0
    })
    return { lead: true, crew }
  })
  const { lead, crew } = state === LOADING ? { lead: false, crew: false } : state
  const cards: TipCard[] = [
    {
      anchor: TEAM_FORMS_LEAD_ANCHOR,
      title: 'One agent leads.',
      body: 'Any agent can run a team. On big tasks, you talk to the lead.',
    },
  ]
  if (crew)
    cards.push({
      anchor: TEAM_FORMS_SESSION_ANCHOR,
      title: 'Step in anytime.',
      body: "Open any agent's session and talk to it directly.",
    })
  useTipMoment('team-forms', { active: lead, cards })
  return null
})
