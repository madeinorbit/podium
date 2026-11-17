import { SyncProgressStore } from '@podium/client-core/replica-assembly'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createContext } from 'react'
import { Text } from 'react-native'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UPDATED_SUBTITLE_MS, WorkspaceSyncContext } from '../client/workspace-refresh'

type HeaderOptions = {
  unstable_nativeProps: { headerConfig: { subtitle?: string; largeSubtitle?: string } }
  headerTitle?: () => React.ReactNode
  headerLeft?: () => React.ReactNode
  headerBackVisible?: boolean
}
const options = vi.hoisted(() => ({ current: {} as HeaderOptions, history: [] as HeaderOptions[] }))
type ToolbarProps = Record<string, unknown> & { children?: React.ReactNode }
vi.mock('react-native', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-native')>()
  return { ...actual, Platform: { ...actual.Platform, OS: 'ios' } }
})
vi.mock('expo-router/stack', () => {
  // The bar's items as plain markup, so a test reads the UIMenu tree it builds.
  const Toolbar = Object.assign(
    ({ children }: ToolbarProps) => <div data-testid="toolbar">{children}</div>,
    {
      Menu: ({ children, inline, title, icon, accessibilityLabel }: ToolbarProps) => (
        <div
          data-testid="menu"
          data-inline={String(inline ?? false)}
          data-title={String(title ?? accessibilityLabel ?? '')}
          data-icon={String(icon ?? '')}
        >
          {children}
        </div>
      ),
      MenuAction: ({ children, icon, destructive, isOn, subtitle }: ToolbarProps) => (
        <div
          data-testid="menu-action"
          data-icon={String(icon ?? '')}
          data-destructive={String(destructive ?? false)}
          data-on={String(isOn ?? false)}
          data-subtitle={String(subtitle ?? '')}
        >
          {children}
        </div>
      ),
      Button: ({ accessibilityLabel, onPress }: ToolbarProps) => (
        <button type="button" data-testid="bar-button" onClick={onPress as () => void}>
          {String(accessibilityLabel)}
        </button>
      ),
      Label: ({ children }: ToolbarProps) => <span>{children}</span>,
    },
  )
  return {
    Stack: {
      Screen: ({ options: value }: { options: HeaderOptions }) => {
        options.current = value
        options.history.push(value)
        return null
      },
      Toolbar,
    },
  }
})
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
  options.history.length = 0
})

describe('iOS navigation refresh subtitle', () => {
  it('never publishes an empty line between updating and ready, and removes it when idle', () => {
    vi.useFakeTimers()
    const store = new SyncProgressStore()
    store.begin('stale')
    render(
      <WorkspaceSyncContext value={store}>
        <Screen title="Work" large>
          <Text>Saved list</Text>
        </Screen>
      </WorkspaceSyncContext>,
    )
    options.history.length = 0
    act(() => store.noteReady())
    expect(options.history.length).toBeGreaterThan(0)
    expect(
      options.history.every(
        (value) => value.unstable_nativeProps.headerConfig.largeSubtitle === 'Updated just now',
      ),
    ).toBe(true)
    act(() => vi.advanceTimersByTime(UPDATED_SUBTITLE_MS))
    expect(options.current.unstable_nativeProps.headerConfig.largeSubtitle).toBeUndefined()
  })
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
    expect(subtitle()).toMatchObject({ subtitle: 'Updating…', largeSubtitle: 'Updating…' })
    act(() => store.noteReady())
    expect(subtitle()).toMatchObject({
      subtitle: 'Updated just now',
      largeSubtitle: 'Updated just now',
    })
    act(() => vi.advanceTimersByTime(UPDATED_SUBTITLE_MS))
    expect(subtitle()).toMatchObject({ subtitle: '$12.34 today', largeSubtitle: '$12.34 today' })
  })
})

it('uses a native logical Back action without starting a stack pop', () => {
  const back = vi.fn()
  const page = (deck: boolean) => (
    <Screen
      title={deck ? 'Flight deck' : 'Chat'}
      backTitle={deck ? 'Chat' : undefined}
      onBack={back}
    >
      <Text>Content</Text>
    </Screen>
  )
  const view = render(page(true))
  expect(options.current.headerBackVisible).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Back to Chat' }))
  expect(back).toHaveBeenCalledTimes(1)
  view.rerender(page(false))
  expect(options.current.headerBackVisible).toBeUndefined()
  expect(screen.queryByRole('button', { name: 'Back to Chat' })).toBeNull()
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

describe('header pull-down menu', () => {
  it('builds the UIMenu from sections, submenus, symbols and the destructive attribute', () => {
    const icon = (name: string) => ({ ios: name, android: name, web: name }) as never
    render(
      <Screen
        title="Chat"
        onBack={() => {}}
        actions={[
          { label: 'Open terminal', icon: icon('terminal'), onPress: () => {} },
          {
            label: 'Session actions',
            icon: icon('ellipsis'),
            items: [
              {
                items: [
                  {
                    label: 'Next Session',
                    hint: 'The next one waiting on you',
                    icon: icon('forward.end'),
                    onPress: () => {},
                  },
                ],
              },
              {
                title: 'Work State',
                submenu: true,
                icon: icon('square.stack.3d.up'),
                items: [{ label: 'Planning', selected: true, onPress: () => {} }],
              },
              {
                items: [
                  {
                    label: 'Kill Session',
                    icon: icon('xmark.octagon'),
                    destructive: true,
                    onPress: () => {},
                  },
                ],
              },
            ],
          },
        ]}
      >
        <Text>Content</Text>
      </Screen>,
    )
    expect(screen.getByTestId('bar-button').textContent).toBe('Open terminal')
    const [root, section, submenu, last] = screen.getAllByTestId('menu')
    expect(root?.dataset.icon).toBe('ellipsis')
    expect(section?.dataset.inline).toBe('true')
    expect(submenu?.dataset).toMatchObject({
      inline: 'false',
      title: 'Work State',
      icon: 'square.stack.3d.up',
    })
    expect(last?.dataset.inline).toBe('true')
    const rows = screen.getAllByTestId('menu-action')
    expect(rows.map((row) => row.textContent)).toEqual(['Next Session', 'Planning', 'Kill Session'])
    expect(rows[0]?.dataset).toMatchObject({
      icon: 'forward.end',
      subtitle: 'The next one waiting on you',
    })
    expect(rows[1]?.dataset.on).toBe('true')
    expect(rows[2]?.dataset.destructive).toBe('true')
  })
})

it('uses a native Done item for sheet dismissal so UIKit owns its text sizing', () => {
  const done = vi.fn()
  render(
    <Screen title="Task details" onBack={done} backAs="text" backLabel="Done">
      <Text>Detail content</Text>
    </Screen>,
  )
  expect(options.current.headerLeft).toBeUndefined()
  const button = screen.getByRole('button', { name: 'Done' })
  expect(button.dataset.testid).toBe('bar-button')
  fireEvent.click(button)
  expect(done).toHaveBeenCalledOnce()
})
