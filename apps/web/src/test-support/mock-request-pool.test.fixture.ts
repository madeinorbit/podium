import { MobxPool } from '@podium/client-graph/pool'
import { asUserId, resolveUserPreferences } from '@podium/model'
import { createPoolProjection } from '@podium/client-graph/runtime-pool'
import { useMemo, useSyncExternalStore } from 'react'
import { afterEach, beforeEach, vi } from 'vitest'
import { useRuntimeSelector } from '@/app/store'

type SessionsFixture = { sessions?: readonly import('@podium/client-core/session-values').SessionView[] }
const selectFixture = useRuntimeSelector as unknown as <T>(read: (state: SessionsFixture) => T) => T
let current: MobxPool | undefined
/** The principal's settings record is always in the app's pool (the row source
 *  publishes its defaults, POD-6673), so the stand-in holds it too. */
function seeded(pool: MobxPool): MobxPool {
  const id = 'operator'
  pool.apply({
    type: 'update',
    rows: [{ kind: 'userPreferences', id, value: { ...resolveUserPreferences(undefined, asUserId(id)), id } as never }],
  })
  return pool
}
function pool() { return current ??= seeded(new MobxPool({ selectedIssueId: null, coarseNow: 0 })) }
// Built before each test, so a test that fakes timers still finds it seeded.
beforeEach(() => { pool() })
afterEach(() => { current?.dispose(); current = undefined })

/** Provider-free directory tests share one real pool, retired after each test. */
vi.mock('@/app/store-worklist-pool', () => ({
  useWorklistPool: pool,
  useWorklistPoolProjection<T>(read: (pool: MobxPool) => T) {
    const shared = pool()
    const sessions = selectFixture(state => state.sessions)
    useMemo(() => shared.apply({ type: 'replace', rows: (sessions ?? []).map(value => ({
      kind: 'session', id: value.sessionId, value: value as unknown as Readonly<Record<string, unknown>>,
    })) }), [shared, sessions])
    const projection = useMemo(() => createPoolProjection(shared, read), [shared, read])
    return useSyncExternalStore(projection.subscribe, projection.getSnapshot)
  },
}))
