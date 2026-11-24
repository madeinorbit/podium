import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { type ReactElement, type ReactNode, useLayoutEffect, useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { NoticeLayout } from '../components/notice-layout'
import { WorkIssueMenu, type WorkIssueMenuTarget } from '../components/WorkIssueMenu'
import { WorkingMark } from '../components/WorkingMark.native'
import type { WorkSurfaceProps } from './WorkSurface.types'

const navigation = vi.hoisted(() => ({ push: vi.fn() }))
const activity = vi.hoisted(() => ({ users: 0, route: null as ReactElement | null }))
vi.mock('expo-router/stack', () => ({
  Stack: Object.assign(
    ({ screenLayout }: { screenLayout: (props: { children: ReactElement }) => ReactElement }) =>
      screenLayout({ children: activity.route ?? <></> }),
    { Screen: () => null },
  ),
}))
vi.mock('@podium/client-core/react', async (original) => ({
  ...(await original<typeof import('@podium/client-core/react')>()),
  useCommands: () => ({ issues: {}, sessions: {}, preferences: {} }),
}))
vi.mock('../client/use-issue-close', () => ({ useIssueCloseGuard: () => () => false }))
vi.mock('../client/use-issue-model', () => ({ useIssueModel: () => undefined }))
vi.mock('../navigation/use-dismiss-on-root-leave', () => ({ useDismissOnRootLeave: () => {} }))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}))
vi.mock('../components/working-mark-motion.native', () => ({
  workingMarkProgress: { get: () => 0 },
  subscribeWorkingMark: () => {
    activity.users++
    return () => {
      activity.users--
    }
  },
}))
vi.mock('react-native-reanimated', async () => {
  const { View } = await import('react-native')
  const { useState } = await import('react')
  return {
    default: { View },
    useSharedValue: <T,>(initial: T) =>
      useState(() => {
        let value = initial
        return {
          get: () => value,
          set: (next: T) => {
            value = next
          },
        }
      })[0],
    useAnimatedStyle: (read: () => object) => read(),
    cancelAnimation: () => {},
    withSpring: (next: number, _config: unknown, finish?: (done: boolean) => void) => {
      finish?.(true)
      return next
    },
    interpolate: () => 1,
    Extrapolation: { CLAMP: 'clamp' },
    ReduceMotion: { System: 'system' },
  }
})
vi.mock('react-native-worklets', () => ({
  scheduleOnUI: (fn: (...args: never[]) => void, ...args: never[]) => fn(...args),
  scheduleOnRN: (fn: (...args: never[]) => void, ...args: never[]) => fn(...args),
}))
vi.mock('react-native-gesture-handler', () => ({
  GestureDetector: ({ children }: { children: ReactNode }) => children,
  GestureHandlerRootView: ({ children }: { children: ReactNode }) => children,
  usePanGesture: () => ({}),
}))
vi.mock('expo-router', () => ({
  usePathname: () => '/work',
  useRouter: () => navigation,
  useFocusEffect: () => {},
  Stack: {
    Screen: () => null,
    SearchBar: () => null,
    Toolbar: Object.assign(({ children }: { children: ReactNode }) => children, {
      Button: ({ onPress, children }: { onPress: () => void; children: ReactNode }) => (
        <button type="button" onClick={onPress}>
          {children}
        </button>
      ),
    }),
  },
}))
vi.mock('../client/mobile-pool', () => ({
  useMobilePoolProjection: (_read: unknown, fallback: unknown) => fallback,
  useMobilePool: () => null,
}))
vi.mock('../client/workspace-refresh', () => ({ useWorkspaceRefreshSubtitle: () => undefined }))
vi.mock('../components/list-row-press.ios', () => ({
  contentVisibility: (onChange: (visible: boolean) => void) => ({
    name: 'contentVisibility',
    value: onChange,
  }),
  listRowHairline: (value: unknown) => ({ name: 'podiumRowHairline', value }),
  listRowPress: (onOpen: () => void) => ({ name: 'listRowPress', value: onOpen }),
  listSearchStartsHidden: () => ({ name: 'podiumSearchStartsHidden' }),
}))
vi.mock('./WorkListRow', () => ({ NAV_LOADER_DELAY_MS: 0, useDelayedFlag: () => false }))
vi.mock('@expo/ui', () => ({ Host: ({ children }: { children: ReactNode }) => children }))
vi.mock('@expo/ui/swift-ui/modifiers', () => ({
  ...Object.fromEntries(
    `accessibilityAddTraits accessibilityElement accessibilityHidden accessibilityHint accessibilityIdentifier
    accessibilityLabel accessibilityValue alignmentGuide animation background buttonStyle
    clipped contentShape controlSize disabled font foregroundStyle frame labelsHidden lineLimit listRowBackground listRowInsets
    listRowSeparator listRowSeparatorTint listSectionMargins listSectionSpacing listStyle
    monospacedDigit onAppear onDisappear onGeometryChange opacity pickerStyle refreshable
    scrollContentBackground tag tint`
      .split(/\s+/)
      .map((name) => [name, (value: unknown) => ({ name, value })]),
  ),
  Animation: { default: 'default' },
  shapes: { rectangle: () => ({}) },
}))
vi.mock('@expo/ui/swift-ui', () => {
  const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>
  return {
    Button: ({
      onPress,
      children,
      modifiers,
    }: {
      onPress: () => void
      children: ReactNode
      modifiers?: { name: string; value: unknown }[]
    }) => (
      <button
        type="button"
        aria-label={modifiers?.find((item) => item.name === 'accessibilityLabel')?.value as string}
        onClick={onPress}
      >
        {children}
      </button>
    ),
    ContextMenu: Object.assign(Box, { Trigger: Box, Items: () => null, Preview: () => null }),
    HStack: Box,
    Image: () => null,
    List: ({ children }: { children: ReactNode }) => <div data-testid="work-list">{children}</div>,
    Picker: Box,
    ProgressView: () => null,
    RNHostView: Box,
    Section: Box,
    Spacer: () => null,
    SwipeActions: Object.assign(Box, { Actions: () => null }),
    Text: Box,
    VStack: ({
      children,
      modifiers,
    }: {
      children?: ReactNode
      modifiers?: { name: string; value: unknown }[]
    }) => {
      const measure = modifiers?.find((modifier) => modifier.name === 'onGeometryChange')?.value as
        | ((frame: { width: number }) => void)
        | undefined
      useLayoutEffect(() => measure?.({ width: 358 }), [measure])
      return <Box>{children}</Box>
    },
  }
})
const { WorkSurface } = await import('./WorkSurface.ios')
const { default: WorkLayout } = await vi.importActual<{ default: () => ReactElement }>(
  '../../app/(tabs)/work/_layout.tsx',
)
afterEach(() => {
  cleanup()
  expect(activity.users).toBe(0)
  activity.route = null
  vi.clearAllMocks()
})

it('pauses the real native Work surface behind its sibling Rename prompt through the route layout', () => {
  const target = {
    issue: { id: 'task', seq: 1, title: 'Task', stage: 'in_progress', labels: [], deps: [] },
    lane: 'live',
    sessionCount: 0,
  } as unknown as WorkIssueMenuTarget
  const phone = {
    query: '',
    needle: '',
    lane: 'open',
    quietExpanded: false,
    quietSections: [],
    activeSections: [],
    counts: { open: 0, snoozed: 0, closed: 0 },
    otherLaneHits: { open: 0, snoozed: 0, closed: 0 },
  } as unknown as WorkSurfaceProps['phone']
  function WorkRoute() {
    const [rename, setRename] = useState(false)
    return (
      <>
        <WorkSurface
          phone={phone}
          collapsed={new Set()}
          scrollOffset={{ current: 0 }}
          returnOffset={0}
          pendingNav={null}
          onToggle={() => {}}
          onOpenIssue={() => {}}
          onOpenSession={() => {}}
          onMenu={() => {}}
          onAction={() => {}}
          onStatus={() => {}}
          onTuck={() => {}}
          refresh={
            { refreshing: false, onRefresh: () => {} } as unknown as WorkSurfaceProps['refresh']
          }
          bottomInset={0}
          loading={false}
          notices={
            <>
              <WorkingMark />
              <button type="button" onClick={() => setRename(true)}>
                Rename row
              </button>
            </>
          }
        />
        {rename ? (
          <WorkIssueMenu
            target={target}
            initialSheet={{ kind: 'rename' }}
            onClose={() => setRename(false)}
          />
        ) : null}
      </>
    )
  }
  activity.route = <WorkRoute />
  render(<WorkLayout />)
  expect(activity.users).toBe(1)
  fireEvent.click(screen.getByRole('button', { name: 'Rename row' }))
  expect(screen.getByRole('textbox', { name: 'Rename task' })).toBeTruthy()
  expect(activity.users).toBe(0)
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(activity.users).toBe(1)
})

it('opens the tapped project from the real Work project header on the first and subsequent taps', () => {
  const phone = {
    query: '',
    needle: '',
    lane: 'open',
    quietExpanded: false,
    quietSections: [],
    activeSections: ['alpha', 'beta'].map((name) => ({
      key: name,
      label: name,
      repoPath: `/repo/${name}`,
      ids: [],
    })),
    counts: { open: 0, snoozed: 0, closed: 0 },
    otherLaneHits: { open: 0, snoozed: 0, closed: 0 },
  } as unknown as WorkSurfaceProps['phone']
  render(
    <WorkSurface
      phone={phone}
      collapsed={new Set()}
      scrollOffset={{ current: 0 }}
      returnOffset={0}
      pendingNav={null}
      onToggle={vi.fn()}
      onOpenIssue={vi.fn()}
      onOpenSession={vi.fn()}
      onMenu={vi.fn()}
      onAction={vi.fn()}
      onStatus={vi.fn()}
      onTuck={vi.fn()}
      refresh={{ refreshing: false, onRefresh: vi.fn() } as unknown as WorkSurfaceProps['refresh']}
      bottomInset={0}
      notices={
        <NoticeLayout>
          <button type="button">Offline Settings</button>
        </NoticeLayout>
      }
      loading={false}
    />,
  )
  expect(within(screen.getByTestId('work-list')).getByText('Offline Settings')).toBeTruthy()
  for (const project of ['beta', 'alpha', 'beta']) {
    fireEvent.click(screen.getByRole('button', { name: `New work in ${project}` }))
    expect(navigation.push).toHaveBeenLastCalledWith({
      pathname: '/new-issue',
      params: { backTo: '/work', repoPath: `/repo/${project}` },
    })
  }
  fireEvent.click(screen.getByRole('button', { name: 'New work' }))
  expect(navigation.push).toHaveBeenLastCalledWith({
    pathname: '/new-issue',
    params: { backTo: '/work' },
  })
})
