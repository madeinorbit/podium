// @vitest-environment happy-dom
import type { PodiumClientApi } from '@podium/client-core/api'
import type { ClientRuntime } from '@podium/client-core/engine'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider } from '@podium/client-core/react'
import { createKernelReplica, createSideCache, memoryStorage } from '@podium/client-core/replica'
import { asUserId } from '@podium/model/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MobxPool } from '../pool'
import * as runtimePool from '../runtime-pool'
import { createPoolHost } from './pool-host'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const stop of cleanups.splice(0).reverse()) stop()
})

async function mount(inline: boolean) {
  const original = runtimePool.createPoolProjection
  const create = vi.spyOn(runtimePool, 'createPoolProjection')
  const subscriptions: (() => number)[] = []
  create.mockImplementation(<T,>(pool: MobxPool, read: (pool: MobxPool) => T) => {
    const view = original(pool, read)
    const subscribe = vi.spyOn(view, 'subscribe')
    subscriptions.push(() => subscribe.mock.calls.length)
    return view
  })
  cleanups.push(() => vi.restoreAllMocks())
  const host = createPoolHost({
    dev: false,
    screens: [{ id: 'projection' }],
  })
  let runtime: ClientRuntime
  let pool: MobxPool | null = null
  let reads = 0
  let renders = 0
  let snapshot: { selected: boolean } | null = null
  const read = (current: MobxPool) => {
    reads++
    return { selected: current.selection.size > 0 && current.selection.has('projection-target') }
  }
  let reader = read
  let target = 'projection-target'
  // The projection owns tracking. A fresh callback keeps the inline-reader
  // contract without making the component itself an observable consumer.
  const freshReader = (captured: string) => (current: MobxPool) => {
    reads++
    return { selected: current.selection.size > 0 && current.selection.has(captured) }
  }
  // This fixture counts ordinary hook-driven renders, including an unchanged
  // parent render. Keep it plain and give React its name without an observer
  // or memo wrapper that would skip the render being measured.
  const Probe = Object.assign(() => {
    renders++
    const captured = target
    pool = host.usePool()
    snapshot = host.usePoolProjection(inline ? freshReader(captured) : reader, null)
    return null
  }, { displayName: 'PoolProjectionProbe' })
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
  await vi.waitFor(async () => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(pool).not.toBeNull()
  })
  expect(pool).not.toBeNull()
  expect(snapshot).not.toBeNull()
  return {
    reads: () => reads,
    renders: () => renders,
    snapshot: () => snapshot!,
    projections: () => create.mock.calls.length,
    subscriptions: () => subscriptions.reduce((sum, count) => sum + count(), 0),
    render,
    replaceReader: () => { reader = (current) => read(current); render() },
    capture: (id: string) => { target = id; render() },
    select: (id: string) => act(async () => {
      const publisher = runtime as unknown as { apply(patch: { selectedIssueId: string | null }): void }
      publisher.apply({ selectedIssueId: id })
    }),
    change: () => act(async () => {
      const publisher = runtime as unknown as { apply(patch: { selectedIssueId: string | null }): void }
      publisher.apply({ selectedIssueId: snapshot!.selected ? null : 'projection-target' })
    }),
  }
}

describe('real host projection read counts', () => {
  it.each([false, true])('measures first mount and a real selection update (inline=%s)', async (inline) => {
    const fixture = await mount(inline)
    const firstMount = fixture.reads()
    const first = fixture.snapshot()
    await fixture.change()
    const perChange = fixture.reads() - firstMount
    expect(fixture.snapshot().selected).toBe(!first.selected)
    const updated = fixture.snapshot()
    const beforeRerender = fixture.reads()
    fixture.render()
    const parentRerender = fixture.reads() - beforeRerender
    console.info('[pool projection counts]', { inline, firstMount, perChange, parentRerender,
      stableOnRerender: fixture.snapshot() === updated })
    // The equality gate derives once per publication. A fresh inline closure
    // gets one additional evaluation in render, without replacing the view.
    expect(perChange).toBe(inline ? 2 : 1)
    expect(firstMount).toBe(1)
    expect(parentRerender).toBe(inline ? 1 : 0)
    expect(fixture.snapshot()).toBe(updated)
    expect(fixture.projections()).toBe(1)
    expect(fixture.subscriptions()).toBe(1)
  })

  it.each([false, true])('does not render the owner for structurally equal results (inline=%s)', async (inline) => {
    const fixture = await mount(inline)
    const snapshot = fixture.snapshot()
    const reads = fixture.reads(), renders = fixture.renders()
    await fixture.select('another-target')
    expect(fixture.reads() - reads).toBe(1)
    expect(fixture.renders()).toBe(renders)
    expect(fixture.snapshot()).toBe(snapshot)
    expect(fixture.projections()).toBe(1)
    expect(fixture.subscriptions()).toBe(1)
  })

  it('measures a changed reader such as a screen navigation callback', async () => {
    const fixture = await mount(false)
    const before = fixture.reads()
    fixture.replaceReader()
    const readerChange = fixture.reads() - before
    console.info('[pool projection reader change]', { readerChange })
    expect(readerChange).toBe(1)
    expect(fixture.projections()).toBe(1)
    expect(fixture.subscriptions()).toBe(1)
  })

  it('adopts changed captures without a pool publication or subscription replacement', async () => {
    const fixture = await mount(true)
    await fixture.change()
    expect(fixture.snapshot().selected).toBe(true)
    const before = fixture.reads()
    fixture.capture('another-target')
    expect(fixture.snapshot().selected).toBe(false)
    expect(fixture.reads() - before).toBe(1)
    expect(fixture.projections()).toBe(1)
    expect(fixture.subscriptions()).toBe(1)
  })
})
