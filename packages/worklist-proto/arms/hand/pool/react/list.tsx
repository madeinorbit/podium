/**
 * POD-4578 (Ha1) — the pool's web list: every pool issue, one `RowShell` per
 * row (no visible set, order or windowing until Hb1/Hb2).
 *
 * The list subscribes to the id list only; each slot subscribes to its own
 * issue's key (`useSyncExternalStore` per key), so a change redraws exactly
 * the rows whose view changed, and a redraw looks nothing up. The pool
 * arrives through props, typed only.
 */

import { memo, type ReactElement, useCallback, useSyncExternalStore } from 'react'
import { RowShell } from '../../../../shared/src/row-shell'
import type { HandPool } from '../pool'
import { PoolRow } from './row'

const PoolRowSlot = memo(function PoolRowSlot({
  pool,
  id,
}: {
  pool: HandPool
  id: string
}): ReactElement | null {
  const subscribe = useCallback((listener: () => void) => pool.subscribe(id, listener), [pool, id])
  const view = useSyncExternalStore(subscribe, () => pool.view(id))
  if (view === undefined) return null
  return <RowShell row={view} component={PoolRow} />
})

export function PoolList({ pool }: { pool: HandPool }): ReactElement {
  const ids = useSyncExternalStore(pool.subscribeIds, pool.issueIds)
  return (
    <div data-pool-list>
      {ids.map((id) => (
        <PoolRowSlot key={id} pool={pool} id={id} />
      ))}
    </div>
  )
}
