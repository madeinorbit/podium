import { vi } from 'vitest'
import { useRuntimeSelector as selectMockSnapshot } from '@/app/store'
import { fixtureStoreSnapshot } from './fixture-store'

// Borrow the suite's existing action owner; leave its pool hooks to the suite.
vi.mock('@podium/client-core/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@podium/client-core/react')>()
  const owner = {
    get access() { return fixtureStoreSnapshot(selectMockSnapshot((state) => state)) },
  }
  return { ...actual, useStoreHandle: () => owner, useHarnessDescriptors: () => ({ served: [] }) }
})
