/** Real Tasks screen and observer rows; navigation/transport chrome is stubbed. */

import { attachMobileScreens } from '@podium/client-graph/mobile-screens'
import { MobxPool } from '@podium/client-graph/pool'
import { attachPreferenceSource } from '@podium/client-graph/preference-source'
import { refreshingScreenFixture } from '@podium/client-graph/refreshing-screen.test.fixture'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Profiler, type ReactNode, useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  pool: null as MobxPool | null,
  counts: new Map<string, number>(),
  lists: 0,
}))
const router = vi.hoisted(() => ({ push: vi.fn() }))
vi.mock('expo-router', () => ({ useRouter: () => router, Stack: { SearchBar: () => null } }))
vi.mock('../client/mobile-pool', () => ({ useMobilePool: () => state.pool }))
vi.mock('../client/hooks', () => ({ useBooting: () => false, useStoreActions: () => ({}) }))
vi.mock('@podium/client-core/react', () => ({
  useCommands: () => ({ issues: { markRead: async () => {}, update: async () => {} } }),
}))
vi.mock('../client/use-issue-close', () => ({ useIssueCloseGuard: () => () => false }))
vi.mock('../lib/issue-row-actions', () => ({ useIssueRowActions: () => ({}) }))
vi.mock('../hooks/usePersistedUiState', () => ({
  usePersistedUiState: () => [{ ordering: 'priority', showAgentTasks: false }, () => {}],
}))
vi.mock('../hooks/useIssuesFilters', () => ({
  useIssuesFilters: () => [{ assignedTo: 'me', showAgentTasks: false, source: {} }, () => {}],
}))
vi.mock('../hooks/useCollapsed', () => ({
  useCollapsed: (_key: string, initial: boolean) => {
    const [collapsed, setCollapsed] = useState(initial)
    return [collapsed, () => setCollapsed((value) => !value)]
  },
}))
vi.mock('../hooks/useContentBottomInset', () => ({ useContentBottomInset: () => 0 }))
vi.mock('../hooks/useMinimizeTabBarOnScroll', () => ({ useMinimizeTabBarOnScroll: () => ({}) }))
vi.mock('../hooks/useReduceMotion', () => ({ useReduceMotion: () => true }))
vi.mock('../hooks/useRefreshableTab', () => ({
  useRefreshableTab: () => ({
    listRef: null,
    refreshAccessibilityProps: {},
    connected: true,
    refreshing: false,
    onRefresh: () => {},
  }),
}))
vi.mock('../components/Screen', async () => {
  const { ScreenRefreshMark } = await import('../components/ScreenRefreshMark')
  return {
    Screen: ({
      right,
      children,
      refreshing,
    }: {
      right: ReactNode
      children: ReactNode
      refreshing?: boolean
    }) => (
      <div>
        <ScreenRefreshMark refreshing={refreshing ?? false} />
        {right}
        {children}
      </div>
    ),
    HeaderButton: ({
      label,
      onPress,
      children,
    }: {
      label: string
      onPress: () => void
      children: ReactNode
    }) => (
      <button type="button" aria-label={label} onClick={onPress}>
        {children}
      </button>
    ),
  }
})
vi.mock('../components/PressableScale', () => ({
  PressableScale: ({
    children,
    accessibilityLabel,
    onPress,
  }: {
    children: ReactNode
    accessibilityLabel?: string
    onPress?: () => void
  }) => (
    <Profiler
      id={accessibilityLabel ?? 'chrome'}
      onRender={(id, phase) => {
        if (phase !== 'mount' && id.startsWith('Task ')) {
          const key = id.split(':')[0]!
          state.counts.set(key, (state.counts.get(key) ?? 0) + 1)
        }
      }}
    >
      <button type="button" aria-label={accessibilityLabel} onClick={onPress}>
        {children}
      </button>
    </Profiler>
  ),
}))
vi.mock('react-native', async (importOriginal) => {
  const real = await importOriginal<typeof import('react-native')>()
  return {
    ...real,
    SectionList: ({
      sections,
      renderItem,
      renderSectionHeader,
      ListHeaderComponent,
    }: {
      sections: { key: string; data: { id: string }[] }[]
      renderItem: (input: {
        item: { id: string }
        index: number
        section: { data: { id: string }[] }
      }) => ReactNode
      renderSectionHeader: (input: { section: unknown }) => ReactNode
      ListHeaderComponent: ReactNode
    }) => {
      state.lists++
      return (
        <div>
          {ListHeaderComponent}
          {sections.map((section) => (
            <div key={section.key}>
              {renderSectionHeader({ section })}
              {section.data.map((item, index) => (
                <div key={item.id}>{renderItem({ item, index, section })}</div>
              ))}
            </div>
          ))}
        </div>
      )
    },
  }
})
vi.mock('../components/LaunchPlaceholders', () => ({
  BootstrapCrossfade: ({ children }: { children: ReactNode }) => children,
  TasksSkeleton: () => null,
}))
vi.mock('../components/PullToRefreshBoundary', () => ({
  PullToRefreshBoundary: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('../components/StorageNoticeAlert', () => ({ StorageNoticeAlert: () => null }))
vi.mock('../components/RefreshOffer', () => ({ RefreshOffer: () => null }))
vi.mock('../components/WorkspaceContinuityNotice', () => ({
  WorkspaceContinuityNotice: () => null,
}))
vi.mock('../components/NotSavedMark', () => ({ NotSavedMark: () => null }))
vi.mock('../components/TaskFiltersSheet', () => ({ TaskFiltersSheet: () => null }))
vi.mock('../components/WorkIssueMenu', () => ({ WorkIssueMenu: () => null }))
vi.stubEnv('EXPO_OS', 'web')
const { IssuesScreen } = await import('./IssuesScreen')

it('the real phone board opens offline data with one refreshing mark and updates its rows in place', async () => {
  const f = await refreshingScreenFixture()
  state.pool = f.pool
  f.mark(f.owned.board)
  const view = render(<IssuesScreen />)
  try {
    expect(screen.getAllByLabelText('Refreshing')).toHaveLength(1)
    const row = screen.getByRole('button', { name: /Task 1: Cached root/ })
    expect(view.container.textContent).not.toContain('Loading')
    await act(async () => f.land())
    expect(screen.queryByLabelText('Refreshing')).toBeNull()
    expect(screen.getByRole('button', { name: /Task 1: Cached root updated/ })).toBe(row)
    expect(f.requested).toEqual([])
  } finally {
    view.unmount()
    state.pool = null
    f.dispose()
  }
})
const now = Date.parse('2026-10-03T12:00:00Z')
async function attachTasks(pool: MobxPool) {
  attachPreferenceSource(pool, {
    get: () => '{"ordering":"priority"}',
    set: () => {},
    subscribe: () => () => {},
  })
  await attachMobileScreens(pool)
}
const issue = (id: string, seq: number, patch: object = {}) => ({
  id,
  seq,
  title: id,
  stage: 'in_progress',
  type: 'task',
  priority: 2,
  audience: 'human',
  repoPath: '/fixture',
  description: '',
  labels: [],
  deps: [],
  createdAt: new Date(now).toISOString(),
  updatedAt: new Date(now).toISOString(),
  ...patch,
})
afterEach(() => {
  cleanup()
  state.pool?.dispose()
  state.pool = null
  state.counts.clear()
  state.lists = 0
  router.push.mockClear()
})

it('redraws only the changed task row and keeps the folded proposals and expansion', async () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: now })
  state.pool = pool
  pool.apply({
    type: 'replace',
    rows: [
      issue('root', 1),
      issue('peer', 2),
      issue('child', 3, { parentId: 'root' }),
      issue('proposal', 4, { parentId: 'root', stage: 'proposed' }),
    ].map((value) => ({ kind: 'issue' as const, id: value.id, value })),
  })
  await attachTasks(pool)
  render(<IssuesScreen />)
  expect(screen.getByRole('button', { name: /Task 1: root/ })).toBeTruthy()
  expect(screen.getByRole('button', { name: /Task 2: peer/ })).toBeTruthy()
  // Proposed starts as one folded group whose "Screen" opens the deck.
  expect(screen.queryByRole('button', { name: /Task 4: proposal/ })).toBeNull()
  expect(screen.queryByRole('button', { name: /Task 3: child/ })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Screen proposed' }))
  expect(router.push).toHaveBeenCalledWith({ pathname: '/screen-proposed', params: { text: '' } })
  fireEvent.click(screen.getByRole('button', { name: 'Proposed, 1 task' }))
  expect(screen.getByRole('button', { name: /Task 4: proposal/ })).toBeTruthy()
  const lists = state.lists
  state.counts.clear()
  await act(async () =>
    pool.apply({
      type: 'update',
      rows: [{ kind: 'issue', id: 'root', value: issue('root', 1, { title: 'Renamed task' }) }],
    }),
  )
  expect(screen.getByRole('button', { name: /Task 1: Renamed task/ })).toBeTruthy()
  expect(state.counts.get('Task 1')).toBe(1)
  expect(state.counts.get('Task 2') ?? 0).toBe(0)
  expect(state.counts.get('Task 4') ?? 0).toBe(0)
  expect(state.lists).toBe(lists)
  // The proposed child is outside accepted progress; the count still discloses children.
  expect(screen.getByRole('button', { name: 'Task 1: Renamed task, 0/1' })).toBeTruthy()
  fireEvent.click(screen.getByText('0/1'))
  expect(screen.getByRole('button', { name: /Task 3: child/ })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /Task 3: child/ }))
  expect(router.push).toHaveBeenCalledWith('/issue/child')
})

it('opens the counted search selection and leaves saved folds untouched on search header taps', async () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: now })
  state.pool = pool
  pool.apply({
    type: 'replace',
    rows: [
      issue('matching proposal', 2347, { stage: 'proposed' }),
      issue('unrelated proposal', 2348, { stage: 'proposed' }),
    ].map((value) => ({ kind: 'issue' as const, id: value.id, value })),
  })
  await attachTasks(pool)
  render(<IssuesScreen />)
  expect(screen.getByRole('button', { name: 'Proposed, 2 tasks' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Search tasks' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Search tasks' }), {
    target: { value: '2347' },
  })
  expect(screen.getByRole('button', { name: 'Proposed, 1 task' })).toBeTruthy()
  expect(screen.getByRole('button', { name: /Task 2347: matching proposal/ })).toBeTruthy()
  expect(screen.queryByRole('button', { name: /Task 2348:/ })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Screen proposed' }))
  expect(router.push).toHaveBeenCalledExactlyOnceWith({
    pathname: '/screen-proposed',
    params: { text: '2347' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Proposed, 1 task' }))
  expect(screen.getByRole('button', { name: /Task 2347: matching proposal/ })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Close task search' }))
  expect(screen.getByRole('button', { name: 'Proposed, 2 tasks' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: /Task 2347:/ })).toBeNull()
  // Positive control: the same header changes the saved fold outside search.
  fireEvent.click(screen.getByRole('button', { name: 'Proposed, 2 tasks' }))
  expect(screen.getByRole('button', { name: /Task 2347:/ })).toBeTruthy()
  expect(screen.getByRole('button', { name: /Task 2348:/ })).toBeTruthy()
})
