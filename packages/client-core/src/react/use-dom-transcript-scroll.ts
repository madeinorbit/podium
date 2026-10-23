import type { RefCallback, RefObject } from 'react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

export interface UseDomTranscriptScrollOptions {
  sessionId: string
  scrollerRef: RefObject<HTMLDivElement | null>
  active: boolean
  blockCount: number
  renderStart: number
  moreAbove: boolean
  loadingOlder: boolean
  loadOlder: () => void
  rowsToRender: unknown
  onFollowChange?: (following: boolean) => void
  onPositionChange?: () => void
  /** A retained row model resolves an old row key after a tool-run merge. */
  lookupAnchorRow?: (key: string) => number | undefined
}

export interface UseDomTranscriptScrollResult {
  atBottom: boolean
  setScrollerRef: RefCallback<HTMLDivElement>
  setContentRef: RefCallback<HTMLDivElement>
  onScroll: () => void
  onPointerUp: () => void
  jumpToBottom: () => void
  pinToBottom: () => void
  loadOlder: () => void
  scrollToBlock: (index: number, opts?: { instant?: boolean }) => void
  scrollToOffset: (offset: number) => void
  scrollBy: (delta: number) => void
}

interface ReadingAnchor {
  /** Absent for a position remembered across a remount until its row mounts. */
  element: HTMLElement | undefined
  shell: boolean
  key: string | undefined
  offset: number
  scrollTop: number
}

// Close enough to count as the tail: subpixel layout and Safari's elastic
// bounce-back leave a reader at the end a few pixels short of the maximum.
const BOTTOM_EPSILON = 10
const POSITION_EPSILON = 0.01
const HISTORY_EDGE = 120

/** A reading position outlives its panel: an evicted tab remounts where it was left. */
const savedPositions = new Map<string, Pick<ReadingAnchor, 'shell' | 'key' | 'offset'>>()
export function forgetTranscriptPositions(): void {
  savedPositions.clear()
}

/**
 * The transcript has one scroll authority.
 *
 * Follow is reader intent, never a conclusion drawn from a content resize.
 * While following, layout changes keep the tail at the bottom. While reading,
 * they keep a retained row at its viewport offset. User movement updates that
 * anchor; a page request does not own it or consume it on an intermediate commit.
 * Browser anchoring is disabled so it cannot compete with these corrections.
 */
export function useDomTranscriptScroll(
  opts: UseDomTranscriptScrollOptions,
): UseDomTranscriptScrollResult {
  const {
    sessionId,
    scrollerRef,
    active,
    moreAbove,
    loadingOlder,
    loadOlder,
    rowsToRender,
    renderStart,
    onFollowChange,
    onPositionChange,
    lookupAnchorRow,
  } = opts

  const [scroller, setScroller] = useState<HTMLDivElement | null>(null)
  const [content, setContent] = useState<HTMLDivElement | null>(null)
  const [atBottom, setAtBottom] = useState(true)
  const followChangeRef = useRef(onFollowChange)
  useLayoutEffect(() => {
    followChangeRef.current = onFollowChange
  }, [onFollowChange])
  const following = useRef(true)
  const userScrolling = useRef(false)
  const writtenTop = useRef<number | null>(null)
  const lastTop = useRef(0)
  const geometry = useRef({ height: 0, viewport: 0 })
  const rowHeights = useRef(new WeakMap<Element, number>())
  const readingAnchor = useRef<ReadingAnchor | null>(null)
  // For the first frames after a reveal, a change of scrollTop is the browser's
  // (WebKit restores a display:none scroller to a stale offset), not reading.
  const restoring = useRef(false)
  const hidden = useRef(false)
  const selectionPaused = useRef(false)

  const setScrollerRef = useCallback<RefCallback<HTMLDivElement>>(
    (element) => {
      scrollerRef.current = element
      if (element) {
        element.style.overflowAnchor = 'none'
        element.style.scrollBehavior = 'auto'
      }
      setScroller(element)
    },
    [scrollerRef],
  )

  const setContentRef = useCallback<RefCallback<HTMLDivElement>>(
    (element) => setContent(element),
    [],
  )

  const setFollowing = useCallback((next: boolean) => {
    if (following.current === next) return
    following.current = next
    setAtBottom(next)
    followChangeRef.current?.(next)
  }, [])

  const captureReadingAnchor = useCallback(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    const viewport = scroller.getBoundingClientRect()
    readingAnchor.current = null
    for (const row of scroller.querySelectorAll<HTMLElement>('[data-block]')) {
      const rect = row.getBoundingClientRect()
      if (rect.bottom <= viewport.top || rect.top >= viewport.bottom) continue
      // The rich row can leave the window during a prepend. Its measured shell
      // stays connected and includes the same margins/day mark before and after.
      const retained = row.closest<HTMLElement>('[data-transcript-row]') ?? row
      readingAnchor.current = {
        element: retained,
        shell: retained.hasAttribute('data-transcript-row'),
        key: row.dataset.rowKey ?? retained.dataset.transcriptRow,
        offset: retained.getBoundingClientRect().top - viewport.top,
        scrollTop: scroller.scrollTop,
      }
      return
    }
  }, [scrollerRef])

  const releaseFollow = useCallback(() => {
    userScrolling.current = true
    restoring.current = false
    setFollowing(false)
    captureReadingAnchor()
  }, [captureReadingAnchor, setFollowing])

  const writeOffset = useCallback(
    (offset: number) => {
      const scroller = scrollerRef.current
      if (!scroller) return
      const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
      const target = Math.max(0, Math.min(max, offset))
      if (Math.abs(scroller.scrollTop - target) > POSITION_EPSILON) {
        scroller.scrollTop = target
        writtenTop.current = scroller.scrollTop
        lastTop.current = scroller.scrollTop
      }
    },
    [scrollerRef],
  )

  const reconcileLayout = useCallback((rowsResized = false) => {
    const scroller = scrollerRef.current
    if (!active || !scroller || scroller.clientHeight === 0) return
    const height = scroller.scrollHeight
    const viewport = scroller.clientHeight
    const focused = scroller.ownerDocument.activeElement
    const editing =
      focused?.matches('textarea, input') ||
      (focused as HTMLElement | null)?.isContentEditable
    // Safari pans/resizes the viewport as its keyboard opens. Writing a new
    // tail offset during that transition can cancel focus and close it again.
    // Keep geometry current, but wait for an observed row change before moving
    // the offset. Keyboard chrome can change content padding as well as the
    // viewport; neither is new transcript content. This also covers duplicate
    // deliveries and a scroll event arriving before the row observation.
    if (editing && !rowsResized && !restoring.current) {
      geometry.current = { height, viewport }
      lastTop.current = scroller.scrollTop
      writtenTop.current = null
      return
    }
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
    // A browser clamp can happen before its scroll event. If the previously
    // observed offset is now outside the legal range, reaching the new maximum
    // is a layout adjustment, not reader input that should request history.
    if (lastTop.current > max && Math.abs(scroller.scrollTop - max) <= BOTTOM_EPSILON)
      lastTop.current = scroller.scrollTop
    if (following.current) {
      writeOffset(scroller.scrollHeight)
      readingAnchor.current = null
    } else {
      const anchor = readingAnchor.current
      let element = anchor?.element
      if (anchor && !element?.isConnected && anchor.key !== undefined) {
        const index = lookupAnchorRow?.(anchor.key)
        element = index === undefined ? undefined : scroller.querySelector<HTMLElement>(`[data-block="${index}"]`) ?? undefined
        element ??= [...scroller.querySelectorAll<HTMLElement>('[data-row-key]')].find(
          (row) =>
            row.dataset.rowKey === anchor.key ||
            (row.dataset.rowAliases !== undefined &&
              (JSON.parse(row.dataset.rowAliases) as string[]).includes(anchor.key!)),
        )
        element ??= [...scroller.querySelectorAll<HTMLElement>('[data-transcript-row]')].find(
          (row) => row.dataset.transcriptRow === anchor.key,
        )
      }
      if (anchor?.shell)
        element = element?.closest<HTMLElement>('[data-transcript-row]') ?? element
      if (anchor && !anchor.element && !element?.isConnected) {
        // A remembered position waits for the first rows; if they arrive
        // without its row, open at the tail as an unremembered tab does.
        if (scroller.querySelector('[data-block]')) {
          readingAnchor.current = null
          setFollowing(true)
          writeOffset(scroller.scrollHeight)
        }
      } else {
        if (anchor && element?.isConnected) {
          // Include movement since capture: a compositor scroll can precede its
          // scroll event. Compensate layout without undoing that newer movement.
          // A reveal or a remembered position has no reader movement to keep.
          const moved =
            restoring.current || !anchor.element ? 0 : scroller.scrollTop - anchor.scrollTop
          const delta =
            element.getBoundingClientRect().top -
            scroller.getBoundingClientRect().top -
            anchor.offset +
            moved
          if (Math.abs(delta) > POSITION_EPSILON) writeOffset(scroller.scrollTop + delta)
        }
        captureReadingAnchor()
      }
    }
    geometry.current = { height: scroller.scrollHeight, viewport: scroller.clientHeight }
    onPositionChange?.()
  }, [
    active,
    captureReadingAnchor,
    scrollerRef,
    onPositionChange,
    lookupAnchorRow,
    setFollowing,
    writeOffset,
  ])

  const loadOlderAnchored = useCallback(() => {
    if (!moreAbove || loadingOlder) return
    releaseFollow()
    loadOlder()
  }, [loadOlder, loadingOlder, moreAbove, releaseFollow])

  const previousRenderStart = useRef(renderStart)
  useLayoutEffect(() => {
    if (previousRenderStart.current === renderStart) return
    previousRenderStart.current = renderStart
    if (following.current) return
    // Revealing a history window moves the mounted head. Conserve the anchor
    // in that commit; waiting for the next resize can paint the empty old tile.
    // Ordinary streaming reflows still use the shared ResizeObserver below.
    reconcileLayout()
  }, [renderStart, reconcileLayout])

  // A different conversation starts at its own tail, or where it was left if
  // its panel was evicted. Hiding/showing a retained panel leaves the reader's
  // intent and anchor intact.
  useLayoutEffect(() => {
    const saved = savedPositions.get(sessionId)
    readingAnchor.current = saved ? { ...saved, element: undefined, scrollTop: 0 } : null
    selectionPaused.current = false
    userScrolling.current = false
    writtenTop.current = null
    rowHeights.current = new WeakMap()
    setFollowing(!saved)
  }, [sessionId, setFollowing])

  // Remember where a hidden or unmounted reader left off. The anchor is current
  // from its last scroll or reconcile; geometry is unreadable once hidden.
  useLayoutEffect(() => {
    if (!active) return
    // The browser's reveal offset lands with the first layout. After that, a
    // scroll is the reader's again (native Find, focus moves, autoscroll).
    let frame = 0
    if (hidden.current) {
      restoring.current = true
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          restoring.current = false
        })
      })
    }
    return () => {
      hidden.current = true
      cancelAnimationFrame(frame)
      const anchor = readingAnchor.current
      if (following.current || !anchor) savedPositions.delete(sessionId)
      else
        savedPositions.set(sessionId, { shell: anchor.shell, key: anchor.key, offset: anchor.offset })
    }
  }, [active, sessionId])

  useLayoutEffect(() => {
    if (!active || !scroller || !content) return
    // ResizeObserver's initial delivery also opens a conversation at its tail.
    // Read geometry after the browser's natural layout, before paint, rather
    // than forcing the whole page to lay out during React's commit. Reobserve
    // on row changes to reconcile replacement/prepend and net-zero reflows.
    const observer = new ResizeObserver((entries) => {
      let rowsResized = false
      for (const entry of entries) {
        if (!entry.target.hasAttribute('data-block') && !entry.target.hasAttribute('data-transcript-row')) continue
        const previous = rowHeights.current.get(entry.target)
        if (previous !== entry.contentRect.height) rowsResized = true
        rowHeights.current.set(entry.target, entry.contentRect.height)
      }
      reconcileLayout(rowsResized)
    })
    observer.observe(content)
    observer.observe(scroller)
    // Two rows can resize in opposite directions without changing the content
    // box. Observe row sizes too, so that net-zero reflow still conserves place.
    for (const row of content.querySelectorAll<HTMLElement>('[data-block], [data-transcript-row]')) observer.observe(row)
    return () => observer.disconnect()
  }, [sessionId, active, scroller, content, rowsToRender, reconcileLayout])

  const onScroll = useCallback(() => {
    const element = scrollerRef.current
    if (!element) return
    const top = element.scrollTop
    const previous = lastTop.current
    const ownWrite = writtenTop.current !== null && Math.abs(top - writtenTop.current) <= 0.5
    const layoutChanged =
      geometry.current.height !== element.scrollHeight ||
      geometry.current.viewport !== element.clientHeight
    writtenTop.current = null
    // A revealed panel's scroll comes from the browser, not the reader: put the
    // anchor back rather than adopting the restored offset as a new position.
    if (layoutChanged || restoring.current) reconcileLayout()
    const readerMoved = !ownWrite && !layoutChanged && !restoring.current && userScrolling.current
    if (readerMoved) {
      const gap = element.scrollHeight - element.clientHeight - top
      // Upward input already released follow before scrolling. Settling back
      // within the tail (an elastic bounce, subpixel rounding) is not leaving it.
      if (top < previous && gap > BOTTOM_EPSILON) setFollowing(false)
      else if (top > previous && !selectionPaused.current && gap <= BOTTOM_EPSILON) {
        setFollowing(true)
      }
    }
    lastTop.current = element.scrollTop
    // A remembered position stays pending until its row mounts.
    const pending = readingAnchor.current !== null && !readingAnchor.current.element
    if (!following.current && !pending) captureReadingAnchor()
    onPositionChange?.()
    if (
      readerMoved &&
      top < previous &&
      // Start revealing history two viewports before its mounted edge. A fast
      // wheel/touch burst can cross the old 120px threshold in one frame.
      top < Math.max(HISTORY_EDGE, element.clientHeight * 2)
    )
      loadOlderAnchored()
  }, [
    captureReadingAnchor,
    loadOlderAnchored,
    reconcileLayout,
    scrollerRef,
    setFollowing,
    onPositionChange,
  ])

  // Release before the browser scrolls, so streaming cannot swallow the first
  // wheel notch or touch move. Nested code/table scrollers keep their own input.
  useEffect(() => {
    if (!active || !scroller) return
    const onNativeFind = () => {
      userScrolling.current = false
      setFollowing(false)
      readingAnchor.current = null
      writtenTop.current = null
    }
    const onWindowLayout = () => reconcileLayout(true)
    let touchY: number | undefined
    const onUpwardInput = (): void => {
      releaseFollow()
      // A short/collapsed page has no scroll range, and input at the top
      // produces no scroll event. The reader can still request older history.
      if (scroller.scrollTop <= 0) loadOlderAnchored()
    }
    const scrollsFeed = (event: Event): boolean => {
      let target = event.target instanceof Element ? event.target : null
      while (target && target !== scroller) {
        if (
          ['auto', 'scroll'].includes(getComputedStyle(target).overflowY) &&
          target.scrollHeight > target.clientHeight
        )
          return false
        target = target.parentElement
      }
      return target === scroller
    }
    const onWheel = (event: WheelEvent): void => {
      if (!scrollsFeed(event)) return
      userScrolling.current = true
      restoring.current = false
      if (event.deltaY < 0) onUpwardInput()
    }
    const onTouchStart = (event: TouchEvent): void => {
      touchY = event.touches[0]?.clientY
    }
    const onTouchMove = (event: TouchEvent): void => {
      if (!scrollsFeed(event)) return
      const y = event.touches[0]?.clientY
      userScrolling.current = true
      restoring.current = false
      if (y !== undefined && touchY !== undefined && y > touchY) onUpwardInput()
      touchY = y
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (
        event.target instanceof Element &&
        event.target.closest('input, textarea, [contenteditable="true"]')
      )
        return
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
        userScrolling.current = true
        restoring.current = false
        if (
          ['ArrowUp', 'PageUp', 'Home'].includes(event.key) ||
          (event.key === ' ' && event.shiftKey)
        )
          onUpwardInput()
      }
    }
    const onPointerDown = (event: PointerEvent): void => {
      const rect = scroller.getBoundingClientRect()
      if (
        event.pointerType !== 'touch' &&
        event.target === scroller &&
        (event.clientX >= rect.right - 18 || event.clientX <= rect.left + 18)
      )
        releaseFollow()
    }
    scroller.addEventListener('wheel', onWheel, { passive: true })
    scroller.addEventListener('touchstart', onTouchStart, { passive: true })
    scroller.addEventListener('touchmove', onTouchMove, { passive: true })
    scroller.addEventListener('keydown', onKeyDown)
    scroller.addEventListener('pointerdown', onPointerDown)
    scroller.addEventListener('podium-transcript-find-start', onNativeFind)
    scroller.addEventListener('podium-transcript-layout', onWindowLayout)
    scroller.addEventListener('beforematch', onNativeFind, true)
    return () => {
      scroller.removeEventListener('wheel', onWheel)
      scroller.removeEventListener('touchstart', onTouchStart)
      scroller.removeEventListener('touchmove', onTouchMove)
      scroller.removeEventListener('keydown', onKeyDown)
      scroller.removeEventListener('pointerdown', onPointerDown)
      scroller.removeEventListener('podium-transcript-find-start', onNativeFind)
      scroller.removeEventListener('podium-transcript-layout', onWindowLayout)
      scroller.removeEventListener('beforematch', onNativeFind, true)
    }
  }, [active, scroller, releaseFollow, loadOlderAnchored, setFollowing, reconcileLayout])

  const onPointerUp = useCallback(() => {
    const selection = window.getSelection()
    if (
      selection &&
      !selection.isCollapsed &&
      selection.rangeCount > 0 &&
      scrollerRef.current?.contains(selection.getRangeAt(0).commonAncestorContainer) &&
      !selectionPaused.current
    ) {
      selectionPaused.current = true
      releaseFollow()
    }
  }, [releaseFollow, scrollerRef])

  useEffect(() => {
    if (!active) return
    const onSelectionChange = (): void => {
      const scroller = scrollerRef.current
      const selection = window.getSelection()
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        selectionPaused.current = false
        return
      }
      if (!scroller) return
      const range = selection.getRangeAt(0)
      if (scroller.contains(range.commonAncestorContainer) && !selectionPaused.current) {
        selectionPaused.current = true
        releaseFollow()
      }
    }
    document.addEventListener('selectionchange', onSelectionChange)
    return () => {
      selectionPaused.current = false
      document.removeEventListener('selectionchange', onSelectionChange)
    }
  }, [active, scrollerRef, releaseFollow])

  const jumpToBottom = useCallback(() => {
    userScrolling.current = false
    readingAnchor.current = null
    setFollowing(true)
    reconcileLayout()
  }, [reconcileLayout, setFollowing])

  const scrollToOffset = useCallback(
    (offset: number) => {
      const scroller = scrollerRef.current
      if (!scroller) return
      userScrolling.current = true
      restoring.current = false
      // Only a move toward the tail can resume following; a small step up from
      // it (the shelf forwards raw wheel deltas) must release.
      setFollowing(
        offset >= scroller.scrollTop &&
          offset >= scroller.scrollHeight - scroller.clientHeight - BOTTOM_EPSILON,
      )
      writeOffset(offset)
      captureReadingAnchor()
      onPositionChange?.()
    },
    [captureReadingAnchor, scrollerRef, setFollowing, onPositionChange, writeOffset],
  )

  const scrollBy = useCallback(
    (delta: number) => {
      const scroller = scrollerRef.current
      if (scroller) scrollToOffset(scroller.scrollTop + delta)
    },
    [scrollerRef, scrollToOffset],
  )

  const scrollToBlock = useCallback(
    (index: number, opts?: { instant?: boolean }): void => {
      const scroller = scrollerRef.current
      const target = scroller?.querySelector<HTMLElement>(`[data-block="${index}"]`)
      if (!scroller || !target) return
      if (target.hasAttribute('data-transcript-placeholder')) {
        // Called by effects as well as input handlers. Expand outside React's
        // commit, then let this same controller align the real row's geometry.
        requestAnimationFrame(() => {
          if (scrollerRef.current !== scroller || !target.isConnected) return
          target.dispatchEvent(new Event('podium-transcript-reveal', { bubbles: true }))
          scrollToBlock(index, opts)
        })
        return
      }
      releaseFollow()
      userScrolling.current = false
      const viewport = scroller.getBoundingClientRect()
      const rect = target.getBoundingClientRect()
      scroller.scrollTo({
        top:
          scroller.scrollTop + rect.top - viewport.top - (scroller.clientHeight - rect.height) / 2,
        behavior: opts?.instant ? 'instant' : 'smooth',
      })
      captureReadingAnchor()
    },
    [captureReadingAnchor, releaseFollow, scrollerRef],
  )

  return {
    atBottom,
    setScrollerRef,
    setContentRef,
    onScroll,
    onPointerUp,
    jumpToBottom,
    pinToBottom: jumpToBottom,
    loadOlder: loadOlderAnchored,
    scrollToBlock,
    scrollToOffset,
    scrollBy,
  }
}
