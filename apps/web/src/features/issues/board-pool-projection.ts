import type { MobxPool } from '@podium/client-graph'
import { useCallback } from 'react'
import { useWorklistPoolProjection } from '@/app/store-worklist-pool'

/** Board and explorer leaves use the same pool projection as other readers. */
export function useBoardPoolProjection<T>(
  entity: 'issueBoardModel' | 'issueExplorerModel',
  key: string,
): T | undefined {
  const read = useCallback((pool: MobxPool) => pool.row(entity, key), [entity, key])
  return useWorklistPoolProjection(read, undefined) as T | undefined
}
