/**
 * POD-4578 (Ha1), POD-4582 (Hb1), POD-4583 (Hb2) — the pool's web list: the
 * PINNED section, then each group's header, open lane and closed fold
 * (`pool.groups`, `../worklist/groups.ts`), windowed with
 * `@tanstack/react-virtual` (spec §4 UI contract).
 *
 * WHAT EACH COMPONENT SUBSCRIBES TO.
 * - The list: the grouped view only (`pool.groupsView`, identity-kept). It
 *   reads no row, so a row change never redraws it; a reorder or a lane
 *   change rebuilds keyed items and commits no row.
 * - A group header: its own group's lanes (`pool.subscribeGroup(key)`), so
 *   it redraws when its group's membership or label changes, never on a
 *   row-internal change. It toggles its closed fold (UI state, not data).
 * - A row slot: its own issue's key (`pool.subscribe(id)`), so a change
 *   redraws exactly the rows whose view changed, and a redraw looks nothing
 *   up. A visible row still COLD is drawn as a bare placeholder outside
 *   `RowShell` until its load lands: its first row commit is its data. With
 *   the window, only the drawn rows' cold rows load.
 *
 * WINDOWING. Fixed heights (row 56 px, header 40 px: the browser harness's
 * viewport is sized to them, `harness/browser/run.ts`), overscan 5. When the
 * scroll container has no height after mount (a unit renderer with no layout,
 * the count lane's happy-dom) the list draws every item instead of a window
 * of none: the commit fence there asks for every changed visible row, as
 * round two's lists did. The browser lane draws the window.
 *
 * The pool arrives through props, typed only.
 */

import { useVirtualizer } from '@tanstack/react-virtual'
import {
  type CSSProperties,
  memo,
  type ReactElement,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { RowShell } from '../../../../shared/src/row-shell'
import type { HandPool } from '../pool'
import { PoolRow } from './row'

/** Item heights (px): the browser harness's viewport is sized to them. */
export const ROW_HEIGHT = 56
export const HEADER_HEIGHT = 40
const OVERSCAN = 5

/** One drawn line of the list. */
type Item =
  | { readonly kind: 'pinned' }
  | { readonly kind: 'header'; readonly key: string }
  | { readonly kind: 'row'; readonly id: string }

function itemKey(item: Item): string {
  if (item.kind === 'row') return item.id
  return item.kind === 'header' ? `group:${item.key}` : 'pinned'
}

/**
 * One visible id: its own view, `memo` on that view's identity (an unchanged
 * view keeps its object, so the row does not redraw); a cold row draws a
 * bare placeholder outside `RowShell` until its load lands.
 */
const PoolRowSlot = memo(function PoolRowSlot({
  pool,
  id,
}: {
  pool: HandPool
  id: string
}): ReactElement | null {
  const subscribe = useCallback((listener: () => void) => pool.subscribe(id, listener), [pool, id])
  const view = useSyncExternalStore(subscribe, () => pool.view(id))
  if (view === undefined) {
    return pool.resident('issue', id) === 'loading' ? <div data-loading-row={id} /> : null
  }
  return <RowShell row={view} component={PoolRow} />
})

/**
 * A group header: label, open count, closed count; toggles the closed fold.
 * `memo` on props plus its own lanes subscription: a list re-render with the
 * same key leaves it alone, and a row-internal change never notifies it.
 */
const PoolGroupHeader = memo(function PoolGroupHeader({
  pool,
  groupKey,
  folded,
  onToggle,
}: {
  pool: HandPool
  groupKey: string
  folded: boolean
  onToggle: (key: string) => void
}): ReactElement {
  const subscribe = useCallback(
    (listener: () => void) => pool.subscribeGroup(groupKey, listener),
    [pool, groupKey],
  )
  const lanes = useSyncExternalStore(subscribe, () => pool.groupLanes(groupKey))
  return (
    <div data-group={groupKey} data-folded={folded ? 'true' : 'false'}>
      <button type="button" onClick={() => onToggle(groupKey)}>
        {lanes.label} {lanes.rowIds.length}+{lanes.closedIds.length}
      </button>
    </div>
  )
})

/** The element for one item (a plain function: the observers are the slot and the header). */
function drawItem(
  pool: HandPool,
  item: Item,
  folded: ReadonlySet<string>,
  onToggle: (key: string) => void,
): ReactElement {
  if (item.kind === 'row') return <PoolRowSlot pool={pool} id={item.id} />
  if (item.kind === 'pinned') return <div data-group="PINNED">Pinned</div>
  return (
    <PoolGroupHeader pool={pool} groupKey={item.key} folded={folded.has(item.key)} onToggle={onToggle} />
  )
}

export function PoolList({ pool }: { pool: HandPool }): ReactElement {
  const view = useSyncExternalStore(pool.subscribeGroups, pool.groupsView)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  // 'unknown' until the container is measured (before paint), then a window
  // or, with no layout at all, every item.
  const [layout, setLayout] = useState<'unknown' | 'window' | 'all'>('unknown')
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set())
  const toggle = useCallback((key: string) => {
    setFolded((previous) => {
      const next = new Set(previous)
      if (!next.delete(key)) next.add(key)
      return next
    })
  }, [])

  const items: Item[] = []
  const pinnedIds = view.pinnedIds
  if (pinnedIds.length > 0) {
    items.push({ kind: 'pinned' })
    for (const id of pinnedIds) items.push({ kind: 'row', id })
  }
  for (const key of view.keys) {
    const lanes = pool.groupLanes(key)
    items.push({ kind: 'header', key })
    for (const id of lanes.rowIds) items.push({ kind: 'row', id })
    if (!folded.has(key)) for (const id of lanes.closedIds) items.push({ kind: 'row', id })
  }

  useLayoutEffect(() => {
    setLayout((scrollRef.current?.clientHeight ?? 0) > 0 ? 'window' : 'all')
  }, [])

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => ((items[index] as Item).kind === 'row' ? ROW_HEIGHT : HEADER_HEIGHT),
    getItemKey: (index) => itemKey(items[index] as Item),
    overscan: OVERSCAN,
    enabled: layout === 'window',
  })

  let body: ReactElement | ReactElement[] | null = null
  if (layout === 'window') {
    body = (
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((entry) => {
          const style: CSSProperties = {
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: entry.size,
            transform: `translateY(${entry.start}px)`,
          }
          return (
            <div key={entry.key} style={style}>
              {drawItem(pool, items[entry.index] as Item, folded, toggle)}
            </div>
          )
        })}
      </div>
    )
  } else if (layout === 'all') {
    body = items.map((item) => (
      <div key={itemKey(item)}>{drawItem(pool, item, folded, toggle)}</div>
    ))
  }
  return (
    <div ref={scrollRef} data-pool-list style={{ overflowY: 'auto', height: '100vh' }}>
      {body}
    </div>
  )
}
