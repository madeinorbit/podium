/** The legacy utility fixture supplies an empty pool shell. Give its newly
 * pooled openings a real owner without changing any behavior assertions. */
import { MobxPool } from '@podium/client-graph/pool'
import { afterEach, vi } from 'vitest'

let fallback: MobxPool | undefined
afterEach(() => { fallback?.dispose(); fallback = undefined })
vi.mock('@podium/client-graph/react/opening-view', async importOriginal => {
  const real = await importOriginal<typeof import('@podium/client-graph/react/opening-view')>()
  return {
    ...real,
    useOpeningView<V extends { dispose(): void }>(pool: MobxPool | null, create: (pool: MobxPool) => V): V | null {
      const owner = pool && (typeof pool.apply === 'function' ? pool : fallback ??= new MobxPool({ selectedIssueId: null, coarseNow: 0 }))
      return real.useOpeningView(owner, create)
    },
  }
})
