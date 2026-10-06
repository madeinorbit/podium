/** POD-4556 (L4b) — CI-sized run, shard 4 of 4 (see `check-ci.ts`). */

import { describe, it } from 'vitest'
import { CI_ENABLED, CI_TEST_TIMEOUT_MS, runCiShard } from './check-ci'

describe.runIf(CI_ENABLED)('checkArm CI run on the control', () => {
  it(
    'shard 4: five seeds x 300 steps at 1x pass in under 5 minutes',
    () => runCiShard(4),
    CI_TEST_TIMEOUT_MS,
  )
})
