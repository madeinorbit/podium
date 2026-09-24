/**
 * POD-4578 (Ha1), POD-4582 (Hb1) — the pool's web list: the VISIBLE rows in
 * rank order (`pool.order`, `worklist/visible.ts`), one `RowShell` per row
 * (no groups or windowing until Hb2).
 *
 * The list subscribes to the order only, so a reorder moves keyed slots and
 * commits no row; each slot subscribes to its own issue's key
 * (`useSyncExternalStore` per key), so a change redraws exactly the rows
 * whose view changed, and a redraw looks nothing up. A visible row is always
 * resident (only resident rows have a `visible` cell). The pool arrives
 * through props, typed only.
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
  const ids = useSyncExternalStore(pool.subscribeOrder, pool.order)
  return (
    <div data-pool-list>
      {ids.map((id) => (
        <PoolRowSlot key={id} pool={pool} id={id} />
      ))}
    </div>
  )
}
