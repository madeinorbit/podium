/**
 * POD-4565 (Ma1), POD-4569 (Mb1) — the pool's web list: the VISIBLE rows in
 * rank order (`pool.worklist.order`), one `RowShell` per row (no groups or
 * windowing until Mb2).
 *
 * The list observes the order only; a reorder moves keyed slots and commits
 * no row. A slot resolves its model when it mounts or its row's presence
 * changes; the row inside it observes only the model's `view`, so a change
 * redraws exactly the rows whose view changed, and a redraw looks nothing up
 * (a lookup per redraw would charge the row's presence read to every change
 * that redraws it). A visible row
 * that is still COLD (a closed issue) is asked for and drawn as a bare
 * placeholder, outside `RowShell`, until its load lands: its first row
 * commit is its data. The pool arrives through props, typed only.
 */

import { observer } from 'mobx-react-lite'
import type { ReactElement } from 'react'
import { RowShell } from '../../../../shared/src/row-shell'
import type { IssueModel } from '../models'
import type { MobxPool } from '../pool'
import { PoolRow } from './row'

/** A drawn row: observes its model's view only, so a redraw looks nothing up. */
const PoolRowView = observer(function PoolRowView({
  model,
}: {
  model: IssueModel
}): ReactElement | null {
  const view = model.view
  if (view === undefined) return null
  return <RowShell row={view} component={PoolRow} />
})

/**
 * One visible id: resolves its model once (and again only when its presence
 * changes, a cold row's load), else asks for the load and draws a bare
 * placeholder outside `RowShell`.
 */
const PoolRowSlot = observer(function PoolRowSlot({
  pool,
  id,
}: {
  pool: MobxPool
  id: string
}): ReactElement | null {
  const model = pool.issue(id)
  if (model === undefined) {
    return pool.resident('issue', id) === 'loading' ? <div data-loading-row={id} /> : null
  }
  return <PoolRowView model={model} />
})

export const PoolList = observer(function PoolList({ pool }: { pool: MobxPool }): ReactElement {
  return (
    <div data-pool-list>
      {pool.worklist.order.map((id) => (
        <PoolRowSlot key={id} pool={pool} id={id} />
      ))}
    </div>
  )
})
