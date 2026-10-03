// @vitest-environment happy-dom
import type { PodiumClientApi } from '@podium/client-core/api'
import type { ClientRuntime } from '@podium/client-core/engine'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider } from '@podium/client-core/react'
import { createKernelReplica, createSideCache, memoryStorage } from '@podium/client-core/replica'
import { asUserId } from '@podium/model/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { MobxPool } from '../pool'
import { createPoolHost } from './pool-host'
import { poolSwitches } from './switches'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const stop of cleanups.splice(0).reverse()) stop()
})

async function mount(inline: boolean) {
  const pilot = poolSwitches(() => ({ get: () => null, device: () => true }))('mobxProjection')
  const host = createPoolHost({
    dev: false,
    screens: [{ initialize: (ui) => { pilot.initialize(ui) }, enabled: () => pilot.layer() === 'pool' }],
  })
  let runtime: ClientRuntime
  let pool: MobxPool | null = null
  let reads = 0
  let snapshot: { now: number } | null = null
  const read = (current: MobxPool) => {
    reads++
    return { now: current.clock.current }
  }
  function Probe() {
    pool = host.usePool()
    snapshot = host.usePoolProjection(inline ? (current) => read(current) : read, null)
    return null
  }
  const replica = createKernelReplica({
    cache: { readCursor: () => null, readEntities: () => [], read: () => undefined, durability: () => 'durable' },
    side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }),
  })
  const container = document.createElement('div')
  const root: Root = createRoot(container)
  cleanups.push(() => { act(() => root.unmount()); container.remove() })
  const principal = asClientPrincipal(asUserId('projection-count'))
  const config = { httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }
  const api = {} as PodiumClientApi
  function render() {
    act(() => root.render(
      <StoreProvider
        principal={principal} config={config} api={api} createReplicaFn={() => replica}
        networkEnabled={false} onFatalError={(message) => { throw new Error(message) }}
        attachRuntime={(owner) => {
          runtime = owner
          return host.attach(owner, (error) => { throw error })
        }}
      >
        <Probe />
      </StoreProvider>,
    ))
  }
  render()
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  expect(pilot.layer()).toBe('pool')
  expect(pool).not.toBeNull()
  expect(snapshot).not.toBeNull()
  return {
    reads: () => reads,
    snapshot: () => snapshot!,
    render,
    tick: () => act(() => {
      const publisher = runtime as unknown as { apply(patch: { coarseNow: number }): void }
      publisher.apply({ coarseNow: snapshot!.now + 60_000 })
    }),
  }
}

describe('real host projection read counts with the pilot on', () => {
  it.each([false, true])('measures first mount and a real clock update (inline=%s)', async (inline) => {
    const fixture = await mount(inline)
    const firstMount = fixture.reads()
    const first = fixture.snapshot()
    fixture.tick()
    const perChange = fixture.reads() - firstMount
    expect(fixture.snapshot().now).toBe(first.now + 60_000)
    const updated = fixture.snapshot()
    const beforeRerender = fixture.reads()
    fixture.render()
    const parentRerender = fixture.reads() - beforeRerender
    console.info('[pool projection counts]', { inline, firstMount, perChange, parentRerender,
      stableOnRerender: fixture.snapshot() === updated })
    expect(firstMount).toBe(2)
    expect(perChange).toBe(inline ? 3 : 1)
    expect(parentRerender).toBe(inline ? 2 : 0)
  })
})
