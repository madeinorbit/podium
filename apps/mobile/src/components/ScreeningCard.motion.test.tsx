import { asIssueId, type IssueWire } from '@podium/model'
import { act, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const motion = vi.hoisted(() => ({
  reduceMotion: false,
  gesture: undefined as
    | {
        onActivate: () => void
        onUpdate: (event: { translationX: number; translationY: number }) => void
        onDeactivate: (event: {
          canceled: boolean
          velocityX: number
          velocityY: number
        }) => void
      }
    | undefined,
  springs: vi.fn(),
  timings: vi.fn(),
  springExecutions: [] as { target: number; suppressed: boolean }[],
  timingExecutions: [] as { target: number; suppressed: boolean }[],
}))

vi.mock('../hooks/useReduceMotion', () => ({ useReduceMotion: () => motion.reduceMotion }))
vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Medium: 'medium' },
  impactAsync: vi.fn(async () => {}),
}))
vi.mock('react-native-worklets', () => ({
  scheduleOnRN: (callback: (...args: unknown[]) => void, ...args: unknown[]) => callback(...args),
}))
vi.mock('react-native-gesture-handler', async () => {
  const React = await import('react')
  return {
    GestureDetector: ({ children }: { children: ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    usePanGesture: (gesture: typeof motion.gesture) => {
      motion.gesture = gesture
      return gesture
    },
  }
})
vi.mock('react-native-reanimated', async () => {
  const React = await import('react')
  return {
    default: {
      View: ({ children }: { children: ReactNode }) =>
        React.createElement(React.Fragment, null, children),
    },
    cancelAnimation: vi.fn(),
    Easing: { bezier: () => (value: number) => value },
    Extrapolation: { CLAMP: 'clamp' },
    interpolate: () => 0,
    ReduceMotion: { Never: 'never', System: 'system' },
    useAnimatedStyle: (updater: () => object) => updater(),
    useSharedValue: (initial: number | boolean) => {
      const value = React.useRef(initial)
      return {
        get: () => value.current,
        set: (next: number | boolean) => {
          value.current = next
        },
      }
    },
    withSpring: (
      target: number,
      config: Record<string, unknown>,
      callback?: (finished: boolean) => void,
    ) => {
      motion.springs(target, config)
      motion.springExecutions.push({
        target,
        suppressed: motion.reduceMotion && config.reduceMotion === 'system',
      })
      callback?.(true)
      return target
    },
    withTiming: (
      target: number,
      config: Record<string, unknown>,
      callback?: (finished: boolean) => void,
    ) => {
      motion.timings(target, config)
      motion.timingExecutions.push({
        target,
        suppressed: motion.reduceMotion && config.reduceMotion !== 'never',
      })
      callback?.(true)
      return target
    },
  }
})
vi.mock('./IdSquare', () => ({ IdSquare: () => null }))
vi.mock('./PressableScale', async () => {
  const React = await import('react')
  return {
    PressableScale: ({ children }: { children: ReactNode }) =>
      React.createElement(React.Fragment, null, children),
  }
})
vi.mock('./ui', () => ({ Pill: () => null }))

const { ScreeningCard } = await import('./ScreeningCard')

const issue = {
  id: asIssueId('screening-motion'),
  repoPath: '/src/podium',
  seq: 42,
  displayRef: 'POD-42',
  priority: 2,
  stage: 'proposed',
  title: 'Motion preference test',
  type: 'task',
  archived: false,
  draft: false,
  audience: 'human',
  color: null,
  blockedByNotes: [],
  childCount: 0,
  childDoneCount: 0,
  brief: null,
  description: 'Behavioral coverage for reduced motion.',
  defaultAgent: 'codex',
  defaultModel: 'auto',
  defaultEffort: 'auto',
  parentBranch: 'main',
  createdAt: '2026-08-23T00:00:00.000Z',
  origin: 'human',
  dependencyNote: null,
} as unknown as IssueWire

describe('ScreeningCard motion', () => {
  beforeEach(() => {
    motion.reduceMotion = false
    motion.gesture = undefined
    motion.springs.mockClear()
    motion.timings.mockClear()
    motion.springExecutions.length = 0
    motion.timingExecutions.length = 0
  })

  it('uses the live preference for snap-back policy and preserves the fade callback', () => {
    const onDecide = vi.fn()
    const card = () => (
      <ScreeningCard
        issue={issue}
        repoName="podium"
        onDecide={onDecide}
        onOpen={vi.fn()}
      />
    )
    const view = render(card())

    act(() => {
      motion.gesture?.onActivate()
      motion.gesture?.onUpdate({ translationX: 48, translationY: 8 })
    })
    const capturedGesture = motion.gesture
    if (!capturedGesture) throw new Error('Screening gesture was not registered')

    motion.reduceMotion = true
    view.rerender(card())
    act(() => {
      capturedGesture.onDeactivate({ canceled: false, velocityX: 20, velocityY: 4 })
    })

    expect(motion.springs).toHaveBeenCalledTimes(2)
    for (const [, config] of motion.springs.mock.calls) {
      expect(config).toMatchObject({ reduceMotion: 'system' })
    }
    expect(motion.springExecutions).toEqual([
      { target: 0, suppressed: true },
      { target: 0, suppressed: true },
    ])
    expect(motion.springs.mock.calls.map(([, config]) => config.velocity)).toEqual([20, 1])
    expect(onDecide).not.toHaveBeenCalled()

    motion.springs.mockClear()
    motion.springExecutions.length = 0
    act(() => {
      motion.gesture?.onActivate()
      motion.gesture?.onUpdate({ translationX: 120, translationY: 0 })
      motion.gesture?.onDeactivate({ canceled: false, velocityX: 0, velocityY: 0 })
    })

    expect(motion.springs).not.toHaveBeenCalled()
    expect(motion.timings).toHaveBeenCalledWith(0, {
      duration: 150,
      easing: expect.any(Function),
      reduceMotion: 'never',
    })
    expect(motion.timingExecutions).toEqual([{ target: 0, suppressed: false }])
    expect(onDecide).toHaveBeenCalledOnce()
    expect(onDecide).toHaveBeenCalledWith('accepted')
  })

  it.each([
    { distance: 120, releaseVelocity: -1_200, verdict: 'accepted' },
    { distance: -120, releaseVelocity: 1_200, verdict: 'declined' },
  ] as const)(
    'clamps opposing exit velocity for a $verdict distance commit',
    ({ distance, releaseVelocity, verdict }) => {
      const onDecide = vi.fn()
      render(
        <ScreeningCard
          issue={issue}
          repoName="podium"
          onDecide={onDecide}
          onOpen={vi.fn()}
        />,
      )

      act(() => {
        motion.gesture?.onActivate()
        motion.gesture?.onUpdate({ translationX: distance, translationY: 0 })
        motion.gesture?.onDeactivate({
          canceled: false,
          velocityX: releaseVelocity,
          velocityY: 0,
        })
      })

      expect(motion.springs).toHaveBeenCalledTimes(2)
      const [, config] = motion.springs.mock.calls[1] ?? []
      expect(config).toMatchObject({ velocity: 0 })
      expect(onDecide).toHaveBeenCalledWith(verdict)
    },
  )
})
