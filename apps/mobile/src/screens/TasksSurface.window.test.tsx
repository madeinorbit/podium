import { attachMobileScreens } from '@podium/client-graph/mobile-screens'
import { MOBILE_SCREEN_SUMMARIES } from '@podium/client-graph/mobile-screens-schema'
import { MOBILE_TASK_WINDOW_SIZE, MobileTasksBoard } from '@podium/client-graph/mobile-tasks'
import { MobxPool } from '@podium/client-graph/pool'
import { type Worklist, worklistView } from '@podium/client-graph/worklist/view-model'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { type ReactNode, useEffect } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ScreenAction } from '../components/screen-actions'
import { ROW_PRIME_MS } from '../lib/use-row-prime'
import type { TasksSurfaceProps } from './TasksSurface.types'
import type { WorkSurfaceProps } from './WorkSurface.types'

const state = vi.hoisted(() => ({
  pool: null as MobxPool | null,
  fontScale: 1,
  header: {} as { headerTransparent?: boolean },
  actions: [] as readonly ScreenAction[],
  slot: vi.fn(),
  list: vi.fn(),
  listMount: vi.fn(),
  search: null as {
    onChangeText: (event: { nativeEvent: { text: string } }) => void
    onCancelButtonPress: () => void
  } | null,
  folded: false,
  toggleFold: vi.fn(),
  work: null as Worklist | null,
  age: vi.fn(() => Date.parse('2026-10-03T12:00:00Z')),
}))
vi.mock('react-native', async (original) => ({
  ...(await original<object>()),
  useWindowDimensions: () => ({ width: 390, height: 844, scale: 3, fontScale: state.fontScale }),
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
    Screen: ({ options }: { options: typeof state.header }) => {
      state.header = options
      return null
    },
    SearchBar: (props: NonNullable<typeof state.search>) => {
      state.search = props
      return null
    },
    Toolbar: Object.assign(() => null, { Button: () => null }),
  },
  useFocusEffect: () => {},
}))
vi.mock('../components/Screen', () => ({
  Screen: ({
    children,
    actions = [],
  }: {
    children: ReactNode
    actions?: readonly ScreenAction[]
  }) => {
    state.actions = actions
    return <div>{children}</div>
  },
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
  Host: ({ children }: { children: ReactNode }) => <div data-testid="native-host">{children}</div>,
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
      'animation',
      'background',
      'buttonStyle',
      'clipped',
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
      'opacity',
      'padding',
      'pickerStyle',
      'refreshable',
      'scrollContentBackground',
      'tag',
      'tint',
    ]
      .map((name) => [
        name,
        (value: unknown, offset?: number) => ({
          name,
          value,
          ...(offset === undefined ? {} : { offset }),
        }),
      ])
      .concat([
        ['shapes', { rectangle: () => ({}) }] as never,
        ['Animation', { default: 'default' }] as never,
      ]),
  ),
)
vi.mock('@expo/ui/swift-ui', () => {
  type Props = { children?: ReactNode; modifiers?: { name: string; value: unknown }[] }
  const Box = ({ children, modifiers }: Props) => (
    <div data-modifiers={JSON.stringify(modifiers)}>{children}</div>
  )
  const VStack = ({ children, modifiers }: Props) => {
    const appear = modifiers?.find((m) => m.name === 'onAppear')?.value as (() => void) | undefined
    const disappear = modifiers?.find((m) => m.name === 'onDisappear')?.value as
      | (() => void)
      | undefined
    if (appear) state.slot(modifiers)
    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: mouse events stand in for native appearance callbacks in this test host.
      <div
        data-testid={appear ? 'slot' : undefined}
        data-modifiers={JSON.stringify(modifiers)}
        onMouseEnter={appear}
        onMouseLeave={disappear}
      >
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
      useEffect(() => {
        state.listMount()
      }, [])
      state.list()
      return <Box>{children}</Box>
    },
    Picker: Box,
    ProgressView: () => null,
    Section: ({ children }: Props) => <section>{children}</section>,
    Spacer: Box,
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
  state.fontScale = 1
  state.actions = []
  state.age.mockClear()
  state.slot.mockClear()
  state.list.mockClear()
  state.listMount.mockClear()
  state.search = null
  state.toggleFold.mockClear()
  state.folded = false
  state.work = null
})

/** Freshly mounted rows draw themselves for ROW_PRIME_MS, then the viewport window rules. */
const lapsePrime = () =>
  act(() => new Promise<void>((resolve) => setTimeout(resolve, ROW_PRIME_MS + 20)))

it('Tasks aligns nested separators, pads scalable content and keeps cell traits outside slot observers', async () => {
  const stamp = '2026-10-03T12:00:00Z'
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
  state.pool = pool
  pool.apply({
    type: 'replace',
    rows: [
      {
        kind: 'issue',
        id: 'task',
        value: {
          id: 'task',
          seq: 1,
          title: 'Single task',
          stage: 'in_progress',
          audience: 'human',
          repoPath: '/fixture',
          createdAt: stamp,
          updatedAt: stamp,
        },
      },
      ...['child', 'grandchild'].map((id, index) => ({
        kind: 'issue' as const,
        id,
        value: {
          id,
          seq: index + 2,
          title: id,
          parentId: index === 0 ? 'task' : 'child',
          stage: 'in_progress',
          audience: 'human',
          repoPath: '/fixture',
          createdAt: stamp,
          updatedAt: stamp,
        },
      })),
    ],
  })
  await attachMobileScreens(pool)
  const board = new MobileTasksBoard(pool, {
    showDone: true,
    expanded: ['task', 'child'],
    filter: {},
    ordering: 'priority',
    showAgentTasks: false,
  })
  const onNewTask = vi.fn()
  const props = {
    board,
    chips: [],
    booting: false,
    refresh: { onRefresh: () => {} },
    minimizeOnScroll: {},
    bottomInset: 0,
    onNewTask,
    onFilters: vi.fn(),
  } as unknown as TasksSurfaceProps
  const view = render(<TasksSurface {...props} />)
  const slots = screen.getAllByTestId('slot')
  const slot = slots[0]
  if (!slot) throw new Error('Expected a task slot')
  expect(slots).toHaveLength(3)
  const host = screen.getByTestId('native-host')
  expect(host.parentElement?.firstElementChild).toBe(host)
  const modifiers = (node: Element | null) => {
    if (!node) throw new Error('Expected a native view')
    return JSON.parse(node.getAttribute('data-modifiers') ?? '[]')
  }
  const cellTraits = modifiers(slot).slice(-4)
  expect(slot.parentElement?.tagName).toBe('SECTION')
  expect(cellTraits).toEqual([
    { name: 'alignmentGuide', value: 'listRowSeparatorLeading', offset: 22 },
    { name: 'listRowBackground', value: expect.any(String) },
    { name: 'listRowSeparatorTint', value: expect.any(String) },
    // The card's first row keeps 8pt more room against the rounded corners.
    { name: 'listRowInsets', value: { leading: 12, trailing: 12, top: 8, bottom: 0 } },
  ])
  for (const [depth, nestedSlot] of slots.entries()) {
    expect(modifiers(nestedSlot)).toContainEqual({
      name: 'alignmentGuide',
      value: 'listRowSeparatorLeading',
      offset: 22 + depth * 16,
    })
  }
  // A freshly mounted row draws itself; the placeholder returns once the prime lapses.
  expect(screen.getByText('Single task')).toBeTruthy()
  await lapsePrime()
  expect(modifiers(slot.firstElementChild)).toContainEqual({
    name: 'frame',
    value: { height: 44 },
  })
  act(() => fireEvent.mouseEnter(slot))
  expect(modifiers(slot).slice(-4)).toEqual(cellTraits)
  expect(modifiers(screen.getByText('Single task').parentElement).slice(0, 2)).toEqual([
    { name: 'padding', value: { vertical: 6 } },
    { name: 'frame', value: expect.objectContaining({ minHeight: 44, alignment: 'leading' }) },
  ])
  // Cell traits belong to the outer slot, above swipe and context-menu wrappers.
  for (const child of slot.querySelectorAll('[data-modifiers]')) {
    expect(
      modifiers(child).some((modifier: { name: string }) => modifier.name.startsWith('listRow')),
    ).toBe(false)
  }
  const monoSizes = () =>
    [...slot.querySelectorAll('[data-modifiers]')].flatMap((child) =>
      modifiers(child)
        .filter(
          (modifier: { name: string; value?: { design?: string } }) =>
            modifier.name === 'font' && modifier.value?.design === 'monospaced',
        )
        .map((modifier: { value: { size: number } }) => modifier.value.size),
    )
  expect(monoSizes()).toEqual([11, 12])
  expect(state.actions.map((action) => action.label)).toEqual(['Filter and display', 'New task'])
  state.fontScale = 2
  view.rerender(<TasksSurface {...props} chips={[]} />)
  expect(monoSizes()).toEqual([22, 24])
  expect(state.actions).toHaveLength(1)
  expect(state.actions[0]?.label).toBe('Task actions')
  const newTask = state.actions[0]?.items?.find((item) => item.label === 'New task')
  expect(newTask).toBeDefined()
  newTask?.onPress()
  expect(onNewTask).toHaveBeenCalledOnce()
  // A taller measured row keeps its height when it leaves the active window.
  const rootModifiers = state.slot.mock.calls.findLast(([modifiers]) =>
    modifiers.some(
      (modifier: { name: string; offset?: number }) =>
        modifier.name === 'alignmentGuide' && modifier.offset === 22,
    ),
  )?.[0]
  const measured = rootModifiers.find(
    (modifier: { name: string }) => modifier.name === 'onGeometryChange',
  ).value
  act(() => measured({ height: 60 }))
  act(() => fireEvent.mouseLeave(slot))
  expect(modifiers(slot.firstElementChild)).toContainEqual({
    name: 'frame',
    value: { height: 60 },
  })
  expect(modifiers(slot).slice(-4)).toEqual(cellTraits)
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
  // The first window draws on mount, then hands over to the viewport window.
  expect(screen.getAllByText(/^Task \d+$/)).toHaveLength(MOBILE_TASK_WINDOW_SIZE)
  await lapsePrime()
  expect(screen.queryAllByText(/^Task \d+$/)).toHaveLength(0)
  state.age.mockClear()
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
  // Cancel resets the native list even when UIKit clears the text first.
  act(() => state.search?.onChangeText({ nativeEvent: { text: 'Task 150' } }))
  const mounts = state.listMount.mock.calls.length
  act(() => state.search?.onChangeText({ nativeEvent: { text: '' } }))
  expect(state.listMount).toHaveBeenCalledTimes(mounts)
  act(() => state.search?.onCancelButtonPress())
  expect(state.listMount).toHaveBeenCalledTimes(mounts + 1)
  expect(board.query).toBe('')
  expect(screen.queryAllByTestId('slot')).toHaveLength(0)
  act(() => state.search?.onCancelButtonPress())
  expect(state.listMount).toHaveBeenCalledTimes(mounts + 2)
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
  const props = {
    mode: 'search',
    phone: state.work.phone,
    collapsed: new Set(),
    refresh: { onRefresh: () => {} },
    loading: false,
    pendingNav: null,
  } as unknown as WorkSurfaceProps
  const view = render(<WorkSurface {...props} />)
  const slots = screen.getAllByTestId('slot')
  expect(slots).toHaveLength(200)
  expect(state.header.headerTransparent).toBe(true)
  const host = screen.getByTestId('native-host')
  expect(host.parentElement?.firstElementChild).toBe(host)
  await lapsePrime()
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

  // Measured content precedes outer cell insets, so a placeholder never
  // grows by another 16pt on each disappearance/reappearance.
  const mods = JSON.parse(slots[31]!.getAttribute('data-modifiers')!)
  expect(mods.findIndex((m: { name: string }) => m.name === 'onGeometryChange')).toBeLessThan(
    mods.findIndex((m: { name: string }) => m.name === 'listRowInsets'),
  )

  // Search and Work share the phone model. Late disappearance from one
  // presentation must not blank the other presentation's on-screen rows.
  const rowText = slots[31]!.textContent
  expect(rowText).toMatch(/^Work \d/)
  const other = render(<WorkSurface {...props} mode="tab" />)
  const otherSlots = other.container.querySelectorAll('[data-testid="slot"]')
  act(() => fireEvent.mouseEnter(otherSlots[31]!))
  act(() => fireEvent.mouseLeave(slots[31]!))
  expect(otherSlots[31]?.textContent).toBe(rowText)
  view.unmount()
  expect(otherSlots[31]?.textContent).toBe(rowText)
  other.unmount()
  expect(state.work.phone.activeSections[0]?.window.visibleRows).toHaveLength(0)
})
