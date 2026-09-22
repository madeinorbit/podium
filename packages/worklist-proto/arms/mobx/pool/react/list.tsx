/**
 * POD-4565 (Ma1) — the pool's web list: every pool issue, one `RowShell` per
 * row (no visible set, order or windowing until Mb1/Mb2).
 *
 * The list observes `pool.issueIds` (membership only) and hands each slot its
 * model; a slot observes only its model's `view` computed, so a change
 * redraws exactly the rows whose view changed, and a redraw looks nothing up.
 * The pool arrives through props, typed only.
 */

import { observer } from 'mobx-react-lite'
import type { ReactElement } from 'react'
import { RowShell } from '../../../../shared/src/row-shell'
import type { IssueModel } from '../models'
import type { MobxPool } from '../pool'
import { PoolRow } from './row'

const PoolRowSlot = observer(function PoolRowSlot({ model }: { model: IssueModel }): ReactElement | null {
  const view = model.view
  if (view === undefined) return null
  return <RowShell row={view} component={PoolRow} />
})

export const PoolList = observer(function PoolList({ pool }: { pool: MobxPool }): ReactElement {
  return (
    <div data-pool-list>
      {pool.issueIds.map((id) => {
        const model = pool.issue(id)
        return model === undefined ? null : <PoolRowSlot key={id} model={model} />
      })}
    </div>
  )
})
