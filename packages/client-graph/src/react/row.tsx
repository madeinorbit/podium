import { observer } from 'mobx-react-lite'
import type { ReactElement } from 'react'
import type { IssueModel } from '../models'
import type { MobxPool } from '../pool'

export type IssueRenderer = (model: IssueModel) => ReactElement | null

/** Observe residency independently from the row component's field reads. */
const PoolRowView = observer(function PoolRowView({
  model,
  renderRow,
}: {
  model: IssueModel
  renderRow: IssueRenderer
}): ReactElement | null {
  if (!model.inMemory) return null
  return renderRow(model)
})

/** Resolve through the pool's reader; cold rows queue a batched load. */
export const PoolRowSlot = observer(function PoolRowSlot({
  pool,
  id,
  renderRow,
  renderLoading,
}: {
  pool: MobxPool
  id: string
  renderRow: IssueRenderer
  renderLoading?: (id: string) => ReactElement | null
}): ReactElement | null {
  const model = pool.issue(id)
  if (model === undefined) {
    return pool.resident('issue', id) === 'loading' ? (renderLoading?.(id) ?? null) : null
  }
  return <PoolRowView model={model} renderRow={renderRow} />
})
