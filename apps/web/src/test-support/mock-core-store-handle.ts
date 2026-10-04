import { vi } from 'vitest'
import { withKeyedInputs, workspaceKeyForState } from '@podium/client-core/engine'
import { useStoreSelector as selectMockSnapshot } from '@/app/store'
import { fixtureStoreSnapshot } from './fixture-store'
import { syncPoolFixture } from './pool-fixture'
import './mock-screen-pool'

// Opt-in for provider-free suites that replace the web store. Stable accessors
// must reach the SAME fake owner as the suite's reactive selectors. Keeping this
// out of global setup leaves real-provider and missing-provider checks intact.
vi.mock('@podium/client-core/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@podium/client-core/react')>()
  const owner = withKeyedInputs({
    getSnapshot: () => {
      const state = fixtureStoreSnapshot(
        selectMockSnapshot((state) => state),
        () =>
          syncPoolFixture(
            selectMockSnapshot((state) => state),
            true,
          ),
      )
      if (typeof state.workspaceKey !== 'function')
        state.workspaceKey = () => workspaceKeyForState(state)
      return state
    },
    subscribe: (notify: () => void) => selectMockSnapshot(state => state.uiState)?.subscribe(notify) ?? (() => {}),
  })
  return { ...actual, useStoreHandle: () => owner, useHarnessDescriptors: () => ({ served: [] }) }
})
