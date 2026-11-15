import { cleanup, render, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import { Animated, Text } from 'react-native'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LaunchBoundary, useLaunchReadySignal } from './launch'

const motion = vi.hoisted(() => ({ reduced: true }))
vi.mock('expo-router', () => ({
  SplashScreen: {
    preventAutoHideAsync: vi.fn(async () => {}),
    hideAsync: vi.fn(async () => {}),
  },
}))
vi.mock('../hooks/useReduceMotion', () => ({ useReduceMotion: () => motion.reduced }))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  motion.reduced = true
})

describe('LaunchBoundary', () => {
  function RouteProbe({ ready }: { ready: boolean }) {
    const markReady = useLaunchReadySignal()
    useEffect(() => {
      if (ready) markReady()
    }, [markReady, ready])
    return <Text>cached work</Text>
  }

  it('keeps one splash mounted until fonts and a measured route are both ready', async () => {
    const view = render(
      <LaunchBoundary fontsReady={false}>
        <RouteProbe ready={false} />
      </LaunchBoundary>,
    )

    expect(view.getAllByLabelText('Podium')).toHaveLength(1)
    view.rerender(
      <LaunchBoundary fontsReady={false}>
        <RouteProbe ready />
      </LaunchBoundary>,
    )
    expect(view.getAllByLabelText('Podium')).toHaveLength(1)

    view.rerender(
      <LaunchBoundary fontsReady>
        <RouteProbe ready />
      </LaunchBoundary>,
    )

    await waitFor(() => expect(view.queryByLabelText('Podium')).toBeNull())
    expect(view.getByText('cached work')).toBeTruthy()
  })

  it('releases the first Work tap while the native launch fade is still finishing', async () => {
    motion.reduced = false
    const start = vi.fn()
    vi.spyOn(Animated, 'timing').mockReturnValue({ start, stop: vi.fn(), reset: vi.fn() })
    const view = render(
      <LaunchBoundary fontsReady={false}>
        <RouteProbe ready={false} />
      </LaunchBoundary>,
    )
    const overlay = view.getByTestId('boot-splash').parentElement
    if (!overlay) throw new Error('Launch overlay is missing')
    expect(getComputedStyle(overlay).pointerEvents).toBe('auto')

    view.rerender(
      <LaunchBoundary fontsReady>
        <RouteProbe ready />
      </LaunchBoundary>,
    )
    await waitFor(() => expect(start).toHaveBeenCalled())
    // The UI-thread animation's completion can wait behind JS startup work.
    // Its still-mounted, nearly transparent overlay must not eat the tap.
    expect(view.getByTestId('boot-splash').parentElement).toBe(overlay)
    expect(getComputedStyle(overlay).pointerEvents).toBe('none')
    expect(view.getByText('cached work')).toBeTruthy()
  })
})
