import type { SessionOffer } from '@podium/model'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { findTipAnchor } from '@/features/tips/anchors'
import { MemoryTipLog } from '@/features/tips/memory-tip-log'
import {
  NEARLY,
  OFF_SCREEN,
  ON_SCREEN,
  PANE,
  stubTipVisibility,
} from '@/features/tips/test-visibility'
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
let visibility: ReturnType<typeof stubTipVisibility>

beforeEach(() => {
  vi.useFakeTimers()
  visibility = stubTipVisibility()
  container = document.createElement('div')
  document.body.appendChild(container)
  visibility.clip(container, PANE)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  stop?.()
  container.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function mount(log = new MemoryTipLog()): { engine: TipEngine; log: MemoryTipLog } {
  // The production resolver, so "on screen" means what the engine accepts.
  const engine = new TipEngine(log, (name) => !!findTipAnchor(name))
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

const bar = (): HTMLElement =>
  container.querySelector<HTMLElement>('[data-testid="offer-bar"]') as HTMLElement

/** Give the bar a box and report it, then let the engine's queue drain (its
 *  timer is armed by the effect that the report's render runs). */
function place(rect: DOMRect): void {
  act(() => visibility.place(bar(), rect))
  act(() => vi.advanceTimersByTime(0))
}

describe('OfferBar first-offer tip', () => {
  it('waits until the card is fully on screen, then anchors the card and the task row', () => {
    const { engine } = mount()
    place(new DOMRect(20, 280, 120, 40))
    expect(engine.current).toBeNull()
    // Card 2's row, so the engine can advance to it.
    const row = document.body.appendChild(document.createElement('div'))
    row.dataset.tipAnchor = 'task-row:iss_1'
    visibility.place(row, new DOMRect(0, 100, 200, 30))
    place(ON_SCREEN)
    expect(engine.current?.registration.id).toBe('first-offer')
    expect(engine.current?.card.anchor).toBe(bar().getAttribute('data-tip-anchor'))
    expect(engine.current?.card.title).toBe('Your next move.')
    act(() => engine.next())
    expect(engine.current?.card).toMatchObject({
      anchor: 'task-row:iss_1',
      title: 'It waits for you.',
      body: 'Offers stay in your list and on your phone. Answer from anywhere.',
    })
    row.remove()
  })

  it('fires once a fold that paused 99% open finishes opening', () => {
    const { engine, log } = mount()
    // The dock pauses with the card's last pixel clipped, long enough for the
    // queue to drain: no attempt is made, so none is wasted.
    place(NEARLY)
    act(() => vi.advanceTimersByTime(30_000))
    expect(engine.current).toBeNull()
    expect(log.isSeen('first-offer')).toBe(false)
    place(ON_SCREEN)
    expect(engine.current?.registration.id).toBe('first-offer')
  })

  it('stops watching once the moment is seen, keeping the anchor for replay', () => {
    const log = new MemoryTipLog()
    log.record('first-offer', 'finished')
    mount(log)
    expect(visibility.watched()).toEqual([])
    expect(bar().getAttribute('data-tip-anchor')).toMatch(/^first-offer-/)
  })

  it('never fires from a bar that stays clipped shut', () => {
    const { engine, log } = mount()
    place(OFF_SCREEN)
    expect(engine.current).toBeNull()
    expect(log.isSeen('first-offer')).toBe(false)
  })
})
