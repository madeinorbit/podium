import type { PodiumClientApi } from '@podium/client-core/api'
import { ClientRuntime } from '@podium/client-core/engine'
import { bindSidebarPerf, createSidebarPerf } from '@podium/client-core/perf'
import { asClientPrincipal, type ClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider } from '@podium/client-core/react'
import { createKernelReplica, createSideCache, memoryStorage } from '@podium/client-core/replica'
import type { MobxPool } from '@podium/client-graph'
import { screenOptions } from '@podium/client-graph/host'
import * as runtimePool from '@podium/client-graph/runtime-pool'
import { asUserId } from '@podium/model'
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildCorpus } from '../../../../packages/worklist-proto/harness/src/fixture'
import {
  pickTargets,
  ScenarioCache,
} from '../../../../packages/worklist-proto/shared/src/scenarios'
import { poolBackedScreens } from './pool-screens'
import { attachWorklistPool, useWorklistPool } from './store-worklist-pool'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const corpus = buildCorpus(1)
const id = pickTargets(corpus).visibleRootId
const config = { httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }
const api = {} as PodiumClientApi
const principal = (name: string) => asClientPrincipal(asUserId(name))
const alice = principal('pool-alice')
const bob = principal('pool-bob')
let root: Root
let container: HTMLDivElement
let shown: MobxPool | null
let runtime: ClientRuntime | null
const errors: Error[] = []

function Probe(): null {
  shown = useWorklistPool()
  return null
}

const replicaFactory = vi.fn(() => {
  const cache = new ScenarioCache()
  cache.put('issueProjection', id, corpus.issueProjections.find((row) => row.id === id)!)
  return createKernelReplica({
    cache,
    side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }),
  })
})

function binding(next: ClientRuntime): () => void {
  runtime = next
  return attachWorklistPool(next, (error) => errors.push(error))
}

function render(
  who: ClientPrincipal | null = alice,
  options: { config?: typeof config; strict?: boolean } = {},
): void {
  const provider = (
    <StoreProvider
      principal={who}
      config={options.config ?? config}
      api={api}
      createReplicaFn={replicaFactory}
      onFatalError={() => {}}
      networkEnabled={false}
      attachRuntime={binding}
    >
      <Probe />
    </StoreProvider>
  )
  act(() => root.render(options.strict ? <StrictMode>{provider}</StrictMode> : provider))
}

async function ready(): Promise<MobxPool> {
  await vi.waitFor(async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(shown).not.toBeNull()
  })
  return shown!
}

beforeEach(() => {
  shown = null
  runtime = null
  errors.length = 0
  replicaFactory.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  shown = null
  runtime = null
  vi.restoreAllMocks()
})

describe('StoreProvider owns the sidebar pool', () => {
  it('builds exactly one pool from its own runtime and replica and reuses it on rerender', async () => {
    const create = vi.spyOn(runtimePool, 'createRuntimeWorklistPool')
    render()
    const pool = await ready()
    expect(create).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledExactlyOnceWith(
      runtime,
      screenOptions(poolBackedScreens, runtime!),
    )
    expect(replicaFactory).toHaveBeenCalledTimes(1)
    expect(runtime!.replica).toBe(runtime!.getSnapshot().replica)
    render()
    expect(await ready()).toBe(pool)
    expect(create).toHaveBeenCalledTimes(1)
    expect(errors).toEqual([])
  })

  it.each([
    'principal',
    'sign-out',
    'rebuild',
  ] as const)('disposes the old pool before runtime destruction on %s', async (change) => {
    render()
    const old = await ready()
    const dispose = vi.spyOn(old, 'dispose')
    const destroy = vi.spyOn(ClientRuntime.prototype, 'destroy').mockImplementation(function (
      this: ClientRuntime,
    ) {
      expect(dispose).toHaveBeenCalledTimes(1)
      return originalDestroy.call(this)
    })
    const oldRuntime = runtime!
    render(
      change === 'sign-out' ? null : change === 'principal' ? bob : alice,
      change === 'rebuild' ? { config: { ...config } } : {},
    )
    expect(destroy).toHaveBeenCalledTimes(1)
    expect(oldRuntime.isDestroyed).toBe(true)
    if (change !== 'sign-out') expect(await ready()).not.toBe(old)
  })

  it('disposes the pool before runtime disposal on unmount', async () => {
    render()
    const pool = await ready()
    const disposePool = vi.spyOn(pool, 'dispose')
    vi.spyOn(runtime!, 'dispose').mockImplementation(function (this: ClientRuntime) {
      expect(disposePool).toHaveBeenCalledTimes(1)
      originalDispose.call(this)
    })
    act(() => root.render(null))
    expect(disposePool).toHaveBeenCalledTimes(1)
  })

  it('builds the workspace pool with retired overrides off', async () => {
    history.replaceState(
      null,
      '',
      '/?mobxSidebar=0&mobxPane=0&mobxHeader=0&mobxSessionPane=0&mobxBoard=0',
    )
    const create = vi.spyOn(runtimePool, 'createRuntimeWorklistPool')
    render()
    await ready()
    expect(create).toHaveBeenCalledTimes(1)
    expect(replicaFactory).toHaveBeenCalledTimes(1)
    history.replaceState(null, '', '/')
  })

  it('publishes resident counts on late panel open and clears them on sign-out', async () => {
    render()
    const pool = await ready()
    const perf = createSidebarPerf()
    const close = bindSidebarPerf(runtime!, perf)
    const row = vi.spyOn(pool, 'row')
    const snapshots = vi.spyOn(runtime!, 'getSnapshot')
    try {
      expect(perf.read().pool).toEqual({ connected: true, rows: 1 })
      for (let i = 0; i < 100; i++) perf.read()
      expect(row).not.toHaveBeenCalled()
      expect(snapshots).not.toHaveBeenCalled()
      render(null)
      expect(perf.read().pool).toEqual({ connected: false, rows: null })
    } finally {
      close()
    }
  })

  it('cancels an attachment disposed before its import resolves', async () => {
    const create = vi.spyOn(runtimePool, 'createRuntimeWorklistPool')
    render()
    render(null)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(create).not.toHaveBeenCalled()
    expect(errors).toEqual([])
  })

  it('StrictMode re-arms the attachment without keeping the discarded pool', async () => {
    const create = vi.spyOn(runtimePool, 'createRuntimeWorklistPool')
    render(alice, { strict: true })
    await ready()
    expect(create).toHaveBeenCalledTimes(1)
    expect(errors).toEqual([])
  })
})

const originalDestroy = ClientRuntime.prototype.destroy
const originalDispose = ClientRuntime.prototype.dispose
