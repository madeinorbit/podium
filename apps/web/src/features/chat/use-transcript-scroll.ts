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
}

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
  return { ...scroll, syncStickyPromptPositions, pinnedBrief }
}
