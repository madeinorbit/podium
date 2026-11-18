import { act, cleanup, render, screen } from '@testing-library/react'
import { type ComponentProps, Profiler } from 'react'
import type { LayoutChangeEvent, View } from 'react-native'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ReducedMotionContext } from '../hooks/useReduceMotion'
import { VisibleContent } from '../lib/visible-content'

const lifecycle = vi.hoisted(() => ({
  state: 'active',
  focused: true,
  events: new Set<() => void>(),
  focus: new Set<() => void>(),
  layouts: [] as ((event: LayoutChangeEvent) => void)[],
}))
const motion = vi.hoisted(() => ({
  repeat: vi.fn(),
  timing: vi.fn(),
  cancel: vi.fn(),
  styles: [] as (() => { transform: { translateX: number }[] })[],
}))
vi.mock('react-native', async (original) => {
  const actual = await original<typeof import('react-native')>()
  return {
    ...actual,
    View: ({ testID, onLayout, ...props }: ComponentProps<typeof View>) => {
      if (testID === 'working-word-glint' && onLayout) lifecycle.layouts.push(onLayout)
      return <actual.View testID={testID} {...props} />
    },
    AppState: {
      get currentState() {
        return lifecycle.state
      },
      addEventListener: (_event: string, listener: () => void) => {
        lifecycle.events.add(listener)
        return { remove: () => lifecycle.events.delete(listener) }
      },
    },
  }
})
vi.mock('../client/projection-focus', async () => {
  const { useSyncExternalStore } = await import('react')
  return {
    useProjectionFocus: () =>
      useSyncExternalStore(
        (listener) => {
          lifecycle.focus.add(listener)
          return () => {
            lifecycle.focus.delete(listener)
          }
        },
        () => lifecycle.focused,
      ),
  }
})
vi.mock('react-native-reanimated', async () => {
  const { View } = await import('react-native')
  const { useRef } = await import('react')
  const mutable = (initial: number) => {
    let value = initial
    return {
      get: () => value,
      set: (next: number) => {
        value = next
      },
    }
  }
  return {
    default: { View },
    makeMutable: mutable,
    useSharedValue: (initial: number) => useRef(mutable(initial)).current,
    useAnimatedStyle: (updater: (typeof motion.styles)[number]) => {
      motion.styles.push(updater)
      return updater()
    },
    Easing: { linear: (x: number) => x, bezierFn: () => (x: number) => x },
    ReduceMotion: { System: 'system' },
    cancelAnimation: motion.cancel,
    withTiming: (value: number, options: object) => {
      motion.timing(value, options)
      return value
    },
    withRepeat: (...args: unknown[]) => {
      motion.repeat(...args)
      return 0
    },
  }
})
const { WorkingWord } = await import('./WorkingWord.native')
const { workingWordProgress } = await import('./working-word-motion')
function focus(value: boolean) {
  act(() => {
    lifecycle.focused = value
    for (const notify of lifecycle.focus) notify()
  })
}
function appState(value: string) {
  act(() => {
    lifecycle.state = value
    for (const notify of lifecycle.events) notify()
  })
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  lifecycle.state = 'active'
  lifecycle.focused = true
  lifecycle.layouts.length = motion.styles.length = 0
})
afterEach(() => {
  cleanup()
  expect(lifecycle.events.size).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
  vi.useRealTimers()
  vi.restoreAllMocks()
})
it.each([1, 50])('uses one UI-thread loop for %s words, without JS frame work', (count) => {
  const interval = vi.spyOn(globalThis, 'setInterval'),
    onRender = vi.fn()
  render(
    <Profiler id="words" onRender={onRender}>
      {Array.from({ length: count }, (_, i) => `word-${i}`).map((id) => (
        <WorkingWord key={id} seed={id}>
          Working
        </WorkingWord>
      ))}
    </Profiler>,
  )
  expect(motion.repeat).toHaveBeenCalledTimes(1)
  expect(motion.timing).toHaveBeenCalledWith(
    1,
    expect.objectContaining({ duration: 2200, reduceMotion: 'system' }),
  )
  expect(lifecycle.events.size).toBe(1)
  onRender.mockClear()
  act(() => vi.advanceTimersByTime(6600))
  expect(onRender).not.toHaveBeenCalled()
  expect(interval).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})
it('keeps the copy fixed while its clipping window moves across the text', () => {
  render(<WorkingWord seed="">Working</WorkingWord>)
  lifecycle.layouts[0]?.({ nativeEvent: { layout: { width: 100 } } } as LayoutChangeEvent)
  const windowStyle = motion.styles[0],
    copyStyle = motion.styles[1]
  if (!windowStyle || !copyStyle) throw new Error('Missing glint styles')
  workingWordProgress.set(0.1)
  const start = windowStyle().transform[0]?.translateX
  workingWordProgress.set(0.3)
  const end = windowStyle().transform[0]?.translateX
  expect(start).not.toBe(end)
  expect(copyStyle().transform[0]?.translateX).toBe(-(end ?? 0))
  expect(screen.getByTestId('working-word-glint').getAttribute('aria-hidden')).toBe('true')
})
it('leaves quiet and reduced-motion words static, without animated styles', () => {
  const { rerender } = render(
    <WorkingWord seed="task" active={false}>
      Idle
    </WorkingWord>,
  )
  expect(screen.getByText('Idle')).toBeTruthy()
  expect(screen.queryByTestId('working-word')).toBeNull()
  rerender(
    <ReducedMotionContext value={true}>
      <WorkingWord seed="task" style={{ fontSize: 13 }}>
        Working
      </WorkingWord>
    </ReducedMotionContext>,
  )
  expect(screen.getByText('Working')).toBeTruthy()
  expect(screen.queryByTestId('working-word-glint')).toBeNull()
  expect(motion.styles).toHaveLength(0)
  expect(motion.repeat).not.toHaveBeenCalled()
})
it('pauses on blur, background and Reduce Motion changes and resumes on return', () => {
  const { rerender } = render(<WorkingWord seed="task">Working</WorkingWord>)
  appState('background')
  expect(workingWordProgress.get()).toBe(0)
  appState('active')
  expect(motion.repeat).toHaveBeenCalledTimes(2)
  focus(false)
  expect(lifecycle.events.size).toBe(0)
  expect(screen.queryByTestId('working-word-glint')).toBeNull()
  focus(true)
  expect(motion.repeat).toHaveBeenCalledTimes(3)
  rerender(
    <ReducedMotionContext value={true}>
      <WorkingWord seed="task">Working</WorkingWord>
    </ReducedMotionContext>,
  )
  expect(lifecycle.events.size).toBe(0)
  expect(screen.getByText('Working')).toBeTruthy()
  rerender(
    <ReducedMotionContext value={false}>
      <WorkingWord seed="task">Working</WorkingWord>
    </ReducedMotionContext>,
  )
  expect(motion.repeat).toHaveBeenCalledTimes(4)
})
it('keeps the clock running when another word unmounts', () => {
  const { rerender } = render(
    <>
      <WorkingWord key="one" seed="one">
        Working
      </WorkingWord>
      <WorkingWord key="two" seed="two">
        Working
      </WorkingWord>
    </>,
  )
  rerender(
    <WorkingWord key="one" seed="one">
      Working
    </WorkingWord>,
  )
  expect(motion.repeat).toHaveBeenCalledTimes(1)
  expect(lifecycle.events.size).toBe(1)
})

it('creates no animated styles or shared loop on hidden pager pages or offscreen rows', () => {
  const { rerender } = render(
    <VisibleContent visible={false}>
      <WorkingWord seed="hidden">Working</WorkingWord>
    </VisibleContent>,
  )
  expect(motion.repeat).not.toHaveBeenCalled()
  expect(motion.styles).toHaveLength(0)
  expect(screen.getByText('Working')).toBeTruthy()
  rerender(
    <VisibleContent visible>
      <WorkingWord seed="hidden">Working</WorkingWord>
    </VisibleContent>,
  )
  expect(motion.repeat).toHaveBeenCalledTimes(1)
  rerender(
    <VisibleContent visible={false}>
      <WorkingWord seed="hidden">Working</WorkingWord>
    </VisibleContent>,
  )
  expect(lifecycle.events.size).toBe(0)
  expect(screen.queryByTestId('working-word-glint')).toBeNull()
})
