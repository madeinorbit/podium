/**
 * POD-4565 (Ma1) — the pool's native list (React Native primitives): the same
 * observation discipline as the web list (`../react/list.tsx`). Loaded
 * lazily by `../arm.ts` so the node lanes never parse `react-native`.
 */

import { observer } from 'mobx-react-lite'
import type { ReactElement } from 'react'
import { ScrollView } from 'react-native'
import { RowShell } from '../../../../shared/src/row-shell'
import type { IssueModel } from '../models'
import type { MobxPool } from '../pool'
import { PoolNativeRow } from './row'

const PoolNativeSlot = observer(function PoolNativeSlot({
  model,
}: {
  model: IssueModel
}): ReactElement | null {
  const view = model.view
  if (view === undefined) return null
  return <RowShell row={view} component={PoolNativeRow} />
})

const PoolNativeList = observer(function PoolNativeList({
  pool,
}: {
  pool: MobxPool
}): ReactElement {
  return (
    <ScrollView testID="mobx-pool-list">
      {pool.issueIds.map((id) => {
        const model = pool.issue(id)
        return model === undefined ? null : <PoolNativeSlot key={id} model={model} />
      })}
    </ScrollView>
  )
})

export default PoolNativeList
