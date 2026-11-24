import { act, cleanup, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { Text } from 'react-native'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 20, right: 0, bottom: 34, left: 0 }),
}))
vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light' },
  impactAsync: vi.fn(),
}))

vi.mock('./Icon', () => ({ Icon: () => null }))
// The real sheet drags with gesture-handler and reanimated, which have no host here.
vi.mock('./BottomSheet', () => ({
  BottomSheet: ({
    visible,
    children,
    head,
    footer,
  }: {
    visible: boolean
    children?: ReactNode
    head?: ReactNode
    footer?: ReactNode
  }) =>
    visible ? (
      <>
        {head}
        {children}
        {footer}
      </>
    ) : null,
}))

const { Screen } = await import('./Screen')
const { MobileSyncProgressStore } = await import('../client/mobile-sync-progress')
const { WorkspaceSyncContext, UPDATED_SUBTITLE_MS } = await import('../client/workspace-refresh')
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('Screen safe areas', () => {
  it('pays the bottom inset when the pushed screen opts in', () => {
    const { container } = render(
      <Screen title="Session" safeBottom>
        <Text>Body</Text>
      </Screen>,
    )

    const inner = container.firstElementChild?.firstElementChild as HTMLElement
    expect(inner.style.paddingBottom).toBe('34px')
  })
})

describe('Screen actions', () => {
  it('draws trailing actions, and a menu action opens its entries as a sheet', async () => {
    const onPress = vi.fn()
    const open = vi.fn()
    const state = vi.fn()
    const { getByLabelText, findByLabelText, queryByLabelText } = render(
      <Screen
        title="Work"
        large
        actions={[
          { label: 'New work', icon: { ios: 'square.and.pencil' } as never, onPress },
          {
            label: 'Show',
            icon: { ios: 'line.3.horizontal' } as never,
            menuTitle: 'Show',
            items: [
              { items: [{ label: 'Open', onPress: open }] },
              {
                title: 'State',
                submenu: true,
                items: [{ label: 'Planning', selected: true, onPress: state }],
              },
            ],
          },
        ]}
      >
        <Text>Body</Text>
      </Screen>,
    )
    getByLabelText('New work').click()
    expect(onPress).toHaveBeenCalledTimes(1)
    // Inline sections flatten into the sheet; a submenu is one row.
    expect(queryByLabelText('Open')).toBeNull()
    act(() => getByLabelText('Show').click())
    expect(await findByLabelText('Open')).toBeTruthy()
    expect(getByLabelText('State…')).toBeTruthy()
    expect(queryByLabelText('Planning')).toBeNull()
  })
})

describe('Screen refresh subtitle', () => {
  it.each([
    '11 need you',
    '17 open · 4 closed',
    '$12.34 today',
  ])('restores the current normal subtitle: %s', (normal) => {
    vi.useFakeTimers()
    const store = new MobileSyncProgressStore()
    store.begin('live')
    const screen = (subtitle: string) => (
      <WorkspaceSyncContext value={store.shared}>
        <Screen title="Work" large subtitle={subtitle}>
          <Text>Cached rows</Text>
        </Screen>
      </WorkspaceSyncContext>
    )
    const view = render(screen(normal))
    expect(view.getByText(normal)).toBeTruthy()
    expect(view.queryByText('Updated just now')).toBeNull()
    act(() => store.beginAttempt())
    expect(view.getByText('Updating…')).toBeTruthy()
    expect(view.queryByText(normal)).toBeNull()
    act(() => store.noteSaving())
    expect(view.getByText('Updating…')).toBeTruthy()
    act(() => store.shared.noteReady())
    expect(view.getByText('Updated just now')).toBeTruthy()
    view.rerender(screen('New count'))
    act(() => vi.advanceTimersByTime(UPDATED_SUBTITLE_MS))
    expect(view.getByText('New count')).toBeTruthy()
    expect(view.queryByText('Updated just now')).toBeNull()
  })

  it('keeps detail metadata and cancels the completion label when another sync starts', () => {
    vi.useFakeTimers()
    const store = new MobileSyncProgressStore()
    store.begin('stale')
    const view = render(
      <WorkspaceSyncContext value={store.shared}>
        <Screen title="Work" large>
          <Text>Rows</Text>
        </Screen>
        <Screen title="Task" subtitle="POD-123">
          <Text>Detail</Text>
        </Screen>
      </WorkspaceSyncContext>,
    )
    expect(view.getByText('POD-123')).toBeTruthy()
    act(() => store.shared.noteReady())
    expect(view.getByText('Updated just now')).toBeTruthy()
    act(() => store.beginAttempt())
    act(() => vi.advanceTimersByTime(UPDATED_SUBTITLE_MS))
    expect(view.getByText('Updating…')).toBeTruthy()
    expect(view.queryByText('Updated just now')).toBeNull()
  })
})
