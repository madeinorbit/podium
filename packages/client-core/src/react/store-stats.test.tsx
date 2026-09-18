// @vitest-environment happy-dom
import { asUserId } from '@podium/model'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { PodiumClientApi } from '../api'
import type { Store } from '../engine/types'
import { readStoreStats, storeStats } from '../perf/store-stats'
import { asClientPrincipal } from '../principal'
import { createSubscriptionStore } from '../store'
import { StoreProvider, useStoreSelector } from './provider'
import { StoreStatsProfiler } from './store-stats-profiler'
import { useSlice } from './use-slice'

const fixture = vi.hoisted(() => ({ handle: null as unknown }))
vi.mock('../engine/runtime', () => ({ createClientRuntime: () => fixture.handle }))
afterEach(() => {
  cleanup()
  storeStats.enable(false)
  storeStats.reset()
})

const select = (s: Store<PodiumClientApi>) => s.view
const slice = { name: 'view', derive: select }
function Reader() {
  const selected = useStoreSelector(select)
  const sliced = useSlice(slice)
  return (
    <span>
      {selected}:{sliced}
    </span>
  )
}

it('reports one feed batch through the real selector and slice hooks, with separate React commits', () => {
  const owner = { start() {}, dispose() {}, destroy() {} }
  const store = createSubscriptionStore(
    { view: 'workspace' } as Store<PodiumClientApi>,
    undefined,
    owner,
  )
  const handle = Object.assign(owner, store)
  fixture.handle = handle
  const api = {} as PodiumClientApi
  const view = render(
    <StoreProvider
      principal={asClientPrincipal(asUserId('test'))}
      config={{ httpOrigin: 'http://test', wsClientUrl: 'ws://test' }}
      api={api}
      onFatalError={() => {}}
      createReplicaFn={() => {
        throw new Error('mock runtime')
      }}
    >
      <StoreStatsProfiler>
        <Reader />
        <Reader />
      </StoreStatsProfiler>
    </StoreProvider>,
  )
  storeStats.enable()
  const window = storeStats.begin('feed')
  act(() => store.publish({ view: 'issues' } as Store<PodiumClientApi>, new Set(['view'])))
  storeStats.end(window)
  const report = readStoreStats()
  expect(report.runtimes).toHaveLength(1)
  expect(report.runtimes[0]).toMatchObject({
    publishes: 1,
    nestedPublishes: 0,
    subscriberWakes: 4,
    selectorRuns: 2,
    selectorCacheMisses: 2,
    slices: { view: 1 },
    rowBuilds: 0,
    reactCommits: 1,
  })
  expect(report.windows[0]?.runtimes).toEqual(report.runtimes)
  expect(view.container.textContent).toBe('issues:issuesissues:issues')
  console.info('[store-stats feed fixture]', JSON.stringify(report.windows[0]))
  act(() => store.publish({ view: 'issues' } as Store<PodiumClientApi>))
  expect(readStoreStats()).toEqual(report)

  // A fresh snapshot whose selected value is unchanged still runs selectors
  // and derives the slice, but commits NOTHING. This is the counter's NO case.
  storeStats.reset()
  act(() => store.publish({ view: 'issues', coarseNow: 1 } as Store<PodiumClientApi>))
  expect(readStoreStats().runtimes[0]).toMatchObject({
    publishes: 1,
    subscriberWakes: 4,
    selectorRuns: 2,
    slices: { view: 1 },
    reactCommits: 0,
  })
})
