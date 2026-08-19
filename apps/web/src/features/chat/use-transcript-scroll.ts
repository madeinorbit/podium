import type { SessionId } from '@podium/model/browser'
import type { RefCallback, RefObject, UIEventHandler } from 'react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useStickToBottom } from 'use-stick-to-bottom'

export interface UseTranscriptScrollOptions {
  sessionId: SessionId
  scrollerRef: RefObject<HTMLDivElement | null>
  active: boolean
  blockCount: number
  renderStart: number
  stickyEnabled: boolean
  moreAbove: boolean
  loadOlder: () => void
  rowsToRender: unknown
}

export interface PinnedBrief {
  key: string
  html: string
  time: string
}

export interface UseTranscriptScrollResult {
  atBottom: boolean
  setScrollerRef: RefCallback<HTMLDivElement>
  setContentRef: RefCallback<HTMLDivElement>
  onScroll: UIEventHandler<HTMLDivElement>
  onPointerUp: () => void
  jumpToBottom: () => void
  pinToBottom: () => void
  loadOlder: () => void
  scrollToBlock: (index: number) => void
  syncStickyPromptPositions: () => void
  pinnedBrief: PinnedBrief | null
}

interface PrependAnchor {
  element: HTMLElement
  offset: number
}

// WebKit can deliver the final upward-scroll event after the Jump click. Keep
// the maintained primitive's own ignore-escape window alive long enough to
// absorb that stale event and the first resize it would otherwise unpin.
const JUMP_SETTLE_MS = 350

/**
 * The transcript has one scroll authority.
 *
 * `use-stick-to-bottom` owns follow/escape semantics and observes the single
 * content column. Podium owns only its product-specific extensions: restoring a
 * retained row after older history is mounted, loading that history near the
 * top, jumping to search hits, and selecting the brief shown on the shelf.
 *
 * Normal top-to-bottom DOM and normal scroll coordinates are deliberate. A
 * reversed flex scroller made `scrollTop` engine-dependent and broke Chrome;
 * scroll writers, stale-maximum healing, element rebirth, and engine sniffing
 * then accumulated around that unstable premise. None of them belongs here.
 */
export function useTranscriptScroll(opts: UseTranscriptScrollOptions): UseTranscriptScrollResult {
  const {
    sessionId,
    scrollerRef,
    active,
    blockCount,
    renderStart,
    stickyEnabled,
    moreAbove,
    loadOlder,
    rowsToRender,
  } = opts

  const {
    scrollRef: followScrollRef,
    contentRef: followContentRef,
    scrollToBottom,
    stopScroll,
    isAtBottom,
  } = useStickToBottom({ initial: 'instant', resize: 'instant' })
  const [pinnedBrief, setPinnedBrief] = useState<PinnedBrief | null>(null)
  const pinnedEl = useRef<HTMLElement | null>(null)
  const prependAnchor = useRef<PrependAnchor | null>(null)

  const setScrollerRef = useCallback<RefCallback<HTMLDivElement>>(
    (element) => {
      scrollerRef.current = element
      followScrollRef(element)
    },
    [followScrollRef, scrollerRef],
  )

  const setContentRef = useCallback<RefCallback<HTMLDivElement>>(
    (element) => followContentRef(element),
    [followContentRef],
  )

  const syncStickyPromptPositions = useCallback(() => {
    const scroller = scrollerRef.current
    if (!scroller || !stickyEnabled) {
      if (pinnedEl.current !== null) {
        pinnedEl.current = null
        setPinnedBrief(null)
      }
      return
    }

    const edge = scroller.getBoundingClientRect().top
    const prompts = scroller.querySelectorAll<HTMLElement>(
      '[data-operator-prompt="true"][data-pinnable="true"]',
    )
    let next: HTMLElement | null = null
    for (const prompt of prompts) {
      // Keep a small dead band around the shelf boundary so fractional layout
      // cannot mount/unmount it on alternating frames.
      const limit = prompt === pinnedEl.current ? edge + 18 : edge + 6
      if (prompt.getBoundingClientRect().bottom < limit) next = prompt
      else break
    }
    if (next === pinnedEl.current) return
    pinnedEl.current = next
    if (!next) {
      setPinnedBrief(null)
      return
    }
    const body = next.querySelector<HTMLElement>('.transcript-you-body')
    setPinnedBrief({
      key: next.dataset.rowKey ?? next.dataset.block ?? '',
      html: body?.querySelector<HTMLElement>('.chat-md')?.innerHTML ?? body?.innerHTML ?? '',
      time: next.querySelector<HTMLElement>('.chat-clk')?.textContent ?? '',
    })
  }, [scrollerRef, stickyEnabled])

  const capturePrependAnchor = useCallback(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    const viewport = scroller.getBoundingClientRect()
    for (const row of scroller.querySelectorAll<HTMLElement>('[data-block]')) {
      const rect = row.getBoundingClientRect()
      if (rect.bottom <= viewport.top || rect.top >= viewport.bottom) continue
      prependAnchor.current = { element: row, offset: rect.top - viewport.top }
      return
    }
  }, [scrollerRef])

  const loadOlderAnchored = useCallback(() => {
    capturePrependAnchor()
    loadOlder()
  }, [capturePrependAnchor, loadOlder])

  // Restore the exact retained row before paint. Stable row keys let React keep
  // this element alive when older siblings are inserted; measuring that node is
  // attribution-safe in a way a scrollHeight delta can never be.
  useLayoutEffect(() => {
    const anchor = prependAnchor.current
    const scroller = scrollerRef.current
    if (!anchor) return
    if (!scroller || !anchor.element.isConnected) {
      prependAnchor.current = null
      return
    }
    const delta =
      anchor.element.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top -
      anchor.offset
    if (Math.abs(delta) > 0.5) scroller.scrollTop += delta
    prependAnchor.current = null
  }, [blockCount, renderStart, rowsToRender, scrollerRef])

  useLayoutEffect(() => {
    syncStickyPromptPositions()
  }, [active, rowsToRender, syncStickyPromptPositions])

  const onScroll = useCallback<UIEventHandler<HTMLDivElement>>(
    (event) => {
      syncStickyPromptPositions()
      if (moreAbove && event.currentTarget.scrollTop < 120) loadOlderAnchored()
    },
    [loadOlderAnchored, moreAbove, syncStickyPromptPositions],
  )

  // Pointer-up is the one extra selection signal needed by the product. The
  // maintained hook already handles wheel escape; selecting text pauses follow
  // without changing or replacing any transcript node.
  const onPointerUp = useCallback(() => {
    const selection = window.getSelection()
    if (selection && !selection.isCollapsed) stopScroll()
  }, [stopScroll])

  useEffect(() => {
    if (!active) return
    const onSelectionChange = (): void => {
      const scroller = scrollerRef.current
      const selection = window.getSelection()
      if (!scroller || !selection || selection.isCollapsed || selection.rangeCount === 0) return
      const range = selection.getRangeAt(0)
      if (scroller.contains(range.commonAncestorContainer)) stopScroll()
    }
    document.addEventListener('selectionchange', onSelectionChange)
    return () => document.removeEventListener('selectionchange', onSelectionChange)
  }, [active, scrollerRef, stopScroll])

  const moveToBottomNow = useCallback(() => {
    const scroller = scrollerRef.current
    if (scroller) scroller.scrollTop = scroller.scrollHeight
  }, [scrollerRef])

  const pinToBottom = useCallback(() => {
    // Explicit operator intent is synchronous geometry, followed by the
    // maintained primitive re-arming follow mode for subsequent growth. A send
    // can append an optimistic row immediately and a durable queued row one
    // frame later; absorb the stale upward scroll event between those commits
    // just as Jump does, or the second row escapes follow before the answer
    // starts streaming.
    moveToBottomNow()
    void scrollToBottom({
      animation: 'instant',
      ignoreEscapes: true,
      duration: JUMP_SETTLE_MS,
    })
  }, [moveToBottomNow, scrollToBottom])

  const jumpToBottom = useCallback(() => {
    moveToBottomNow()
    void scrollToBottom({
      animation: 'instant',
      ignoreEscapes: true,
      duration: JUMP_SETTLE_MS,
    })
  }, [moveToBottomNow, scrollToBottom])

  useEffect(() => {
    if (!active) return
    void scrollToBottom({ animation: 'instant', preserveScrollPosition: true })
  }, [active, scrollToBottom])

  // A mobile panel reuses one component for different sessions. A conversation
  // never inherits the previous session's reading offset or escaped-follow bit.
  // biome-ignore lint/correctness/useExhaustiveDependencies: session identity is the reset boundary
  useLayoutEffect(() => {
    pinnedEl.current = null
    prependAnchor.current = null
    setPinnedBrief(null)
    void scrollToBottom('instant')
  }, [sessionId])

  const scrollToBlock = useCallback(
    (index: number) => {
      const scroller = scrollerRef.current
      const target = scroller?.querySelector<HTMLElement>(`[data-block="${index}"]`)
      if (!target) return
      stopScroll()
      target.scrollIntoView({ block: 'center', behavior: 'smooth' })
    },
    [scrollerRef, stopScroll],
  )

  return {
    atBottom: isAtBottom,
    setScrollerRef,
    setContentRef,
    onScroll,
    onPointerUp,
    jumpToBottom,
    pinToBottom,
    loadOlder: loadOlderAnchored,
    scrollToBlock,
    syncStickyPromptPositions,
    pinnedBrief,
  }
}
