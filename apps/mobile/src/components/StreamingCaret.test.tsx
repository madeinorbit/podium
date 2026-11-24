import { act, cleanup, render, screen } from '@testing-library/react'
import { IsFocusedContext } from 'expo-router/build/react-navigation/core/useIsFocused'
import { type ReactNode, StrictMode } from 'react'
import { Animated } from 'react-native'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ContentActivity, VisibleContent } from '../lib/visible-content'
import { ActivityModal } from './ActivityModal'
import { StreamingCaret } from './StreamingCaret'

const app = vi.hoisted(() => ({ state: 'active', listeners: new Set<() => void>() }))
vi.mock('react-native', async (original) => ({
  ...(await original<typeof import('react-native')>()),
  Modal: ({ visible = true, children }: { visible?: boolean; children: ReactNode }) =>
    visible ? <div>{children}</div> : null,
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
const running = new Set<object>()
beforeEach(() => {
  vi.useFakeTimers()
  app.state = 'active'
  vi.spyOn(Animated, 'loop').mockImplementation(() => {
    const id = {}
    return {
      start: () => {
        running.add(id)
      },
      stop: () => {
        running.delete(id)
      },
      reset() {},
    }
  })
})
afterEach(() => {
  cleanup()
  expect(running.size).toBe(0)
  expect(app.listeners.size).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
  vi.restoreAllMocks()
  vi.useRealTimers()
})
const state = (value: string) =>
  act(() => {
    app.state = value
    for (const notify of app.listeners) notify()
  })

it('stops and resumes the actual loop across page, focus, modal, foreground and Reduce Motion changes', () => {
  const scene = ({ visible = true, focused = true, modal = false, reduced = false } = {}) => (
    <IsFocusedContext value={focused}>
      <ContentActivity>
        <VisibleContent visible={visible}>
          <StreamingCaret reduceMotion={reduced} />
        </VisibleContent>
        <ActivityModal visible={modal}>Covered</ActivityModal>
      </ContentActivity>
    </IsFocusedContext>
  )
  const view = render(scene())
  expect(running.size).toBe(1)
  for (const hidden of [
    { visible: false },
    { focused: false },
    { modal: true },
    { reduced: true },
  ]) {
    view.rerender(scene(hidden))
    expect(running.size).toBe(0)
    expect(screen.getByTestId('streaming-caret').textContent).toBe('▋')
    view.rerender(scene())
    expect(running.size).toBe(1)
  }
  state('background')
  expect(running.size).toBe(0)
  state('active')
  expect(running.size).toBe(1)
  state('inactive')
  expect(running.size).toBe(0)
  state('active')
  expect(running.size).toBe(1)
})

it('shares one loop and balances StrictMode replay and keyed caret recycling', () => {
  const scene = (key: string) => (
    <StrictMode>
      <StreamingCaret key={key} reduceMotion={false} />
      <StreamingCaret key="other" reduceMotion={false} />
    </StrictMode>
  )
  const view = render(scene('one'))
  expect(running.size).toBe(1)
  view.rerender(scene('recycled'))
  expect(running.size).toBe(1)
  view.unmount()
  expect(running.size).toBe(0)
  const fresh = render(<StreamingCaret reduceMotion={false} />)
  expect(running.size).toBe(1)
  fresh.unmount()
  expect(running.size).toBe(0)
})
