import { withKeyedInputs } from '@podium/client-core/test-support/keyed-inputs'
import { workspaceKeyForState } from '@podium/client-core/ui'
import { vi } from 'vitest'
import { fixtureSnapshot as selectLocals } from '@/test-support/fixture-snapshot'
import type { ReferenceState } from '../../../../tests/worklist/diagnostics/reference-state'
import { fixtureStoreSnapshot } from './fixture-store'
import { syncPoolFixture } from './pool-fixture'
import './mock-screen-pool'
const selectMockSnapshot = selectLocals as unknown as <T>(
  read: (state: ReferenceState<import('@/app/trpc').Trpc>) => T,
) => T

// Opt-in for provider-free suites that replace the web store. Stable accessors
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
        Object.defineProperty(state, 'workspaceKey', {
          value: () => workspaceKeyForState(state),
          configurable: true,
        })
      return state
    },
    services: {},
    outbox: { pending: () => [], subscribe: () => () => {} },
    subscribe: (notify: () => void) =>
      selectMockSnapshot((state) => state.uiState)?.subscribe(notify) ?? (() => {}),
  })
  return {
    ...actual,
    ...fixtureRuntimeHooks(() => owner),
    ...(await import('@podium/client-core/test-support/react')).fixtureUiHooks(() => owner),
    useHarnessDescriptors: () => ({ served: [] }),
  }
})
