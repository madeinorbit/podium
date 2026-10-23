import type { RefObject } from 'react'
import { useLayoutEffect } from 'react'

/** The prompt never grows past this share of the window; past it, it scrolls. */
export const COLD_START_PROMPT_MAX_SHARE = 0.6

export type ColdStartPromptFit = {
  height: number
  capped: boolean
}

/**
 * THE BOX GROWS WITH THE TEXT, THEN SCROLLS (POD-2079).
 *
 * It rests two lines tall (`minHeight`, from the stylesheet), takes one more
 * line per line written, and stops at 60% of the window. The cap is the
 * window's, not the pane's: the overlay always has the whole column, and a box
 * that stopped at whatever the pane happened to leave over would change height
 * when an unrelated panel opened.
 */
export function fitColdStartPromptHeight({
  contentHeight,
  minHeight,
  windowHeight,
}: {
  contentHeight: number
  minHeight: number
  windowHeight: number
}): ColdStartPromptFit {
  const cap = Math.max(minHeight, Math.floor(windowHeight * COLD_START_PROMPT_MAX_SHARE))
  const wanted = Math.max(minHeight, contentHeight)
  return { height: Math.min(wanted, cap), capped: wanted > cap }
}

/**
 * Sizes the cold-start textarea to its contents. No height transition: a box
 * that eases each new line in is animating layout on every keystroke, and a
 * line appearing is already the calmest thing it can do.
 */
export function useColdStartPromptAutoGrow({
  taRef,
  value,
}: {
  taRef: RefObject<HTMLTextAreaElement | null>
  value: string
}): void {
  // Layout effect, not effect: a pasted prompt can add many lines at once, and
  // resizing after paint would show one frame at the previous height.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `value` is the trigger; the size is read from the DOM.
  useLayoutEffect(() => {
    const ta = taRef.current
    if (!ta) return
    const apply = (): void => {
      ta.style.removeProperty('height')
      const minHeight = ta.offsetHeight
      const fit = fitColdStartPromptHeight({
        contentHeight: ta.value.length === 0 ? minHeight : ta.scrollHeight,
        minHeight,
        windowHeight: window.innerHeight,
      })
      ta.style.height = `${fit.height}px`
      ta.dataset.capped = fit.capped ? 'true' : 'false'
    }
    apply()
    window.addEventListener('resize', apply)
    return () => window.removeEventListener('resize', apply)
  }, [taRef, value])
}
