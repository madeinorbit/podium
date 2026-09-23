/**
 * POD-4565 (Ma1), POD-4569 (Mb1) — the pool's native list (React Native
 * primitives): the same visible rows, order and observation discipline as
 * the web list (`../react/list.tsx`). Loaded lazily by `../arm.ts` so the
 * node lanes never parse `react-native`.
 */

import { observer } from 'mobx-react-lite'
import type { ReactElement } from 'react'
import { ScrollView, View } from 'react-native'
import { RowShell } from '../../../../shared/src/row-shell'
import type { MobxPool } from '../pool'
import { PoolNativeRow } from './row'

const PoolNativeSlot = observer(function PoolNativeSlot({
  pool,
  id,
}: {
  pool: MobxPool
  id: string
}): ReactElement | null {
  const view = pool.issue(id)?.view
  if (view === undefined) {
    return pool.resident('issue', id) === 'loading' ? <View testID={`loading-${id}`} /> : null
  }
  return <RowShell row={view} component={PoolNativeRow} />
})

const PoolNativeList = observer(function PoolNativeList({
  pool,
}: {
  pool: MobxPool
}): ReactElement {
  return (
    <ScrollView testID="mobx-pool-list">
      {pool.worklist.order.map((id) => (
        <PoolNativeSlot key={id} pool={pool} id={id} />
      ))}
    </ScrollView>
  )
})

export default PoolNativeList
