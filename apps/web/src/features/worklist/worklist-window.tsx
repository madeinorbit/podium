import {
  Fragment,
  type JSX,
  type KeyboardEvent,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useBoundedVirtualList } from '@/features/issues/use-bounded-virtual-list'

const focusable = 'button:not([disabled]), input:not([disabled]), [tabindex="0"], a[href]'

/** Mount geometry only; callers keep the complete order and all action state. */
export function WorklistWindow<T>({
  rows,
  rowKey,
  renderRow,
  scrollRef,
  selectedKey,
  draggingKey,
  dragScope,
  dragId,
  estimateSize = 50,
}: {
  rows: readonly T[]
  rowKey: (row: T) => string
  renderRow: (row: T) => JSX.Element
  scrollRef: RefObject<HTMLElement | null>
  selectedKey?: string | null
  draggingKey?: string | null
  dragScope?: string
  dragId?: (row: T) => string | undefined
  estimateSize?: number
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const keys = useMemo(() => rows.map(rowKey), [rows, rowKey])
  const [focusedKey, setFocusedKey] = useState<string | null>(null)
  const [revealKey, setRevealKey] = useState<string | null>(selectedKey ?? null)
  const pendingFocus = useRef<{ key: string; last: boolean } | null>(null)
  useLayoutEffect(() => setRevealKey(selectedKey ?? null), [selectedKey])
  useEffect(() => {
    if (!revealKey) return
    const frame = requestAnimationFrame(() => setRevealKey(null))
    return () => cancelAnimationFrame(frame)
  }, [revealKey])
  const virtual = useBoundedVirtualList({
    keys,
    scrollRef,
    containerRef,
    estimateSize,
    overscan: 3,
    pinnedKeys: [focusedKey, draggingKey, revealKey],
    revealKey,
  })
  useLayoutEffect(() => {
    const pending = pendingFocus.current
    if (!pending) return
    const row = containerRef.current?.querySelector<HTMLElement>(
      `[data-window-row="${CSS.escape(pending.key)}"]`,
    )
    const controls = row?.querySelectorAll<HTMLElement>(focusable)
    const control = pending.last ? controls?.[controls.length - 1] : controls?.[0]
    if (control) {
      pendingFocus.current = null
      control.focus({ preventScroll: true })
    }
  })
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.target instanceof HTMLInputElement)
      return
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-window-row]')
    const index = keys.indexOf(row?.dataset.windowRow ?? '')
    if (index < 0) return
    let next = index
    let last = false
    if (event.key === 'ArrowDown') next++
    else if (event.key === 'ArrowUp') {
      next--
      last = true
    } else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = keys.length - 1
    else if (event.key === 'Tab') {
      const controls = row!.querySelectorAll<HTMLElement>(focusable)
      const edge = event.shiftKey ? controls[0] : controls[controls.length - 1]
      if (event.target !== edge) return
      next += event.shiftKey ? -1 : 1
      last = event.shiftKey
      // Native Tab still owns movement inside the mounted window and to bands.
      if (
        containerRef.current?.querySelector(`[data-window-row="${CSS.escape(keys[next] ?? '')}"]`)
      )
        return
    } else return
    const key = keys[next]
    if (!key || next === index) return
    event.preventDefault()
    event.stopPropagation()
    pendingFocus.current = { key, last }
    setFocusedKey(key)
    setRevealKey(key)
  }
  let end = 0
  return (
    <div
      ref={containerRef}
      data-testid="worklist-window"
      data-window-count={rows.length}
      data-drag-scope={dragScope}
      className="min-w-0"
      onKeyDown={onKeyDown}
      onFocusCapture={(event) => {
        const row = (event.target as HTMLElement).closest<HTMLElement>('[data-window-row]')
        setFocusedKey(row?.dataset.windowRow ?? null)
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusedKey(null)
      }}
    >
      {virtual.items.map((item) => {
        const gap = Math.max(0, item.start - end)
        end = item.start + item.size
        const row = rows[item.index]!
        return (
          <Fragment key={item.key}>
            {gap > 0 && <div aria-hidden="true" style={{ height: gap }} />}
            <div
              ref={virtual.measureRef(item.key)}
              data-window-row={item.key}
              data-drag-key={dragScope ? dragId?.(row) : undefined}
              aria-posinset={item.index + 1}
              aria-setsize={rows.length}
            >
              {renderRow(row)}
            </div>
          </Fragment>
        )
      })}
      {virtual.totalSize > end && (
        <div aria-hidden="true" style={{ height: virtual.totalSize - end }} />
      )}
    </div>
  )
}
