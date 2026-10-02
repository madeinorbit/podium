/** Identical mounted 20-row window for both measurement arms. */
import { autorun } from 'mobx'
import { useCallback, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import type { RowView } from '@podium/client-graph/shared/row-view'
import type { HandPool } from '../../hand/pool/pool'
import type { LeanPool } from './pool'

export const WINDOW_ROWS = 20
export interface WindowPool {
  prepare?(ids: readonly string[]): void
  order(): readonly string[]
  view(id: string): RowView | undefined
  subscribeOrder(changed: () => void): () => void
  subscribeRow(id: string, changed: () => void): () => void
}
export const handWindow = (pool: HandPool): WindowPool => ({
  order: () => pool.order(),
  view: (id) => pool.view(id),
  subscribeOrder: (changed) => pool.subscribeOrder(changed),
  subscribeRow: (id, changed) => pool.subscribe(id, changed),
})
export const leanWindow = (pool: LeanPool): WindowPool => ({
  prepare: (ids) => pool.setWindow(ids),
  order: () => pool.filing.get().order,
  view: (id) => pool.mountRow(id).get(),
  subscribeOrder: (changed) => autorun(() => { pool.filing.get(); changed() }),
  subscribeRow: (id, changed) => {
    const off = autorun(() => { pool.mountRow(id).get(); changed() })
    return () => { off(); pool.unmountRow(id) }
  },
})

function Row({ pool, id }: { pool: WindowPool; id: string }) {
  const subscribe = useCallback((changed: () => void) => pool.subscribeRow(id, changed), [pool, id])
  const get = useCallback(() => pool.view(id), [pool, id])
  const view = useSyncExternalStore(subscribe, get)
  // Exercise every displayed field, including the rollup and origin facts.
  return <div data-prototype-row={id}>{view ? JSON.stringify(view) : 'LOADING'}</div>
}

function Window({ pool }: { pool: WindowPool }) {
  const subscribe = useCallback((changed: () => void) => pool.subscribeOrder(changed), [pool])
  const get = useCallback(() => pool.order(), [pool])
  const ids = useSyncExternalStore(subscribe, get)
  return <>{ids.slice(0, WINDOW_ROWS).map((id) => <Row key={id} pool={pool} id={id} />)}</>
}

export function mountWindow(pool: WindowPool, element: Element): () => void {
  pool.prepare?.(pool.order().slice(0, WINDOW_ROWS))
  // Keep filing observed before React's first render reads the row slots.
  const off = pool.subscribeOrder(() => {})
  const root = createRoot(element)
  root.render(<Window pool={pool} />)
  return () => { root.unmount(); off() }
}
