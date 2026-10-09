import '@podium/client-graph/synced-models'
import type { MobxPool } from '@podium/client-graph'
import { act, render as renderReact } from '@testing-library/react'
import { afterEach, vi } from 'vitest'
import { useRuntimeSelector as readFixtureSnapshot } from '@/app/store'
import { syncPoolFixture } from './pool-fixture'

/** Settings fixtures use the real model pool and retain their existing inputs.
 * Publish plain fixture input before React renders, never from a pool read. */
const published = vi.hoisted(() => ({ pool: null as MobxPool | null }))

vi.mock('@/app/store-worklist-pool', async () => {
  const { createPoolProjection } = await import('@podium/client-graph/runtime-pool')
  const { useMemo, useSyncExternalStore } = await import('react')
  const current = () => {
    if (!published.pool) throw new Error('Publish the settings fixture before mounting')
    return published.pool
  }
  return {
    useWorklistPool: current,
    useWorklistPoolProjection<T>(read: (pool: MobxPool) => T, _empty: T) {
      const pool = current()
      const projection = useMemo(() => createPoolProjection(pool, read), [pool, read])
      return useSyncExternalStore(projection.subscribe, projection.getSnapshot)
    },
  }
})

afterEach(() => { published.pool = null })

function publish() {
  const pool = syncPoolFixture(readFixtureSnapshot(state => state))
  pool.sources.view('settings.fixtureCatalog', () => {
    pool.sources.register(['settingsCatalog'], {
      read: () => ({ machines: [...pool.tables.machine.keys()], repositories: [] }),
      dispose() {},
    })
    return {}
  })
  published.pool = pool
}

/** Same testing-library result, with fixture receipt before mount/rerender. */
export function renderSettingsPool(...args: Parameters<typeof renderReact>) {
  publish()
  const view = renderReact(...args)
  return {
    ...view,
    rerender(...next: Parameters<typeof view.rerender>) {
      act(() => { publish() })
      view.rerender(...next)
    },
  }
}
