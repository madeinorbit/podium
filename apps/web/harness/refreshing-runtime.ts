import { fixtureRuntimeHooks } from '@podium/client-core/test-support/command-hooks'
import { withKeyedInputs } from '@podium/client-core/test-support/keyed-inputs'
import { fixtureUiHooks } from '@podium/client-core/test-support/react'
import { fixtureStoreSnapshot } from '@/test-support/fixture-store'
import { readFixture } from './deck-store-stub'

export * from '../../../packages/client-core/src/react/index'

const owner = withKeyedInputs({
  getSnapshot: () => fixtureStoreSnapshot(readFixture((state) => state) as never),
  subscribe: () => () => {},
})
export const {
  useClientRuntime,
  useCommands,
  useRequestClient,
  useHttpOrigin,
  useReplica,
  useSocketHub,
  useDrafts,
} = fixtureRuntimeHooks(() => owner)
export const { useUi, useUiValue, useDeviceState } = fixtureUiHooks(() => owner)
export const useHarnessDescriptors = () => ({ served: [] })
