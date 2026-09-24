/**
 * POD-4578 (Ha1), POD-4582 (Hb1) — the pool's native list (React Native
 * primitives): the visible rows in rank order, with the same per-key
 * subscriptions as the web list (`../react/list.tsx`). Loaded lazily
 * by `../arm.ts` so the node lanes never parse `react-native`.
 */

import { memo, type ReactElement, useCallback, useSyncExternalStore } from 'react'
import { ScrollView } from 'react-native'
import { RowShell } from '../../../../shared/src/row-shell'
import type { HandPool } from '../pool'
import { PoolNativeRow } from './row'

const PoolNativeSlot = memo(function PoolNativeSlot({
  pool,
  id,
}: {
  pool: HandPool
  id: string
}): ReactElement | null {
  const subscribe = useCallback((listener: () => void) => pool.subscribe(id, listener), [pool, id])
  const view = useSyncExternalStore(subscribe, () => pool.view(id))
  if (view === undefined) return null
  return <RowShell row={view} component={PoolNativeRow} />
})

function PoolNativeList({ pool }: { pool: HandPool }): ReactElement {
  const ids = useSyncExternalStore(pool.subscribeOrder, pool.order)
  return (
    <ScrollView testID="hand-pool-list">
      {ids.map((id) => (
        <PoolNativeSlot key={id} pool={pool} id={id} />
      ))}
    </ScrollView>
  )
}

export default PoolNativeList
