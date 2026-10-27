import type { AgentPhase } from '@podium/model/browser'
import { fireEvent, render, screen } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryTipLog } from '@/features/tips/memory-tip-log'
import { TipContext } from '@/features/tips/tip-context'
import { TipEngine } from '@/features/tips/tip-engine'
import { ASK_ANYTHING_EXAMPLES, askAnythingAnchor, useAskAnythingTip } from './ask-anything-tip'

let stop: () => void
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  stop?.()
  vi.useRealTimers()
})

function Probe(props: {
  phase: AgentPhase | undefined
  viewing: boolean
  onExample?: (t: string) => void
}) {
  useAskAnythingTip({ sessionId: 's1', onExample: () => {}, ...props })
  return null
}

function fixture() {
  const log = new MemoryTipLog()
  const engine = new TipEngine(log, () => true)
  stop = engine.connect()
  const view = render(
    <TipContext.Provider value={engine}>
      <Probe phase="working" viewing />
    </TipContext.Provider>,
  )
  const set = (phase: AgentPhase | undefined, viewing = true) =>
    act(() =>
      view.rerender(
        <TipContext.Provider value={engine}>
          <Probe phase={phase} viewing={viewing} />
        </TipContext.Provider>,
      ),
    )
  const settle = () => act(() => vi.advanceTimersByTime(0))
  return { engine, set, settle }
}

describe('ask-anything moment', () => {
  it('shows on the composer when a watched turn goes working → idle', () => {
    const { engine, set, settle } = fixture()
    settle()
    expect(engine.current).toBeNull()
    set('idle')
    settle()
    expect(engine.current?.registration.id).toBe('ask-anything')
    expect(engine.current?.registration.read().cards[0]?.anchor).toBe(askAnythingAnchor('s1'))
  })

  it('stays quiet for a session that is already idle or finishes out of sight', () => {
    const { engine, set, settle } = fixture()
    set('working', false)
    set('idle', false)
    settle()
    expect(engine.current).toBeNull()
    set('idle', true)
    settle()
    expect(engine.current).toBeNull()
  })

  it('puts an example in the draft instead of sending it', () => {
    const onExample = vi.fn()
    const engine = new TipEngine(new MemoryTipLog(), () => true)
    stop = engine.connect()
    const view = render(
      <TipContext.Provider value={engine}>
        <Probe phase="working" viewing onExample={onExample} />
      </TipContext.Provider>,
    )
    view.rerender(
      <TipContext.Provider value={engine}>
        <Probe phase="idle" viewing onExample={onExample} />
      </TipContext.Provider>,
    )
    act(() => vi.advanceTimersByTime(0))
    render(<>{engine.current?.registration.read().cards[0]?.extra}</>)
    fireEvent.click(screen.getByRole('button', { name: ASK_ANYTHING_EXAMPLES[1] }))
    expect(onExample).toHaveBeenCalledWith(ASK_ANYTHING_EXAMPLES[1])
  })
})
