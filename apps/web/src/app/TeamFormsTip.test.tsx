import type { FullDeck } from '@podium/client-graph/mission-full-deck'
import { act, render } from '@testing-library/react'
import { observable, runInAction } from 'mobx'
import { describe, expect, it } from 'vitest'
import { MemoryTipLog } from '@/features/tips/memory-tip-log'
import { TipContext } from '@/features/tips/tip-context'
import type { TipEngine } from '@/features/tips/tip-engine'
import type { TipMoment } from '@/features/tips/types'
import { TEAM_FORMS_LEAD_ANCHOR, TEAM_FORMS_SESSION_ANCHOR, TeamFormsTip } from './TeamFormsTip'

type Task = { open: boolean; sessionIds: string[] }
/** An observable deck; `rowReads` counts reads of the sub-task roster. */
function deck(coordinator: string | null, initial: Record<string, Task> = {}) {
  const state = observable({ coordinator, tasks: initial }, undefined, { deep: false })
  let rowReads = 0
  const full = {
    get coordinatorSessionId() {
      return state.coordinator
    },
    get rowIds() {
      rowReads++
      return Object.keys(state.tasks)
    },
    task: (id: string) => state.tasks[id],
  } as unknown as FullDeck
  return {
    full,
    rowReads: () => rowReads,
    setTasks: (tasks: Record<string, Task>) => act(() => runInAction(() => (state.tasks = tasks))),
  }
}

function mount(full: FullDeck, log = new MemoryTipLog()) {
  let read: (() => TipMoment) | null = null
  const engine = {
    log,
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
  return () => {
    if (!read) throw new Error('team-forms never registered')
    return read()
  }
}

const anchors = (moment: TipMoment) => moment.cards.map((card) => card.anchor)

describe('team-forms moment', () => {
  it('stays registered but inactive with no coordinator and no sub-task session', () => {
    const moment = mount(deck(null, { t1: { open: true, sessionIds: [] } }).full)
    expect(moment().active).toBe(false)
    expect(moment().cards).toEqual([])
  })
  it('shows the lead card alone while no sub-task session row is drawn', () => {
    const moment = mount(deck('coord', { t1: { open: true, sessionIds: [] } }).full)
    expect(moment().active).toBe(true)
    expect(anchors(moment())).toEqual([TEAM_FORMS_LEAD_ANCHOR])
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
      }).full,
    )
    expect(anchors(moment())).toEqual([TEAM_FORMS_LEAD_ANCHOR, TEAM_FORMS_SESSION_ANCHOR])
    expect(moment().cards[1]).toMatchObject({
      title: 'Step in anytime.',
      body: "Open any agent's session and talk to it directly.",
    })
  })
  it('triggers on an unclaimed parent gaining its first sub-task session, with the step-in card alone', () => {
    const d = deck(null, { t1: { open: true, sessionIds: [] } })
    const moment = mount(d.full)
    expect(moment().active).toBe(false)
    d.setTasks({ t1: { open: true, sessionIds: ['s1'] } })
    expect(moment().active).toBe(true)
    expect(anchors(moment())).toEqual([TEAM_FORMS_SESSION_ANCHOR])
  })
  it('stops reading the sub-task roster once seen, and keeps replayable cards', () => {
    const log = new MemoryTipLog()
    act(() => log.record('team-forms', 'finished'))
    const d = deck('coord', { t1: { open: true, sessionIds: [] } })
    const moment = mount(d.full, log)
    const reads = d.rowReads()
    d.setTasks({ t1: { open: true, sessionIds: ['s1'] } })
    expect(d.rowReads()).toBe(reads)
    expect(reads).toBe(0)
    expect(moment().active).toBe(false)
    expect(anchors(moment())).toEqual([TEAM_FORMS_LEAD_ANCHOR, TEAM_FORMS_SESSION_ANCHOR])
  })
})
