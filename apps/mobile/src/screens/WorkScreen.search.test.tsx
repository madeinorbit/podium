import { MobxPool } from '@podium/client-graph/pool'
import { worklistView } from '@podium/client-graph/worklist/view-model'
import { act, cleanup, render } from '@testing-library/react'
import { type EffectCallback, useEffect } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { WorkRouteParams } from './work-navigation'

const state = vi.hoisted(() => ({
  pool: null as MobxPool | null,
  params: {} as WorkRouteParams,
  focus: 0,
  router: {
    setParams: vi.fn((params: WorkRouteParams) => {
      state.params = { ...state.params, ...params }
    }),
  },
}))
vi.mock('react-native', async (original) => {
  const real = await original<typeof import('react-native')>()
  return { ...real, Platform: { ...real.Platform, OS: 'ios' } }
})
vi.mock('expo-router', () => ({
  useLocalSearchParams: () => state.params,
  useRouter: () => state.router,
  // biome-ignore lint/correctness/useExhaustiveDependencies: the counter simulates a native refocus.
  useFocusEffect: (effect: EffectCallback) => useEffect(effect, [effect, state.focus]),
}))
vi.mock('../client/mobile-pool', () => ({
  useMobilePool: () => state.pool,
  useMobilePoolProjection: (_read: unknown, fallback: unknown) => fallback,
}))
vi.mock('../client/hooks', () => ({ useStoreActions: () => ({}) }))
vi.mock('../client/use-issue-close', () => ({ useIssueCloseGuard: () => () => false }))
vi.mock('../client/use-session-context', () => ({ useSessionContextBooting: () => false }))
vi.mock('../hooks/useCollapsedSet', () => ({
  useCollapsedSet: () => ({ collapsed: new Set(), toggle: () => {} }),
}))
vi.mock('../hooks/useContentBottomInset', () => ({ useContentBottomInset: () => 0 }))
vi.mock('../hooks/useRefreshableTab', () => ({ useRefreshableTab: () => ({}) }))
vi.mock('../components/LaunchPlaceholders', () => ({ WorkSkeleton: () => null }))
vi.mock('../components/Screen', () => ({ Screen: () => null }))
vi.mock('../components/RefreshOffer', () => ({ RefreshOffer: () => null }))
vi.mock('../components/StorageNoticeAlert', () => ({ StorageNoticeAlert: () => null }))
vi.mock('../components/WorkspaceContinuityNotice', () => ({
  WorkspaceContinuityNotice: () => null,
}))
vi.mock('../components/WorkIssueMenu', () => ({ WorkIssueMenu: () => null }))
vi.mock('./WorkSurface', () => ({ WorkSurface: () => null }))
const { WorkScreen } = await import('./WorkScreen')
afterEach(() => {
  cleanup()
  state.pool?.dispose()
  state.pool = null
  state.params = {}
  state.focus = 0
  vi.clearAllMocks()
})

it('keeps the existing Work route query on iOS mount and refocus, and saves changes to that route', () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  state.pool = pool
  state.params = { workQuery: 'POD-123', workLane: 'snoozed' }
  const view = render(<WorkScreen />)
  const phone = worklistView(pool).phone
  expect(phone.query).toBe('POD-123')
  expect(phone.lane).toBe('snoozed')
  expect(state.router.setParams).not.toHaveBeenCalled()
  act(() => phone.setQuery('child title'))
  expect(state.router.setParams).toHaveBeenLastCalledWith(
    expect.objectContaining({ workQuery: 'child title', workLane: 'snoozed' }),
  )
  state.focus++
  view.rerender(<WorkScreen />)
  expect(phone.query).toBe('child title')
  act(() => phone.setQuery(''))
  expect(state.router.setParams).toHaveBeenLastCalledWith(
    expect.objectContaining({ workQuery: undefined, workLane: 'snoozed' }),
  )
})
