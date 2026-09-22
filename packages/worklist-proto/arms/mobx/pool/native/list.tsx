/**
 * POD-4565 (Ma1) — the pool's native list (React Native primitives): the same
 * observation discipline as the web list (`../react/list.tsx`). Loaded
 * lazily by `../arm.ts` so the node lanes never parse `react-native`.
 */

import { observer } from 'mobx-react-lite'
import type { ReactElement } from 'react'
import { ScrollView, Text, View } from 'react-native'
import { type RowProps, RowShell } from '../../../../shared/src/row-shell'
import type { MobxPool } from '../pool'

const PoolNativeRow = observer(function PoolNativeRow({ row }: RowProps): ReactElement {
  return (
    <View testID={`row-${row.id}`} accessibilityState={{ selected: row.selected }}>
      <Text>
        {row.displayRef} {row.title} [{row.phase}] {row.progressDone}/{row.progressTotal}
      </Text>
    </View>
  )
})

const PoolNativeSlot = observer(function PoolNativeSlot({ pool, id }: { pool: MobxPool; id: string }): ReactElement | null {
  const view = pool.issue(id)?.view
  if (view === undefined) return null
  return <RowShell row={view} component={PoolNativeRow} />
})

const PoolNativeList = observer(function PoolNativeList({ pool }: { pool: MobxPool }): ReactElement {
  return (
    <ScrollView testID="mobx-pool-list">
      {pool.issueIds.map((id) => (
        <PoolNativeSlot key={id} pool={pool} id={id} />
      ))}
    </ScrollView>
  )
})

export default PoolNativeList
