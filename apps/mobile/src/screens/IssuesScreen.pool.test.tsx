/** Real Tasks screen and observer rows; navigation/transport chrome is stubbed. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Profiler, type ReactNode, useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { attachMobileScreens } from '@podium/client-graph/mobile-screens'
import { MobxPool } from '@podium/client-graph/pool'

const state = vi.hoisted(() => ({
  pool: null as MobxPool | null,
  counts: new Map<string, number>(),
  lists: 0,
}))
const router = vi.hoisted(() => ({ push: vi.fn() }))
vi.mock('expo-router', () => ({ useRouter: () => router, Stack: { SearchBar: () => null } }))
vi.mock('../client/mobile-pool', () => ({ useMobilePool: () => state.pool }))
vi.mock('../client/hooks', () => ({ useBooting: () => false, useStoreActions: () => ({}) }))
vi.mock('../client/use-issue-close', () => ({ useIssueCloseGuard: () => () => false }))
vi.mock('../hooks/usePersistedUiState', () => ({
  usePersistedUiState: () => [{ ordering: 'priority', showAgentTasks: false }, () => {}],
}))
vi.mock('../hooks/useCollapsed', () => ({
  useCollapsed: (_key: string, initial: boolean) => useState(initial),
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
vi.mock('../components/Screen', () => ({
  Screen: ({ right, children }: { right: ReactNode; children: ReactNode }) => (
    <div>
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
}))
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
      renderItem: (input: { item: { id: string } }) => ReactNode
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
              {section.data.map((item) => (
                <div key={item.id}>{renderItem({ item })}</div>
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
vi.mock('../components/NotSavedMark', () => ({ NotSavedMark: () => null }))
vi.mock('../components/TaskFiltersSheet', () => ({ TaskFiltersSheet: () => null }))
vi.mock('../components/ActionSheet', () => ({ ActionSheet: () => null }))
vi.mock('../components/IssueCloseSheet', () => ({ IssueCloseSheet: () => null }))
vi.stubEnv('EXPO_OS', 'web')
const { IssuesScreen } = await import('./IssuesScreen')
const now = Date.parse('2026-10-03T12:00:00Z')
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
})

it('redraws only the changed task row and keeps proposal and expansion behavior', async () => {
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
  await attachMobileScreens(pool)
  render(<IssuesScreen />)
  expect(screen.getByRole('button', { name: /Task 1: root/ })).toBeTruthy()
  expect(screen.getByRole('button', { name: /Task 2: peer/ })).toBeTruthy()
  expect(screen.getByRole('button', { name: /Task 4: proposal/ })).toBeTruthy()
  expect(screen.queryByRole('button', { name: /Task 3: child/ })).toBeNull()
  expect(screen.getByRole('button', { name: 'Screen proposed' })).toBeTruthy()
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
  fireEvent.click(screen.getByText('1 sub-task'))
  expect(screen.getByRole('button', { name: /Task 3: child/ })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /Task 3: child/ }))
  expect(router.push).toHaveBeenCalledWith('/issue/child')
})
