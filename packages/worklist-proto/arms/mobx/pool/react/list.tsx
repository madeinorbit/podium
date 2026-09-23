/**
 * POD-4565 (Ma1), POD-4569 (Mb1) — the pool's web list: the VISIBLE rows in
 * rank order (`pool.worklist.order`), one `RowShell` per row (no groups or
 * windowing until Mb2).
 *
 * The list observes the order only; a reorder moves keyed slots and commits
 * no row. A slot observes its own model's `view`, so a change redraws exactly
 * the rows whose view changed, and a redraw looks nothing up. A visible row
 * that is still COLD (a closed issue) is asked for and drawn as a bare
 * placeholder, outside `RowShell`, until its load lands: its first row
 * commit is its data. The pool arrives through props, typed only.
 */

import { observer } from 'mobx-react-lite'
import type { ReactElement } from 'react'
import { RowShell } from '../../../../shared/src/row-shell'
import type { MobxPool } from '../pool'
import { PoolRow } from './row'

const PoolRowSlot = observer(function PoolRowSlot({
  pool,
  id,
}: {
  pool: MobxPool
  id: string
}): ReactElement | null {
  const view = pool.issue(id)?.view
  if (view === undefined) {
    return pool.resident('issue', id) === 'loading' ? <div data-loading-row={id} /> : null
  }
  return <RowShell row={view} component={PoolRow} />
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
