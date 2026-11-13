import type { PodiumClientApi } from '@podium/client-core/api'
import type { ClientRuntime } from '@podium/client-core/engine'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider, useStoreHandle } from '@podium/client-core/react'
import { createKernelReplica, createSideCache, memoryStorage } from '@podium/client-core/replica'
import { ISSUES_DISPLAY_KEY } from '@podium/client-core/ui-state'
import { createPoolHost, type PoolHost } from '@podium/client-graph/host'
import { attachMobileScreens } from '@podium/client-graph/mobile-screens'
import { MOBILE_SCREEN_SUMMARIES } from '@podium/client-graph/mobile-screens-schema'
import type { MobxPool } from '@podium/client-graph/pool'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { asUserId } from '@podium/model'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createContext, useContext } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { TasksSurfaceProps } from './TasksSurface.types'

const state = vi.hoisted(() => ({
  host: null as PoolHost | null,
  runtime: null as ClientRuntime | null,
  pool: null as MobxPool | null,
  focused: false,
  booting: true,
  frames: [] as { ordering: string; ids: string[] }[],
  boards: [] as NonNullable<TasksSurfaceProps['board']>[],
}))
const VisitContext = createContext({ focused: false, booting: true })
function currentHost(): PoolHost {
  if (!state.host) throw new Error('The first-visit host is missing')
  return state.host
}

// Keep the production host's focus pause, preference source, hook and board.
// Only navigation, platform chrome and the refresh/transport boundary are stubbed.
vi.mock('../client/mobile-pool', () => ({
  useMobilePool: () => currentHost().usePool(),
  useMobilePoolProjection: <T,>(read: (pool: MobxPool) => T, empty: T) =>
    currentHost().usePoolProjection(read, empty, useContext(VisitContext).focused),
}))
vi.mock('../client/hooks', () => ({
  useUiState: () => (useStoreHandle() as unknown as ClientRuntime).ui,
  useBooting: () => useContext(VisitContext).booting,
  useStoreActions: () => ({}),
}))
vi.mock('expo-router', () => ({ useRouter: () => ({ push: () => {} }) }))
vi.mock('../client/use-issue-close', () => ({ useIssueCloseGuard: () => () => false }))
vi.mock('../lib/issue-row-actions', () => ({ useIssueRowActions: () => ({}) }))
vi.mock('../hooks/useContentBottomInset', () => ({ useContentBottomInset: () => 0 }))
vi.mock('../hooks/useMinimizeTabBarOnScroll', () => ({ useMinimizeTabBarOnScroll: () => ({}) }))
vi.mock('../hooks/useRefreshableTab', () => ({ useRefreshableTab: () => ({}) }))
vi.mock('../components/WorkIssueMenu', () => ({ WorkIssueMenu: () => null }))
vi.mock('../components/TaskFiltersSheet', () => ({
  TaskFiltersSheet: ({
    onOrdering,
    onShowAgentTasks,
  }: {
    onOrdering: (ordering: string) => void
    onShowAgentTasks: (show: boolean) => void
  }) => (
    <>
      <button type="button" onClick={() => onOrdering('created')}>
        Newest created
      </button>
      <button type="button" onClick={() => onShowAgentTasks(true)}>
        Show agent tasks
      </button>
    </>
  ),
}))
vi.mock('./TasksSurface', async () => {
  const { observer } = await import('mobx-react-lite')
  return {
    TasksSurface: observer(({ board, onFilters }: TasksSurfaceProps) => {
      if (board && board !== state.boards.at(-1)) state.boards.push(board)
      const groups = board?.groups ?? LOADING
      if (state.focused && board && groups !== LOADING) {
        state.frames.push({
          ordering: board.ordering,
          ids: groups.flatMap((group) => group.rows.map((row) => row.id)),
        })
      }
      return (
        <button type="button" onClick={onFilters}>
          Display
        </button>
      )
    }),
  }
})

const { IssuesScreen } = await import('./IssuesScreen')
afterEach(() => {
  cleanup()
  state.host = null
  state.pool = null
  state.runtime = null
  state.focused = false
  state.booting = true
  state.frames.length = 0
  state.boards.length = 0
})

it('uses the saved display on every first-focus frame of the board mounted before Tasks opens', async () => {
  const replica = createKernelReplica({
    cache: {
      readCursor: () => null,
      readEntities: () => [],
      read: () => undefined,
      durability: () => 'durable',
    },
    side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }),
  })
  state.host = createPoolHost({
    dev: false,
    screens: [
      {
        id: 'tasks',
        options: () => ({ preferences: true, summaries: MOBILE_SCREEN_SUMMARIES }),
        attach: async (runtime, pool) => {
          state.pool = pool
          await attachMobileScreens(pool, runtime)
        },
      },
    ],
  })
  const content = (
    <StoreProvider
      principal={asClientPrincipal(asUserId('first-visit'))}
      config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }}
      api={{} as PodiumClientApi}
      createReplicaFn={() => replica}
      networkEnabled={false}
      onFatalError={(message) => {
        throw new Error(message)
      }}
      attachRuntime={(runtime) => {
        state.runtime = runtime
        // The restored display is installed before the hidden Tasks board exists.
        runtime.ui.set(ISSUES_DISPLAY_KEY, '{"layout":"board","ordering":"updated"}')
        return currentHost().attach(runtime, (error) => {
          throw error
        })
      }}
    >
      <IssuesScreen />
    </StoreProvider>
  )
  const tree = () => (
    <VisitContext.Provider value={{ focused: state.focused, booting: state.booting }}>
      {content}
    </VisitContext.Provider>
  )
  const view = render(tree())
  await waitFor(() => expect(state.pool).not.toBeNull(), { timeout: 10_000 })
  const pool = state.pool
  if (!pool) throw new Error('The first-visit pool did not attach')
  const stamp = '2026-01-01T00:00:00Z'
  await act(async () => {
    pool.apply({
      type: 'replace',
      rows: [
        { id: 'older', seq: 1, updatedAt: stamp, createdAt: '2026-03-01T00:00:00Z' },
        { id: 'newer', seq: 2, updatedAt: '2026-02-01T00:00:00Z', createdAt: stamp },
        { id: 'agent', seq: 3, updatedAt: stamp, createdAt: stamp, audience: 'agent' },
      ].map((row) => ({
        kind: 'issue' as const,
        id: row.id,
        value: {
          title: row.id,
          stage: 'in_progress',
          priority: 2,
          type: 'task',
          audience: 'human',
          repoPath: '/fixture',
          description: '',
          labels: [],
          deps: [],
          ...row,
        },
      })),
    })
  })
  const focus = (focused: boolean) => {
    state.focused = focused
    view.rerender(tree())
  }
  // The same board survives hidden mount, first focus, boot completion and repeat visits.
  for (let visit = 0; visit < 3; visit++) {
    state.frames.length = 0
    act(() => focus(true))
    state.booting = false
    view.rerender(tree())
    expect(state.frames.length).toBeGreaterThan(0)
    expect(state.frames).toEqual(
      state.frames.map(() => ({
        ordering: 'updated',
        ids: ['newer', 'older'],
      })),
    )
    act(() => focus(false))
  }
  expect(state.boards).toHaveLength(1)
  act(() => focus(true))
  fireEvent.click(screen.getByRole('button', { name: 'Display' }))
  state.frames.length = 0
  fireEvent.click(screen.getByRole('button', { name: 'Newest created' }))
  expect(state.frames.length).toBeGreaterThan(0)
  expect(
    state.frames.every(
      (frame) => frame.ordering === 'created' && frame.ids.join(',') === 'older,newer',
    ),
  ).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Show agent tasks' }))
  expect(state.frames.at(-1)?.ids).toEqual(['older', 'agent', 'newer'])
  expect(JSON.parse(state.runtime?.ui.get(ISSUES_DISPLAY_KEY) ?? 'null')).toMatchObject({
    layout: 'board',
    ordering: 'created',
    showAgentTasks: true,
  })
})
