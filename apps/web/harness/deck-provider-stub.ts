/**
 * THE DECK HARNESS'S STORE HANDLE (POD-2027).
 *
 * The pool-backed deck reads its mission through `useClientRuntime`, which throws
 * outside a real `StoreProvider` ("useStore outside StoreProvider"). The vite
 * deck config redirects the provider module here: everything else is the real
 * provider, and the handle is the same fixture owner `FlightDeck.test.tsx`
 * builds — the stub store's snapshot, published into a fixture pool.
 */
import { DraftStore } from '@podium/client-core/conversation'
import { fixtureRuntimeHooks } from '@podium/client-core/test-support/command-hooks'
import { withKeyedInputs } from '@podium/client-core/test-support/keyed-inputs'
import { fixtureUiHooks } from '@podium/client-core/test-support/react'
import { fixtureStoreSnapshot } from '@/test-support/fixture-store'
import { syncPoolFixture } from '@/test-support/pool-fixture'
import { readFixture } from './deck-store-stub'

export * from '../../../packages/client-core/src/react/provider'

const drafts = new DraftStore({
  storage: { get: () => null, set: () => {} },
  hub: {
    on: () => () => {},
    sendDraftEdit: () => false,
    connectionHealth: () => ({ status: 'ok' }),
  } as never,
})

const snapshot = () => readFixture((state) => state) as never

const owner = withKeyedInputs({
  drafts,
  getSnapshot: () => fixtureStoreSnapshot(snapshot(), () => syncPoolFixture(snapshot(), true)),
  subscribe: () => () => {},
})

// Re-exporting useClientRuntime alone cannot replace other hooks' internal
// context reads. Bind the same runtime/UI hooks as FlightDeck.test.tsx.
export const {
  useClientRuntime,
  useCommands,
  useChatSends,
  useRequestClient,
  useHttpOrigin,
  useReplica,
  useSocketHub,
  useDrafts,
  useDeviceState,
  useUi,
  useUiValue,
} = { ...fixtureRuntimeHooks(() => owner), ...fixtureUiHooks(() => owner) }
