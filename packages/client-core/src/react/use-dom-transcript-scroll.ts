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
  element: HTMLElement
  key: string | undefined
  offset: number
  scrollTop: number
}

const BOTTOM_EPSILON = 2
const POSITION_EPSILON = 0.01
const HISTORY_EDGE = 120

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
    onFollowChange,
    onPositionChange,
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
  const readingAnchor = useRef<ReadingAnchor | null>(null)
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
      readingAnchor.current = {
        element: row,
        key: row.dataset.rowKey,
        offset: rect.top - viewport.top,
        scrollTop: scroller.scrollTop,
      }
      return
    }
  }, [scrollerRef])

  const releaseFollow = useCallback(() => {
    userScrolling.current = true
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

  const reconcileLayout = useCallback(() => {
    const scroller = scrollerRef.current
    if (!active || !scroller || scroller.clientHeight === 0) return
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
        element = [...scroller.querySelectorAll<HTMLElement>('[data-row-key]')].find(
          (row) =>
            row.dataset.rowKey === anchor.key ||
            (row.dataset.rowAliases !== undefined &&
              (JSON.parse(row.dataset.rowAliases) as string[]).includes(anchor.key!)),
        )
      }
      if (anchor && element?.isConnected) {
        // Include movement since capture: a compositor scroll can precede its
        // scroll event. Compensate layout without undoing that newer movement.
        const delta =
          element.getBoundingClientRect().top -
          scroller.getBoundingClientRect().top -
          anchor.offset +
          (scroller.scrollTop - anchor.scrollTop)
        if (Math.abs(delta) > POSITION_EPSILON) writeOffset(scroller.scrollTop + delta)
      }
      captureReadingAnchor()
    }
    geometry.current = { height: scroller.scrollHeight, viewport: scroller.clientHeight }
    onPositionChange?.()
  }, [active, captureReadingAnchor, scrollerRef, onPositionChange, writeOffset])

  const loadOlderAnchored = useCallback(() => {
    if (!moreAbove || loadingOlder) return
    releaseFollow()
    loadOlder()
  }, [loadOlder, loadingOlder, moreAbove, releaseFollow])

  // A different conversation starts at its own tail. Hiding/showing a retained
  // panel leaves the reader's intent and anchor intact.
  useLayoutEffect(() => {
    readingAnchor.current = null
    selectionPaused.current = false
    userScrolling.current = false
    writtenTop.current = null
    setFollowing(true)
  }, [sessionId, setFollowing])

  useLayoutEffect(() => {
    if (!active || !scroller || !content) return
    // ResizeObserver's initial delivery also opens a conversation at its tail.
    // Read geometry after the browser's natural layout, before paint, rather
    // than forcing the whole page to lay out during React's commit. Reobserve
    // on row changes to reconcile replacement/prepend and net-zero reflows.
    const observer = new ResizeObserver(reconcileLayout)
    observer.observe(content)
    observer.observe(scroller)
    // Two rows can resize in opposite directions without changing the content
    // box. Observe row sizes too, so that net-zero reflow still conserves place.
    for (const row of content.querySelectorAll<HTMLElement>('[data-block]')) observer.observe(row)
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
    if (layoutChanged) reconcileLayout()
    if (!ownWrite && !layoutChanged && userScrolling.current) {
      if (top < previous) setFollowing(false)
      else if (
        top > previous &&
        !selectionPaused.current &&
        element.scrollHeight - element.clientHeight - top <= BOTTOM_EPSILON
      ) {
        setFollowing(true)
      }
    }
    lastTop.current = element.scrollTop
    if (!following.current) captureReadingAnchor()
    onPositionChange?.()
    if (
      !ownWrite &&
      !layoutChanged &&
      userScrolling.current &&
      top < previous &&
      top < HISTORY_EDGE
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
      if (event.deltaY < 0) onUpwardInput()
    }
    const onTouchStart = (event: TouchEvent): void => {
      touchY = event.touches[0]?.clientY
    }
    const onTouchMove = (event: TouchEvent): void => {
      if (!scrollsFeed(event)) return
      const y = event.touches[0]?.clientY
      userScrolling.current = true
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
    return () => {
      scroller.removeEventListener('wheel', onWheel)
      scroller.removeEventListener('touchstart', onTouchStart)
      scroller.removeEventListener('touchmove', onTouchMove)
      scroller.removeEventListener('keydown', onKeyDown)
      scroller.removeEventListener('pointerdown', onPointerDown)
    }
  }, [active, scroller, releaseFollow, loadOlderAnchored])

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
      setFollowing(offset >= scroller.scrollHeight - scroller.clientHeight - BOTTOM_EPSILON)
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
    (index: number, opts?: { instant?: boolean }) => {
      const scroller = scrollerRef.current
      const target = scroller?.querySelector<HTMLElement>(`[data-block="${index}"]`)
      if (!scroller || !target) return
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
