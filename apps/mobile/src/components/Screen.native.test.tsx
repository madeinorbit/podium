import { SyncProgressStore } from '@podium/client-core/replica-assembly'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createContext } from 'react'
import { Text } from 'react-native'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UPDATED_SUBTITLE_MS, WorkspaceSyncContext } from '../client/workspace-refresh'

type HeaderOptions = {
  unstable_nativeProps: { headerConfig: { subtitle?: string; largeSubtitle?: string } }
  headerTitle?: () => React.ReactNode
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
  it('uses the counts already updated with the list when the completion label expires', () => {
    vi.useFakeTimers()
    const store = new SyncProgressStore()
    store.begin('stale')
    const screen = (counts: string) => (
      <WorkspaceSyncContext value={store}>
        <Screen title="Work" large subtitle={counts}>
          <Text>Saved list</Text>
        </Screen>
      </WorkspaceSyncContext>
    )
    const view = render(screen('2 need you · 4 working'))
    const subtitle = () => options.current.unstable_nativeProps.headerConfig.largeSubtitle
    // The shared pool delivers new list membership and its counts together.
    // The completion acknowledgement intentionally occupies the subtitle first.
    view.rerender(screen('3 need you · 2 working'))
    expect(subtitle()).toBe('Updating…')
    act(() => store.noteReady())
    expect(subtitle()).toBe('Updated just now')
    act(() => vi.advanceTimersByTime(UPDATED_SUBTITLE_MS - 1))
    expect(subtitle()).toBe('Updated just now')
    act(() => vi.advanceTimersByTime(1))
    expect(subtitle()).toBe('3 need you · 2 working')
  })

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

describe('tappable navigation title', () => {
  it('draws the title and subtitle as one button and keeps the subtitle out of the bar', () => {
    const open = vi.fn()
    render(
      <Screen title="Chat parity" subtitle="Coordinator" onTitlePress={open} onBack={() => {}}>
        <Text>Content</Text>
      </Screen>,
    )
    expect(options.current.unstable_nativeProps.headerConfig.subtitle).toBeUndefined()
    const Title = options.current.headerTitle
    expect(Title).toBeDefined()
    render(<>{Title?.()}</>)
    fireEvent.click(screen.getByRole('button', { name: 'Chat parity, Coordinator' }))
    expect(open).toHaveBeenCalledTimes(1)
  })
  it('keeps the native title when the screen has no title action', () => {
    render(
      <Screen title="Session" subtitle="Claude" onBack={() => {}}>
        <Text>Content</Text>
      </Screen>,
    )
    expect(options.current.headerTitle).toBeUndefined()
  })
})
