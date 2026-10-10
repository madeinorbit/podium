import { MobxPool } from '@podium/client-graph/pool'
import { createPoolProjection } from '@podium/client-graph/runtime-pool'
import { useMemo, useSyncExternalStore } from 'react'
import { afterEach, vi } from 'vitest'
import { useRuntimeSelector } from '@/app/store'

let current: MobxPool | undefined
function pool() { return current ??= new MobxPool({ selectedIssueId: null, coarseNow: 0 }) }
afterEach(() => { current?.dispose(); current = undefined })

/** Provider-free directory tests share one real pool, retired after each test. */
vi.mock('@/app/store-worklist-pool', () => ({
  useWorklistPool: pool,
  useWorklistPoolProjection<T>(read: (pool: MobxPool) => T) {
    const shared = pool()
    const sessions = useRuntimeSelector(state => state.sessions)
    useMemo(() => shared.apply({ type: 'replace', rows: (sessions ?? []).map(value => ({
      kind: 'session', id: value.sessionId, value: value as unknown as Readonly<Record<string, unknown>>,
    })) }), [shared, sessions])
    const projection = useMemo(() => createPoolProjection(shared, read), [shared, read])
    return useSyncExternalStore(projection.subscribe, projection.getSnapshot)
  },
}))
