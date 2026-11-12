import { act, cleanup, render } from '@testing-library/react'
import { type ComponentProps, Profiler } from 'react'
import type { View as RNView } from 'react-native'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReducedMotionContext } from '../hooks/useReduceMotion'
import { workingMarkRest } from './working-mark-frames'

const lifecycle = vi.hoisted(() => ({
  events: new Set<() => void>(),
  state: 'active',
  focused: true,
  focusListeners: new Set<() => void>(),
}))
const motion = vi.hoisted(() => ({
  repeat: vi.fn(),
  cancel: vi.fn(),
  timing: vi.fn(),
  updaters: [] as (() => object)[],
}))
vi.mock('react-native', async () => ({
  ...(await vi.importActual<typeof import('react-native')>('react-native')),
  AppState: {
    get currentState() {
      return lifecycle.state
    },
    addEventListener: (_event: string, handler: () => void) => {
      lifecycle.events.add(handler)
      return { remove: () => lifecycle.events.delete(handler) }
    },
  },
}))
vi.mock('expo-router/react-navigation', async () => {
  const { useSyncExternalStore } = await import('react')
  return {
    useIsFocused: () =>
      useSyncExternalStore(
        (listener) => {
          lifecycle.focusListeners.add(listener)
          return () => {
            lifecycle.focusListeners.delete(listener)
          }
        },
        () => lifecycle.focused,
      ),
  }
})
vi.mock('expo-router', async () => {
  const { useEffect } = await import('react')
  const { useIsFocused } = await import('expo-router/react-navigation')
  return {
    useFocusEffect: (effect: () => undefined | (() => void)) => {
      const focused = useIsFocused()
      useEffect(() => (focused ? effect() : undefined), [effect, focused])
    },
  }
})
vi.mock('react-native-reanimated', async () => {
  const { createElement } = await import('react')
  return {
    default: {
      createAnimatedComponent:
        (Component: React.ComponentType<object>) =>
        ({ animatedProps, ...props }: { animatedProps: object }) =>
          createElement(Component, { ...props, ...animatedProps }),
    },
    makeMutable: (initial: number) => {
      let value = initial
      return {
        get: () => value,
        set: (next: number) => {
          value = next
        },
      }
    },
    Easing: { linear: (x: number) => x },
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
    useAnimatedProps: (updater: () => object) => {
      motion.updaters.push(updater)
      return updater()
    },
  }
})
const cells: Record<string, unknown>[] = []
const dots: Record<string, unknown>[] = []
vi.mock('react-native-svg', async () => {
  const { View } = await import('react-native')
  return {
    default: ({ children, ...props }: ComponentProps<typeof RNView>) => {
      cells.push(props)
      return <View>{children}</View>
    },
    Ellipse: (props: Record<string, unknown>) => {
      dots.push(props)
      return null
    },
  }
})
const { WorkingMark } = await import('./WorkingMark.native')
const { workingMarkProgress } = await import('./working-mark-motion.native')

function setAppState(state: string) {
  act(() => {
    lifecycle.state = state
    for (const notify of lifecycle.events) notify()
  })
}
function setFocused(value: boolean) {
  act(() => {
    lifecycle.focused = value
    for (const notify of lifecycle.focusListeners) notify()
  })
}

describe('UI-thread working mark', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    lifecycle.focused = true
    lifecycle.state = 'active'
    cells.length = dots.length = motion.updaters.length = 0
    vi.clearAllMocks()
  })
  afterEach(() => {
    cleanup()
    expect(lifecycle.events.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it.each([
    [24, 16],
    [18, 12],
    [12, 8],
    [9, 6],
  ])('preserves the %spx by %spx decorative cell', (size, width) => {
    render(<WorkingMark size={size} label="Working" />)
    expect(cells.at(-1)).toMatchObject({
      width,
      height: size,
      accessible: false,
      accessibilityElementsHidden: true,
      importantForAccessibility: 'no-hide-descendants',
    })
    expect(cells.at(-1)?.accessibilityLabel).toBeUndefined()
    expect(dots).toHaveLength(4)
  })

  it.each([
    1, 10, 50,
  ])('runs %s marks with one UI animation, no JS timers or React commits', (count) => {
    const interval = vi.spyOn(globalThis, 'setInterval')
    const onRender = vi.fn()
    const ids = Array.from({ length: count }, (_, i) => `mark-${i}`)
    render(
      <Profiler id="marks" onRender={onRender}>
        {ids.map((id) => (
          <WorkingMark key={id} />
        ))}
      </Profiler>,
    )
    expect(lifecycle.events.size).toBe(1)
    expect(motion.repeat).toHaveBeenCalledTimes(1)
    expect(motion.timing).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ duration: 4000, reduceMotion: 'system' }),
    )
    onRender.mockClear()
    for (let tick = 0; tick < 15; tick++) act(() => vi.advanceTimersByTime(67))
    expect(onRender).not.toHaveBeenCalled()
    expect(interval).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    expect(motion.repeat).toHaveBeenCalledTimes(1)
  })

  it('pauses in background and resumes without input, while inactive overlays keep moving', () => {
    render(<WorkingMark />)
    setAppState('inactive')
    expect(motion.repeat).toHaveBeenCalledTimes(1)
    setAppState('background')
    expect(workingMarkProgress.get()).toBe(0)
    expect(motion.cancel).toHaveBeenCalledTimes(2)
    setAppState('active')
    expect(motion.repeat).toHaveBeenCalledTimes(2)
  })

  it('unsubscribes covered or reduced-motion marks, restoring the static shared tetra', () => {
    const { rerender } = render(
      <ReducedMotionContext.Provider value={false}>
        <WorkingMark />
      </ReducedMotionContext.Provider>,
    )
    setFocused(false)
    expect(lifecycle.events.size).toBe(0)
    setFocused(true)
    expect(motion.repeat).toHaveBeenCalledTimes(2)
    dots.length = 0
    rerender(
      <ReducedMotionContext.Provider value={true}>
        <WorkingMark tint="#fff" />
      </ReducedMotionContext.Provider>,
    )
    expect(lifecycle.events.size).toBe(0)
    expect(dots.map(({ cx, cy, rx, ry, opacity }) => [cx, cy, rx, ry, opacity])).toEqual(
      workingMarkRest,
    )
    expect(dots.map((dot) => dot.fill)).toEqual(Array(4).fill('#fff'))
    rerender(
      <ReducedMotionContext.Provider value={false}>
        <WorkingMark />
      </ReducedMotionContext.Provider>,
    )
    expect(motion.repeat).toHaveBeenCalledTimes(3)
  })

  it('does not stop a remaining mark when another unmounts', () => {
    const { rerender } = render(
      <>
        <WorkingMark key="one" />
        <WorkingMark key="two" />
      </>,
    )
    rerender(<WorkingMark key="one" />)
    expect(lifecycle.events.size).toBe(1)
    expect(motion.repeat).toHaveBeenCalledTimes(1)
    expect(motion.cancel).toHaveBeenCalledTimes(1)
  })
})
