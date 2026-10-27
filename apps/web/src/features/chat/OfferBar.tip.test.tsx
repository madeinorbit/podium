import type { SessionOffer } from '@podium/model'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryTipLog } from '@/features/tips/memory-tip-log'
import { TipContext } from '@/features/tips/tip-context'
import { TipEngine } from '@/features/tips/tip-engine'
import { OfferBar } from './OfferBar'

// The evidence strip reads the runtime store; this file is about the tip.
vi.mock('./OfferArtifactStrip', () => ({ OfferArtifactStrip: () => null }))

// First Flights moment 6 (first-offer): the first offer card on screen.

const offer: SessionOffer = {
  message: 'Login screen ready to merge',
  actions: [{ label: 'Merge', prompt: 'Merge it' }],
  createdAt: '2026-10-27T07:00:00.000Z',
}
const session = { sessionId: 's1', issueId: 'iss_1', lastInputAt: null } as never

let container: HTMLDivElement
let root: Root
let stop: () => void
let observed: Array<(ratio: number) => void>

beforeEach(() => {
  vi.useFakeTimers()
  observed = []
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe(): void {
        observed.push((ratio) =>
          this.callback([{ intersectionRatio: ratio } as IntersectionObserverEntry], this as never),
        )
      }
      disconnect(): void {}
    },
  )
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  stop?.()
  container.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function mount(): { engine: TipEngine; log: MemoryTipLog } {
  const log = new MemoryTipLog()
  const engine = new TipEngine(log, () => true)
  stop = engine.connect()
  act(() =>
    root.render(
      <TipContext.Provider value={engine}>
        <OfferBar offer={offer} disabled={false} onAction={() => {}} session={session} />
      </TipContext.Provider>,
    ),
  )
  return { engine, log }
}

/** Report the bar's visible share, then let the engine's queue drain (its
 *  timer is armed by the effect that the report's render runs). */
function reveal(ratio: number): void {
  act(() => {
    for (const report of observed) report(ratio)
  })
  act(() => vi.advanceTimersByTime(0))
}

describe('OfferBar first-offer tip', () => {
  it('waits until the card is fully on screen, then anchors the card and the task row', () => {
    const { engine } = mount()
    reveal(0.5)
    expect(engine.current).toBeNull()
    reveal(1)
    const bar = container.querySelector('[data-testid="offer-bar"]')
    expect(engine.current?.registration.id).toBe('first-offer')
    expect(engine.current?.card.anchor).toBe(bar?.getAttribute('data-tip-anchor'))
    expect(engine.current?.card.title).toBe('Your next move.')
    act(() => engine.next())
    expect(engine.current?.card).toMatchObject({
      anchor: 'task-row:iss_1',
      title: 'It waits for you.',
      body: 'Offers stay in your list and on your phone. Answer from anywhere.',
    })
  })

  it('never fires from a bar that stays clipped shut', () => {
    const { engine, log } = mount()
    reveal(0)
    expect(engine.current).toBeNull()
    expect(log.isSeen('first-offer')).toBe(false)
  })
})
