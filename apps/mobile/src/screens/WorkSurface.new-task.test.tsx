import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { type ReactNode, useLayoutEffect } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { NoticeLayout } from '../components/notice-layout'
import type { WorkSurfaceProps } from './WorkSurface.types'

const navigation = vi.hoisted(() => ({ push: vi.fn() }))
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
}))
vi.mock('../client/workspace-refresh', () => ({ useWorkspaceRefreshSubtitle: () => undefined }))
vi.mock('./WorkListRow', () => ({ NAV_LOADER_DELAY_MS: 0, useDelayedFlag: () => false }))
vi.mock('@expo/ui', () => ({ Host: ({ children }: { children: ReactNode }) => children }))
vi.mock('@expo/ui/swift-ui/modifiers', () => ({
  ...Object.fromEntries(
    `accessibilityAddTraits accessibilityElement accessibilityHidden accessibilityHint accessibilityIdentifier
    accessibilityLabel accessibilityValue alignmentGuide animation background buttonStyle
    clipped contentShape disabled font foregroundStyle frame lineLimit listRowBackground listRowInsets
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
    ContextMenu: Object.assign(Box, { Trigger: Box, Items: () => null }),
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
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
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
