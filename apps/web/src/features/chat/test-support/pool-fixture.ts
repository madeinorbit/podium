import { borrowPoolFixtureInputs } from '@/test-support/mock-screen-pool'
import { fakeStoreHandle } from './fake-store-handle'

borrowPoolFixtureInputs(() => fakeStoreHandle.getSnapshot() as never, fakeStoreHandle.subscribe)
