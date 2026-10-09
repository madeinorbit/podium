import { observer } from '@podium/client-graph/react'
import { settled } from '@podium/client-graph/mission-view'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import type { JSX, RefCallback, RefObject } from 'react'
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'

export const DECK_OVERSCAN = 3
const INITIAL_ROWS = 24
const SIZE_CACHE = 256

export interface DeckWindowRow {
  key: string
  size: number
  text?: string
}

export const deckTaskKey = (id: string): string => `task:${id}`
export const deckSessionKey = (issueId: string, id: string): string => `session:${issueId}:${id}`

export interface DeckWindow {
  enabled: boolean
  contains: (key: string) => boolean
  size: (key: string) => number
  text: (key: string) => string | undefined
  measure: (key: string) => RefCallback<HTMLElement>
  reveal: (key: string, focus?: boolean | 'last') => void
  beginFind: (key: string) => void
}

function focusRow(node: HTMLElement, last: boolean): void {
  const controls = [...node.querySelectorAll<HTMLElement>('button, input, [tabindex]')].filter(
    (control) => control.tabIndex >= 0 && !control.matches(':disabled'),
  )
  const visible = controls.filter((control) => control.getClientRects().length > 0)
  // Unlaid-out fixtures have no rects. Hover-only menu affordances are hidden
  // there too, and must not displace the row's actual first/last Tab stop.
  const candidates = visible.length
    ? visible
    : controls.filter((control) => !control.closest('[data-hover-reveal]'))
  ;(last ? candidates.at(-1) : candidates[0])?.focus({ preventScroll: true })
}

function selectMatch(node: HTMLElement, text: string): boolean {
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
  const parts: Text[] = []
  let content = ''
  while (walker.nextNode()) {
    const part = walker.currentNode as Text
    parts.push(part)
    content += part.data
  }
  const start = content.toLocaleLowerCase().indexOf(text.toLocaleLowerCase())
  if (start < 0) return false
  const range = document.createRange()
  let offset = 0
  for (const part of parts) {
    if (start >= offset && start < offset + part.length) range.setStart(part, start - offset)
    if (start + text.length > offset && start + text.length <= offset + part.length) {
      range.setEnd(part, start + text.length - offset)
      break
    }
    offset += part.length
  }
  const selection = document.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
  return true
}

/** One geometry model for task bands AND their sessions. Windowing task blocks
 * alone leaves an unbounded roster mounted when one task owns many sessions. */
export function useFlightDeckWindow(
  rows: readonly DeckWindowRow[],
  scrollRef: RefObject<HTMLElement | null>,
  containerRef: RefObject<HTMLElement | null>,
  scope: string,
  viewportKey = scope,
): DeckWindow {
  const sizes = useRef(new Map<string, number>())
  const nodes = useRef(new Map<string, HTMLElement>())
  const callbacks = useRef(new Map<string, RefCallback<HTMLElement>>())
  const observer = useRef<ResizeObserver | null>(null)
  const pendingFocus = useRef<{ key: string; last: boolean } | null>(null)
  const pendingFind = useRef<{ key: string; text: string } | null>(null)
  const nativeFind = useRef<{
    key: string
    anchor: Node | null
    anchorOffset: number
    focus: Node | null
    focusOffset: number
  } | null>(null)
  const priorScope = useRef(scope)
  const priorViewportKey = useRef(viewportKey)
  const priorLayout = useRef<ReturnType<typeof layoutOf> | null>(null)
  const frame = useRef<number | null>(null)
  const [revision, setRevision] = useState(0)
  const [viewport, setViewport] = useState({ top: 0, height: 0, width: 0 })
  // Measurements belong to a mission and a width, never to a later mission
  // which happens to reuse a row id or to the wide one-line composition.
  if (priorScope.current !== scope) {
    sizes.current.clear()
    priorLayout.current = null
    priorScope.current = scope
    pendingFind.current = null
    nativeFind.current = null
  }
  if (priorViewportKey.current !== viewportKey) {
    priorLayout.current = null
    priorViewportKey.current = viewportKey
  }
  const layout = useMemo(() => {
    void revision
    return layoutOf(rows, sizes.current)
  }, [rows, revision, scope])
  const current = useRef(layout)
  current.current = layout

  const captureFind = useCallback(() => {
    const selection = document.getSelection()
    const anchor = selection?.anchorNode
    const proxy = anchor?.parentElement?.closest<HTMLElement>('[data-deck-placeholder]')
    const key = proxy?.dataset.deckPlaceholder
    const text = selection?.toString()
    if (key && text && proxy && containerRef.current?.contains(proxy)) {
      pendingFind.current = { key, text }
      // Chromium's Find UI keeps its match outside DOM Selection until Find
      // closes. Its text node must survive until that selection is committed.
    }
    const held = nativeFind.current
    if (
      held &&
      text &&
      selection &&
      (key === held.key ||
        selection.anchorNode !== held.anchor ||
        selection.anchorOffset !== held.anchorOffset ||
        selection.focusNode !== held.focus ||
        selection.focusOffset !== held.focusOffset)
    ) {
      nativeFind.current = null
      setRevision((value) => value + 1)
    }
  }, [containerRef])
  const finishFind = useCallback(() => {
    if (!nativeFind.current) return
    captureFind()
    if (nativeFind.current) {
      nativeFind.current = null
      setRevision((value) => value + 1)
    }
  }, [captureFind])
  const beginFind = useCallback((key: string) => {
    const selection = document.getSelection()
    nativeFind.current = {
      key,
      anchor: selection?.anchorNode ?? null,
      anchorOffset: selection?.anchorOffset ?? 0,
      focus: selection?.focusNode ?? null,
      focusOffset: selection?.focusOffset ?? 0,
    }
    setRevision((value) => value + 1)
  }, [])

  const readViewport = useCallback(() => {
    const scroll = scrollRef.current
    const container = containerRef.current
    if (!scroll || !container || scroll.clientHeight <= 0) return
    // Native find can scroll to its hidden text before dispatching beforematch.
    // Retain the range before the viewport update replaces that text node.
    captureFind()
    const scrollBox = scroll.getBoundingClientRect()
    const box = container.getBoundingClientRect()
    const chrome =
      scroll.querySelector<HTMLElement>('.deck-chrome')?.getBoundingClientRect().height ?? 0
    const next = {
      top: scrollBox.top + chrome - box.top,
      height: Math.max(0, scroll.clientHeight - chrome),
      width: box.width,
    }
    setViewport((old) => {
      if (old.width && old.width !== next.width) {
        sizes.current.clear()
        setRevision((value) => value + 1)
      }
      return old.top === next.top && old.height === next.height && old.width === next.width
        ? old
        : next
    })
  }, [scrollRef, containerRef, captureFind])
  const scheduleViewport = useCallback(() => {
    if (frame.current !== null) return
    frame.current = requestAnimationFrame(() => {
      frame.current = null
      // Publish once per frame, but commit the replacement rows before that
      // frame paints the browser's new scroll offset.
      flushSync(readViewport)
    })
  }, [readViewport])

  useLayoutEffect(() => {
    const scroll = scrollRef.current
    if (!scroll || !containerRef.current) return
    readViewport()
    scroll.addEventListener('scroll', scheduleViewport, { passive: true })
    document.addEventListener('selectionchange', captureFind)
    document.addEventListener('pointerdown', finishFind, true)
    document.addEventListener('keydown', finishFind, true)
    const resize =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scheduleViewport)
    resize?.observe(scroll)
    resize?.observe(containerRef.current)
    return () => {
      scroll.removeEventListener('scroll', scheduleViewport)
      document.removeEventListener('selectionchange', captureFind)
      document.removeEventListener('pointerdown', finishFind, true)
      document.removeEventListener('keydown', finishFind, true)
      resize?.disconnect()
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      frame.current = null
    }
  }, [scope, scrollRef, containerRef, readViewport, scheduleViewport, captureFind, finishFind])

  // Retain the same row and pixel after a fold, filter or addressed update.
  // Only the deck scroller is adjusted: transcript scroll/anchor belongs to its
  // own pane. Browser anchoring is disabled on this window's scroll surface.
  useLayoutEffect(() => {
    const previous = priorLayout.current
    const scroll = scrollRef.current
    if (
      previous &&
      scroll &&
      viewport.height > 0 &&
      viewport.top >= 0 &&
      viewport.top < previous.total
    ) {
      const index = rowAt(previous.ends, viewport.top)
      const key = previous.rows[index]?.key
      const nextIndex = key ? layout.index.get(key) : undefined
      if (nextIndex !== undefined) {
        const delta = layout.starts[nextIndex]! - previous.starts[index]!
        if (Math.abs(delta) >= 0.5) scroll.scrollTop += delta
      }
    }
    priorLayout.current = layout
    readViewport()
  }, [layout, readViewport, scrollRef])

  useLayoutEffect(() => {
    if (typeof ResizeObserver === 'undefined') return
    const resize = new ResizeObserver((entries) => {
      let changed = false
      for (const entry of entries) {
        const node = entry.target as HTMLElement
        const key = node.dataset.deckMeasure
        const index = key ? current.current.index.get(key) : undefined
        const height = entry.borderBoxSize?.[0]?.blockSize ?? node.getBoundingClientRect().height
        if (!key || index === undefined || height <= 0 || !Number.isFinite(height)) continue
        const old = sizes.current.get(key) ?? current.current.rows[index]!.size
        if (Math.abs(old - height) < 0.5) continue
        sizes.current.delete(key)
        sizes.current.set(key, height)
        changed = true
      }
      // Bounded measurement and element retention, even after traversing every
      // row. Mounted measurements are refreshed by the observer when revisited.
      while (sizes.current.size > SIZE_CACHE)
        sizes.current.delete(sizes.current.keys().next().value!)
      if (changed) setRevision((value) => value + 1)
    })
    observer.current = resize
    for (const node of nodes.current.values()) resize.observe(node)
    return () => {
      resize.disconnect()
      observer.current = null
    }
  }, [])

  const measure = useCallback((key: string): RefCallback<HTMLElement> => {
    const saved = callbacks.current.get(key)
    if (saved) return saved
    const callback: RefCallback<HTMLElement> = (node) => {
      const previous = nodes.current.get(key)
      if (previous) observer.current?.unobserve(previous)
      if (!node) {
        nodes.current.delete(key)
        callbacks.current.delete(key)
        return
      }
      node.dataset.deckMeasure = key
      nodes.current.set(key, node)
      observer.current?.observe(node)
      if (pendingFind.current?.key === key) {
        selectMatch(node, pendingFind.current.text)
        pendingFind.current = null
      }
      if (pendingFocus.current?.key === key) {
        const { last } = pendingFocus.current
        pendingFocus.current = null
        focusRow(node, last)
      }
    }
    callbacks.current.set(key, callback)
    return callback
  }, [])

  const reveal = useCallback(
    (key: string, focus: boolean | 'last' = false) => {
      const model = current.current
      const index = model.index.get(key)
      const scroll = scrollRef.current
      const container = containerRef.current
      if (index === undefined || !scroll || !container) return
      captureFind()
      nativeFind.current = null
      if (focus) pendingFocus.current = { key, last: focus === 'last' }
      const containerTop =
        container.getBoundingClientRect().top -
        scroll.getBoundingClientRect().top +
        scroll.scrollTop
      const start = model.starts[index]!
      const height = scroll.clientHeight
      const chrome =
        scroll.querySelector<HTMLElement>('.deck-chrome')?.getBoundingClientRect().height ?? 0
      // End alignment stays below the sticky mission chrome, including an
      // above-viewport reveal.
      scroll.scrollTop = Math.max(0, containerTop + model.ends[index]! - height)
      setViewport({
        top: scroll.scrollTop + chrome - containerTop,
        height: Math.max(0, height - chrome),
        width: container.getBoundingClientRect().width,
      })
      if (focus && nodes.current.has(key)) {
        pendingFocus.current = null
        focusRow(nodes.current.get(key)!, focus === 'last')
      }
      if (height <= 0) setViewport((old) => ({ ...old, top: start, height: 1 }))
    },
    [scrollRef, containerRef, captureFind],
  )

  // Small, unlaid-out test/SSR trees preserve the original DOM. Real viewports
  // always window; the cold large-tree render has a bounded initial budget.
  const enabled = rows.length > 64 || viewport.height > 0
  let first = 0
  let last = rows.length
  if (enabled) {
    const buffer = viewport.height
    first = Math.max(0, rowAt(layout.ends, Math.max(0, viewport.top - buffer)) - DECK_OVERSCAN)
    last =
      viewport.height > 0
        ? Math.min(
            rows.length,
            rowAt(layout.ends, Math.max(0, viewport.top + viewport.height + buffer)) + DECK_OVERSCAN + 1,
          )
        : Math.min(rows.length, first + INITIAL_ROWS)
    if (
      viewport.height > 0 &&
      (viewport.top - buffer >= layout.total || viewport.top + viewport.height + buffer <= 0)
    )
      last = first = 0
  }
  const selected =
    typeof document === 'undefined' ? null : (document.getSelection()?.anchorNode ?? null)
  return {
    enabled,
    contains: (key) => {
      if (nativeFind.current?.key === key) return false
      const index = layout.index.get(key)
      const node = nodes.current.get(key)
      return (
        (index !== undefined && index >= first && index < last) ||
        pendingFind.current?.key === key ||
        Boolean(node?.contains(document.activeElement)) ||
        Boolean(node?.contains(selected))
      )
    },
    size: (key) => {
      const index = layout.index.get(key)
      return index === undefined ? 0 : layout.ends[index]! - layout.starts[index]!
    },
    text: (key) => {
      const index = layout.index.get(key)
      return index === undefined ? undefined : layout.rows[index]!.text
    },
    measure,
    reveal,
    beginFind,
  }
}

function layoutOf(rows: readonly DeckWindowRow[], sizes: ReadonlyMap<string, number>) {
  const starts: number[] = [],
    ends: number[] = [],
    index = new Map<string, number>()
  let total = 0
  rows.forEach((row, i) => {
    index.set(row.key, i)
    starts.push(total)
    total += sizes.get(row.key) ?? row.size
    ends.push(total)
  })
  return { rows, starts, ends, index, total }
}
function rowAt(ends: readonly number[], offset: number): number {
  let low = 0,
    high = ends.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (ends[mid]! <= offset) low = mid + 1
    else high = mid
  }
  return low
}

/** Searchable text costs one inert element per unmounted row, not a component
 * tree/menu per row. Native find reveals it through beforematch or its scroll. The focus
 * sentinel keeps ordinary Tab traversal reaching rows outside the window. */
export const DeckRowPlaceholder = observer(function DeckRowPlaceholder({
  row,
  window: deckWindow,
}: {
  row: DeckWindowRow
  window: DeckWindow
}): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const value = settled(() => row.text)
  const text = value === LOADING ? undefined : value
  useLayoutEffect(() => {
    const node = ref.current
    // React treats hidden as a boolean DOM property. Set the enumerated value
    // explicitly so native find can search it rather than display:none it.
    node?.setAttribute('hidden', 'until-found')
    const found = () => deckWindow.beginFind(row.key)
    node?.addEventListener('beforematch', found)
    return () => {
      node?.removeEventListener('beforematch', found)
    }
  }, [deckWindow.beginFind, row.key, text])
  return (
    <div
      style={{ height: deckWindow.size(row.key), position: 'relative' }}
      data-deck-placeholder={row.key}
      onPointerDown={() => flushSync(() => deckWindow.reveal(row.key, true))}
    >
      {text && (
        <>
          <div ref={ref} hidden style={{ position: 'absolute', inset: 0 }} aria-hidden="true">
            {text}
          </div>
          <button
            type="button"
            className="sr-only"
            aria-label={text}
            onFocus={(event) => {
              const from = event.relatedTarget
              const reverse =
                from instanceof Node &&
                Boolean(
                  event.currentTarget.parentElement!.compareDocumentPosition(from) &
                    Node.DOCUMENT_POSITION_FOLLOWING,
                )
              flushSync(() => deckWindow.reveal(row.key, reverse ? 'last' : true))
            }}
          />
        </>
      )}
    </div>
  )
})
