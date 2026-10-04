/**
 * The presence seam, stubbed for suites that render `AgentPanel` for reasons
 * other than presence (POD-1535).
 *
 * `usePresenceRoom` reads the hub off the client-core StoreProvider, which
 * these focused renders do not mount. Stubbing it here rather than degrading
 * the hook keeps a missing provider LOUD in the app: a component that cannot
 * reach a hub has no presence, and silently rendering "unknown" forever is the
 * shape of bug this deliverable exists to remove.
 *
 * Use as:
 *   vi.mock('@podium/client-core/react', async () =>
 *     (await import('./test-support/presence-mock')).presenceSeamStub())
 */

import { withKeyedInputs } from '@podium/client-core/engine'
import { useStoreSelector as readFixture } from '@/app/store'
import { fakeStoreHandle } from '../../chat/test-support/fake-store-handle'

// The action owner and keyed locals are the same fixture the suite paints.
// Conversation rows retain their independently controlled snapshot handle.
const paneOwner = withKeyedInputs({
  getSnapshot: () => Object.create(readFixture(state => state),
    Object.getOwnPropertyDescriptors(fakeStoreHandle.getSnapshot())),
  subscribe: fakeStoreHandle.subscribe,
})

export function presenceSeamStub(): Record<string, unknown> {
  return {
    usePresenceRoom: () => ({ status: 'unknown' as const }),
    useCurrentPrincipal: () => null,
    useStoreHandle: () => paneOwner,
    useModelCatalog: () => ({}),
    // Served harness descriptors (POD-4475): provider-free suites render
    // against the bundled copy.
    useHarnessDescriptors: () => ({ served: undefined, status: 'unavailable' as const }),
  }
}
