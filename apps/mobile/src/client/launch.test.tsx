import { act, cleanup, render, waitFor } from '@testing-library/react'
import { type EffectCallback, useEffect } from 'react'
import { Animated, Text } from 'react-native'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSearchLaunchTransition } from '../components/list-search-bar.ios'
import { LaunchBoundary, useLaunchReadySignal } from './launch'

const motion = vi.hoisted(() => ({ reduced: true }))
vi.mock('expo-router', () => ({
  useFocusEffect: (effect: EffectCallback) => useEffect(effect, [effect]),
  Stack: { SearchBar: () => null },
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
  let search: ReturnType<typeof useSearchLaunchTransition>
  function SearchProbe() {
    search = useSearchLaunchTransition()
    return <Text>native list</Text>
  }
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

  it('keeps the first native search scroll under the splash until it settles', async () => {
    const view = render(
      <LaunchBoundary fontsReady>
        <RouteProbe ready />
        <SearchProbe />
      </LaunchBoundary>,
    )
    expect(search.canTuck).toBe(true)
    const overlay = view.getByTestId('boot-splash').parentElement
    if (!overlay) throw new Error('Launch overlay is missing')
    expect(getComputedStyle(overlay).pointerEvents).toBe('auto')
    act(() => search.onReady())
    await waitFor(() => expect(view.queryByTestId('boot-splash')).toBeNull())
    expect(search.canTuck).toBe(false)
    expect(view.getByText('native list')).toBeTruthy()
  })

  it('leaves a list that arrives after reveal at rest instead of moving a visible target', async () => {
    const route = (showList: boolean) => (
      <LaunchBoundary fontsReady>
        <RouteProbe ready />
        {showList ? <SearchProbe /> : null}
      </LaunchBoundary>
    )
    const view = render(route(false))
    await waitFor(() => expect(view.queryByTestId('boot-splash')).toBeNull())
    view.rerender(route(true))
    expect(search.canTuck).toBe(false)
    act(() => search.onReady())
    expect(view.queryByTestId('boot-splash')).toBeNull()
  })

  it('lets a native hold win when fonts finish after the route already has a frame', async () => {
    const view = render(
      <LaunchBoundary fontsReady={false}>
        <RouteProbe ready />
      </LaunchBoundary>,
    )
    view.rerender(
      <LaunchBoundary fontsReady>
        <RouteProbe ready />
        <SearchProbe />
      </LaunchBoundary>,
    )
    expect(search.canTuck).toBe(true)
    expect(view.getByTestId('boot-splash')).toBeTruthy()
    act(() => search.onReady())
    await waitFor(() => expect(view.queryByTestId('boot-splash')).toBeNull())
  })

  it('releases an unfinished native transition when its tab leaves', async () => {
    const route = (showList: boolean) => (
      <LaunchBoundary fontsReady>
        <RouteProbe ready />
        {showList ? <SearchProbe /> : null}
      </LaunchBoundary>
    )
    const view = render(route(true))
    expect(search.canTuck).toBe(true)
    view.rerender(route(false))
    await waitFor(() => expect(view.queryByTestId('boot-splash')).toBeNull())
  })
})
