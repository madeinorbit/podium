import { act, cleanup, render } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { View as RNView } from 'react-native'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dotsAt, restingPicture } from '@podium/working-mark/frames'
import { tetra } from '@podium/working-mark/designs'
import { ReducedMotionContext } from '../hooks/useReduceMotion'

const lifecycle = vi.hoisted(() => ({
  events: new Map<string, (value?: string) => void>(),
  focused: true,
  focusListeners: new Set<() => void>(),
}))
vi.mock('react-native', async () => ({
  ...await vi.importActual<typeof import('react-native')>('react-native'),
  AppState: {
    currentState: 'active',
    addEventListener: (event: string, handler: (value?: string) => void) => {
      lifecycle.events.set(event, handler)
      return { remove: () => lifecycle.events.delete(event) }
    },
  },
}))
vi.mock('expo-router', async () => {
  const { useEffect, useSyncExternalStore } = await import('react')
  return { useFocusEffect: (effect: () => void | (() => void)) => {
    const focused = useSyncExternalStore(listener => {
      lifecycle.focusListeners.add(listener)
      return () => { lifecycle.focusListeners.delete(listener) }
    }, () => lifecycle.focused)
    useEffect(() => focused ? effect() : undefined, [effect, focused])
  } }
})

// Native SVG is a drawing boundary; retain the actual frame and lifecycle code.
const drawn: Record<string, unknown>[] = []
const cells: Record<string, unknown>[] = []
const updates: Record<string, unknown>[] = []
vi.mock('react-native-svg', async () => {
  const { View } = await import('react-native')
  const { forwardRef, useImperativeHandle } = await import('react')
  const Svg = ({ children, ...props }: ComponentProps<typeof RNView>) => {
    cells.push(props as Record<string, unknown>)
    return <View>{children}</View>
  }
  const Ellipse = forwardRef((props: Record<string, unknown>, ref) => {
    drawn.push(props)
    useImperativeHandle(ref, () => ({ setNativeProps: (values: Record<string, unknown>) => updates.push(values) }), [])
    return null
  })
  return { default: Svg, Svg, Ellipse }
})

const { WorkingMark } = await import('./WorkingMark.native')

const latestPicture = () => updates.slice(-4).map(dot => [dot.cx, dot.cy, dot.rx, dot.ry, dot.opacity])
const rest = restingPicture(tetra)

describe('phone tetra mark', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    drawn.length = cells.length = updates.length = 0
    lifecycle.focused = true
  })
  afterEach(() => {
    cleanup()
    expect(lifecycle.events.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })

  it.each([[24, 16], [18, 12], [12, 8], [9, 6]])('keeps the existing %spx cell and %spx width', (size, width) => {
    render(<WorkingMark size={size} label="Working" />)
    expect(cells.at(-1)).toMatchObject({ width, height: size, accessible: false,
      accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' })
    expect(cells.at(-1)?.accessibilityLabel).toBeUndefined()
    expect(drawn).toHaveLength(4)
  })

  it('uses the tetra frames with one clock, updates native dots without React renders, and keeps moving without input', () => {
    render(<><WorkingMark /><WorkingMark size={18} /></>)
    expect(lifecycle.events.size).toBe(1)
    expect(vi.getTimerCount()).toBe(1) // one frame interval, no idle timeout
    expect(latestPicture()).toEqual(dotsAt(tetra, 1000))
    const rendered = drawn.length
    act(() => vi.advanceTimersByTime(1000))
    expect(latestPicture()).not.toEqual(rest)
    expect(drawn).toHaveLength(rendered)
    act(() => vi.advanceTimersByTime(60_000))
    const later = latestPicture()
    act(() => vi.advanceTimersByTime(200))
    expect(latestPicture()).not.toEqual(later)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('stops only in the background and moves again when the app returns', () => {
    render(<WorkingMark />)
    act(() => lifecycle.events.get('change')?.('inactive'))
    expect(vi.getTimerCount()).toBe(1)
    act(() => lifecycle.events.get('change')?.('background'))
    expect(latestPicture()).toEqual(rest)
    expect(vi.getTimerCount()).toBe(0)
    act(() => lifecycle.events.get('change')?.('active'))
    expect(vi.getTimerCount()).toBe(1)
  })

  it('pauses covered screens and responds to reduced motion, with the resting picture and working colour', () => {
    const { rerender } = render(<ReducedMotionContext.Provider value={false}><WorkingMark /></ReducedMotionContext.Provider>)
    expect(new Set(drawn.map(dot => dot.fill))).toEqual(new Set(['#6f9dff']))
    act(() => {
      lifecycle.focused = false
      for (const listener of lifecycle.focusListeners) listener()
    })
    expect(latestPicture()).toEqual(rest)
    expect(vi.getTimerCount()).toBe(0)
    act(() => {
      lifecycle.focused = true
      for (const listener of lifecycle.focusListeners) listener()
    })
    expect(vi.getTimerCount()).toBe(1)
    drawn.length = 0
    rerender(<ReducedMotionContext.Provider value={true}><WorkingMark tint="#fff" /></ReducedMotionContext.Provider>)
    expect(latestPicture()).toEqual(rest)
    expect(vi.getTimerCount()).toBe(0)
    expect(new Set(drawn.map(dot => dot.fill))).toEqual(new Set(['#fff']))
    rerender(<ReducedMotionContext.Provider value={false}><WorkingMark /></ReducedMotionContext.Provider>)
    expect(vi.getTimerCount()).toBe(1)
  })
})
