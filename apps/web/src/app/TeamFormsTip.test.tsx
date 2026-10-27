import type { FullDeck } from '@podium/client-graph/mission-full-deck'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TipContext } from '@/features/tips/tip-context'
import type { TipEngine } from '@/features/tips/tip-engine'
import type { TipMoment } from '@/features/tips/types'
import { TEAM_FORMS_LEAD_ANCHOR, TEAM_FORMS_SESSION_ANCHOR, TeamFormsTip } from './TeamFormsTip'

type Task = { open: boolean; sessionIds: string[] }
const deck = (coordinator: string | null, tasks: Record<string, Task> = {}) =>
  ({
    coordinatorSessionId: coordinator,
    rowIds: Object.keys(tasks),
    task: (id: string) => tasks[id],
  }) as unknown as FullDeck

function mount(full: FullDeck) {
  let read: (() => TipMoment) | null = null
  const engine = {
    register: (_id: string, next: () => TipMoment) => {
      read = next
      return () => {}
    },
    refresh: () => {},
  } as unknown as TipEngine
  render(
    <TipContext.Provider value={engine}>
      <TeamFormsTip full={full} />
    </TipContext.Provider>,
  )
  return () => read!()
}

describe('team-forms moment', () => {
  it('stays registered but inactive until a coordinator seat is claimed', () => {
    const moment = mount(deck(null, { t1: { open: true, sessionIds: ['s1'] } }))
    expect(moment().active).toBe(false)
  })
  it('shows the lead card alone while no sub-task session row is drawn', () => {
    const moment = mount(deck('coord', { t1: { open: true, sessionIds: [] } }))
    expect(moment().active).toBe(true)
    expect(moment().cards.map((card) => card.anchor)).toEqual([TEAM_FORMS_LEAD_ANCHOR])
    expect(moment().cards[0]).toMatchObject({
      title: 'One agent leads.',
      body: 'Any agent can run a team. On big tasks, you talk to the lead.',
    })
  })
  it('adds the step-in card once an open sub-task draws a session row', () => {
    const moment = mount(
      deck('coord', {
        t1: { open: false, sessionIds: ['s0'] },
        t2: { open: true, sessionIds: ['s1'] },
      }),
    )
    expect(moment().cards.map((card) => card.anchor)).toEqual([
      TEAM_FORMS_LEAD_ANCHOR,
      TEAM_FORMS_SESSION_ANCHOR,
    ])
    expect(moment().cards[1]).toMatchObject({
      title: 'Step in anytime.',
      body: "Open any agent's session and talk to it directly.",
    })
  })
})
