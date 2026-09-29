/**
 * POD-4565 (Ma1), POD-4569 (Mb1), POD-4570 (Mb2) — the pool's web list: the
 * PINNED section, then each group's header, open lane and closed fold
 * (`pool.groups`, `../worklist/groups.ts`), windowed with
 * `@tanstack/react-virtual` (spec §4 UI contract).
 *
 * WHAT EACH COMPONENT OBSERVES.
 * - The list: the group keys (`groups.keys`, a shallow-compared computed),
 *   and in the window each lane's length (`groups.pinnedIds`, each group's
 *   `rowIds` / `closedIds`). It reads no row, so a row change never redraws
 *   it, and it builds no per-row array: the window resolves an index by
 *   binary search over one segment per lane (`WindowPlan`).
 * - A lane (`PoolLane`, the `all` layout): the pinned section, a group's
 *   open lane or its closed fold, each its own observer of its own ids
 *   (POD-4792). A placement change redraws the lanes the row leaves and
 *   enters and walks no other; a reorder inside a lane moves keyed slots and
 *   commits no row. A row that changes lane remounts its slot there.
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
 * round two's lists did. The browser lane draws the window. The virtualizer
 * still re-measures every index when the plan changes (its own arithmetic
 * over `estimateSize` and `getItemKey`, which read an id by index and no
 * row); only the drawn items redraw.
 *
 * The pool arrives through props, typed only.
 */

import { useVirtualizer } from '@tanstack/react-virtual'
import { observer } from 'mobx-react-lite'
import {
  type CSSProperties,
  Fragment,
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

const PINNED_TITLE = <div data-group="PINNED">Pinned</div>

/** Which lane a {@link PoolLane} draws: the pinned section, or a group's open lane or closed fold. */
type Lane = 'pinned' | 'open' | 'closed'

function laneIds(groups: WorklistGroups, lane: Lane, groupKey: string): readonly string[] {
  if (lane === 'pinned') return groups.pinnedIds
  const group = groups.group(groupKey)
  return lane === 'open' ? group.rowIds : group.closedIds
}

/**
 * One lane's rows, every one (the `all` layout): observes only its own ids,
 * so a placement change redraws the lanes it leaves and enters and walks no
 * other lane. The pinned lane draws its title when it has rows.
 */
const PoolLane = observer(function PoolLane({
  pool,
  lane,
  groupKey,
}: {
  pool: MobxPool
  lane: Lane
  groupKey: string
}): ReactElement {
  const ids = laneIds(pool.groups, lane, groupKey)
  return (
    <>
      {lane === 'pinned' && ids.length > 0 ? <div key="pinned">{PINNED_TITLE}</div> : null}
      {ids.map((id) => (
        <div key={id}>
          <PoolRowSlot pool={pool} id={id} />
        </div>
      ))}
    </>
  )
})

/**
 * One group (the `all` layout): its header, open lane and, unless folded, its
 * closed fold (a plain function: the observers are the header and the lanes).
 */
function drawGroup(
  pool: MobxPool,
  groupKey: string,
  folded: boolean,
  onToggle: (key: string) => void,
): ReactElement {
  return (
    <Fragment key={`group:${groupKey}`}>
      <div>
        <PoolGroupHeader
          groups={pool.groups}
          groupKey={groupKey}
          folded={folded}
          onToggle={onToggle}
        />
      </div>
      <PoolLane pool={pool} lane="open" groupKey={groupKey} />
      {folded ? null : <PoolLane pool={pool} lane="closed" groupKey={groupKey} />}
    </Fragment>
  )
}

/** The element for one item (a plain function: the observers are the slot and the header). */
function drawItem(
  pool: MobxPool,
  item: Item,
  folded: ReadonlySet<string>,
  onToggle: (key: string) => void,
): ReactElement {
  if (item.kind === 'row') return <PoolRowSlot pool={pool} id={item.id} />
  if (item.kind === 'pinned') return PINNED_TITLE
  return (
    <PoolGroupHeader
      groups={pool.groups}
      groupKey={item.key}
      folded={folded.has(item.key)}
      onToggle={onToggle}
    />
  )
}

/** A run of items in the window's index space: an optional title, then one lane's ids. */
interface Segment {
  readonly start: number
  readonly title: Item | null
  readonly ids: readonly string[]
}

/**
 * The window's index space, read off each lane's LENGTH: one segment per lane
 * (the pinned section, each group's header with its open lane, its closed
 * fold unless folded), so building it walks the groups, never their rows. An
 * index resolves by binary search over the segments.
 */
class WindowPlan {
  readonly count: number
  private readonly segments: Segment[] = []

  constructor(groups: WorklistGroups, keys: readonly string[], folded: ReadonlySet<string>) {
    let start = 0
    const add = (title: Item | null, ids: readonly string[]): void => {
      if (title === null && ids.length === 0) return
      this.segments.push({ start, title, ids })
      start += (title === null ? 0 : 1) + ids.length
    }
    const pinnedIds = groups.pinnedIds
    if (pinnedIds.length > 0) add({ kind: 'pinned' }, pinnedIds)
    for (const key of keys) {
      const group = groups.group(key)
      add({ kind: 'header', key }, group.rowIds)
      if (!folded.has(key)) add(null, group.closedIds)
    }
    this.count = start
  }

  /** The item at `index` (0 <= index < count). */
  at(index: number): Item {
    const segments = this.segments
    let low = 0
    let high = segments.length - 1
    while (low < high) {
      const middle = (low + high + 1) >> 1
      if ((segments[middle] as Segment).start <= index) low = middle
      else high = middle - 1
    }
    const segment = segments[low] as Segment
    const offset = index - segment.start
    if (segment.title === null) return { kind: 'row', id: segment.ids[offset] as string }
    if (offset === 0) return segment.title
    return { kind: 'row', id: segment.ids[offset - 1] as string }
  }
}

export const PoolList = observer(function PoolList({ pool }: { pool: MobxPool }): ReactElement {
  const groups = pool.groups
  // Every layout reads the keys (the first, unmeasured render too).
  const keys = groups.keys
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

  useLayoutEffect(() => {
    setLayout((scrollRef.current?.clientHeight ?? 0) > 0 ? 'window' : 'all')
  }, [])

  // Only the window reads the lanes (their lengths): the `all` layout leaves
  // each lane to its own observer, so this redraws only when the group keys
  // (or the folds) change.
  const plan = layout === 'window' ? new WindowPlan(groups, keys, folded) : null
  const virtualizer = useVirtualizer({
    count: plan?.count ?? 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) =>
      (plan as WindowPlan).at(index).kind === 'row' ? ROW_HEIGHT : HEADER_HEIGHT,
    // A fresh function per plan: the virtualizer re-measures when it changes.
    getItemKey: (index) => (plan === null ? index : itemKey(plan.at(index))),
    overscan: OVERSCAN,
    enabled: layout === 'window',
  })

  let body: ReactElement | ReactElement[] | null = null
  if (plan !== null) {
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
              {drawItem(pool, plan.at(entry.index), folded, toggle)}
            </div>
          )
        })}
      </div>
    )
  } else if (layout === 'all') {
    body = [
      <PoolLane key="pinned" pool={pool} lane="pinned" groupKey="" />,
      ...keys.map((key) => drawGroup(pool, key, folded.has(key), toggle)),
    ]
  }
  return (
    <div ref={scrollRef} data-pool-list style={{ overflowY: 'auto', height: '100vh' }}>
      {body}
    </div>
  )
})
