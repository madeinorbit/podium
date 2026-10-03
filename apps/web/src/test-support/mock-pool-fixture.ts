import { vi } from 'vitest'

vi.mock('@/features/worklist/worklist-motion', () => ({
  WorklistMotion: ({ children }: { children: import('react').ReactNode }) => children,
}))

vi.mock('@/app/store-worklist-pool', async () => ({
  ...(await import('./pool-fixture')).fixturePoolHooks,
}))
