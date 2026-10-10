import { MobxPool } from '@podium/client-graph/pool'
import { useEffect, useMemo } from 'react'
import { vi } from 'vitest'

/** Provider-free directory tests still use one real, opening-owned record pool. */
vi.mock('@/app/store-worklist-pool', () => ({
  useWorklistPool() {
    const pool = useMemo(() => new MobxPool({ selectedIssueId: null, coarseNow: 0 }), [])
    useEffect(() => () => pool.dispose(), [pool])
    return pool
  },
}))
