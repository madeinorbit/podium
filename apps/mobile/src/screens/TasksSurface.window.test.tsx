import { attachMobileScreens } from '@podium/client-graph/mobile-screens'
import { MOBILE_SCREEN_SUMMARIES } from '@podium/client-graph/mobile-screens-schema'
import { MOBILE_TASK_WINDOW_SIZE, MobileTasksBoard } from '@podium/client-graph/mobile-tasks'
import { MobxPool } from '@podium/client-graph/pool'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { TasksSurfaceProps } from './TasksSurface.types'

const state = vi.hoisted(() => ({
  pool: null as MobxPool | null,
  age: vi.fn(() => Date.parse('2026-10-03T12:00:00Z')),
}))
vi.mock('../client/mobile-pool', () => ({ useMobilePool: () => state.pool }))
vi.mock('../lib/clock-hooks', () => ({ useAgeNow: state.age }))
vi.mock('../hooks/useRefreshableTab', () => ({ MIN_REFRESH_CONFIRMATION_MS: 0 }))
vi.mock('expo-router', () => ({ Stack: { SearchBar: () => null } }))
vi.mock('../components/Screen', () => ({
  Screen: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock('../components/NativeGroupHeader.ios', () => ({ NativeGroupHeader: () => null }))
vi.mock('../components/RefreshOffer', () => ({ RefreshOffer: () => null }))
vi.mock('../components/StorageNoticeAlert', () => ({ StorageNoticeAlert: () => null }))
vi.mock('./tasks-folds', () => ({
  useStageFolds: () =>
    Object.fromEntries(
      ['in_progress', 'review', 'planning', 'backlog', 'proposed', 'done'].map((stage) => [
        stage,
        [false, () => {}],
      ]),
    ),
}))
vi.mock('@expo/ui', () => ({
  Host: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock('@expo/ui/swift-ui/modifiers', () =>
  Object.fromEntries(
    [
      'accessibilityElement',
      'accessibilityHidden',
      'accessibilityHint',
      'accessibilityIdentifier',
      'accessibilityLabel',
      'alignmentGuide',
      'background',
      'buttonStyle',
      'contentShape',
      'font',
      'foregroundStyle',
      'frame',
      'lineLimit',
      'listRowBackground',
      'listRowInsets',
      'listRowSeparator',
      'listRowSeparatorTint',
      'listSectionMargins',
      'listSectionSpacing',
      'listStyle',
      'monospacedDigit',
      'onAppear',
      'onDisappear',
      'onGeometryChange',
      'pickerStyle',
      'refreshable',
      'scrollContentBackground',
      'tag',
      'tint',
    ]
      .map((name) => [name, (value: unknown) => ({ name, value })])
      .concat([['shapes', { rectangle: () => ({}) }] as never]),
  ),
)
vi.mock('@expo/ui/swift-ui', () => {
  type Props = { children?: ReactNode; modifiers?: { name: string; value: unknown }[] }
  const Box = ({ children }: Props) => <div>{children}</div>
  const VStack = ({ children, modifiers }: Props) => {
    const appear = modifiers?.find((m) => m.name === 'onAppear')?.value as (() => void) | undefined
    const disappear = modifiers?.find((m) => m.name === 'onDisappear')?.value as
      | (() => void)
      | undefined
    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: mouse events stand in for native appearance callbacks in this test host.
      <div data-testid={appear ? 'slot' : undefined} onMouseEnter={appear} onMouseLeave={disappear}>
        {children}
      </div>
    )
  }
  return {
    Button: Box,
    ContextMenu: Object.assign(Box, { Trigger: Box, Items: () => null }),
    HStack: Box,
    Image: () => null,
    List: Box,
    Picker: Box,
    ProgressView: () => null,
    Section: Box,
    Spacer: () => null,
    SwipeActions: Object.assign(Box, { Actions: () => null }),
    Text: Box,
    VStack,
  }
})
const { TasksSurface } = await import('./TasksSurface.ios')
afterEach(() => {
  cleanup()
  state.pool?.dispose()
  state.pool = null
  state.age.mockClear()
})

it('native placeholders activate a bounded window both ways; only age labels read the clock', async () => {
  const stamp = '2026-10-03T12:00:00Z'
  const rows = Array.from({ length: 200 }, (_, index) => ({
    kind: 'issue' as const,
    id: `task-${index}`,
    value: {
      id: `task-${index}`,
      seq: index,
      title: `Task ${index}`,
      type: 'task',
      stage: 'in_progress',
      priority: 2,
      audience: 'human',
      repoPath: '/fixture',
      deps: [],
      createdAt: stamp,
      updatedAt: stamp,
      ...(index === 199 ? { parentId: 'task-0' } : {}),
    },
  }))
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) }, undefined, {
    summaries: MOBILE_SCREEN_SUMMARIES,
    load: (kind, id) => rows.find((row) => row.kind === kind && row.id === id)?.value,
  })
  state.pool = pool
  pool.apply({ type: 'replace', rows })
  await attachMobileScreens(pool)
  const board = new MobileTasksBoard(pool, {
    showDone: true,
    expanded: [],
    filter: {},
    ordering: 'priority',
    showAgentTasks: false,
  })
  render(
    <TasksSurface
      {...({
        board,
        chips: [],
        booting: false,
        refresh: { onRefresh: () => {} },
        minimizeOnScroll: {},
        bottomInset: 0,
      } as unknown as TasksSurfaceProps)}
    />,
  )
  const slots = screen.getAllByTestId('slot')
  expect(slots).toHaveLength(199)
  expect(screen.queryAllByText(/^Task \d+$/)).toHaveLength(0)
  act(() => fireEvent.mouseEnter(slots[0]!))
  expect(screen.getAllByText(/^Task \d+$/)).toHaveLength(MOBILE_TASK_WINDOW_SIZE)
  // Task 0 has a progress label, so it must not subscribe to age.
  expect(state.age).toHaveBeenCalledTimes(MOBILE_TASK_WINDOW_SIZE - 1)
  act(() => {
    fireEvent.mouseLeave(slots[0]!)
    fireEvent.mouseEnter(slots[150]!)
  })
  expect(screen.getAllByText(/^Task \d+$/)).toHaveLength(MOBILE_TASK_WINDOW_SIZE)
  expect(screen.queryByText('Task 0')).toBeNull()
  act(() => {
    fireEvent.mouseLeave(slots[150]!)
    fireEvent.mouseEnter(slots[0]!)
  })
  expect(screen.getByText('Task 0')).toBeTruthy()
  expect(screen.getAllByText(/^Task \d+$/)).toHaveLength(MOBILE_TASK_WINDOW_SIZE)
  act(() => fireEvent.mouseLeave(slots[0]!))
  expect(screen.queryAllByText(/^Task \d+$/)).toHaveLength(0)
})
