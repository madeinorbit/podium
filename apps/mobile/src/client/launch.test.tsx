import { render, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import { Text } from 'react-native'
import { describe, expect, it, vi } from 'vitest'
import { LaunchBoundary, useLaunchReadySignal } from './launch'

vi.mock('expo-router', () => ({
  SplashScreen: {
    preventAutoHideAsync: vi.fn(async () => {}),
    hideAsync: vi.fn(async () => {}),
  },
}))
vi.mock('../hooks/useReduceMotion', () => ({ useReduceMotion: () => true }))

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
})
