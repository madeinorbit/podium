/**
 * POD-4565 (Ma1), POD-4569 (Mb1), POD-4570 (Mb2) — the pool's web list: the
 * PINNED section, then each group's header, open lane and closed fold
 * (`pool.groups`, `../worklist/groups.ts`), windowed with
 * `@tanstack/react-virtual` (spec §4 UI contract).
 *
 * WHAT EACH COMPONENT OBSERVES.
 * - The list: the grouped ids only (`groups.pinnedIds`, `groups.keys`, each
 *   group's `rowIds` / `closedIds`, all shallow-compared computeds). It reads
 *   no row, so a row change never redraws it; a reorder or a lane change
 *   moves keyed slots and commits no row.
 * - A group header: its own group's label and id lists (`GroupNode`), so it
 *   redraws when its group's membership or label changes, never on a
 *   row-internal change. It toggles its closed fold (UI state, not data).
 * - A row slot: resolves its model when it mounts or its row's presence
 *   changes (a cold row's load); its shell observes only whether the model
 *   is in memory and hands `RowShell` the model itself; the row (`./row.tsx`,
 *   an `observer`) reads the model's row fields, so a change redraws exactly
 *   the rows a changed field is read by. A redraw looks nothing up.
 *   A visible row still COLD (a closed issue) is asked for and drawn as a bare
 *   placeholder outside `RowShell` until its load lands: its first row commit
 *   is its data. With the window, only the drawn rows' cold rows load.
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
import { observer } from 'mobx-react-lite'
import {
  type CSSProperties,
  type ReactElement,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { RowShell } from '../../../../shared/src/row-shell'
import type { IssueModel } from '../models'
import type { MobxPool } from '../pool'
import type { WorklistGroups } from '../worklist/groups'
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
 * A drawn row's shell: observes only whether its issue is in memory, and
 * hands the issue ITSELF to the row (it implements `RowView`). The row is the
 * observer of its fields, so a field change redraws the row and never this.
 */
const PoolRowView = observer(function PoolRowView({
  model,
}: {
  model: IssueModel
}): ReactElement | null {
  if (!model.inMemory) return null
  return <RowShell row={model} component={PoolRow} />
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

/** A group header: label, open count, closed count; toggles the closed fold. */
const PoolGroupHeader = observer(function PoolGroupHeader({
  groups,
  groupKey,
  folded,
  onToggle,
}: {
  groups: WorklistGroups
  groupKey: string
  folded: boolean
  onToggle: (key: string) => void
}): ReactElement {
  const group = groups.group(groupKey)
  return (
    <div data-group={groupKey} data-folded={folded ? 'true' : 'false'}>
      <button type="button" onClick={() => onToggle(groupKey)}>
        {group.label} {group.rowIds.length}+{group.closedIds.length}
      </button>
    </div>
  )
})

/** The element for one item (a plain function: the observers are the slot and the header). */
function drawItem(
  pool: MobxPool,
  item: Item,
  folded: ReadonlySet<string>,
  onToggle: (key: string) => void,
): ReactElement {
  if (item.kind === 'row') return <PoolRowSlot pool={pool} id={item.id} />
  if (item.kind === 'pinned') return <div data-group="PINNED">Pinned</div>
  return (
    <PoolGroupHeader
      groups={pool.groups}
      groupKey={item.key}
      folded={folded.has(item.key)}
      onToggle={onToggle}
    />
  )
}

export const PoolList = observer(function PoolList({ pool }: { pool: MobxPool }): ReactElement {
  const groups = pool.groups
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
  const pinnedIds = groups.pinnedIds
  if (pinnedIds.length > 0) {
    items.push({ kind: 'pinned' })
    for (const id of pinnedIds) items.push({ kind: 'row', id })
  }
  for (const key of groups.keys) {
    const group = groups.group(key)
    items.push({ kind: 'header', key })
    for (const id of group.rowIds) items.push({ kind: 'row', id })
    if (!folded.has(key)) for (const id of group.closedIds) items.push({ kind: 'row', id })
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
})
