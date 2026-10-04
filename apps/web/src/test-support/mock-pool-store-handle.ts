import { withKeyedInputs, workspaceKeyForState } from '@podium/client-core/engine'
import { vi } from 'vitest'
import { useStoreSelector as selectMockSnapshot } from '@/app/store'
import { fixtureStoreSnapshot } from './fixture-store'
import { syncPoolFixture } from './pool-fixture'

// Opt-in for suites using the real pool fixture. Stable accessors
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
    subscribe: (notify: () => void) =>
      selectMockSnapshot((state) => state.uiState)?.subscribe(notify) ?? (() => {}),
  })
  return { ...actual, useStoreHandle: () => owner, useHarnessDescriptors: () => ({ served: [] }) }
})
