// @vitest-environment happy-dom
import { asUserId } from '@podium/model'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { withKeyedInputs } from '../../test-support/keyed-inputs'
import { createSubscriptionStore } from '../../test-support/local-store'
import type { PodiumClientApi } from '../api'
import type { Store } from '../engine/types'
import { storeStats } from '../perf/store-stats'
import { asClientPrincipal } from '../principal'
import { StoreProvider } from './provider'
import { useHarnessDescriptors } from './use-harness-descriptors'
import { useModelCatalogState } from './use-model-catalog'
import { usePresenceRoom } from './use-presence-room'

const fixture = vi.hoisted(() => ({ handle: null as unknown }))
vi.mock('../engine/runtime', () => ({ createClientRuntime: () => fixture.handle }))
afterEach(() => {
  cleanup()
  storeStats.enable(false)
  storeStats.reset()
})

it('acquires every shared transport without legacy subscriptions or derivations', async () => {
  const api = {} as PodiumClientApi
  const owner = { start() {}, dispose() {}, destroy() {} }
  const snapshot = { trpc: api, hub: undefined, reposLoading: false } as unknown as Store
  const store = createSubscriptionStore(snapshot, undefined, owner)
  const subscribe = vi.fn(store.subscribe)
  fixture.handle = withKeyedInputs(Object.assign(owner, store, { subscribe }))
  function Reader() {
    const catalog = useModelCatalogState()
    const descriptors = useHarnessDescriptors(undefined)
    const presence = usePresenceRoom(null)
    return (
      <span>
        {catalog.status}:{descriptors.status}:{presence.status}
      </span>
    )
  }
  const view = render(
    <StoreProvider
      principal={asClientPrincipal(asUserId('access'))}
      config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }}
      api={api}
      networkEnabled={false}
      onFatalError={() => {}}
      createReplicaFn={() => {
        throw new Error('fixture owns runtime')
      }}
    >
      <Reader />
    </StoreProvider>,
  )
  await act(async () => {})
  expect(view.container.textContent).toBe('unavailable:unavailable:unknown')
  expect(subscribe).not.toHaveBeenCalled()
  storeStats.enable()
  act(() => {
    for (let n = 1; n <= 20; n++) {
      store.publish({ ...snapshot, reposLoading: n % 2 === 1 }, new Set(['reposLoading']))
    }
  })
  expect(storeStats.snapshot().runtimes).toHaveLength(1)
  expect(storeStats.snapshot().runtimes[0]).toMatchObject({
    publishes: 20,
    subscriberWakes: 0,
    selectorRuns: 0,
    selectorCacheMisses: 0,
    slices: {},
  })
})
