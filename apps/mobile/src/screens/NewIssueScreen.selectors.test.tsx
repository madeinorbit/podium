import { MobxPool } from '@podium/client-graph/pool'
import { createPoolProjection } from '@podium/client-graph/runtime-pool'
import { useMemo, useSyncExternalStore } from 'react'
import type { Store } from '@podium/client-core/engine'
import { readStoreStats, storeStats } from '@podium/client-core/perf'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider, StoreStatsProfiler } from '@podium/client-core/react'
import { createSubscriptionStore } from '@podium/client-core/store'
import { asUserId, type GitRepositoryWire } from '@podium/model'
import { act, cleanup, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { MobileTrpc } from '../client/trpc'
import { NewIssueScreen } from './NewIssueScreen'

const fixture = vi.hoisted(() => ({ handle: null as unknown, pool: null as MobxPool | null }))
vi.mock('../../../../packages/client-core/src/engine/runtime', () => ({
  createClientRuntime: () => fixture.handle,
}))
vi.mock('expo-router', () => ({ useRouter: () => ({ back() {}, replace() {} }) }))
vi.mock('../hooks/useContentBottomInset', () => ({ useContentBottomInset: () => 0 }))
vi.mock('../components/Screen', () => ({
  Screen: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock('../components/LaunchConfigurationFields', () => ({
  LaunchConfigurationFields: () => null,
}))
vi.mock('../client/hooks', async original => {
  const real = await original<typeof import('../client/hooks')>()
  return { ...real, useSessions: () => [] }
})
vi.mock('../client/mobile-pool', () => ({
  useMobilePoolProjection: <T,>(read: (pool: MobxPool) => T) => {
    const view = useMemo(() => createPoolProjection(fixture.pool!, read), [read])
    return useSyncExternalStore(view.subscribe, view.getSnapshot)
  },
}))
afterEach(() => {
  cleanup()
  storeStats.enable(false)
  storeStats.reset()
})

const repo = (path: string) =>
  ({ path, kind: 'repository', worktrees: [] }) as unknown as GitRepositoryWire

it('isolates NewIssueScreen from unrelated publishes while still painting repository updates', async () => {
  const results = []
  {
    fixture.pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
    fixture.pool.header.apply([{ kind: 'repository', id: '/before', value: repo('/before') }])
    fixture.pool.header.order('repository', ['/before'])
    const owner = { start() {}, dispose() {}, destroy() {} }
    const trpc = { settings: { get: { query: async () => ({}) } } } as unknown as MobileTrpc
    const store = createSubscriptionStore(
      {
        repos: [repo('/before')],
        sessions: [],
        trpc,
        coarseNow: 0,
      } as unknown as Store<MobileTrpc>,
      undefined,
      owner,
    )
    fixture.handle = Object.assign(owner, store)
    const view = render(
      <StoreProvider
        principal={asClientPrincipal(asUserId('test'))}
        config={{ httpOrigin: 'http://test', wsClientUrl: 'ws://test' }}
        api={trpc}
        onFatalError={() => {}}
        createReplicaFn={() => {
          throw new Error('mock runtime')
        }}
      >
        <StoreStatsProfiler>
          <NewIssueScreen />
        </StoreStatsProfiler>
      </StoreProvider>,
    )
    await act(async () => {})
    expect(view.getByRole('radio', { name: 'Repository before' })).toBeTruthy()
    storeStats.enable()
    storeStats.reset()
    const window = storeStats.begin('feed')
    for (const coarseNow of [1, 2, 3]) {
      act(() => store.publish({ ...store.getSnapshot(), coarseNow }, new Set(['coarseNow'])))
    }
    storeStats.end(window)
    const unrelated = readStoreStats().runtimes[0]!
    storeStats.reset()
    // Same selected path avoids a separate local selection effect; the added
    // option must appear in both arms and requires a real selected-field update.
    act(() => {
      store.publish(
        { ...store.getSnapshot(), repos: [repo('/before'), repo('/after')] },
        new Set(['repos']),
      )
      fixture.pool!.header.apply([{ kind: 'repository', id: '/after', value: repo('/after') }])
      fixture.pool!.header.order('repository', ['/before', '/after'])
    })
    const relevant = readStoreStats().runtimes[0]!
    expect(view.getByRole('radio', { name: 'Repository after' })).toBeTruthy()
    results.push({
      publishes: unrelated.publishes,
      unrelatedCommits: unrelated.reactCommits,
      relevantPublishes: relevant.publishes,
      relevantCommits: relevant.reactCommits,
    })
    view.unmount()
    fixture.pool.dispose()
    storeStats.enable(false)
  }
  expect(results).toEqual([
    { publishes: 3, unrelatedCommits: 0, relevantPublishes: 1, relevantCommits: 1 },
  ])
})
