import type { RefObject } from 'react'
import { useCallback, useEffect, useLayoutEffect, useState } from 'react'

/**
 * SCROLL ANCHORING AND THE STICKY PROMPT (POD-405, extracted from ChatView).
 *
 * The one part of the chat surface that is genuinely about the DOM: where the
 * scroller sits, when it may be moved, and how the operator-prompt rows hand off
 * to one another as the user scrolls. `useTranscriptWindow` owns the DATA
 * (reads, deltas, paging) and hands this hook the three refs the two must
 * coordinate through; this hook owns every write to `scrollTop` and every style
 * written onto a prompt row.
 *
 * BEHAVIOUR PARITY IS THE POINT OF THIS FILE. Every effect below is the one that
 * was inline in ChatView, moved with its ordering, its dependency list and its
 * biome suppressions intact. The ordering is load-bearing and is documented at
 * each effect: the prepend re-anchor is a LAYOUT effect so it corrects position
 * before paint, and the bottom-snap that follows is gated on `pinnedToBottom`
 * (false while the user has scrolled up), so the two can never fight.
 */

export interface UseTranscriptScrollOptions {
  scrollerRef: RefObject<HTMLDivElement | null>
  /** Mirrors ChatView's `active` prop — a hidden panel gets no scroll events, so
   *  becoming active re-honours the pin. */
  active: boolean
  /** Grows as the transcript grows; the trigger for every follow-the-tail effect. */
  blockCount: number
  /** First windowed-in row — changes when a prepend widens the window. */
  renderStart: number
  /** Sticky operator prompts are a preference, and are suppressed in the narrow
   *  dock (too short to give a pinned prompt anywhere to go). */
  stickyEnabled: boolean
  /** More rows exist above — scrolling near the top autoloads them. */
  moreAbove: boolean
  loadOlder: () => void
  /** From `useTranscriptWindow`: read AND written here. */
  pinnedToBottom: RefObject<boolean>
  didInitialScroll: RefObject<boolean>
  prependAnchor: RefObject<{ scrollHeight: number; scrollTop: number } | null>
  /** Changes whenever the mounted row set changes — the trigger for a fresh
   *  geometry pass over the sticky prompts. */
  rowsToRender: unknown
}

export interface UseTranscriptScrollResult {
  /** False once the user scrolls up — drives the "jump to bottom" affordance. */
  atBottom: boolean
  onScroll: () => void
  jumpToBottom: () => void
  /** Re-pin to the tail (used by the send path, which always follows its own send). */
  pinToBottom: () => void
  /** Scroll a `[data-block]` row into view — the search jump. */
  scrollToBlock: (index: number) => void
  syncStickyPromptPositions: () => void
}

export function useTranscriptScroll(opts: UseTranscriptScrollOptions): UseTranscriptScrollResult {
  const {
    scrollerRef,
    active,
    blockCount,
    renderStart,
    stickyEnabled,
    moreAbove,
    loadOlder,
    pinnedToBottom,
    didInitialScroll,
    prependAnchor,
    rowsToRender,
  } = opts

  const [atBottom, setAtBottom] = useState(true)

  // Native sticky positioning keeps the real prompt row in the transcript.
  // As the next prompt approaches, translate the current row by exactly the
  // overlap so the two turns hand off rather than stack on top of one another.
  // Reading geometry before writing styles keeps the scroll path free of
  // forced layout loops; transform intentionally has no transition because it
  // must remain locked to the user's scroll position.
  const syncStickyPromptPositions = useCallback(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    const prompts = Array.from(
      scroller.querySelectorAll<HTMLElement>('[data-operator-prompt="true"]'),
    )

    if (!stickyEnabled) {
      for (const prompt of prompts) {
        prompt.style.removeProperty('transform')
        prompt.style.removeProperty('visibility')
        delete prompt.dataset.stuck
      }
      return
    }

    const scrollerTop = scroller.getBoundingClientRect().top
    const firstPrompt = prompts[0]
    const stickyOffset = firstPrompt ? Number.parseFloat(getComputedStyle(firstPrompt).top) || 0 : 0
    const stickyTop =
      scrollerTop + (Number.parseFloat(getComputedStyle(scroller).paddingTop) || 0) + stickyOffset
    let activeIndex = -1
    for (let i = 0; i < prompts.length; i++) {
      const prompt = prompts[i]
      if (prompt && prompt.getBoundingClientRect().top <= stickyTop + 1) activeIndex = i
    }

    const activePrompt = activeIndex >= 0 ? prompts[activeIndex] : undefined
    const nextPrompt = activeIndex >= 0 ? prompts[activeIndex + 1] : undefined
    const activeBody = activePrompt?.querySelector<HTMLElement>(':scope > .transcript-body')
    const nextBody = nextPrompt?.querySelector<HTMLElement>(':scope > .transcript-body')
    const currentPushY = activePrompt
      ? Number.parseFloat(
          /^translateY\((-?[\d.]+)px\)$/.exec(activePrompt.style.transform)?.[1] ?? '0',
        )
      : 0
    const pushY =
      activeBody && nextBody
        ? Math.min(
            0,
            nextBody.getBoundingClientRect().top -
              (activeBody.getBoundingClientRect().bottom - currentPushY),
          )
        : 0

    for (let i = 0; i < prompts.length; i++) {
      const prompt = prompts[i]
      if (!prompt) continue
      const isActive = i === activeIndex
      prompt.style.visibility = i < activeIndex ? 'hidden' : ''
      prompt.style.transform = isActive && pushY < 0 ? `translateY(${pushY}px)` : ''
      if (isActive) prompt.dataset.stuck = 'true'
      else delete prompt.dataset.stuck
    }
  }, [scrollerRef, stickyEnabled])

  // Reconcile after row-window changes before paint, including when the
  // continuation prompt is mounted for a virtualized long answer.
  // biome-ignore lint/correctness/useExhaustiveDependencies: row-window and active-panel changes require a fresh DOM geometry pass
  useLayoutEffect(() => {
    syncStickyPromptPositions()
  }, [active, rowsToRender, syncStickyPromptPositions])

  // Follow the live tail unless the user scrolled up to read. Re-runs as blocks
  // arrive (snapshot lands after mount, then live appends) — an empty dep array
  // fired once before any transcript existed and never followed the stream.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the block list grows
  useEffect(() => {
    const el = scrollerRef.current
    if (el && pinnedToBottom.current) {
      el.scrollTop = el.scrollHeight
      syncStickyPromptPositions()
    }
  }, [blockCount, syncStickyPromptPositions])

  // Scroll-anchor for prepends: after older blocks are inserted at the top (window
  // widened or a disk page prepended), the content the user was reading shifts down
  // by the inserted height. Re-pin scrollTop by that delta BEFORE paint so the view
  // doesn't jump. Keyed on the values that change the top of the list; a no-op
  // unless a prepend captured an anchor. Runs before the bottom-snap effect below,
  // and that effect is gated on pinnedToBottom (false while scrolled up), so the two
  // never fight.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-anchor when the top of the list changes
  useLayoutEffect(() => {
    const anchor = prependAnchor.current
    if (!anchor) return
    prependAnchor.current = null
    const el = scrollerRef.current
    if (!el) return
    const delta = el.scrollHeight - anchor.scrollHeight
    if (delta !== 0) el.scrollTop = anchor.scrollTop + delta
  }, [blockCount, renderStart])

  // Initial-load snap: the growth effect above can fire before markdown/code
  // blocks have laid out (it measures a shorter scrollHeight and lands above the
  // tail). On the first populated render, defer two frames so layout settles,
  // then pin to the bottom. One-shot per session — incremental growth is handled
  // above and must still honour a user who scrolled up.
  // biome-ignore lint/correctness/useExhaustiveDependencies: one-shot keyed off the block count
  useEffect(() => {
    if (didInitialScroll.current || blockCount === 0) return
    didInitialScroll.current = true
    const el = scrollerRef.current
    if (!el) return
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (pinnedToBottom.current) el.scrollTop = el.scrollHeight
      })
    })
  }, [blockCount])

  // ResizeObserver: while pinned, re-snap to bottom whenever the stream grows
  // taller (async markdown / code-block layout that settles after the DOM paint).
  // Gated on pinnedToBottom so it never yanks the view while the user has scrolled
  // up to read or page older content.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pinnedToBottom is a stable ref from useTranscriptWindow, not app state
  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      if (pinnedToBottom.current) el.scrollTop = el.scrollHeight
      syncStickyPromptPositions()
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [syncStickyPromptPositions])

  // Snap to bottom on pane switch-in: the keep-mounted panel deck hides inactive
  // panels with `display:none`, so scroll events stop firing. When this pane
  // becomes active again, honour the pin by jumping straight to the bottom (and
  // only then — a user who scrolled up keeps their position).
  // biome-ignore lint/correctness/useExhaustiveDependencies: fire only on active transition
  useEffect(() => {
    if (!active) return
    const el = scrollerRef.current
    if (el && pinnedToBottom.current) {
      el.scrollTop = el.scrollHeight
      syncStickyPromptPositions()
    }
  }, [active, syncStickyPromptPositions])

  const onScroll = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    pinnedToBottom.current = near
    setAtBottom(near)
    syncStickyPromptPositions()
    // Near the TOP and more exists above → reveal/fetch older content.
    if (el.scrollTop < 200 && moreAbove) loadOlder()
  }, [scrollerRef, pinnedToBottom, syncStickyPromptPositions, moreAbove, loadOlder])

  const jumpToBottom = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    pinnedToBottom.current = true
    el.scrollTop = el.scrollHeight
    setAtBottom(true)
    syncStickyPromptPositions()
  }, [scrollerRef, pinnedToBottom, syncStickyPromptPositions])

  // A send always follows its own message: re-pin without touching the DOM, and
  // let the growth effect above do the scrolling once the bubble mounts.
  const pinToBottom = useCallback(() => {
    pinnedToBottom.current = true
    setAtBottom(true)
  }, [pinnedToBottom])

  const scrollToBlock = useCallback(
    (index: number) => {
      scrollerRef.current
        ?.querySelector(`[data-block="${index}"]`)
        ?.scrollIntoView({ block: 'center' })
    },
    [scrollerRef],
  )

  return {
    atBottom,
    onScroll,
    jumpToBottom,
    pinToBottom,
    scrollToBlock,
    syncStickyPromptPositions,
  }
}
