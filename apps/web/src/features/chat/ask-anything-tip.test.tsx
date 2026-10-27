import type { AgentPhase } from '@podium/model/browser'
import { fireEvent, render, screen } from '@testing-library/react'
import { observable, runInAction } from 'mobx'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryTipLog } from '@/features/tips/memory-tip-log'
import { TipContext } from '@/features/tips/tip-context'
import { TipEngine } from '@/features/tips/tip-engine'
import {
  ASK_ANYTHING_EXAMPLES,
  AskAnythingTip,
  appendExample,
  askAnythingAnchor,
} from './ask-anything-tip'

let stop: () => void
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  stop?.()
  vi.useRealTimers()
})

/** A session whose phase reads are counted, like SessionModel.agentPhase. */
function fakeSession(initial: AgentPhase | undefined) {
  const phase = observable.box<AgentPhase | undefined>(initial)
  let reads = 0
  return {
    session: {
      get agentPhase() {
        reads++
        return phase.get()
      },
    },
    set: (next: AgentPhase | undefined) => act(() => runInAction(() => phase.set(next))),
    reads: () => reads,
  }
}

function fixture({
  taskChat = true,
  onExample = () => {},
}: {
  taskChat?: boolean
  onExample?: (t: string) => void
} = {}) {
  const log = new MemoryTipLog()
  const engine = new TipEngine(log, () => true)
  stop = engine.connect()
  const phase = fakeSession('working')
  const ui = (viewing: boolean) => (
    <TipContext.Provider value={engine}>
      <AskAnythingTip
        sessionId="s1"
        session={phase.session}
        viewing={viewing}
        taskChat={taskChat}
        onExample={onExample}
      />
    </TipContext.Provider>
  )
  const view = render(ui(true))
  const setViewing = (viewing: boolean) => act(() => view.rerender(ui(viewing)))
  const settle = () => act(() => vi.advanceTimersByTime(0))
  return { engine, log, phase, setViewing, settle }
}

describe('ask-anything moment', () => {
  it('shows on the composer when a watched turn goes working → idle', () => {
    const { engine, phase, settle } = fixture()
    settle()
    expect(engine.current).toBeNull()
    phase.set('idle')
    settle()
    expect(engine.current?.registration.id).toBe('ask-anything')
    expect(engine.current?.registration.read().cards[0]?.anchor).toBe(askAnythingAnchor('s1'))
  })

  it('stays quiet for a session that is already idle or finishes out of sight', () => {
    const { engine, phase, setViewing, settle } = fixture()
    setViewing(false)
    phase.set('idle')
    settle()
    expect(engine.current).toBeNull()
    setViewing(true)
    settle()
    expect(engine.current).toBeNull()
  })

  it('stays quiet in the superagent chat, which is not a task', () => {
    const { engine, phase, settle } = fixture({ taskChat: false })
    phase.set('idle')
    settle()
    expect(engine.current).toBeNull()
  })

  it('stops reading the phase once the moment is seen, and stays replayable', () => {
    const { engine, log, phase, settle } = fixture()
    act(() => log.record('ask-anything', 'dismissed'))
    const before = phase.reads()
    phase.set('idle')
    phase.set('working')
    phase.set('idle')
    expect(phase.reads()).toBe(before)
    settle()
    expect(engine.current).toBeNull()
    act(() => engine.replay('ask-anything'))
    settle()
    expect(engine.current?.registration.id).toBe('ask-anything')
  })

  it('puts an example in the draft instead of sending it', () => {
    const onExample = vi.fn()
    const { engine, phase, settle } = fixture({ onExample })
    phase.set('idle')
    settle()
    render(engine.current?.card.extra)
    fireEvent.click(screen.getByRole('button', { name: ASK_ANYTHING_EXAMPLES[1] }))
    expect(onExample).toHaveBeenCalledWith(ASK_ANYTHING_EXAMPLES[1])
  })

  it('appends an example after the draft, or fills an empty box', () => {
    expect(appendExample('', 'Start a task')).toBe('Start a task')
    expect(appendExample('  ', 'Start a task')).toBe('Start a task')
    expect(appendExample('typed', 'Start a task')).toBe('typed\nStart a task')
  })
})
