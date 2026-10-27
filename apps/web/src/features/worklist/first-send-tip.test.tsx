import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TipContext } from '@/features/tips/tip-context'
import type { TipEngine } from '@/features/tips/tip-engine'
import type { TipMoment } from '@/features/tips/types'
import { FirstSendTip, FLIGHT_DECK_ANCHOR, noteFirstSend } from './first-send-tip'

const selection = vi.hoisted(() => ({ id: null as string | null }))
vi.mock('@/app/store', () => ({
  useRuntimeSelector: (pick: (s: { selectedIssueId: string | null }) => unknown) =>
    pick({ selectedIssueId: selection.id }),
}))

afterEach(cleanup)

function mount() {
  let read: (() => TipMoment) | undefined
  const engine = {
    register: vi.fn((_id: string, next: () => TipMoment) => {
      read = next
      return () => {}
    }),
    refresh: vi.fn(),
  }
  const view = render(
    <TipContext.Provider value={engine as unknown as TipEngine}>
      <FirstSendTip />
    </TipContext.Provider>,
  )
  return { engine, view, moment: () => read?.() }
}

describe('first-send moment', () => {
  it('stays registered but inactive until the first launch opens its task', () => {
    selection.id = 'iss_other'
    const { engine, view, moment } = mount()
    expect(engine.register).toHaveBeenCalledWith('first-send', expect.any(Function))
    expect(moment()?.active).toBe(false)
    // Registered for replay against the open task's row.
    expect(moment()?.cards.map((c) => c.anchor)).toEqual(['task-row:iss_other', FLIGHT_DECK_ANCHOR])

    act(() => noteFirstSend('iss_first'))
    expect(moment()?.active).toBe(false)
    expect(moment()?.cards[0]?.anchor).toBe('task-row:iss_first')

    selection.id = 'iss_first'
    view.rerender(
      <TipContext.Provider value={engine as unknown as TipEngine}>
        <FirstSendTip />
      </TipContext.Provider>,
    )
    expect(moment()?.active).toBe(true)
    expect(moment()?.cards[0]?.title).toBe('Your list.')
    expect(moment()?.cards[1]?.title).toBe('The flight deck.')
  })
})
