/**
 * POD-4447 — the MobX arm's own windowed UI (spec §4 UI contract).
 *
 * `observer` components read model fields as late as possible: the list
 * reads `worklist.order` only, headers read their group slice, rows read
 * their own `row` plus `isSelected`. A row receives its model, never arrays
 * — passing model objects through props is fine; reading plain values
 * outside `observer` is the untracked-staging foot-gun (K2).
 *
 * Windowing is fixed item heights plus overscan; when the container cannot be
 * measured (height 0 — unit renderers have no layout) the list degrades to a
 * full render instead of guessing a window.
 */

import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import { observer } from 'mobx-react-lite'
import { CommitBoundary } from '../../../shared/src/row-shell'
import type { SliceRow } from '../../../shared/src/slice-types'
import type { IssueModel } from '../models/issue'
import type { MobXStore } from '../store'

const ROW_H = 56
const HEADER_H = 40

const MobxRowView = observer(function MobxRowView({
  model,
  store,
}: {
  model: IssueModel
  store: MobXStore
}): ReactElement | null {
  const row = model.row as SliceRow | null
  const selected = model.isSelected
  if (row === null) return null
  const tick = model.tick
  return (
    <CommitBoundary id={row.id}>
      <div data-issue-row={row.id} data-selected={selected ? 'true' : 'false'}>
        <button type="button" data-pressable onClick={() => store.setSelection(row.id)}>
          {row.displayRef} {row.title} [{row.phase}
          {row.working ? '*' : ''}
          {row.asking ? '?' : ''}] {row.progressDone}/{row.progressTotal}
          {tick !== null ? ` ⤷${tick.ref}` : ''}
        </button>
      </div>
    </CommitBoundary>
  )
})

const MobxRow = observer(function MobxRow({
  model,
  store,
}: {
  model: IssueModel
  store: MobXStore
}): ReactElement {
  return <MobxRowView model={model} store={store} />
})

const MobxGroupHeader = observer(function MobxGroupHeader({
  store,
  groupKey,
}: {
  store: MobXStore
  groupKey: string
}): ReactElement | null {
  const group = store.worklist.groups.groups.find((entry) => entry.key === groupKey) ?? null
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

export const MobxList = observer(function MobxList({
  store,
}: {
  store: MobXStore
}): ReactElement {
  const pinnedIds = store.worklist.groups.pinnedIds
  const groups = store.worklist.groups.groups
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [range, setRange] = useState<{ start: number; end: number } | null>(null)

  const items: Item[] = []
  if (pinnedIds.length > 0) {
    items.push({ kind: 'pinned-header' })
    for (const id of pinnedIds) items.push({ kind: 'row', id })
  }
  for (const group of groups) {
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
  }, [pinnedIds, groups])

  const windowed = range === null ? items : items.slice(range.start, range.end)
  const base = range === null ? 0 : range.start
  return (
    <div
      ref={containerRef}
      data-mobx-list
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
            const model = store.issues.get(item.id)
            if (!model) return null
            return (
              <div key={item.id} style={style}>
                <MobxRow model={model} store={store} />
              </div>
            )
          }
          if (item.kind === 'header') {
            return (
              <div key={item.key} style={style}>
                <MobxGroupHeader store={store} groupKey={item.key} />
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
})
