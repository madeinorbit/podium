import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryTipLog } from '@/features/tips/memory-tip-log'
import { TipContext } from '@/features/tips/tip-context'
import { TipEngine } from '@/features/tips/tip-engine'
import {
  FIRST_ARTIFACT_NEW_PANEL_ANCHOR,
  FIRST_ARTIFACT_THUMB_ANCHOR,
  FirstArtifactMoment,
  useFirstArtifactAnchor,
} from './first-artifact-tip'

function Surface({ surface, issueId }: { surface: 'panel' | 'offer'; issueId: string }) {
  return <div data-tip-anchor={useFirstArtifactAnchor(surface, issueId)} />
}

let stop: () => void
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanup()
  stop?.()
  vi.useRealTimers()
})
function mount(surfaces: { surface: 'panel' | 'offer'; issueId: string }[]) {
  const log = new MemoryTipLog()
  const engine = new TipEngine(
    log,
    (name) => document.querySelector(`[data-tip-anchor="${name}"]`) !== null,
    Date.now,
    0,
  )
  stop = engine.connect()
  const ui = (list: typeof surfaces) => (
    <TipContext.Provider value={engine}>
      <FirstArtifactMoment />
      <div data-tip-anchor={FIRST_ARTIFACT_NEW_PANEL_ANCHOR} />
      {list.map((s) => (
        <Surface key={`${s.surface}:${s.issueId}`} {...s} />
      ))}
    </TipContext.Provider>
  )
  const view = render(ui(surfaces))
  act(() => vi.advanceTimersByTime(0))
  return { log, engine, rerender: (list: typeof surfaces) => view.rerender(ui(list)) }
}

describe('first-artifact moment', () => {
  it('waits for an artifact surface, then points at the thumbnail and the +', () => {
    const { engine, rerender } = mount([])
    expect(engine.current).toBeNull()
    rerender([{ surface: 'panel', issueId: 'iss_a' }])
    act(() => vi.advanceTimersByTime(0))
    expect(engine.current?.registration.id).toBe('first-artifact')
    expect(engine.current?.card).toMatchObject({
      anchor: FIRST_ARTIFACT_THUMB_ANCHOR,
      title: 'Your agent made something.',
      body: 'Mockups, screenshots and docs land here. Click one to open it.',
    })
    act(() => engine.next())
    expect(engine.current?.card).toMatchObject({
      anchor: FIRST_ARTIFACT_NEW_PANEL_ANCHOR,
      title: 'All in one tab.',
      body: 'Open Artifacts from + to see everything this task made.',
    })
  })

  it('lets first-offer go first, then anchors to the offer thumbnails', () => {
    const { engine, log } = mount([
      { surface: 'panel', issueId: 'iss_a' },
      { surface: 'offer', issueId: 'iss_a' },
    ])
    expect(engine.current).toBeNull()
    act(() => log.record('first-offer', 'finished'))
    act(() => vi.advanceTimersByTime(0))
    expect(engine.current?.card.anchor).toBe('first-artifact-offer:iss_a')
  })

  it('stays quiet once seen', () => {
    const { engine, log, rerender } = mount([])
    act(() => log.record('first-artifact', 'finished'))
    rerender([{ surface: 'panel', issueId: 'iss_a' }])
    act(() => vi.advanceTimersByTime(0))
    expect(engine.current).toBeNull()
  })
})
