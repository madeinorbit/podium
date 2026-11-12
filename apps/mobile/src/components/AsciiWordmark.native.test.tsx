import { act, cleanup, render } from '@testing-library/react'
import { Profiler } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReducedMotionContext } from '../hooks/useReduceMotion'
import { ASCII_WORDMARK } from './AsciiWordmark.shared'

const motion = vi.hoisted(() => ({ timing: vi.fn(), cancel: vi.fn(), opacity: 1 }))
vi.mock('react-native-reanimated', async () => {
  const { Text } = await import('react-native')
  const { useMemo } = await import('react')
  return {
    default: { Text },
    cancelAnimation: motion.cancel,
    Easing: { bezier: () => 'ease-out' },
    ReduceMotion: { System: 'system' },
    useSharedValue: (initial: number) =>
      useMemo(() => {
        motion.opacity = initial
        return {
          get: () => motion.opacity,
          set: (value: number) => {
            motion.opacity = value
          },
        }
      }, []),
    useAnimatedStyle: (updater: () => object) => updater(),
    withTiming: (target: number, config: object) => {
      motion.timing(target, config)
      return target
    },
  }
})
const { AsciiWordmark, REVEAL_DURATION_MS } = await import('./AsciiWordmark.native')

describe('native ASCII reveal', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('typesets once, with no JS timer or React commits during the one-second fade', () => {
    const interval = vi.spyOn(globalThis, 'setInterval')
    const onRender = vi.fn()
    const { getByLabelText } = render(
      <Profiler id="ascii" onRender={onRender}>
        <AsciiWordmark color="#fff" variant="reveal" />
      </Profiler>,
    )
    expect(getByLabelText('Podium').textContent).toBe(ASCII_WORDMARK)
    expect(motion.timing).toHaveBeenCalledWith(1, {
      duration: REVEAL_DURATION_MS,
      easing: 'ease-out',
      reduceMotion: 'system',
    })
    onRender.mockClear()
    for (let tick = 0; tick < 31; tick++) act(() => vi.advanceTimersByTime(34))
    expect(onRender).not.toHaveBeenCalled()
    expect(interval).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps idle and reduced-motion wordmarks settled and cancels on unmount', () => {
    const { rerender, unmount } = render(<AsciiWordmark color="#fff" />)
    expect(motion.timing).not.toHaveBeenCalled()
    expect(motion.opacity).toBe(1)
    rerender(
      <ReducedMotionContext.Provider value={true}>
        <AsciiWordmark color="#fff" variant="reveal" />
      </ReducedMotionContext.Provider>,
    )
    expect(motion.timing).not.toHaveBeenCalled()
    expect(motion.opacity).toBe(1)
    unmount()
    expect(motion.cancel).toHaveBeenCalled()
  })

  it('settles immediately when reduced motion changes during reveal', () => {
    const { rerender } = render(
      <ReducedMotionContext.Provider value={false}>
        <AsciiWordmark color="#fff" variant="reveal" />
      </ReducedMotionContext.Provider>,
    )
    expect(motion.timing).toHaveBeenCalledTimes(1)
    rerender(
      <ReducedMotionContext.Provider value={true}>
        <AsciiWordmark color="#fff" variant="reveal" />
      </ReducedMotionContext.Provider>,
    )
    expect(motion.opacity).toBe(1)
    expect(motion.timing).toHaveBeenCalledTimes(1)
  })
})
