/**
 * POD-4565 (Ma1) — the pool's web list: every pool issue, one `RowShell` per
 * row (no visible set, order or windowing until Mb1/Mb2).
 *
 * The list observes `pool.issueIds` (membership only); each slot observes its
 * own model's `view` computed, so a change redraws exactly the rows whose
 * view changed. The pool arrives through props, typed only.
 */

import { observer } from 'mobx-react-lite'
import type { ReactElement } from 'react'
import { RowShell } from '../../../../shared/src/row-shell'
import type { MobxPool } from '../pool'
import { PoolRow } from './row'

const PoolRowSlot = observer(function PoolRowSlot({ pool, id }: { pool: MobxPool; id: string }): ReactElement | null {
  const view = pool.issue(id)?.view
  if (view === undefined) return null
  return <RowShell row={view} component={PoolRow} />
})

export const PoolList = observer(function PoolList({ pool }: { pool: MobxPool }): ReactElement {
  return (
    <div data-pool-list>
      {pool.issueIds.map((id) => (
        <PoolRowSlot key={id} pool={pool} id={id} />
      ))}
    </div>
  )
})
