import { MobxPool } from '@podium/client-graph/pool'
import { createPoolProjection } from '@podium/client-graph/runtime-pool'
import { asUserId, resolveUserPreferences } from '@podium/model'
import { useMemo, useSyncExternalStore } from 'react'
import { afterEach, beforeEach, vi } from 'vitest'
import { useRuntimeSelector } from '@/app/store'

type SessionsFixture = {
  sessions?: readonly import('@podium/client-core/session-values').SessionView[]
}
const selectFixture = useRuntimeSelector as unknown as <T>(read: (state: SessionsFixture) => T) => T
let current: MobxPool | undefined
/** The principal's settings record is always in the app's pool (the row source
 *  publishes its defaults with every publication, POD-6673), so the stand-in
 *  holds it too, and a wholesale replace below carries it as the app's does. */
const MY_PREFERENCES_ID = 'operator'
function myPreferencesRow() {
  const value = {
    ...resolveUserPreferences(undefined, asUserId(MY_PREFERENCES_ID)),
    id: MY_PREFERENCES_ID,
  }
  return { kind: 'userPreferences' as const, id: MY_PREFERENCES_ID, value: value as never }
}
function seeded(pool: MobxPool): MobxPool {
  pool.apply({ type: 'update', rows: [myPreferencesRow()] })
  return pool
}
function pool() {
  return (current ??= seeded(new MobxPool({ selectedIssueId: null, coarseNow: 0 })))
}
// Built before each test, so a test that fakes timers still finds it seeded.
beforeEach(() => {
  pool()
})
afterEach(() => {
  current?.dispose()
  current = undefined
})

/** Provider-free directory tests share one real pool, retired after each test. */
vi.mock('@/app/store-worklist-pool', () => ({
  useWorklistPool: pool,
  useWorklistPoolProjection<T>(read: (pool: MobxPool) => T) {
    const shared = pool()
    const sessions = selectFixture((state) => state.sessions)
    useMemo(() => {
      // Keep my settings row unless a test already changed it in place.
      const mine = shared.tables.userPreferences?.get(MY_PREFERENCES_ID)
      shared.apply({
        type: 'replace',
        rows: [
          ...(sessions ?? []).map((value) => ({
            kind: 'session' as const,
            id: value.sessionId,
            value: value as unknown as Readonly<Record<string, unknown>>,
          })),
          mine
            ? { kind: 'userPreferences' as const, id: MY_PREFERENCES_ID, value: mine as never }
            : myPreferencesRow(),
        ],
      })
    }, [shared, sessions])
    const projection = useMemo(() => createPoolProjection(shared, read), [shared, read])
    return useSyncExternalStore(projection.subscribe, projection.getSnapshot)
  },
}))
