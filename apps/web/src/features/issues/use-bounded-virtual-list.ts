import type { RefCallback, RefObject } from 'react'
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'

/**
 * Hard retention limits for issue indexes [spec:SP-d562]. A viewport mounts no
 * more than 36 ordinary rows, plus a focused row and an active drag source
 * while either is outside the window. Measurements are LRU-bounded separately:
 * dynamic heights do not turn a trip through a 674-task list into 674 retained
 * element records.
 */
export const ISSUE_VIRTUAL_MAX_ITEMS = 36
export const ISSUE_VIRTUAL_SIZE_CACHE = 128
const DEFAULT_OVERSCAN = 4
const DEFAULT_INITIAL_ITEMS = 16

export interface VirtualIssueItem {
  key: string
  index: number
  start: number
  size: number
}

interface Layout {
  keys: readonly string[]
  offsets: number[]
  sizes: number[]
  totalSize: number
}

interface BoundedVirtualListOptions {
  keys: readonly string[]
  scrollRef: RefObject<HTMLElement | null>
  /** Optional spacer inside a larger scroll surface (the grouped list). */
  containerRef?: RefObject<HTMLElement | null>
  estimateSize: number
  gap?: number
  overscan?: number
  maxItems?: number
  initialItems?: number
  /** Kept mounted across the one render needed to scroll keyboard focus/drag. */
  pinnedKeys?: readonly (string | null | undefined)[]
}

interface BoundedVirtualList {
  items: VirtualIssueItem[]
  totalSize: number
  measureRef: (key: string) => RefCallback<HTMLElement>
  offsetForIndex: (index: number) => number
}

function itemAt(layout: Layout, offset: number): number {
  if (layout.keys.length === 0) return 0
  let low = 0
  let high = layout.keys.length - 1
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    const end = (layout.offsets[mid] ?? 0) + (layout.sizes[mid] ?? 0)
    if (end < offset) low = mid + 1
    else high = mid
  }
  return low
}

function localScrollTop(
  scroll: HTMLElement | null,
  container: HTMLElement | null | undefined,
): number {
  if (!scroll) return 0
  if (!container || container === scroll) return scroll.scrollTop
  const scrollRect = scroll.getBoundingClientRect()
  const containerRect = container.getBoundingClientRect()
  return scrollRect.top - containerRect.top
}

/**
 * A small variable-height virtualizer specialised for Podium's issue surfaces.
 * It deliberately owns only mounting and geometry: full issue order, selection,
 * keyboard navigation, menus and drag state remain in their existing owners.
 */
export function useBoundedVirtualList({
  keys,
  scrollRef,
  containerRef,
  estimateSize,
  gap = 0,
  overscan = DEFAULT_OVERSCAN,
  maxItems = ISSUE_VIRTUAL_MAX_ITEMS,
  initialItems = DEFAULT_INITIAL_ITEMS,
  pinnedKeys = [],
}: BoundedVirtualListOptions): BoundedVirtualList {
  const sizesRef = useRef(new Map<string, number>())
  const nodesRef = useRef(new Map<string, HTMLElement>())
  const callbacksRef = useRef(new Map<string, RefCallback<HTMLElement>>())
  const observerRef = useRef<ResizeObserver | null>(null)
  const layoutRef = useRef<Layout>({ keys: [], offsets: [], sizes: [], totalSize: 0 })
  const priorLayoutRef = useRef<Layout>({ keys: [], offsets: [], sizes: [], totalSize: 0 })
  const signatureRef = useRef('')
  const [revision, setRevision] = useState(0)
  const [viewport, setViewport] = useState({ top: 0, height: 0 })
  const viewportFrameRef = useRef<number | null>(null)

  const layout = useMemo<Layout>(() => {
    void revision
    const offsets: number[] = []
    const itemSizes: number[] = []
    let cursor = 0
    for (const key of keys) {
      offsets.push(cursor)
      const size = sizesRef.current.get(key) ?? estimateSize
      itemSizes.push(size)
      cursor += size + gap
    }
    return {
      keys,
      offsets,
      sizes: itemSizes,
      totalSize: Math.max(0, cursor - (keys.length > 0 ? gap : 0)),
    }
  }, [keys, estimateSize, gap, revision])
  layoutRef.current = layout

  const publishViewport = useCallback(() => {
    if (viewportFrameRef.current !== null) return
    viewportFrameRef.current = window.requestAnimationFrame(() => {
      viewportFrameRef.current = null
      const scroll = scrollRef.current
      const top = localScrollTop(scroll, containerRef?.current)
      const height = scroll?.clientHeight ?? 0
      setViewport((current) =>
        current.top === top && current.height === height ? current : { top, height },
      )
    })
  }, [scrollRef, containerRef])

  useLayoutEffect(() => {
    if (viewportFrameRef.current !== null) {
      window.cancelAnimationFrame(viewportFrameRef.current)
      viewportFrameRef.current = null
    }
    const scroll = scrollRef.current
    if (!scroll) return
    publishViewport()
    scroll.addEventListener('scroll', publishViewport, { passive: true })
    const resize =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(publishViewport)
    resize?.observe(scroll)
    if (containerRef?.current) resize?.observe(containerRef.current)
    return () => {
      scroll.removeEventListener('scroll', publishViewport)
      resize?.disconnect()
      if (viewportFrameRef.current !== null) {
        window.cancelAnimationFrame(viewportFrameRef.current)
        viewportFrameRef.current = null
      }
    }
  }, [scrollRef, containerRef, publishViewport])

  const recordSize = useCallback(
    (key: string, node: HTMLElement): void => {
      const measured = node.getBoundingClientRect().height
      if (!Number.isFinite(measured) || measured <= 0) return
      const oldSize = sizesRef.current.get(key) ?? estimateSize
      if (Math.abs(oldSize - measured) < 0.5) return

      const currentLayout = layoutRef.current
      const index = currentLayout.keys.indexOf(key)
      const itemStart = index < 0 ? 0 : (currentLayout.offsets[index] ?? 0)
      const scroll = scrollRef.current
      const beforeTop = localScrollTop(scroll, containerRef?.current)

      sizesRef.current.delete(key)
      sizesRef.current.set(key, measured)
      let anchorDelta = itemStart < beforeTop ? measured - oldSize : 0

      while (sizesRef.current.size > ISSUE_VIRTUAL_SIZE_CACHE) {
        const evicted = sizesRef.current.keys().next().value as string | undefined
        if (!evicted) break
        // Mounted entries are the useful edge of the LRU. Rotate them until an
        // off-window measurement can be released.
        if (nodesRef.current.has(evicted)) {
          const value = sizesRef.current.get(evicted) as number
          sizesRef.current.delete(evicted)
          sizesRef.current.set(evicted, value)
          if ([...sizesRef.current.keys()].every((candidate) => nodesRef.current.has(candidate))) {
            break
          }
          continue
        }
        const evictedSize = sizesRef.current.get(evicted) as number
        const evictedIndex = currentLayout.keys.indexOf(evicted)
        const evictedStart =
          evictedIndex < 0 ? Number.POSITIVE_INFINITY : (currentLayout.offsets[evictedIndex] ?? 0)
        if (evictedStart < beforeTop) anchorDelta += estimateSize - evictedSize
        sizesRef.current.delete(evicted)
      }

      if (scroll && anchorDelta !== 0) scroll.scrollTop += anchorDelta
      setRevision((value) => value + 1)
    },
    [containerRef, estimateSize, scrollRef],
  )

  useLayoutEffect(() => {
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const node = entry.target as HTMLElement
        const key = node.dataset.virtualIssueKey
        if (key) recordSize(key, node)
      }
    })
    observerRef.current = observer
    for (const [key, node] of nodesRef.current) {
      observer.observe(node)
      recordSize(key, node)
    }
    return () => {
      observer.disconnect()
      observerRef.current = null
    }
  }, [recordSize])

  const measureRef = useCallback(
    (key: string): RefCallback<HTMLElement> => {
      const saved = callbacksRef.current.get(key)
      if (saved) return saved
      const callback: RefCallback<HTMLElement> = (node) => {
        const previous = nodesRef.current.get(key)
        if (previous && previous !== node) observerRef.current?.unobserve(previous)
        if (!node) {
          nodesRef.current.delete(key)
          callbacksRef.current.delete(key)
          return
        }
        node.dataset.virtualIssueKey = key
        nodesRef.current.set(key, node)
        observerRef.current?.observe(node)
        recordSize(key, node)
      }
      callbacksRef.current.set(key, callback)
      return callback
    },
    [recordSize],
  )

  // Keep the same visible row at the same pixel when expansion, filtering or a
  // replica update inserts/removes rows above it.
  const signature = keys.join('\0')
  useLayoutEffect(() => {
    const previous = layout
    // layoutRef already points at the current render, so retain the prior
    // render's geometry separately.
    const prior = priorLayoutRef.current
    if (signatureRef.current && signatureRef.current !== signature && prior.keys.length > 0) {
      const scroll = scrollRef.current
      const top = localScrollTop(scroll, containerRef?.current)
      // Only the section intersecting a shared grouped-list viewport may move
      // that viewport. Offscreen sections update their geometry silently.
      if (scroll && top < prior.totalSize && top + scroll.clientHeight > 0) {
        const anchorIndex = itemAt(prior, Math.max(0, top))
        const anchorKey = prior.keys[anchorIndex]
        const currentIndex = anchorKey ? previous.keys.indexOf(anchorKey) : -1
        if (currentIndex >= 0) {
          const delta = (previous.offsets[currentIndex] ?? 0) - (prior.offsets[anchorIndex] ?? 0)
          if (delta !== 0) scroll.scrollTop += delta
        }
      }
    }
    signatureRef.current = signature
    priorLayoutRef.current = previous
    publishViewport()
  }, [signature, layout, scrollRef, containerRef, publishViewport])

  const focusKey = pinnedKeys.find((candidate): candidate is string =>
    Boolean(candidate && keys.includes(candidate)),
  )
  useLayoutEffect(() => {
    if (!focusKey) return
    const index = layout.keys.indexOf(focusKey)
    const scroll = scrollRef.current
    if (index < 0 || !scroll) return
    const container = containerRef?.current
    const containerStart =
      !container || container === scroll
        ? 0
        : container.getBoundingClientRect().top -
          scroll.getBoundingClientRect().top +
          scroll.scrollTop
    const start = containerStart + (layout.offsets[index] ?? 0)
    const end = start + (layout.sizes[index] ?? estimateSize)
    const viewStart = scroll.scrollTop
    const viewEnd = viewStart + scroll.clientHeight
    if (start < viewStart) scroll.scrollTop = start
    else if (end > viewEnd) scroll.scrollTop = Math.max(0, end - scroll.clientHeight)
    publishViewport()
  }, [focusKey, layout, scrollRef, containerRef, estimateSize, publishViewport])

  let start = 0
  let end = 0
  if (keys.length > 0) {
    if (viewport.height <= 0) {
      start = Math.max(0, itemAt(layout, Math.max(0, viewport.top)) - overscan)
      end = Math.min(keys.length, start + Math.min(initialItems, maxItems))
    } else if (viewport.top < layout.totalSize && viewport.top + viewport.height > 0) {
      const first = itemAt(layout, Math.max(0, viewport.top))
      const last = itemAt(layout, Math.max(0, viewport.top + viewport.height))
      start = Math.max(0, first - overscan)
      end = Math.min(keys.length, last + overscan + 1)
      if (end - start > maxItems) end = start + maxItems
    }
  }

  const indexes = new Set<number>()
  for (let index = start; index < end; index++) indexes.add(index)
  for (const key of pinnedKeys) {
    if (!key) continue
    const index = keys.indexOf(key)
    if (index >= 0) indexes.add(index)
  }
  const items = [...indexes]
    .sort((a, b) => a - b)
    .map((index) => ({
      key: keys[index] as string,
      index,
      start: layout.offsets[index] ?? 0,
      size: layout.sizes[index] ?? estimateSize,
    }))

  return {
    items,
    totalSize: layout.totalSize,
    measureRef,
    offsetForIndex: (index) =>
      layout.offsets[Math.max(0, Math.min(index, keys.length))] ?? layout.totalSize,
  }
}
