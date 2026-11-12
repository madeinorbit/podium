import { SyncProgressStore } from '@podium/client-core/replica-assembly'
import { act, cleanup, render } from '@testing-library/react'
import { createContext } from 'react'
import { Text } from 'react-native'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UPDATED_SUBTITLE_MS, WorkspaceSyncContext } from '../client/workspace-refresh'

type HeaderOptions = {
  unstable_nativeProps: { headerConfig: { subtitle?: string; largeSubtitle?: string } }
}
const options = vi.hoisted(() => ({ current: {} as HeaderOptions }))
vi.mock('expo-router/stack', () => ({
  Stack: {
    Screen: ({ options: value }: { options: HeaderOptions }) => {
      options.current = value
      return null
    },
  },
}))
vi.mock('expo-router/react-navigation', () => ({ HeaderHeightContext: createContext(0) }))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}))
vi.mock('expo-haptics', () => ({ ImpactFeedbackStyle: { Light: 'light' } }))
vi.mock('../navigation/native-stack', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  nativeSubtitleAvailable: true,
}))
const { Screen } = await import('./Screen.native')
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('iOS navigation refresh subtitle', () => {
  it('updates both the large and collapsed subtitle, then restores the normal one', () => {
    vi.useFakeTimers()
    const store = new SyncProgressStore()
    store.begin('stale')
    render(
      <WorkspaceSyncContext value={store}>
        <Screen title="Pulse" large subtitle="$12.34 today">
          <Text>Content</Text>
        </Screen>
      </WorkspaceSyncContext>,
    )
    const subtitle = () => options.current.unstable_nativeProps.headerConfig
    expect(subtitle()).toEqual({ subtitle: 'Updating…', largeSubtitle: 'Updating…' })
    act(() => store.noteReady())
    expect(subtitle()).toEqual({ subtitle: 'Updated just now', largeSubtitle: 'Updated just now' })
    act(() => vi.advanceTimersByTime(UPDATED_SUBTITLE_MS))
    expect(subtitle()).toEqual({ subtitle: '$12.34 today', largeSubtitle: '$12.34 today' })
  })
})
