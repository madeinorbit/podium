import { attachMobileScreens } from '@podium/client-graph/mobile-screens'
import { MOBILE_SCREEN_SUMMARIES } from '@podium/client-graph/mobile-screens-schema'
import { MOBILE_TASK_WINDOW_SIZE, MobileTasksBoard } from '@podium/client-graph/mobile-tasks'
import { MobxPool } from '@podium/client-graph/pool'
import { type Worklist, worklistView } from '@podium/client-graph/worklist/view-model'
import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react'
import { type ReactNode, useEffect, useImperativeHandle } from 'react'
import type { SearchBarCommands, SearchBarProps } from 'react-native-screens'
import { afterEach, expect, it, vi } from 'vitest'
import type { ScreenAction, ScreenMenuItem } from '../components/screen-actions'
import { useIssueRowActions } from '../lib/issue-row-actions'
import { ROW_PRIME_MS } from '../lib/use-row-prime'
import type { TasksSurfaceProps } from './TasksSurface.types'
import type { WorkSurfaceProps } from './WorkSurface.types'

const state = vi.hoisted(() => ({
  pool: null as MobxPool | null,
  fontScale: 1,
  header: {} as { headerTransparent?: boolean },
  actions: [] as readonly ScreenAction[],
  slot: vi.fn(),
  measure: vi.fn(),
  list: vi.fn(),
  listMount: vi.fn(),
  search: null as SearchBarProps | null,
  setSearchText: vi.fn(),
  folded: false,
  toggleFold: vi.fn(),
  work: null as Worklist | null,
  age: vi.fn(() => Date.parse('2026-10-03T12:00:00Z')),
  showActions: false,
  setIssueTucked: vi.fn(async (_id: string, _tucked: boolean) => {}),
}))
vi.mock('../client/hooks', () => ({
  useStoreActions: () => ({ setIssueTucked: state.setIssueTucked }),
}))
vi.mock('../client/use-issue-close', () => ({ useIssueCloseGuard: () => () => false }))
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
vi.mock('../components/list-row-press.ios', () => ({
  listRowPress: (onOpen: () => void) => ({ name: 'podiumListRowPress', value: onOpen }),
  listSearchStartsHidden: () => ({ name: 'podiumSearchStartsHidden' }),
}))
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
      useImperativeHandle(
        props.ref,
        (): SearchBarCommands => ({
          setText: state.setSearchText,
          focus: () => {},
          blur: () => {},
          clearText: () => {},
          cancelSearch: () => {},
          toggleCancelButton: () => {},
        }),
      )
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
// Continuity behavior is covered by its pool and native-row tests, outside list windowing.
vi.mock('../components/WorkspaceContinuityNotice', () => ({
  WorkspaceContinuityNotice: () => null,
}))
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
      'accessibilityAddTraits',
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
  // The row modifier wraps its label stack in the native Button (podium-list-row).
  const RowButton = ({ children, modifiers }: Props) => (
    <button
      type="button"
      aria-label={modifiers?.find((m) => m.name === 'accessibilityLabel')?.value as string}
      data-native-row="true"
      data-modifiers={JSON.stringify(modifiers)}
      onClick={modifiers?.find((m) => m.name === 'podiumListRowPress')?.value as () => void}
    >
      {children}
    </button>
  )
  const isRow = (modifiers: Props['modifiers']) =>
    Boolean(modifiers?.some((m) => m.name === 'podiumListRowPress'))
  const Box = ({ children, modifiers }: Props) =>
    isRow(modifiers) ? (
      <RowButton modifiers={modifiers}>{children}</RowButton>
    ) : (
      <div data-modifiers={JSON.stringify(modifiers)}>{children}</div>
    )
  const VStack = ({ children, modifiers }: Props) => {
    if (isRow(modifiers)) return <RowButton modifiers={modifiers}>{children}</RowButton>
    const appear = modifiers?.find((m) => m.name === 'onAppear')?.value as (() => void) | undefined
    const disappear = modifiers?.find((m) => m.name === 'onDisappear')?.value as
      | (() => void)
      | undefined
    if (appear) state.slot(modifiers)
    const measure = modifiers?.find((m) => m.name === 'onGeometryChange')?.value
    if (measure) state.measure(measure)
    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: mouse events stand in for native appearance callbacks in this test host.
      <div
        data-testid={appear ? 'slot' : measure ? 'measured-content' : undefined}
        data-modifiers={JSON.stringify(modifiers)}
        onMouseEnter={appear}
        onMouseLeave={disappear}
      >
        {children}
      </div>
    )
  }
  return {
    Button: ({
      children,
      modifiers,
      onPress,
      label,
      systemImage,
    }: Props & {
      onPress?: () => void
      label?: string
      systemImage?: string
    }) => (
      <button
        type="button"
        aria-label={modifiers?.find((m) => m.name === 'accessibilityLabel')?.value as string}
        data-modifiers={JSON.stringify(modifiers)}
        onClick={onPress}
        data-system-image={systemImage}
        disabled={modifiers?.some((m) => m.name === 'disabled' && m.value === true)}
      >
        {children ?? label}
      </button>
    ),
    ContextMenu: Object.assign(Box, {
      Trigger: Box,
      Items: ({ children }: Props) =>
        state.showActions ? <div data-testid="context-menu">{children}</div> : null,
    }),
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
    Menu: Box,
    Toggle: () => null,
    ProgressView: () => <div data-testid="native-progress" />,
    Section: ({ children }: Props) => <section>{children}</section>,
    Spacer: ({ modifiers }: Props) => {
      const value = modifiers?.find((m) => m.name === 'frame')?.value as
        | { height?: number }
        | undefined
      return (
        <div
          data-testid={value?.height === undefined ? undefined : 'row-placeholder'}
          data-height={value?.height}
        />
      )
    },
    SwipeActions: Object.assign(Box, {
      Actions: ({ children, allowsFullSwipe }: Props & { allowsFullSwipe: boolean }) =>
        state.showActions ? (
          <div data-testid="swipe-actions" data-full-swipe={String(allowsFullSwipe)}>
            {children}
          </div>
        ) : null,
    }),
    Text: Box,
    VStack,
  }
})
const { TasksSurface } = await import('./TasksSurface.ios')
const { WorkSurface } = await import('./WorkSurface.ios')

it.each([
  'snoozed',
  'closed',
] as const)('keeps one inset trait around the %s empty-state text', async (lane) => {
  const pool = new MobxPool({
    selectedIssueId: null,
    coarseNow: Date.parse('2026-10-03T12:00:00Z'),
  })
  state.pool = pool
  pool.apply({ type: 'replace', rows: [] })
  await attachMobileScreens(pool)
  state.work = worklistView(pool)
  const phone = state.work.phone
  phone.setLane(lane)
  render(
    <WorkSurface
      {...({
        phone,
        collapsed: new Set(),
        loading: false,
        pendingNav: null,
        refresh: { onRefresh: () => {} },
      } as unknown as WorkSurfaceProps)}
    />,
  )
  const label = screen.getByText(`No ${lane} tasks`)
  const row = label.parentElement
  const modifiers = JSON.parse(row?.getAttribute('data-modifiers') ?? '[]') as {
    name: string
    value: unknown
  }[]
  // Two nested listRowInsets traits let the zero-inset quiet-row policy win,
  // putting first/last-line glyphs against the rounded List cell's clip.
  expect(modifiers.filter((modifier) => modifier.name === 'listRowInsets')).toEqual([
    { name: 'listRowInsets', value: { leading: 12, trailing: 12, top: 8, bottom: 8 } },
  ])
  expect(row?.textContent).toContain(
    lane === 'closed'
      ? 'Tasks closed in the last 7 days appear here.'
      : 'Snoozed tasks will appear here until they return to Open.',
  )
})

afterEach(() => {
  cleanup()
  state.pool?.dispose()
  state.pool = null
  state.fontScale = 1
  state.actions = []
  state.age.mockClear()
  state.slot.mockClear()
  state.measure.mockClear()
  state.list.mockClear()
  state.listMount.mockClear()
  state.search = null
  state.setSearchText.mockClear()
  state.toggleFold.mockClear()
  state.folded = false
  state.work = null
  state.showActions = false
  state.setIssueTucked.mockReset()
})

const TUCK_STAMP = '2026-10-03T12:00:00Z'
const tuckIssue = (patch: Record<string, unknown> = {}) => ({
  id: 'tuckable',
  seq: 1,
  title: 'Finished task',
  stage: 'done',
  closedReason: 'done',
  closedAt: TUCK_STAMP,
  audience: 'human',
  repoId: 'repo',
  repoPath: '/fixture',
  createdAt: TUCK_STAMP,
  updatedAt: TUCK_STAMP,
  tuckedAt: null,
  ...patch,
})

async function tuckFixture(patch: Record<string, unknown> = {}) {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(TUCK_STAMP) })
  state.pool = pool
  const issue = tuckIssue(patch)
  pool.apply({
    type: 'replace',
    rows: [
      { kind: 'repo', id: 'repo', value: { id: 'repo', repoPath: '/fixture', prefix: 'POD' } },
      {
        kind: 'issue',
        id: 'parent',
        value: tuckIssue({
          id: 'parent',
          seq: 2,
          title: 'Parent',
          stage: 'in_progress',
          closedReason: null,
        }),
      },
      { kind: 'issue', id: issue.id, value: issue },
    ],
  })
  await attachMobileScreens(pool)
  state.work = worklistView(pool)
  const board = new MobileTasksBoard(pool, {
    showDone: true,
    expanded: ['parent'],
    filter: {},
    ordering: 'priority',
    showAgentTasks: true,
  })
  return { pool, issue, board }
}

function TuckSurface({
  tab,
  board,
  onError = () => {},
}: {
  tab: 'Work' | 'Tasks'
  board: MobileTasksBoard
  onError?: (message: string) => void
}) {
  const actions = useIssueRowActions({ openMenu: () => {}, onError })
  const common = { ...actions, refresh: { onRefresh: () => {} }, bottomInset: 0 }
  return tab === 'Work' ? (
    <WorkSurface
      {...({
        ...common,
        phone: state.work?.phone,
        collapsed: new Set(),
        loading: false,
        pendingNav: null,
      } as unknown as WorkSurfaceProps)}
    />
  ) : (
    <TasksSurface
      {...({ ...common, board, chips: [], booting: false } as unknown as TasksSurfaceProps)}
    />
  )
}

function actionHost(kind: 'swipe-actions' | 'context-menu', label: string) {
  const host = screen
    .getAllByTestId(kind)
    .find((element) => within(element).queryByRole('button', { name: label }))
  if (!host) throw new Error(`Expected ${label} in ${kind}`)
  return host
}

for (const tab of ['Work', 'Tasks'] as const) {
  it.each([
    'swipe',
    'menu',
  ] as const)(`${tab} Tuck %s calls the shared command and follows its fold`, async (gesture) => {
    const { pool, issue, board } = await tuckFixture()
    state.showActions = true
    render(<TuckSurface tab={tab} board={board} />)
    const row = pool.worklistRow(issue.id)
    if (!row) throw new Error('Expected the shared worklist row')
    expect(row.canTuck).toBe(true)
    const host = actionHost(gesture === 'swipe' ? 'swipe-actions' : 'context-menu', 'Tuck')
    const tuck = within(host).getByRole('button', { name: 'Tuck' })
    expect(tuck.dataset.systemImage).toBe('arrow.down.to.line')
    if (gesture === 'swipe') expect(host.dataset.fullSwipe).toBe('false')
    await act(async () => fireEvent.click(tuck))
    expect(state.setIssueTucked).toHaveBeenCalledExactlyOnceWith(issue.id, true)
    // The command's replicated result drives the existing shared fold, with no
    // local hidden-row list in either mobile surface.
    act(() =>
      pool.apply({
        type: 'update',
        rows: [{ kind: 'issue', id: issue.id, value: { ...issue, tuckedAt: TUCK_STAMP } }],
      }),
    )
    expect(row.canTuck).toBe(false)
    expect(screen.queryByRole('button', { name: 'Tuck' })).toBeNull()
    if (tab === 'Work') {
      expect(screen.queryByText(issue.title)).toBeNull()
      act(() => state.work?.phone.setLane('closed'))
    }
    // Tasks keeps explicit Show Done membership, just like the desktop board.
    expect(screen.getByText(issue.title)).toBeTruthy()
    const bringBack = within(actionHost('swipe-actions', 'Bring Back')).getByRole('button', {
      name: 'Bring Back',
    })
    await act(async () => fireEvent.click(bringBack))
    expect(state.setIssueTucked).toHaveBeenLastCalledWith(issue.id, false)
    act(() => pool.apply({ type: 'update', rows: [{ kind: 'issue', id: issue.id, value: issue }] }))
    if (tab === 'Work') act(() => state.work?.phone.setLane('open'))
    expect(screen.getByText(issue.title)).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Tuck' })).toHaveLength(2)
  })
}

it.each([
  ['open', { stage: 'in_progress', closedReason: null }],
  ['cancelled', { closedReason: 'cancelled' }],
  ['duplicate', { closedReason: 'duplicate' }],
  ['superseded', { closedReason: 'superseded' }],
  ['subtask', { parentId: 'parent' }],
  ['agent-only root', { audience: 'agent' }],
  ['needs attention', { needsHuman: true }],
  ['past grace', { closedAt: '2026-10-01T12:00:00Z' }],
  ['already tucked', { tuckedAt: TUCK_STAMP }],
] as const)('Tasks Tuck eligibility excludes %s using the desktop companion', async (_label, patch) => {
  const { pool, board } = await tuckFixture(patch)
  state.showActions = true
  render(<TuckSurface tab="Tasks" board={board} />)
  expect(screen.getByText('Finished task')).toBeTruthy()
  expect(pool.worklistRow('tuckable')?.canTuck).toBe(false)
  expect(screen.queryByRole('button', { name: 'Tuck' })).toBeNull()
  expect(state.setIssueTucked).not.toHaveBeenCalled()
})

it('Work Tuck never offers Bring Back past the desktop grace window', async () => {
  const { board } = await tuckFixture({ closedAt: '2026-10-01T12:00:00Z', tuckedAt: TUCK_STAMP })
  state.showActions = true
  state.work?.phone.setLane('closed')
  render(<TuckSurface tab="Work" board={board} />)
  expect(screen.queryByRole('button', { name: 'Bring Back' })).toBeNull()
  const menu = screen.getByRole<HTMLButtonElement>('button', { name: 'Bring Back from Closed' })
  expect(menu.disabled).toBe(true)
  fireEvent.click(menu)
  expect(state.setIssueTucked).not.toHaveBeenCalled()
})

it('Tuck dispatch rechecks the shared verdict for stale native menu callbacks', async () => {
  const { pool, issue } = await tuckFixture()
  const openMenu = vi.fn()
  const { result } = renderHook(() => useIssueRowActions({ openMenu, onError: vi.fn() }))
  act(() => result.current.onAction(issue.id, 'bringBack'))
  expect(state.setIssueTucked).not.toHaveBeenCalled()
  act(() =>
    pool.apply({
      type: 'update',
      rows: [{ kind: 'issue', id: issue.id, value: { ...issue, tuckedAt: TUCK_STAMP } }],
    }),
  )
  act(() => result.current.onAction(issue.id, 'tuck'))
  expect(state.setIssueTucked).not.toHaveBeenCalled()
  expect(openMenu).not.toHaveBeenCalled()
})

it('Tuck dispatch reports a refused shared command', async () => {
  const { issue } = await tuckFixture()
  const onError = vi.fn()
  state.setIssueTucked.mockRejectedValueOnce(new Error('Tuck refused'))
  const { result } = renderHook(() => useIssueRowActions({ openMenu: vi.fn(), onError }))
  await act(async () => result.current.onAction(issue.id, 'tuck'))
  expect(state.setIssueTucked).toHaveBeenCalledExactlyOnceWith(issue.id, true)
  expect(onError).toHaveBeenCalledExactlyOnceWith('Tuck refused')
})

/** Freshly mounted rows draw themselves for ROW_PRIME_MS, then the viewport window rules. */
const lapsePrime = () =>
  act(() => new Promise<void>((resolve) => setTimeout(resolve, ROW_PRIME_MS + 20)))

const changeSearchText = (text: string) =>
  state.search?.onChangeText?.({ nativeEvent: { text } } as Parameters<
    NonNullable<SearchBarProps['onChangeText']>
  >[0])

const cancelSearch = () =>
  state.search?.onCancelButtonPress?.(
    {} as Parameters<NonNullable<SearchBarProps['onCancelButtonPress']>>[0],
  )

it.each([
  'proposed',
  'in_progress',
])('caches only %s row content while preserving large-text heights on reuse', async (stage) => {
  const stamp = '2026-10-03T12:00:00Z'
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
  state.pool = pool
  pool.apply({
    type: 'replace',
    rows: Array.from({ length: MOBILE_TASK_WINDOW_SIZE * 3 }, (_, index) => ({
      kind: 'issue' as const,
      id: `task-${index}`,
      value: {
        id: `task-${index}`,
        seq: index + 1,
        title: `Reusable task ${index}`,
        stage,
        audience: 'human',
        repoPath: '/fixture',
        createdAt: stamp,
        updatedAt: stamp,
      },
    })),
  })
  await attachMobileScreens(pool)
  const board = new MobileTasksBoard(pool, {
    showDone: false,
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
      } as unknown as TasksSurfaceProps)}
    />,
  )
  const slots = screen.getAllByTestId('slot')
  const slot = slots[0]
  const distant = slots.at(-1)
  if (!slot || !distant) throw new Error('Expected a long lane')
  const traits = JSON.parse(slot.getAttribute('data-modifiers') ?? '[]') as { name: string }[]
  expect(traits.some((trait) => trait.name === 'onGeometryChange')).toBe(false)
  expect(within(slot).getByTestId('measured-content')).toBeTruthy()
  const measure = state.measure.mock.calls[0]?.[0] as
    | ((geometry: { height: number }) => void)
    | undefined
  if (!measure) throw new Error('Expected a content measurement callback')
  for (const height of [44, 104]) {
    act(() => measure({ height }))
    fireEvent.mouseEnter(slot)
    fireEvent.mouseLeave(slot)
    fireEvent.mouseEnter(distant)
    expect(within(slot).getByTestId('row-placeholder').dataset.height).toBe(String(height))
    expect(JSON.parse(slot.getAttribute('data-modifiers') ?? '[]')).toEqual(traits)
    fireEvent.mouseEnter(slot)
    fireEvent.mouseLeave(distant)
    expect(screen.getByText('Reusable task 0')).toBeTruthy()
  }
})

const expectPullDownSearch = () =>
  expect(state.search).toMatchObject({
    placement: 'stacked',
    hideWhenScrolling: true,
    allowToolbarIntegration: false,
    obscureBackground: false,
    placeholder: 'Search tasks or ID',
  })

it('keeps the native list rows unchanged when first-visit booting settles', async () => {
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
          title: 'First task',
          stage: 'in_progress',
          audience: 'human',
          repoPath: '/fixture',
          createdAt: stamp,
          updatedAt: stamp,
        },
      },
    ],
  })
  await attachMobileScreens(pool)
  const board = new MobileTasksBoard(pool, {
    showDone: false,
    expanded: [],
    filter: {},
    ordering: 'priority',
    showAgentTasks: false,
  })
  const props = {
    board,
    chips: [],
    booting: true,
    refresh: { onRefresh: () => {} },
  } as unknown as TasksSurfaceProps
  const view = render(<TasksSurface {...props} board={null} />)
  expect(screen.queryByTestId('native-progress')).toBeNull()
  view.rerender(<TasksSurface {...props} />)
  expect(screen.queryByTestId('native-progress')).toBeNull()
  expect(screen.getByText('First task')).toBeTruthy()
  const before = screen.getByTestId('native-host').innerHTML
  view.rerender(<TasksSurface {...props} booting={false} />)
  expect(screen.getByTestId('native-host').innerHTML).toBe(before)
  expect(state.listMount).toHaveBeenCalledOnce()
})

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
  const cellTraits = modifiers(slot).slice(-3)
  expect(slot.parentElement?.tagName).toBe('SECTION')
  // No custom listRowBackground: it would suppress the List's native touch-down
  // highlight (the system cell background has paper.card's exact values).
  expect(modifiers(slot).map((m: { name: string }) => m.name)).not.toContain('listRowBackground')
  expect(cellTraits).toEqual([
    { name: 'alignmentGuide', value: 'listRowSeparatorLeading', offset: 22 },
    { name: 'listRowSeparatorTint', value: expect.any(String) },
    // At default sizes the List minimum already pads the row: no extra edge,
    // so the first row centres like the middle rows.
    { name: 'listRowInsets', value: { leading: 12, trailing: 12, top: 0, bottom: 0 } },
  ])
  for (const [depth, nestedSlot] of slots.entries()) {
    expect(modifiers(nestedSlot)).toContainEqual({
      name: 'alignmentGuide',
      value: 'listRowSeparatorLeading',
      offset: 22 + depth * 16,
    })
  }
  // The row is there on first render, and stays once the prime lapses.
  expect(screen.getByText('Single task')).toBeTruthy()
  await lapsePrime()
  expect(screen.getByText('Single task')).toBeTruthy()
  act(() => fireEvent.mouseEnter(slot))
  expect(modifiers(slot).slice(-3)).toEqual(cellTraits)
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
  const swipeOwner = slot.firstElementChild
  const listMounts = state.listMount.mock.calls.length
  state.fontScale = 2
  view.rerender(<TasksSurface {...props} chips={[]} />)
  expect(slot.isConnected).toBe(true)
  expect(slot.firstElementChild).toBe(swipeOwner)
  expect(state.listMount).toHaveBeenCalledTimes(listMounts)
  expect(monoSizes()).toEqual([22, 24])
  // Accessibility sizes outgrow the minimum: the first row gets 8pt against the corners.
  const accessibleTraits = [
    cellTraits[0],
    cellTraits[1],
    { name: 'listRowInsets', value: { leading: 12, trailing: 12, top: 8, bottom: 0 } },
  ]
  expect(modifiers(slot).slice(-3)).toEqual(accessibleTraits)
  expect(state.actions).toHaveLength(1)
  expect(state.actions[0]?.label).toBe('Task actions')
  const newTask = state.actions[0]?.items?.find(
    (item): item is ScreenMenuItem => 'label' in item && item.label === 'New task',
  )
  expect(newTask).toBeDefined()
  newTask?.onPress()
  expect(onNewTask).toHaveBeenCalledOnce()
  const measured = state.measure.mock.calls[0]?.[0] as
    | ((geometry: { height: number }) => void)
    | undefined
  if (!measured) throw new Error('Expected a content measurement callback')
  act(() => measured({ height: 60 }))
  // A short lane never leaves the window: the row stays, not a placeholder.
  act(() => fireEvent.mouseLeave(slot))
  expect(screen.getByText('Single task')).toBeTruthy()
  expect(modifiers(slot).slice(-3)).toEqual(accessibleTraits)
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
  // Rows are there on first render, before any native cell reports appearing,
  // and the window keeps them once the prime lapses.
  expect(screen.getAllByText(/^Task \d+$/)).toHaveLength(MOBILE_TASK_WINDOW_SIZE)
  expect(screen.getByText('Task 0')).toBeTruthy()
  await lapsePrime()
  expect(screen.getAllByText(/^Task \d+$/)).toHaveLength(MOBILE_TASK_WINDOW_SIZE)
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
  // Every cell leaving (a hidden tab) keeps the window mounted for the return.
  act(() => fireEvent.mouseLeave(slots[0]!))
  expect(screen.getAllByText(/^Task \d+$/)).toHaveLength(MOBILE_TASK_WINDOW_SIZE)
  expect(screen.getByText('Task 0')).toBeTruthy()
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
  // UIKit may clear the text first. Neither event may replace its scroll view.
  expectPullDownSearch()
  act(() => changeSearchText('Task 150'))
  const mounts = state.listMount.mock.calls.length
  act(() => changeSearchText(''))
  expect(state.listMount).toHaveBeenCalledTimes(mounts)
  act(cancelSearch)
  expect(state.listMount).toHaveBeenCalledTimes(mounts)
  expect(board.query).toBe('')
  expect(screen.queryAllByTestId('slot')).toHaveLength(0)
  act(cancelSearch)
  expect(state.listMount).toHaveBeenCalledTimes(mounts)
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

  // Retained Work screens share the phone model. Late disappearance from one
  // presentation must not blank the other presentation's on-screen rows.
  const rowText = slots[31]!.textContent
  expect(rowText).toMatch(/^Work \d/)
  const other = render(<WorkSurface {...props} />)
  const otherSlots = other.container.querySelectorAll('[data-testid="slot"]')
  act(() => fireEvent.mouseEnter(otherSlots[31]!))
  act(() => fireEvent.mouseLeave(slots[31]!))
  expect(otherSlots[31]?.textContent).toBe(rowText)
  view.unmount()
  expect(otherSlots[31]?.textContent).toBe(rowText)
  other.unmount()
  // Unmount drops appearances; a remount starts from the top window again.
  expect(state.work.phone.activeSections[0]?.window.visibleRows).toHaveLength(
    MOBILE_TASK_WINDOW_SIZE,
  )
})

it.each([
  'Work',
  'Tasks',
] as const)('%s pull-down search uses its shared filter for titles and sub-task references, then Cancel restores the list', async (tab) => {
  const stamp = '2026-10-03T12:00:00Z'
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
  state.pool = pool
  pool.apply({
    type: 'replace',
    rows: [
      { kind: 'repo', id: 'repo', value: { id: 'repo', repoPath: '/fixture', prefix: 'POD' } },
      ...[
        { id: 'parent', seq: 1, title: 'Search parent' },
        { id: 'child', seq: 123, title: 'Nested task', parentId: 'parent' },
        { id: 'other', seq: 2, title: 'Other task' },
      ].map((issue) => ({
        kind: 'issue' as const,
        id: issue.id,
        value: {
          ...issue,
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
  const phone = state.work.phone
  const board = new MobileTasksBoard(pool, {
    showDone: false,
    expanded: [],
    filter: {},
    ordering: 'priority',
    showAgentTasks: false,
  })
  const common = {
    refresh: { onRefresh: () => {} },
    bottomInset: 0,
  }
  const onOpen = vi.fn()
  render(
    tab === 'Work' ? (
      <WorkSurface
        {...({
          ...common,
          phone,
          collapsed: new Set(),
          loading: false,
          pendingNav: null,
          onOpenIssue: onOpen,
          onOpenSession: onOpen,
        } as unknown as WorkSurfaceProps)}
      />
    ) : (
      <TasksSurface
        {...({
          ...common,
          board,
          chips: [],
          booting: false,
          onOpen,
        } as unknown as TasksSurfaceProps)}
      />
    ),
  )
  expectPullDownSearch()
  expect(state.listMount).toHaveBeenCalledOnce()
  // One native row Button per row: the podium-list-row modifier builds it around
  // the label, so press feedback, drags and assistive activation stay native.
  const openTarget = screen.getByRole('button', { name: /^Search parent\./ })
  expect(openTarget.getAttribute('data-native-row')).toBe('true')
  // VoiceOver reads the List Button from its label: accessibility goes inside.
  const rowModifiers = JSON.parse(openTarget.getAttribute('data-modifiers') ?? '[]').map(
    (m: { name: string }) => m.name,
  )
  expect(rowModifiers.at(-1)).toBe('podiumListRowPress')
  expect(rowModifiers).toContain('accessibilityLabel')
  fireEvent.click(openTarget)
  expect(onOpen).toHaveBeenCalledOnce()
  expect(screen.getByText('Other task')).toBeTruthy()
  for (const text of ['POD-123', 'pod 123', '#123', '123', 'nested task']) {
    act(() => changeSearchText(text))
    expect(screen.getByText('Search parent')).toBeTruthy()
    expect(screen.getByText('Nested task')).toBeTruthy()
    expect(screen.queryByText('Other task')).toBeNull()
    if (tab === 'Work') {
      expect(phone.query).toBe(text)
      expect(phone.childHit('parent')).toBe('child')
    } else expect(board.searchFilter.text).toBe(text)
  }
  act(cancelSearch)
  expect(tab === 'Work' ? phone.query : board.searchFilter.text).toBeFalsy()
  expect(screen.getByText('Other task')).toBeTruthy()

  // A query restored outside the native control must also update its text.
  act(() => {
    if (tab === 'Work') phone.setQuery('POD-123')
    else board.setFilter({ text: 'POD-123' })
  })
  expect(state.setSearchText).toHaveBeenLastCalledWith('POD-123')
  expect(screen.queryByText('Other task')).toBeNull()
  act(cancelSearch)
  expect(tab === 'Work' ? phone.query : board.searchFilter.text).toBeFalsy()
  expect(screen.getByText('Other task')).toBeTruthy()
  expect(state.listMount).toHaveBeenCalledOnce()

  if (tab === 'Work') {
    for (const lane of ['snoozed', 'closed', 'open', 'closed', 'snoozed', 'open'] as const) {
      act(() => phone.setLane(lane))
      expectPullDownSearch()
      expect(state.listMount).toHaveBeenCalledOnce()
    }
    expect(screen.getByText('Other task')).toBeTruthy()
  } else {
    act(() => board.setFilter({ projectPaths: ['/other'] }))
    expect(screen.queryByText('Other task')).toBeNull()
    act(() => board.setFilter({}))
    expect(screen.getByText('Other task')).toBeTruthy()
    expect(state.listMount).toHaveBeenCalledOnce()
  }

  act(() => {
    pool.apply({
      type: 'update',
      rows: [
        {
          kind: 'issue',
          id: 'other',
          value: {
            id: 'other',
            seq: 2,
            title: 'Reloaded task',
            stage: 'in_progress',
            audience: 'human',
            repoId: 'repo',
            repoPath: '/fixture',
            createdAt: stamp,
            updatedAt: stamp,
          },
        },
      ],
    })
  })
  expect(screen.getByText('Reloaded task')).toBeTruthy()
  expect(state.listMount).toHaveBeenCalledOnce()
})
