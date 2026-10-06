// @vitest-environment happy-dom
import type { PodiumClientApi } from '@podium/client-core/api'
import type { ClientRuntime } from '@podium/client-core/engine'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider } from '@podium/client-core/react'
import { createKernelReplica, createSideCache, memoryStorage } from '@podium/client-core/replica'
import { asUserId } from '@podium/model/browser'
import { getObserverTree } from 'mobx'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MobxPool } from '../pool'
import * as runtimePool from '../runtime-pool'
import { createPoolHost } from './pool-host'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PROJECTION_NAME = 'PoolProjectionProbe'
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const stop of cleanups.splice(0).reverse()) stop()
})

async function mount(inline: boolean, initiallyActive = true, retainWhileInactive = false) {
  const original = runtimePool.createPoolProjection
  const create = vi.spyOn(runtimePool, 'createPoolProjection')
  const subscriptions: (() => number)[] = []
  create.mockImplementation(<T,>(
    pool: MobxPool,
    read: (pool: MobxPool) => T,
    options?: Parameters<typeof original>[2],
  ) => {
    const view = original(pool, read, { ...options, name: PROJECTION_NAME })
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
  const paints = { selected: { selected: true }, empty: { selected: false } }
  const read = (current: MobxPool) => {
    reads++
    return current.selection.size > 0 && current.selection.has('projection-target')
      ? paints.selected
      : paints.empty
  }
  let reader = read
  let target = 'projection-target'
  let active = initiallyActive
  // The projection owns tracking. A fresh callback keeps the inline-reader
  // contract without making the component itself an observable consumer.
  const freshReader = (captured: string) => (current: MobxPool) => {
    reads++
    return current.selection.size > 0 && current.selection.has(captured)
      ? paints.selected
      : paints.empty
  }
  // This fixture counts ordinary hook-driven renders, including an unchanged
  // parent render. Keep it plain and give React its name without an observer
  // or memo wrapper that would skip the render being measured.
  const Probe = Object.assign(
    () => {
      renders++
      const captured = target
      pool = host.usePool()
      snapshot = host.usePoolProjection(
        inline ? freshReader(captured) : reader,
        null,
        active,
        retainWhileInactive,
      )
      return null
    },
    { displayName: 'PoolProjectionProbe' },
  )
  const replica = createKernelReplica({
    cache: {
      readCursor: () => null,
      readEntities: () => [],
      read: () => undefined,
      durability: () => 'durable',
    },
    side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }),
  })
  const container = document.createElement('div')
  const root: Root = createRoot(container)
  let unmounted = false
  const unmount = () => {
    if (unmounted) return
    unmounted = true
    act(() => root.unmount())
  }
  cleanups.push(() => {
    unmount()
    container.remove()
  })
  const principal = asClientPrincipal(asUserId('projection-count'))
  const config = { httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }
  const api = {} as PodiumClientApi
  function render() {
    act(() =>
      root.render(
        <StoreProvider
          principal={principal}
          config={config}
          api={api}
          createReplicaFn={() => replica}
          networkEnabled={false}
          onFatalError={(message) => {
            throw new Error(message)
          }}
          attachRuntime={(owner) => {
            runtime = owner
            return host.attach(owner, (error) => {
              throw error
            })
          }}
        >
          <Probe />
        </StoreProvider>,
      ),
    )
  }
  render()
  await vi.waitFor(async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(pool).not.toBeNull()
  })
  expect(pool).not.toBeNull()
  if (initiallyActive) expect(snapshot).not.toBeNull()
  return {
    reads: () => reads,
    renders: () => renders,
    snapshot: () => snapshot!,
    projections: () => create.mock.calls.length,
    subscriptions: () => subscriptions.reduce((sum, count) => sum + count(), 0),
    observers: () => getObserverTree(pool!.selection).observers?.length ?? 0,
    // The host also owns a standing sidebar selection reaction. Count this
    // probe's projection separately; unmount still checks every observer.
    projectionObservers: () =>
      getObserverTree(pool!.selection).observers?.filter((observer) => observer.name === PROJECTION_NAME)
        .length ?? 0,
    unmount,
    render,
    focus: (value: boolean) => {
      active = value
      render()
    },
    replaceReader: () => {
      reader = (current) => read(current)
      render()
    },
    capture: (id: string) => {
      target = id
      render()
    },
    select: (id: string) =>
      act(async () => {
        const publisher = runtime as unknown as {
          apply(patch: { selectedIssueId: string | null }): void
        }
        publisher.apply({ selectedIssueId: id })
      }),
    change: () =>
      act(async () => {
        const publisher = runtime as unknown as {
          apply(patch: { selectedIssueId: string | null }): void
        }
        publisher.apply({ selectedIssueId: snapshot!.selected ? null : 'projection-target' })
      }),
  }
}

describe('real host projection read counts', () => {
  it('keeps a visited fold lazy while hidden and releases its dependencies on unmount', async () => {
    const fixture = await mount(false, true, true)
    fixture.focus(false)
    expect(fixture.projectionObservers()).toBe(1)
    const reads = fixture.reads(), renders = fixture.renders()
    await fixture.select('another-target')
    await fixture.select('projection-target')
    expect(fixture.reads()).toBe(reads)
    expect(fixture.renders()).toBe(renders)
    fixture.focus(true)
    expect(fixture.snapshot()).toEqual({ selected: true })
    expect(fixture.reads() - reads).toBe(1)
    fixture.focus(false)
    fixture.unmount()
    expect(fixture.observers()).toBe(0)
  })

  it('keeps a mounted hidden tab quiet and catches up once on focus', async () => {
    const fixture = await mount(false)
    const first = fixture.snapshot()
    fixture.focus(false)
    const reads = fixture.reads(),
      renders = fixture.renders()
    await fixture.select('projection-target')
    await fixture.select('another-target')
    await fixture.select('projection-target')
    expect(fixture.reads()).toBe(reads)
    expect(fixture.renders()).toBe(renders)
    expect(fixture.snapshot()).toBe(first)
    fixture.focus(true)
    expect(fixture.reads() - reads).toBe(1)
    expect(fixture.snapshot()).toEqual({ selected: true })
  })

  it('does not demand an initially hidden tab before its first focus', async () => {
    const fixture = await mount(false, false)
    expect(fixture.reads()).toBe(0)
    await fixture.select('projection-target')
    expect(fixture.reads()).toBe(0)
    fixture.focus(true)
    expect(fixture.reads()).toBe(1)
    expect(fixture.snapshot()).toEqual({ selected: true })
  })

  it.each([
    false,
    true,
  ])('measures first mount and a real selection update (inline=%s)', async (inline) => {
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
    console.info('[pool projection counts]', {
      inline,
      firstMount,
      perChange,
      parentRerender,
      stableOnRerender: fixture.snapshot() === updated,
    })
    // The equality gate derives once per publication. A fresh inline closure
    // gets one additional evaluation in render, without replacing the view.
    expect(perChange).toBe(inline ? 2 : 1)
    expect(firstMount).toBe(1)
    expect(parentRerender).toBe(inline ? 1 : 0)
    expect(fixture.snapshot()).toBe(updated)
    expect(fixture.projections()).toBe(1)
    expect(fixture.subscriptions()).toBe(1)
  })

  it.each([
    false,
    true,
  ])('does not render the owner for structurally equal results (inline=%s)', async (inline) => {
    const fixture = await mount(inline)
    const snapshot = fixture.snapshot()
    const reads = fixture.reads(),
      renders = fixture.renders()
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
