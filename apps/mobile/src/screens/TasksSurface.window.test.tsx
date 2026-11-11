import { attachMobileScreens } from '@podium/client-graph/mobile-screens'
import { MOBILE_SCREEN_SUMMARIES } from '@podium/client-graph/mobile-screens-schema'
import { MOBILE_TASK_WINDOW_SIZE, MobileTasksBoard } from '@podium/client-graph/mobile-tasks'
import { MobxPool } from '@podium/client-graph/pool'
import { type Worklist, worklistView } from '@podium/client-graph/worklist/view-model'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { TasksSurfaceProps } from './TasksSurface.types'
import type { WorkSurfaceProps } from './WorkSurface.types'

const state = vi.hoisted(() => ({
  pool: null as MobxPool | null,
  slot: vi.fn(),
  list: vi.fn(),
  folded: false,
  toggleFold: vi.fn(),
  work: null as Worklist | null,
  age: vi.fn(() => Date.parse('2026-10-03T12:00:00Z')),
}))
vi.mock('../client/mobile-pool', () => ({
  useMobilePool: () => state.pool,
  useMobilePoolProjection: (_read: unknown, fallback: unknown) => fallback,
}))
vi.mock('@podium/client-graph/react', async (original) => ({
  ...(await original<object>()),
  useWorklistModel: () => state.work,
}))
vi.mock('../components/NewWorkButton', () => ({ NewWorkButton: () => null }))
vi.mock('./WorkListRow', () => ({ NAV_LOADER_DELAY_MS: 0, useDelayedFlag: () => false }))
vi.mock('../lib/clock-hooks', () => ({ useAgeNow: state.age }))
vi.mock('../hooks/useRefreshableTab', () => ({ MIN_REFRESH_CONFIRMATION_MS: 0 }))
vi.mock('expo-router', () => ({
  Stack: {
    Screen: () => null,
    SearchBar: () => null,
    Toolbar: Object.assign(() => null, { Button: () => null }),
  },
  useFocusEffect: () => {},
}))
vi.mock('../components/Screen', () => ({
  Screen: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock('../components/NativeGroupHeader.ios', () => ({
  NativeGroupHeader: ({ onToggle, title }: { onToggle: () => void; title: string }) => (
    <button type="button" data-testid="group-header" onClick={onToggle}>
      {title}
    </button>
  ),
}))
vi.mock('../components/RefreshOffer', () => ({ RefreshOffer: () => null }))
vi.mock('../components/StorageNoticeAlert', () => ({ StorageNoticeAlert: () => null }))
vi.mock('./tasks-folds', () => ({
  useStageFolds: () =>
    Object.fromEntries(
      ['in_progress', 'review', 'planning', 'backlog', 'proposed', 'done'].map((stage) => [
        stage,
        [state.folded, state.toggleFold],
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
      'accessibilityValue',
      'disabled',
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
    if (appear) state.slot()
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
    List: ({ children }: Props) => {
      state.list()
      return <Box>{children}</Box>
    },
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
const { WorkSurface } = await import('./WorkSurface.ios')
afterEach(() => {
  cleanup()
  state.pool?.dispose()
  state.pool = null
  state.age.mockClear()
  state.slot.mockClear()
  state.list.mockClear()
  state.toggleFold.mockClear()
  state.folded = false
  state.work = null
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
  state.slot.mockClear()
  state.list.mockClear()
  act(() => {
    fireEvent.mouseEnter(slots[151]!)
    fireEvent.mouseLeave(slots[150]!)
  })
  expect(state.slot).toHaveBeenCalledTimes(2)
  expect(state.list).not.toHaveBeenCalled()
  act(() => {
    fireEvent.mouseLeave(slots[151]!)
    fireEvent.mouseEnter(slots[0]!)
  })
  expect(screen.getByText('Task 0')).toBeTruthy()
  expect(screen.getAllByText(/^Task \d+$/)).toHaveLength(MOBILE_TASK_WINDOW_SIZE)
  act(() => fireEvent.mouseLeave(slots[0]!))
  expect(screen.queryAllByText(/^Task \d+$/)).toHaveLength(0)
  // Search temporarily reveals hits in saved folded groups; clearing restores the fold.
  state.folded = true
  act(() => board.search('Task 150'))
  const hit = screen.getByTestId('slot')
  act(() => fireEvent.mouseEnter(hit))
  expect(screen.getByText('Task 150')).toBeTruthy()
  fireEvent.click(screen.getByTestId('group-header'))
  expect(state.toggleFold).not.toHaveBeenCalled()
  act(() => board.search(''))
  expect(screen.queryAllByTestId('slot')).toHaveLength(0)
  fireEvent.click(screen.getByTestId('group-header'))
  expect(state.toggleFold).toHaveBeenCalledTimes(1)
})

it('Work keeps its native list and unchanged slots quiet during a one-row scroll', async () => {
  const stamp = '2026-10-03T12:00:00Z'
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
  state.pool = pool
  pool.apply({
    type: 'replace',
    rows: [
      { kind: 'repo', id: 'repo', value: { id: 'repo', repoPath: '/fixture', prefix: 'POD' } },
      ...Array.from({ length: 200 }, (_, index) => ({
        kind: 'issue' as const,
        id: `work-${index}`,
        value: {
          id: `work-${index}`,
          seq: index + 1,
          title: `Work ${index}`,
          stage: 'in_progress',
          audience: 'human',
          repoId: 'repo',
          repoPath: '/fixture',
          createdAt: stamp,
          updatedAt: stamp,
        },
      })),
    ],
  })
  await attachMobileScreens(pool)
  state.work = worklistView(pool)
  render(
    <WorkSurface
      {...({
        mode: 'search',
        phone: state.work.phone,
        collapsed: new Set(),
        refresh: { onRefresh: () => {} },
        loading: false,
        pendingNav: null,
      } as unknown as WorkSurfaceProps)}
    />,
  )
  const slots = screen.getAllByTestId('slot')
  expect(slots).toHaveLength(200)
  act(() => fireEvent.mouseEnter(slots[30]!))
  expect(screen.getAllByText(/^Work \d+$/)).toHaveLength(MOBILE_TASK_WINDOW_SIZE)
  state.slot.mockClear()
  state.list.mockClear()
  act(() => {
    fireEvent.mouseEnter(slots[31]!)
    fireEvent.mouseLeave(slots[30]!)
  })
  expect(state.slot).toHaveBeenCalledTimes(2)
  expect(state.list).not.toHaveBeenCalled()
  expect(screen.getAllByText(/^Work \d+$/)).toHaveLength(MOBILE_TASK_WINDOW_SIZE)
})
