import { MobxPool } from '@podium/client-graph/pool'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { type ReactElement, type ReactNode, StrictMode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkingMark } from '../components/WorkingMark.native'
import type { TasksSurfaceProps } from './TasksSurface.types'

const state = vi.hoisted(() => ({ pool: null as MobxPool | null, push: vi.fn() }))
const activity = vi.hoisted(() => ({ users: 0, route: null as ReactElement | null }))
vi.mock('expo-router/stack', () => ({
  Stack: ({
    screenLayout,
  }: {
    screenLayout: (props: { children: ReactElement }) => ReactElement
  }) => screenLayout({ children: activity.route ?? <></> }),
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
vi.mock('react-native-reanimated', async () => ({
  default: { View: (await import('react-native')).View },
  useAnimatedStyle: (read: () => object) => read(),
}))
vi.mock('../navigation/use-dismiss-on-root-leave', () => ({ useDismissOnRootLeave: () => {} }))
vi.mock('../client/use-launch-inputs', () => ({ useLaunchRepositoryPaths: () => [] }))
vi.mock('@expo/ui', () => ({ Host: ({ children }: { children: ReactNode }) => children }))
vi.mock('@expo/ui/swift-ui', async () => {
  const { useEffect } = await import('react')
  const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>
  return {
    BottomSheet: ({
      isPresented,
      onDismiss,
      children,
    }: {
      isPresented: boolean
      onDismiss?(): void
      children: ReactNode
    }) => {
      useEffect(() => {
        if (!isPresented) onDismiss?.()
      }, [isPresented, onDismiss])
      return isPresented ? <div role="dialog">{children}</div> : null
    },
    Button: ({ label, onPress }: { label: string; onPress(): void }) => (
      <button type="button" onClick={onPress}>
        {label}
      </button>
    ),
    Form: Box,
    Group: Box,
    NavigationStack: Box,
    Picker: Box,
    Section: Box,
    Text: Box,
    Toggle: () => null,
    Toolbar: Object.assign(Box, { Content: Box }),
    ToolbarItem: Box,
  }
})
vi.mock('@expo/ui/swift-ui/modifiers', () =>
  Object.fromEntries(
    [
      'disabled',
      'navigationBarTitleDisplayMode',
      'navigationTitle',
      'pickerStyle',
      'presentationDetents',
      'presentationDragIndicator',
      'tag',
    ].map((name) => [name, () => ({})]),
  ),
)
vi.mock('expo-router', () => ({ useRouter: () => ({ push: state.push }) }))
vi.mock('../client/mobile-pool', () => ({ useMobilePool: () => state.pool }))
vi.mock('../client/hooks', () => ({ useBooting: () => false }))
vi.mock('../client/member-roster', () => ({ useMobileMemberRoster: () => undefined }))
vi.mock('../hooks/useIssuesFilters', async () => {
  const { readIssuesFilters } = await import('@podium/client-core/values')
  return { useIssuesFilters: () => [readIssuesFilters(null, null), () => {}] }
})
vi.mock('../client/use-issue-close', () => ({ useIssueCloseGuard: () => () => false }))
vi.mock('../lib/issue-row-actions', () => ({ useIssueRowActions: () => ({}) }))
vi.mock('../hooks/useContentBottomInset', () => ({ useContentBottomInset: () => 0 }))
vi.mock('../hooks/useMinimizeTabBarOnScroll', () => ({ useMinimizeTabBarOnScroll: () => ({}) }))
vi.mock('../hooks/useRefreshableTab', () => ({ useRefreshableTab: () => ({}) }))
vi.mock('../hooks/usePersistedUiState', () => ({
  usePersistedUiState: () => [{ ordering: 'updated', showAgentTasks: true }, () => {}],
}))
vi.mock('../components/WorkIssueMenu', () => ({ WorkIssueMenu: () => null }))
vi.mock('../components/TaskFiltersSheet', () => import('../components/TaskFiltersSheet.ios'))
vi.mock('./TasksSurface', () => ({
  TasksSurface: ({ board, onOpen, onFilters }: TasksSurfaceProps) => (
    <>
      <WorkingMark />
      <input aria-label="Task search" onChange={(event) => board?.search(event.target.value)} />
      <button type="button" onClick={() => onOpen('task')}>
        Open task
      </button>
      <button type="button" onClick={onFilters}>
        Filters
      </button>
    </>
  ),
}))
const { IssuesScreen } = await import('./IssuesScreen')
const { default: IssuesLayout } = await vi.importActual<{ default: () => ReactElement }>(
  '../../app/(tabs)/issues/_layout.tsx',
)
afterEach(() => {
  cleanup()
  expect(activity.users).toBe(0)
  activity.route = null
  state.pool?.dispose()
  state.pool = null
  state.push.mockClear()
})

it('stops a real mark under the real Tasks route and sibling native filter sheet, then resumes on Done', () => {
  activity.route = <IssuesScreen />
  render(
    <StrictMode>
      <IssuesLayout />
    </StrictMode>,
  )
  expect(activity.users).toBe(1)
  fireEvent.click(screen.getByRole('button', { name: 'Filters' }))
  expect(screen.getByRole('dialog')).toBeTruthy()
  expect(activity.users).toBe(0)
  fireEvent.click(screen.getByRole('button', { name: 'Done' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(activity.users).toBe(1)
})

it.each([
  { coordinator: 'lead', sessions: ['lead', 'recent'], target: '/mission/task?sessionId=lead' },
  {
    coordinator: undefined,
    sessions: ['lead', 'recent'],
    target: '/mission/task?sessionId=recent',
  },
  { coordinator: undefined, sessions: [], target: '/issue/task' },
])('opens Tasks and search rows on $target', ({ coordinator, sessions, target }) => {
  state.pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  const stamp = '2026-11-13T12:00:00.000Z'
  state.pool.apply({
    type: 'replace',
    rows: [
      {
        kind: 'issue',
        id: 'task',
        value: {
          id: 'task',
          seq: 1,
          title: 'Task',
          repoPath: '/repo',
          description: '',
          labels: [],
          deps: [],
          type: 'task',
          priority: 2,
          stage: 'in_progress',
          createdAt: stamp,
          updatedAt: stamp,
          coordinatorSessionId: coordinator,
        },
      },
      ...sessions.map((id, index) => ({
        kind: 'session' as const,
        id,
        value: {
          sessionId: id,
          issueId: 'task',
          agentKind: 'codex',
          title: id,
          cwd: '/repo',
          status: 'live',
          archived: false,
          createdAt: stamp,
          lastActiveAt: `2026-11-13T1${index + 2}:00:00.000Z`,
        },
      })),
    ],
  })
  render(<IssuesScreen />)
  fireEvent.click(screen.getByRole('button', { name: 'Open task' }))
  expect(state.push).toHaveBeenLastCalledWith(target)
  fireEvent.change(screen.getByRole('textbox', { name: 'Task search' }), {
    target: { value: 'Task' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Open task' }))
  expect(state.push).toHaveBeenLastCalledWith(target)
  expect(state.push).toHaveBeenCalledTimes(2)
})
