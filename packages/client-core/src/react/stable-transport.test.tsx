import { withKeyedInputs } from '../../test-support/keyed-inputs'

// @vitest-environment happy-dom
import { asUserId } from '@podium/model'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { PodiumClientApi } from '../api'
import type { Store } from '../engine/types'
import { storeStats } from '../perf/store-stats'
import { asClientPrincipal } from '../principal'
import { createSubscriptionStore } from '../../test-support/local-store'
import { StoreProvider } from './provider'
import { useHarnessDescriptors } from './use-harness-descriptors'
import { useRepoLocks } from './use-merge-lock'
import { useModelCatalogState } from './use-model-catalog'
import { usePresenceRoom } from './use-presence-room'

const fixture = vi.hoisted(() => ({ handle: null as unknown }))
vi.mock('../engine/runtime', () => ({ createClientRuntime: () => fixture.handle }))
afterEach(() => { cleanup(); storeStats.enable(false); storeStats.reset() })

it('acquires every shared transport without legacy subscriptions or derivations', async () => {
  const api = {} as PodiumClientApi
  const owner = { start() {}, dispose() {}, destroy() {} }
  const snapshot = { trpc: api, hub: undefined, coarseNow: 0 } as unknown as Store
  const store = createSubscriptionStore(snapshot, undefined, owner)
  const subscribe = vi.fn(store.subscribe)
  fixture.handle = withKeyedInputs(Object.assign(owner, store, { subscribe }))
  function Reader() {
    const catalog = useModelCatalogState()
    const descriptors = useHarnessDescriptors(undefined)
    const locks = useRepoLocks(null)
    const presence = usePresenceRoom(null)
    return <span>{catalog.status}:{descriptors.status}:{locks.locks.length}:{presence.status}</span>
  }
  const view = render(<StoreProvider
    principal={asClientPrincipal(asUserId('access'))}
    config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }}
    api={api} networkEnabled={false} onFatalError={() => {}}
    createReplicaFn={() => { throw new Error('fixture owns runtime') }}
  ><Reader /></StoreProvider>)
  await act(async () => {})
  expect(view.container.textContent).toBe('unavailable:unavailable:0:unknown')
  expect(subscribe).not.toHaveBeenCalled()
  storeStats.enable()
  act(() => {
    for (let coarseNow = 1; coarseNow <= 20; coarseNow++) {
      store.publish({ ...snapshot, coarseNow }, new Set(['coarseNow']))
    }
  })
  expect(storeStats.snapshot().runtimes).toHaveLength(1)
  expect(storeStats.snapshot().runtimes[0]).toMatchObject({
    publishes: 20, subscriberWakes: 0, selectorRuns: 0, selectorCacheMisses: 0, slices: {},
  })
})
