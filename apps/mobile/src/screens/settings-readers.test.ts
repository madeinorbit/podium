import type { ClientRuntime, Store } from '@podium/client-core/engine'
import { MobxPool } from '@podium/client-graph'
import { createMobileSettingsSource } from '@podium/client-graph/mobile-settings'
import { createPoolProjection } from '@podium/client-graph/runtime-pool'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { afterEach, expect, it, vi } from 'vitest'

const stops: (() => void)[] = []
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
})

async function fixture() {
  const runtimeListeners = new Set<() => void>()
  // A huge array-like inventory catches accidental payload iteration without
  // allocating it; the production seam only needs its maintained length.
  const inventory = (length: number) =>
    new Proxy(
      { length },
      {
        get(target, key) {
          if (key !== 'length') throw new Error(`payload walk: ${String(key)}`)
          return target.length
        },
      },
    )
  let state = { issueProjections: inventory(100_000), conversations: inventory(5) }
  let cursor: ReturnType<ClientRuntime['replica']['getCursor']> = null
  const read = vi.fn(() => state as unknown as Pick<Store, 'issueProjections' | 'conversations'>)
  const source = await createMobileSettingsSource({
    getSnapshot: read,
    subscribe: (wake) => {
      runtimeListeners.add(wake)
      return () => {
        runtimeListeners.delete(wake)
      }
    },
    replica: {
      getCursor: () => cursor,
    } as unknown as ClientRuntime['replica'],
  })
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  pool.sources.register(['mobileSettingsDiagnostics'], source)
  stops.push(() => pool.dispose())
  return {
    pool,
    source,
    read,
    runtimeListeners,
    publish(issues: number, conversations: number) {
      state = { issueProjections: inventory(issues), conversations: inventory(conversations) }
      for (const wake of runtimeListeners) wake()
    },
    cursor(next: typeof cursor) {
      cursor = next
      // The real facade intentionally ignores cursor-only events. The existing
      // runtime clock/publication refreshes diagnostic scalars without row churn.
      for (const wake of runtimeListeners) wake()
    },
  }
}

it('batches declared diagnostics and maintains counts without iterating payloads', async () => {
  const f = await fixture()
  expect(f.read).not.toHaveBeenCalled()
  expect(f.pool.row('mobileSettingsDiagnostics', 'diagnostics')).toBe(LOADING)
  expect(f.pool.row('mobileSettingsDiagnostics', 'diagnostics')).toBe(LOADING)
  expect(f.read).not.toHaveBeenCalled()
  await Promise.resolve()
  expect(f.read).toHaveBeenCalledTimes(1)
  expect(f.pool.row('mobileSettingsDiagnostics', 'diagnostics')).toEqual({
    issueCount: 100_000,
    conversationCount: 5,
    cursor: null,
  })
  f.publish(2, 9)
  f.publish(1, 10)
  await Promise.resolve()
  expect(f.source.counts.batches).toBe(2)
  expect(f.pool.row('mobileSettingsDiagnostics', 'diagnostics')).toMatchObject({
    issueCount: 1,
    conversationCount: 10,
  })
})

it('refreshes the cursor on runtime publications and suppresses equal diagnostics', async () => {
  const f = await fixture()
  const view = createPoolProjection(f.pool, (pool) =>
    pool.row('mobileSettingsDiagnostics', 'diagnostics'),
  )
  const wake = vi.fn()
  stops.push(view.subscribe(wake))
  await Promise.resolve()
  wake.mockClear()
  f.publish(100_000, 5)
  await Promise.resolve()
  expect(wake).not.toHaveBeenCalled()
  f.cursor(42)
  await Promise.resolve()
  expect(view.getSnapshot()).toMatchObject({ cursor: 42 })
  expect(wake).toHaveBeenCalledTimes(1)
})

it('unsubscribes at disposal and cancels a pending diagnostic batch', async () => {
  const f = await fixture()
  expect(f.pool.row('mobileSettingsDiagnostics', 'diagnostics')).toBe(LOADING)
  f.pool.dispose()
  expect(f.runtimeListeners.size).toBe(0)
  await Promise.resolve()
  expect(f.read).not.toHaveBeenCalled()
  expect(f.pool.row('mobileSettingsDiagnostics', 'diagnostics')).toBe(LOADING)
})
