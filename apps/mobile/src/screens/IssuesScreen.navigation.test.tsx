import { MobxPool } from '@podium/client-graph/pool'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { TasksSurfaceProps } from './TasksSurface.types'

const state = vi.hoisted(() => ({ pool: null as MobxPool | null, push: vi.fn() }))
vi.mock('expo-router', () => ({ useRouter: () => ({ push: state.push }) }))
vi.mock('../client/mobile-pool', () => ({ useMobilePool: () => state.pool }))
vi.mock('../client/hooks', () => ({ useBooting: () => false, useStoreActions: () => ({}) }))
vi.mock('../client/use-issue-close', () => ({ useIssueCloseGuard: () => () => false }))
vi.mock('../lib/issue-row-actions', () => ({ useIssueRowActions: () => ({}) }))
vi.mock('../hooks/useContentBottomInset', () => ({ useContentBottomInset: () => 0 }))
vi.mock('../hooks/useMinimizeTabBarOnScroll', () => ({ useMinimizeTabBarOnScroll: () => ({}) }))
vi.mock('../hooks/useRefreshableTab', () => ({ useRefreshableTab: () => ({}) }))
vi.mock('../hooks/usePersistedUiState', () => ({
  usePersistedUiState: () => [{ ordering: 'updated', showAgentTasks: true }, () => {}],
}))
vi.mock('../components/WorkIssueMenu', () => ({ WorkIssueMenu: () => null }))
vi.mock('../components/TaskFiltersSheet', () => ({ TaskFiltersSheet: () => null }))
vi.mock('./TasksSurface', () => ({
  TasksSurface: ({ board, onOpen }: TasksSurfaceProps) => (
    <>
      <input aria-label="Task search" onChange={(event) => board?.search(event.target.value)} />
      <button type="button" onClick={() => onOpen('task')}>
        Open task
      </button>
    </>
  ),
}))
const { IssuesScreen } = await import('./IssuesScreen')
afterEach(() => {
  cleanup()
  state.pool?.dispose()
  state.pool = null
  state.push.mockClear()
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
