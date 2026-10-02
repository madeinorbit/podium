import { vi } from 'vitest'
import { useStoreSelector as selectMockSnapshot } from '@/app/store'

// Opt-in for provider-free suites that replace the web store. Stable accessors
// must reach the SAME fake owner as the suite's reactive selectors. Keeping this
// out of global setup leaves real-provider and missing-provider checks intact.
vi.mock('@podium/client-core/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@podium/client-core/react')>()
  const owner = { getSnapshot: () => selectMockSnapshot((state) => state) }
  return { ...actual, useStoreHandle: () => owner }
})
