import { worklistGroups } from '@podium/client-graph/worklist/groups'
import { sidebarView } from '@podium/client-graph/worklist/sidebar'
import { PoolRowSlot } from '@podium/client-graph/react'
/**
 * POD-4565 (Ma1), POD-4569 (Mb1), POD-4570 (Mb2) — the pool's web list: the
 * PINNED section, then each group's header, open lane and closed fold
 * (`pool.groups`, `../worklist/groups.ts`), windowed with
 * fixed-height lane geometry (spec §4 UI contract).
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
 * round two's lists did. The window count variant supplies a box from the
 * harness, with no product test hook. One stable plan memoizes each lane's
 * segment; a changed lane replaces only its payload and the offsets after
 * it. Pixel/index lookup is binary search over lanes plus fixed-height
 * arithmetic, and only the viewport plus overscan is materialized. There is
 * no per-row measurement cache to rebuild when a count or key changes.
 *
 * The pool arrives through props, typed only.
 */

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
import type { WorklistIssue } from '@podium/client-graph/worklist/issue'
import type { MobxPool } from '@podium/client-graph/pool'
import type { WorklistGroups } from '@podium/client-graph/worklist/groups'
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

/** Demo renderers; the product package owns the row observation boundaries. */
function renderPoolRow(model: WorklistIssue): ReactElement {
  return <RowShell row={model} component={PoolRow} />
}

function renderPoolLoading(id: string): ReactElement {
  return <div data-loading-row={id} />
}

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
  const ids = laneIds(worklistGroups(pool), lane, groupKey)
  return (
    <>
      {lane === 'pinned' && ids.length > 0 ? <div key="pinned">{PINNED_TITLE}</div> : null}
      {ids.map((id) => (
        <div key={id}>
          <PoolRowSlot
            pool={pool}
            id={id}
            renderRow={renderPoolRow}
            renderLoading={renderPoolLoading}
          />
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
          groups={worklistGroups(pool)}
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
  if (item.kind === 'row')
    return (
      <PoolRowSlot
        pool={pool}
        id={item.id}
        renderRow={renderPoolRow}
        renderLoading={renderPoolLoading}
      />
    )
  if (item.kind === 'pinned') return PINNED_TITLE
  return (
    <PoolGroupHeader
      groups={worklistGroups(pool)}
      groupKey={item.key}
      folded={folded.has(item.key)}
      onToggle={onToggle}
    />
  )
}

/** One lane's immutable geometry, memoized by its id-array identity. */
interface LaneSegment {
  readonly key: string
  readonly title: Item | null
  readonly ids: readonly string[]
  readonly count: number
  readonly height: number
}

/** A lane's offsets in the index and pixel spaces. */
export interface Segment {
  readonly start: number
  readonly top: number
  readonly lane: LaneSegment
}

/**
 * The fixed-height window's stable segment table. Updating visits lanes,
 * never their rows: unchanged lane payloads survive, and an unchanged prefix
 * keeps its segment objects too. No row index is held here.
 */
export class WindowPlan {
  readonly segments: Segment[] = []
  private readonly lanes = new Map<string, LaneSegment>()
  count = 0
  height = 0

  update(groups: WorklistGroups, keys: readonly string[], folded: ReadonlySet<string>): void {
    let start = 0
    let top = 0
    let next = 0
    const active = new Set<string>()
    const add = (key: string, title: Item | null, ids: readonly string[]): void => {
      if (title === null && ids.length === 0) return
      active.add(key)
      let lane = this.lanes.get(key)
      if (lane === undefined || lane.ids !== ids) {
        lane = {
          key,
          title,
          ids,
          count: ids.length + (title === null ? 0 : 1),
          height: ids.length * ROW_HEIGHT + (title === null ? 0 : HEADER_HEIGHT),
        }
        this.lanes.set(key, lane)
      }
      const previous = this.segments[next]
      this.segments[next] =
        previous?.lane === lane && previous.start === start && previous.top === top
          ? previous
          : { start, top, lane }
      next += 1
      start += lane.count
      top += lane.height
    }
    const pinnedIds = groups.pinnedIds
    if (pinnedIds.length > 0) add('pinned', { kind: 'pinned' }, pinnedIds)
    for (const key of keys) {
      const group = groups.group(key)
      add(`group:${key}`, { kind: 'header', key }, group.rowIds)
      if (!folded.has(key)) add(`closed:${key}`, null, group.closedIds)
    }
    this.segments.length = next
    for (const key of this.lanes.keys()) if (!active.has(key)) this.lanes.delete(key)
    this.count = start
    this.height = top
  }

  private segmentAt(value: number, space: 'start' | 'top'): Segment {
    let low = 0
    let high = this.segments.length - 1
    while (low < high) {
      const middle = (low + high + 1) >> 1
      if ((this.segments[middle] as Segment)[space] <= value) low = middle
      else high = middle - 1
    }
    return this.segments[low] as Segment
  }

  /** The item at `index` (0 <= index < count). */
  at(index: number): Item {
    const segment = this.segmentAt(index, 'start')
    const offset = index - segment.start
    if (segment.lane.title === null) return { kind: 'row', id: segment.lane.ids[offset] as string }
    if (offset === 0) return segment.lane.title
    return { kind: 'row', id: segment.lane.ids[offset - 1] as string }
  }

  /** Stable key/size functions over the current plan, also used by the browser cache probe. */
  readonly getItemKey = (index: number): string => itemKey(this.at(index))
  readonly estimateSize = (index: number): number =>
    this.at(index).kind === 'row' ? ROW_HEIGHT : HEADER_HEIGHT

  topOf(index: number): number {
    const segment = this.segmentAt(index, 'start')
    const offset = index - segment.start
    if (segment.lane.title === null) return segment.top + offset * ROW_HEIGHT
    return segment.top + (offset === 0 ? 0 : HEADER_HEIGHT + (offset - 1) * ROW_HEIGHT)
  }

  indexAt(top: number): number {
    const segment = this.segmentAt(top, 'top')
    const offset = top - segment.top
    if (segment.lane.title === null) return segment.start + Math.floor(offset / ROW_HEIGHT)
    return segment.start +
      (offset < HEADER_HEIGHT ? 0 : 1 + Math.floor((offset - HEADER_HEIGHT) / ROW_HEIGHT))
  }

  /** Only the drawn items: independent of the number of rows in the lanes. */
  window(
    offset: number,
    height: number,
  ): { index: number; key: string; start: number; size: number }[] {
    if (this.count === 0 || height <= 0) return []
    const top = Math.max(0, Math.min(offset, Math.max(0, this.height - height)))
    const first = Math.max(0, this.indexAt(top) - OVERSCAN)
    const last = Math.min(
      this.count - 1,
      this.indexAt(Math.min(this.height - 1, top + height - 1)) + OVERSCAN,
    )
    const entries = []
    for (let index = first; index <= last; index += 1) {
      entries.push({
        index,
        key: this.getItemKey(index),
        start: this.topOf(index),
        size: this.estimateSize(index),
      })
    }
    return entries
  }
}

export const PoolList = observer(function PoolList({ pool }: { pool: MobxPool }): ReactElement {
  // Measure the real section payload in this existing list observer.
  void sidebarView(pool).sections()
  const groups = worklistGroups(pool)
  // Every layout reads the keys (the first, unmeasured render too).
  const keys = groups.keys
  const scrollRef = useRef<HTMLDivElement | null>(null)
  // 'unknown' until the container is measured (before paint), then a window
  // or, with no layout at all, every item.
  const [layout, setLayout] = useState<'unknown' | 'window' | 'all'>('unknown')
  const [window, setWindow] = useState({ offset: 0, height: 0 })
  const [windowPlan] = useState(() => new WindowPlan())
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set())
  const toggle = useCallback((key: string) => {
    setFolded((previous) => {
      const next = new Set(previous)
      if (!next.delete(key)) next.add(key)
      return next
    })
  }, [])

  useLayoutEffect(() => {
    const element = scrollRef.current
    if (element === null) return
    const measure = (): void => {
      const height = element.clientHeight
      const offset = element.scrollTop
      setLayout(height > 0 ? 'window' : 'all')
      setWindow((previous) =>
        previous.height === height && previous.offset === offset ? previous : { height, offset },
      )
    }
    measure()
    element.addEventListener('scroll', measure, { passive: true })
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    resize?.observe(element)
    return () => {
      element.removeEventListener('scroll', measure)
      resize?.disconnect()
    }
  }, [])

  // The full-list layout leaves each lane to its own observer. Only the
  // window reads the lanes here; its stable plan memoizes their geometry.
  const plan = layout === 'window' ? windowPlan : null
  plan?.update(groups, keys, folded)

  let body: ReactElement | ReactElement[] | null = null
  if (plan !== null) {
    body = (
      <div style={{ height: plan.height, position: 'relative' }}>
        {plan.window(window.offset, window.height).map((entry) => {
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
