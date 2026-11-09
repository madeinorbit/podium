import { withKeyedInputs } from '@podium/client-core/test-support/keyed-inputs'
import { workspaceKeyForState } from '@podium/client-core/ui'
import { vi } from 'vitest'
import { fixtureSnapshot as selectLocals } from '@/test-support/fixture-snapshot'
import type { ReferenceState } from '../../../../tests/worklist/diagnostics/reference-state'

const selectMockSnapshot = selectLocals as unknown as <T>(read: (state: ReferenceState) => T) => T

import { fixtureStoreSnapshot } from './fixture-store'
import { syncPoolFixture } from './pool-fixture'

// Opt-in for suites using the real pool fixture. Stable accessors
// must reach the SAME fake owner as the suite's reactive selectors. Keeping this
// out of global setup leaves real-provider and missing-provider checks intact.
vi.mock('@podium/client-core/react', async (importOriginal) => {
  const { fixtureRuntimeHooks } = await import('@podium/client-core/test-support/command-hooks')

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
    services: {},
    subscribe: (notify: () => void) =>
      selectMockSnapshot((state) => state.uiState)?.subscribe(notify) ?? (() => {}),
  })
  Object.defineProperties(owner, {
    hub: { get: () => selectMockSnapshot((state) => state.hub) },
    replica: { get: () => selectMockSnapshot((state) => state.replica) },
  })
  return {
    ...actual,
    ...fixtureRuntimeHooks(() => owner),
    ...(await import('@podium/client-core/test-support/react')).fixtureUiHooks(() => owner),
    useHarnessDescriptors: () => ({ served: [] }),
  }
})
