import type { RefObject } from 'react'
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'

export type ColdStartPromptFit = {
  height: number
  capped: boolean
}

/**
 * Fits the empty-state prompt into the pane without making the deck scroll.
 * `bodyHeight` is measured with the textarea at its resting height, so the
 * difference between it and `boundsHeight` is exactly the room the prompt may
 * claim before its own scrollbar takes over.
 */
export function fitColdStartPromptHeight({
  contentHeight,
  empty,
  restingHeight,
  boundsHeight,
  bodyHeight,
}: {
  contentHeight: number
  empty: boolean
  restingHeight: number
  boundsHeight: number
  bodyHeight: number
}): ColdStartPromptFit {
  const freeHeight = boundsHeight > 0 && bodyHeight > 0 ? Math.max(0, boundsHeight - bodyHeight) : 0
  const cap = restingHeight + freeHeight
  const wanted = empty ? restingHeight : Math.max(restingHeight, contentHeight)
  return { height: Math.min(wanted, cap), capped: wanted > cap }
}

/**
 * Grows the cold-start textarea with its contents until the deck fills its
 * scroll viewport. At that point only the textarea scrolls, leaving the
 * headline and launch controls on screen.
 */
export function useColdStartPromptAutoGrow({
  taRef,
  expanded,
  value,
  layoutKey,
}: {
  taRef: RefObject<HTMLTextAreaElement | null>
  expanded: boolean
  value: string
  /** Changes when content outside the textarea takes or releases vertical room. */
  layoutKey: string
}): void {
  const lastHeight = useRef<number | null>(null)

  const apply = useCallback(
    (mode: 'animate' | 'instant') => {
      const ta = taRef.current
      if (!ta) return

      const renderedHeight = ta.offsetHeight || lastHeight.current
      if (!expanded) {
        if (mode === 'animate' && renderedHeight !== null && renderedHeight > 46) {
          ta.dataset.grow = 'down'
          ta.style.height = `${renderedHeight}px`
          void ta.offsetHeight
          ta.style.removeProperty('height')
        } else {
          ta.dataset.grow = 'none'
          ta.style.removeProperty('height')
        }
        ta.dataset.capped = 'false'
        lastHeight.current = 46
        return
      }

      // Return to the stylesheet's responsive resting height for measurement.
      // `data-grow=none` prevents that temporary reset from becoming a visible
      // transition before the measured target is restored in this layout pass.
      ta.dataset.grow = 'none'
      ta.style.removeProperty('height')
      const restingHeight = ta.offsetHeight || 72
      const body = ta.closest<HTMLElement>('[data-cold-start-body]')
      const bounds = ta.closest<HTMLElement>('[data-cold-start-bounds]')
      const fit = fitColdStartPromptHeight({
        contentHeight: ta.scrollHeight,
        empty: ta.value.length === 0,
        restingHeight,
        boundsHeight: bounds?.clientHeight ?? 0,
        bodyHeight: body?.scrollHeight ?? 0,
      })
      const from = renderedHeight ?? restingHeight
      const animate = mode === 'animate' && fit.height !== from

      ta.dataset.capped = fit.capped ? 'true' : 'false'
      if (!animate) {
        ta.dataset.grow = 'none'
        ta.style.height = `${fit.height}px`
        lastHeight.current = fit.height
        return
      }
      ta.style.height = `${from}px`
      void ta.offsetHeight
      ta.dataset.grow = fit.height > from ? (from <= 46 ? 'fold' : 'up') : 'down'
      ta.style.height = `${fit.height}px`
      lastHeight.current = fit.height
    },
    [expanded, taRef],
  )

  // Layout effect, not effect: a pasted prompt can add many lines at once, and
  // resizing after paint would show one frame at the previous height.
  useLayoutEffect(() => {
    apply('animate')
  }, [apply, value, layoutKey])

  useEffect(() => {
    const ta = taRef.current
    const bounds = ta?.closest<HTMLElement>('[data-cold-start-bounds]')
    if (!bounds || typeof ResizeObserver === 'undefined') return
    let size = `${bounds.clientWidth}x${bounds.clientHeight}`
    const observer = new ResizeObserver(() => {
      const next = `${bounds.clientWidth}x${bounds.clientHeight}`
      if (next === size) return
      size = next
      apply('instant')
    })
    observer.observe(bounds)
    return () => observer.disconnect()
  }, [apply, taRef])
}
