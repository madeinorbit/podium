import type { MobxPool } from '@podium/client-graph/pool'
import { createPoolProjection } from '@podium/client-graph/runtime-pool'
import { useMemo, useSyncExternalStore } from 'react'
import { fixture } from './refreshing-state'

export const useWorklistPool = () => fixture.pool
export const useMobilePool = useWorklistPool
export function useWorklistPoolProjection<T>(read: (pool: MobxPool) => T, _empty: T): T {
  const value = useMemo(() => createPoolProjection(fixture.pool, read), [read])
  return useSyncExternalStore(value.subscribe, value.getSnapshot)
}
export const useMobilePoolProjection = useWorklistPoolProjection
