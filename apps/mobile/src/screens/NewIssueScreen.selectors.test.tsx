import type { Store } from '@podium/client-core/engine'
import { readStoreStats, storeStats } from '@podium/client-core/perf'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider, StoreStatsProfiler, useStore } from '@podium/client-core/react'
import { createSubscriptionStore } from '@podium/client-core/store'
import { asUserId, type GitRepositoryWire } from '@podium/model'
import { act, cleanup, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { MobileTrpc } from '../client/trpc'
import { NewIssueScreen } from './NewIssueScreen'

const fixture = vi.hoisted(() => ({ handle: null as unknown, legacy: false }))
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
vi.mock('../client/hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../client/hooks')>()
  return {
    ...actual,
    // The same production screen and scenario, restoring only the old read seam.
    useStoreSelector: (...args: Parameters<typeof actual.useStoreSelector>) =>
      fixture.legacy ? args[0](useStore<MobileTrpc>()) : actual.useStoreSelector(...args),
  }
})
afterEach(() => {
  cleanup()
  storeStats.enable(false)
  storeStats.reset()
})

const repo = (path: string) =>
  ({ path, kind: 'repository', worktrees: [] }) as unknown as GitRepositoryWire

it('isolates NewIssueScreen from unrelated publishes while still painting repository updates', async () => {
  const results = []
  for (const legacy of [true, false]) {
    fixture.legacy = legacy
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
    act(() =>
      store.publish(
        { ...store.getSnapshot(), repos: [repo('/before'), repo('/after')] },
        new Set(['repos']),
      ),
    )
    const relevant = readStoreStats().runtimes[0]!
    expect(view.getByRole('radio', { name: 'Repository after' })).toBeTruthy()
    results.push({
      legacy,
      publishes: unrelated.publishes,
      unrelatedCommits: unrelated.reactCommits,
      relevantPublishes: relevant.publishes,
      relevantCommits: relevant.reactCommits,
    })
    view.unmount()
    storeStats.enable(false)
  }
  // The legacy arm cannot satisfy the zero-commit assertion; useful updates
  // remain equal, so simply suppressing all notifications cannot pass.
  expect(results).toEqual([
    { legacy: true, publishes: 3, unrelatedCommits: 3, relevantPublishes: 1, relevantCommits: 1 },
    { legacy: false, publishes: 3, unrelatedCommits: 0, relevantPublishes: 1, relevantCommits: 1 },
  ])
})
