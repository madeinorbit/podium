import { act, cleanup, render } from '@testing-library/react'
import { observable, runInAction } from 'mobx'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { findTipAnchor } from '@/features/tips/anchors'
import { MemoryTipLog } from '@/features/tips/memory-tip-log'
import { OFF_SCREEN, ON_SCREEN, stubTipVisibility } from '@/features/tips/test-visibility'
import { TipContext } from '@/features/tips/tip-context'
import { TipEngine } from '@/features/tips/tip-engine'
import {
  FIRST_ARTIFACT_NEW_PANEL_ANCHOR,
  FIRST_ARTIFACT_THUMB_ANCHOR,
  FirstArtifactDot,
  FirstArtifactMoment,
  useFirstArtifactAnchor,
} from './first-artifact-tip'

// The pooled issue keeps its identity when an artifact is published; only its
// observable panel changes.
const pageIssue = observable({ panel: { artifacts: [] as { path: string }[] } })
vi.mock('@/features/files/artifacts-tab', () => ({ usePageIssue: () => pageIssue }))
vi.mock('./dock-issue', () => ({ useDockIssue: () => ({ issueId: 'iss_a' }) }))

type Spec = { surface: 'panel' | 'offer'; issueId: string }
function Surface({ surface, issueId }: Spec) {
  return <div data-testid={`${surface}:${issueId}`} {...useFirstArtifactAnchor(surface, issueId)} />
}

let stop: () => void
let visibility: ReturnType<typeof stubTipVisibility>
beforeEach(() => {
  vi.useFakeTimers()
  visibility = stubTipVisibility()
  runInAction(() => {
    pageIssue.panel.artifacts = []
  })
})
afterEach(() => {
  cleanup()
  stop?.()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})
function mount(surfaces: Spec[], log = new MemoryTipLog()) {
  const engine = new TipEngine(log, (name) => !!findTipAnchor(name), Date.now, 0)
  stop = engine.connect()
  const ui = (list: Spec[]) => (
    <TipContext.Provider value={engine}>
      <FirstArtifactMoment />
      <div data-testid="new-panel" data-tip-anchor={FIRST_ARTIFACT_NEW_PANEL_ANCHOR} />
      {list.map((s) => (
        <Surface key={`${s.surface}:${s.issueId}`} {...s} />
      ))}
    </TipContext.Provider>
  )
  const view = render(ui(surfaces))
  visibility.place(view.getByTestId('new-panel'), new DOMRect(300, 10, 20, 20))
  const place = (testId: string, rect: DOMRect) => {
    act(() => visibility.place(view.getByTestId(testId), rect))
    act(() => vi.advanceTimersByTime(0))
  }
  act(() => vi.advanceTimersByTime(0))
  return { log, engine, place, rerender: (list: Spec[]) => view.rerender(ui(list)) }
}

describe('first-artifact moment', () => {
  it('waits for a visible artifact surface, then points at the thumbnail and the +', () => {
    const { engine, rerender, place } = mount([])
    expect(engine.current).toBeNull()
    rerender([{ surface: 'panel', issueId: 'iss_a' }])
    act(() => vi.advanceTimersByTime(0))
    expect(engine.current).toBeNull()
    place('panel:iss_a', ON_SCREEN)
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

  it('lets first-offer go first, then anchors to the visible offer thumbnails', () => {
    const { engine, log, place } = mount([
      { surface: 'panel', issueId: 'iss_a' },
      { surface: 'offer', issueId: 'iss_a' },
    ])
    place('offer:iss_a', new DOMRect(20, 100, 120, 40))
    place('panel:iss_a', ON_SCREEN)
    expect(engine.current).toBeNull()
    act(() => log.record('first-offer', 'finished'))
    act(() => vi.advanceTimersByTime(0))
    expect(engine.current?.card.anchor).toBe('first-artifact-offer:iss_a')
  })

  it('does not let a background task offer block the visible panel', () => {
    const { engine, place } = mount([
      { surface: 'offer', issueId: 'iss_b' },
      { surface: 'panel', issueId: 'iss_a' },
    ])
    place('offer:iss_b', OFF_SCREEN)
    place('panel:iss_a', ON_SCREEN)
    expect(engine.current?.card.anchor).toBe(FIRST_ARTIFACT_THUMB_ANCHOR)
  })

  it('activates when a thumbnail below the fold is scrolled into view', () => {
    const { engine, log, place } = mount([{ surface: 'panel', issueId: 'iss_a' }])
    place('panel:iss_a', OFF_SCREEN)
    act(() => vi.advanceTimersByTime(30_000))
    expect(engine.current).toBeNull()
    expect(log.isSeen('first-artifact')).toBe(false)
    place('panel:iss_a', ON_SCREEN)
    expect(engine.current?.card.anchor).toBe(FIRST_ARTIFACT_THUMB_ANCHOR)
  })

  it('stays quiet once seen and stops watching its surfaces', () => {
    const log = new MemoryTipLog()
    log.record('first-artifact', 'finished')
    const { engine, place } = mount([{ surface: 'panel', issueId: 'iss_a' }], log)
    expect(visibility.watched()).toEqual([])
    place('panel:iss_a', ON_SCREEN)
    expect(engine.current).toBeNull()
  })
})

describe('first-artifact dot', () => {
  it('appears when the task publishes its first artifact without a task switch', () => {
    const engine = new TipEngine(new MemoryTipLog(), () => true)
    const view = render(
      <TipContext.Provider value={engine}>
        <FirstArtifactDot />
      </TipContext.Provider>,
    )
    expect(view.queryByTestId('first-artifact-dot')).toBeNull()
    act(() =>
      runInAction(() => {
        pageIssue.panel.artifacts.push({ path: 'shots/login.png' })
      }),
    )
    expect(view.queryByTestId('first-artifact-dot')).not.toBeNull()
  })
})
