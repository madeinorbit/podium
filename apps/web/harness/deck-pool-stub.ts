// The deck harness's worklist pool (POD-2027): the fixture pool the component
// tests mount, fed from the stub store, in place of `app/store-worklist-pool`.
import { fixturePoolHooks } from '@/test-support/pool-fixture'

export const { useWorklistPool, useWorklistPoolProjection } = fixturePoolHooks
