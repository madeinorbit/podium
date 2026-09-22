/**
 * POD-4448 — the TanStack arm's own windowed UI (spec §4 UI contract).
 *
 * Keyed subscriptions, not per-row live queries: each row reads its own
 * committed key (plus `selected:<id>`) through useSyncExternalStore over
 * identity-stable row objects; the list reads `order` only; headers read
 * `group:<key>`. A row receives its id plus the store, never arrays. The
 * arm's per-row useLiveQuery(findOne) variant was measured against this
 * (see tanstack.test.ts "bindings"): identical commits, one live query
 * instance per mounted row — the keyed subscription stays the default.
 * Selection renders from locals, never from the row object (R-SEL).
 *
 * Windowing is hand-rolled (fixed item heights + overscan, full-render
 * fallback at height 0), the same call the MobX arm made: no new
 * virtualization dependency for M1.
 */

import {
  memo,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactElement,
} from 'react'
import { CommitBoundary } from '../../../shared/src/row-shell'
import type { SliceRow } from '../../../shared/src/slice-types'
import type { TanStackStore } from '../store'

export function useTanStackKey<T>(store: TanStackStore, key: string): T {
  return useSyncExternalStore(
    (listener) => store.subscribe(key, listener),
    () => store.get(key) as T,
  )
}

const ROW_H = 56
const HEADER_H = 40

const TanStackRow = memo(function TanStackRow({
  store,
  id,
}: {
  store: TanStackStore
  id: string
}): ReactElement | null {
  const row = useTanStackKey<SliceRow | null>(store, id)
  const selected = useTanStackKey<boolean>(store, `selected:${id}`)
  if (row === null) return null
  const tick = store.rollup.ticks.get(id) ?? null
  return (
    <CommitBoundary id={id}>
      <div data-issue-row={id} data-selected={selected ? 'true' : 'false'}>
        <button type="button" data-pressable onClick={() => store.setSelection(id)}>
          {row.displayRef} {row.title} [{row.phase}
          {row.working ? '*' : ''}
          {row.asking ? '?' : ''}] {row.progressDone}/{row.progressTotal}
          {tick !== null ? ` ⤷${tick.ref}` : ''}
        </button>
      </div>
    </CommitBoundary>
  )
})

const TanStackGroupHeader = memo(function TanStackGroupHeader({
  store,
  groupKey,
}: {
  store: TanStackStore
  groupKey: string
}): ReactElement | null {
  const group = useTanStackKey<{ label: string; rowIds: string[]; closedIds: string[] } | null>(
    store,
    `group:${groupKey}`,
  )
  if (group === null) return null
  return (
    <div data-group={groupKey}>
      <span>
        {group.label} {group.rowIds.length}+{group.closedIds.length}
      </span>
    </div>
  )
})

type Item = { kind: 'pinned-header' } | { kind: 'row'; id: string } | { kind: 'header'; key: string }

function itemHeight(item: Item): number {
  return item.kind === 'row' ? ROW_H : HEADER_H
}

interface OrderView {
  pinnedIds: string[]
  groups: { key: string; rowIds: string[]; closedIds: string[] }[]
}

export function TanStackList({ store }: { store: TanStackStore }): ReactElement {
  const order = useTanStackKey<OrderView>(store, 'order')
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [range, setRange] = useState<{ start: number; end: number } | null>(null)

  const items: Item[] = []
  if (order.pinnedIds.length > 0) {
    items.push({ kind: 'pinned-header' })
    for (const id of order.pinnedIds) items.push({ kind: 'row', id })
  }
  for (const group of order.groups) {
    items.push({ kind: 'header', key: group.key })
    for (const id of group.rowIds) items.push({ kind: 'row', id })
    for (const id of group.closedIds) items.push({ kind: 'row', id })
  }

  const offsets: number[] = new Array(items.length)
  let total = 0
  for (let i = 0; i < items.length; i += 1) {
    offsets[i] = total
    total += itemHeight(items[i] as Item)
  }

  useEffect(() => {
    const el = containerRef.current
    if (el === null) return
    const update = (): void => {
      const height = el.clientHeight
      if (height === 0) {
        setRange(null)
        return
      }
      const top = Math.max(0, el.scrollTop - 5 * ROW_H)
      const bottom = el.scrollTop + height + 5 * ROW_H
      let start = 0
      let end = items.length
      for (let i = 0; i < items.length; i += 1) {
        if ((offsets[i] as number) + itemHeight(items[i] as Item) < top) start = i + 1
        if ((offsets[i] as number) > bottom) {
          end = i
          break
        }
      }
      setRange((prev) =>
        prev !== null && prev.start === start && prev.end === end ? prev : { start, end },
      )
    }
    update()
    el.addEventListener('scroll', update, { passive: true })
    return () => el.removeEventListener('scroll', update)
  }, [order])

  const windowed = range === null ? items : items.slice(range.start, range.end)
  const base = range === null ? 0 : range.start
  return (
    <div
      ref={containerRef}
      data-tanstack-list
      style={{ overflowY: 'auto', height: '100vh', maxHeight: '100vh' }}
    >
      <div style={range === null ? undefined : { height: total, position: 'relative' }}>
        {windowed.map((item, index) => {
          const absolute = base + index
          const style: CSSProperties | undefined =
            range === null
              ? undefined
              : {
                  position: 'absolute',
                  top: offsets[absolute],
                  left: 0,
                  right: 0,
                  height: itemHeight(item),
                }
          if (item.kind === 'row') {
            return (
              <div key={item.id} style={style}>
                <TanStackRow store={store} id={item.id} />
              </div>
            )
          }
          if (item.kind === 'header') {
            return (
              <div key={item.key} style={style}>
                <TanStackGroupHeader store={store} groupKey={item.key} />
              </div>
            )
          }
          return (
            <div key="pinned" style={style}>
              <div data-group="PINNED">Pinned</div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
