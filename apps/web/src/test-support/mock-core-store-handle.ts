import { vi } from 'vitest'
import { useStoreSelector as selectMockSnapshot } from '@/app/store'
import { fixtureStoreSnapshot } from './fixture-store'
import { syncPoolFixture } from './pool-fixture'
import './mock-screen-pool'

// Opt-in for provider-free suites that replace the web store. Stable accessors
// must reach the SAME fake owner as the suite's reactive selectors. Keeping this
// out of global setup leaves real-provider and missing-provider checks intact.
vi.mock('@podium/client-core/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@podium/client-core/react')>()
  const owner = {
    getSnapshot: () =>
      fixtureStoreSnapshot(
        selectMockSnapshot((state) => state),
        () =>
          syncPoolFixture(
            selectMockSnapshot((state) => state),
            true,
          ),
      ),
  }
  return { ...actual, useStoreHandle: () => owner, useHarnessDescriptors: () => ({ served: [] }) }
})
