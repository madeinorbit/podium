import type { MobxPool } from '@podium/client-graph'
import { useCallback, useSyncExternalStore } from 'react'
import { useWorklistPoolProjection } from '@/app/store-worklist-pool'

const empty = () => undefined
const unsubscribe = () => {}
const subscribeEmpty = (_wake: () => void) => unsubscribe

/** The handle is declared by this screen and comes through the same reader.
 * Its MobX implementation remains behind the startup attachment. */
export function useBoardPoolProjection<T>(
  entity: 'issueBoardModel' | 'issueExplorerModel',
  key: string,
): T | undefined {
  const demand = JSON.stringify([entity, key])
  const read = useCallback((pool: MobxPool) => pool.row('issueBoardProjection', demand), [demand])
  const value = useWorklistPoolProjection(read, undefined)
  const view = value && typeof value !== 'symbol' ? value : undefined
  return useSyncExternalStore(view?.subscribe ?? subscribeEmpty, view?.getSnapshot ?? empty) as
    | T
    | undefined
}
