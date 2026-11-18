import { setClockWakeSource } from '@podium/mobx-helpers'
import { act, cleanup, render, screen } from '@testing-library/react'
import { IsFocusedContext } from 'expo-router/build/react-navigation/core/useIsFocused'
import { observer } from 'mobx-react-lite'
import { Profiler, StrictMode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { platformClockWakeSource } from '../client/clock-wake-source.native'
import { useAgeNow, useClock } from './clock-hooks'
import {
  ContentActivity,
  SheetActivity,
  useContentActive,
  useContentVisible,
  VisibleContent,
} from './visible-content'

const app = vi.hoisted(() => ({ state: 'active', listeners: new Set<() => void>() }))
vi.mock('react-native', async (original) => ({
  ...(await original<typeof import('react-native')>()),
  AppState: {
    get currentState() {
      return app.state
    },
    addEventListener: (_event: string, listener: () => void) => {
      app.listeners.add(listener)
      return { remove: () => app.listeners.delete(listener) }
    },
  },
}))

const start = Date.parse('2026-11-18T12:00:00Z')
function Clock({ id = 'clock', seconds = false }: { id?: string; seconds?: boolean }) {
  const now = useAgeNow(start - 120_000, 0, true, seconds ? 3_600_000 : 0)
  return <span data-testid={id}>{now}</span>
}
function Visible({ id }: { id: string }) {
  return <span data-testid={id}>{String(useContentVisible())}</span>
}
function appState(state: string) {
  act(() => {
    app.state = state
    for (const notify of app.listeners) notify()
  })
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(start)
  app.state = 'active'
  setClockWakeSource(platformClockWakeSource)
})
afterEach(() => {
  cleanup()
  setClockWakeSource(undefined)
  expect(app.listeners.size).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it('shares a minute timer between mounted labels and never commits their unchanged parent row', () => {
  const timeout = vi.spyOn(globalThis, 'setTimeout')
  const commits = vi.fn()
  render(
    <Profiler id="row" onRender={commits}>
      <Clock />
      <Clock id="other" />
    </Profiler>,
  )
  expect(vi.getTimerCount()).toBe(1)
  expect(timeout).toHaveBeenCalledWith(expect.any(Function), 60_000)
  commits.mockClear()
  act(() => vi.advanceTimersByTime(59_999))
  expect(commits).not.toHaveBeenCalled()
  act(() => vi.advanceTimersByTime(1))
  expect(screen.getByTestId('clock').textContent).toBe(String(start + 60_000))
})

it('unsubscribes mounted hidden content, blurred tabs and covered stack screens, and resamples on return', () => {
  const view = render(
    <VisibleContent visible={false}>
      <Clock seconds />
    </VisibleContent>,
  )
  expect(vi.getTimerCount()).toBe(0)
  view.rerender(
    <VisibleContent visible>
      <Clock seconds />
    </VisibleContent>,
  )
  expect(vi.getTimerCount()).toBe(1)
  view.rerender(
    <IsFocusedContext value={false}>
      <Clock seconds />
    </IsFocusedContext>,
  )
  expect(vi.getTimerCount()).toBe(0)
  act(() => vi.advanceTimersByTime(120_000))
  view.rerender(
    <IsFocusedContext value>
      <Clock seconds />
    </IsFocusedContext>,
  )
  expect(screen.getByTestId('clock').textContent).toBe(String(start + 120_000))
  expect(vi.getTimerCount()).toBe(1)
})

it('removes all clock work in background and catches up immediately on foreground', () => {
  render(<Clock seconds />)
  expect(vi.getTimerCount()).toBe(1)
  appState('background')
  expect(vi.getTimerCount()).toBe(0)
  act(() => vi.advanceTimersByTime(10_000))
  appState('active')
  expect(screen.getByTestId('clock').textContent).toBe(String(start + 10_000))
  expect(vi.getTimerCount()).toBe(1)
})

it('pauses the screen behind a sheet while leaving the visible sheet active', () => {
  function Content({ sheet }: { sheet: boolean }) {
    return (
      <ContentActivity>
        <Visible id="behind" />
        <Clock />
        <SheetActivity visible={sheet}>
          <Visible id="sheet" />
        </SheetActivity>
      </ContentActivity>
    )
  }
  const view = render(<Content sheet={false} />)
  expect(screen.getByTestId('behind').textContent).toBe('true')
  expect(vi.getTimerCount()).toBe(1)
  view.rerender(<Content sheet />)
  expect(screen.getByTestId('behind').textContent).toBe('false')
  expect(screen.getByTestId('sheet').textContent).toBe('true')
  expect(vi.getTimerCount()).toBe(0)
  view.rerender(<Content sheet={false} />)
  expect(screen.getByTestId('behind').textContent).toBe('true')
  expect(vi.getTimerCount()).toBe(1)
})

it('never lets a nested visible row restart a hidden page, and pauses polling on blur/background', () => {
  function PollState() {
    return <span data-testid="poll">{String(useContentActive())}</span>
  }
  const view = render(
    <VisibleContent visible={false}>
      <VisibleContent visible>
        <Visible id="nested" />
      </VisibleContent>
    </VisibleContent>,
  )
  expect(screen.getByTestId('nested').textContent).toBe('false')
  view.rerender(
    <IsFocusedContext value>
      <PollState />
    </IsFocusedContext>,
  )
  expect(screen.getByTestId('poll').textContent).toBe('true')
  appState('background')
  expect(screen.getByTestId('poll').textContent).toBe('false')
  appState('active')
  expect(screen.getByTestId('poll').textContent).toBe('true')
  view.rerender(
    <IsFocusedContext value={false}>
      <PollState />
    </IsFocusedContext>,
  )
  expect(screen.getByTestId('poll').textContent).toBe('false')
})

it('keeps explicitly enabled precision clocks separate from coarse age labels', () => {
  function Seconds() {
    return <span>{useClock(1_000)}</span>
  }
  render(
    <>
      <Clock />
      <Seconds />
    </>,
  )
  expect(vi.getTimerCount()).toBe(2)
})

it('drops observer label demand and wake listeners after repeated open, blur and pop cycles', () => {
  const ObservedClock = observer(Clock)
  for (let opening = 0; opening < 3; opening++) {
    const scene = (focused: boolean) => (
      <StrictMode>
        <IsFocusedContext value={focused}>
          <ContentActivity>
            <ObservedClock seconds />
          </ContentActivity>
        </IsFocusedContext>
      </StrictMode>
    )
    const view = render(scene(true))
    expect(vi.getTimerCount()).toBe(1)
    view.rerender(scene(false))
    expect(vi.getTimerCount()).toBe(0)
    view.rerender(scene(true))
    expect(vi.getTimerCount()).toBe(1)
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
    expect(app.listeners.size).toBe(0)
  }
})
