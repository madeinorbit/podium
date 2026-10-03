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
import '../runtime-pool'
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
  let snapshot: { selected: boolean } | null = null
  const read = (current: MobxPool) => {
    reads++
    return { selected: current.selection.has('projection-target') }
  }
  let reader = read
  function Probe() {
    pool = host.usePool()
    snapshot = host.usePoolProjection(inline ? (current) => read(current) : reader, null)
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
  await vi.waitFor(async () => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(pool).not.toBeNull()
  })
  expect(pilot.layer()).toBe('pool')
  expect(pool).not.toBeNull()
  expect(snapshot).not.toBeNull()
  return {
    reads: () => reads,
    snapshot: () => snapshot!,
    render,
    replaceReader: () => { reader = (current) => read(current); render() },
    change: () => act(async () => {
      const publisher = runtime as unknown as { apply(patch: { selectedIssueId: string | null }): void }
      publisher.apply({ selectedIssueId: snapshot!.selected ? null : 'projection-target' })
    }),
  }
}

describe('real host projection read counts with the pilot on', () => {
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
    // One tracked read per projection; a new inline closure replaces the reader.
    expect(firstMount).toBe(1)
    expect(perChange).toBe(inline ? 2 : 1)
    expect(parentRerender).toBe(inline ? 1 : 0)
    if (!inline) expect(fixture.snapshot()).toBe(updated)
  })

  it('measures a changed reader such as a screen navigation callback', async () => {
    const fixture = await mount(false)
    const before = fixture.reads()
    fixture.replaceReader()
    const readerChange = fixture.reads() - before
    console.info('[pool projection reader change]', { readerChange })
    expect(readerChange).toBe(1)
  })
})
