import { vi } from 'vitest'

vi.mock('@/app/store-worklist-pool', async () => ({
  ...(await import('./pool-fixture')).fixturePoolHooks,
}))
