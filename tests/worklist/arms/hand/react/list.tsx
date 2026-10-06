/**
 * POD-4446 — the hand-rolled arm's own windowed UI (spec §4 UI contract).
 *
 * One subscription key per row (`useHandKey(id)` + `useHandKey(selected:id)`,
 * bound with useSyncExternalStore over stored objects by identity); the list
 * subscribes to `order` only; headers to `group:<key>`. No whole-array props
 * anywhere — a row receives its id plus the store, never collections.
 * Selection renders from locals, never from the row object (R-SEL).
 *
 * Windowing is hand-rolled (fixed item heights + overscan): when the
 * container cannot be measured (height 0 — unit renderers have no layout)
 * the list degrades to a full render instead of guessing a window.
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
import type { SliceRow } from '@podium/client-graph/shared/slice-types'
import type { HandStore } from '../store'

export function useHandKey<T>(store: HandStore, key: string): T {
  return useSyncExternalStore(
    (listener) => store.subscribe(key, listener),
    () => store.get(key) as T,
  )
}

const ROW_H = 56
const HEADER_H = 40

const HandRow = memo(function HandRow({
  store,
  id,
}: {
  store: HandStore
  id: string
}): ReactElement | null {
  const row = useHandKey<SliceRow | null>(store, id)
  const selected = useHandKey<boolean>(store, `selected:${id}`)
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

const HandGroupHeader = memo(function HandGroupHeader({
  store,
  groupKey,
}: {
  store: HandStore
  groupKey: string
}): ReactElement | null {
  const group = useHandKey<{ label: string; rowIds: string[]; closedIds: string[] } | null>(
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

export function HandList({ store }: { store: HandStore }): ReactElement {
  const order = useHandKey<OrderView>(store, 'order')
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
      data-hand-list
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
                <HandRow store={store} id={item.id} />
              </div>
            )
          }
          if (item.kind === 'header') {
            return (
              <div key={item.key} style={style}>
                <HandGroupHeader store={store} groupKey={item.key} />
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
