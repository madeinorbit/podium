import { vi } from 'vitest'

// Focused ChatView suites replace the web store and mount no client-core
// StoreProvider. Keep the production hooks strict while supplying the two
// provider-backed reads reached by these renders.
vi.mock('@podium/client-core/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@podium/client-core/react')>()),
  useModelCatalog: () => ({}),
  // Served harness descriptors (POD-4475): provider-free suites render
  // against the bundled copy.
  useHarnessDescriptors: () => ({ served: undefined, status: 'unavailable' as const }),
  useStoreHandle: () => ({ getSnapshot: () => ({ issues: [] }) }),
}))
