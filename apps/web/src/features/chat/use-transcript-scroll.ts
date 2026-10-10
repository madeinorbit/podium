import {
  useDomTranscriptScroll,
  type UseDomTranscriptScrollOptions,
  type UseDomTranscriptScrollResult,
} from '@podium/client-core/react/transcript-scroll'
import type { SessionId } from '@podium/model/browser'
import { useCallback, useLayoutEffect, useRef, useState } from 'react'

export interface UseTranscriptScrollOptions extends UseDomTranscriptScrollOptions {
  sessionId: SessionId
  stickyEnabled: boolean
}

export interface PinnedBrief {
  key: string
  html: string
  time: string
}

export interface UseTranscriptScrollResult extends UseDomTranscriptScrollResult {
  syncStickyPromptPositions: () => void
  pinnedBrief: PinnedBrief | null
  /** Scroll the feed back to the prompt the shelf is carrying, its top just
   *  under the scroller's edge. A no-op when nothing is pinned. */
  scrollToPinned: () => void
}

/** Breathing room above the prompt once the jump lands, so its first line is
 *  not flush against the top of the feed. */
const PIN_JUMP_MARGIN = 12

/** Desktop shelf presentation delegates all position and intent to the shared browser controller. */
export function useTranscriptScroll(opts: UseTranscriptScrollOptions): UseTranscriptScrollResult {
  const { sessionId, scrollerRef, stickyEnabled } = opts
  const [pinnedBrief, setPinnedBrief] = useState<PinnedBrief | null>(null)
  const pinnedEl = useRef<HTMLElement | null>(null)
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
  useLayoutEffect(() => {
    pinnedEl.current = null
    setPinnedBrief(null)
  }, [sessionId])
  const scroll = useDomTranscriptScroll({ ...opts, onPositionChange: syncStickyPromptPositions })
  const { scrollToOffset } = scroll
  const pinnedKey = pinnedBrief?.key
  const scrollToPinned = useCallback(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    let target = pinnedEl.current
    // The row may have been re-rendered since it was pinned; find it again by key.
    if (!target?.isConnected && pinnedKey) {
      target =
        [...scroller.querySelectorAll<HTMLElement>('[data-operator-prompt="true"]')].find(
          (row) => (row.dataset.rowKey ?? row.dataset.block) === pinnedKey,
        ) ?? null
    }
    if (!target?.isConnected) return
    const top = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top
    scrollToOffset(scroller.scrollTop + top - PIN_JUMP_MARGIN)
  }, [scrollerRef, scrollToOffset, pinnedKey])
  return { ...scroll, syncStickyPromptPositions, pinnedBrief, scrollToPinned }
}
