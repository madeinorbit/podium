import type { RefObject } from 'react'
import { useCallback, useEffect, useLayoutEffect } from 'react'

/**
 * THE PROMPT BOX'S HEIGHT (POD-516).
 *
 * The composer is one line at rest and grows a line at a time as the prompt
 * wraps, up to a cap, after which it scrolls inside. The mechanics that make
 * that feel like a tool rather than a jumping textarea are all here, because
 * three of them are easy to get subtly wrong:
 *
 *  1. THE CAP IS DERIVED, NOT A MAGIC NUMBER. It was `Math.min(scrollHeight,
 *     114)` — six lines at one particular density, in a dock of any height. It
 *     is now `maxLines` of the element's OWN line-height, and separately capped
 *     at a fraction of the surface it sits in, so a short dock never ends up
 *     mostly composer.
 *  2. BELOW THE CAP THE BOX GROWS INSTEAD OF SCROLLING. The height transition
 *     takes ~150ms to catch up with a newly wrapped line; if the textarea could
 *     scroll during that window the browser would chase the caret and shove the
 *     line above it out of view and back. `capped` drives `overflow` so the new
 *     line is briefly clipped by a box that is opening, which reads as motion,
 *     not as a jump.
 *  3. THE TRANSITION NEEDS A PIXEL START VALUE. Measuring at `height:auto` and
 *     assigning the target in one pass leaves the start value as `auto`, which
 *     cannot interpolate — the height snaps. So: measure at auto, restore the
 *     previous pixel height, force a reflow, then assign.
 *
 * Direction is reported on `data-grow` rather than an inline duration, so
 * `prefers-reduced-motion` can still zero it from the stylesheet (an inline
 * `transition-duration` would outrank the media query).
 *
 * This is deliberately a hook plus a pure function over three CSS classes
 * (`.prompt-dock` / `.prompt-well` / `.prompt-input`), not a component: the
 * chat composer runs the same auto-grow from its own copy of this measurement,
 * and adopting this file is a smaller change than adopting a wrapper.
 */

/** How much of its surface the composer may take before the cap bites. */
const PANE_SHARE = 0.42

export type PromptFit = {
  /** The height to assign, in px. */
  height: number
  /** True once the content wants more room than the cap allows. */
  capped: boolean
}

/**
 * The whole sizing decision, as arithmetic over measurements — so it can be
 * tested without a layout engine.
 *
 * `content` is `scrollHeight` measured at `height:auto`. It is ignored when the
 * field is empty: an empty textarea's scrollHeight includes its placeholder,
 * which wraps to two lines in a narrow dock and would leave the resting box a
 * line too tall.
 */
export function fitPromptHeight({
  content,
  empty,
  lineHeight,
  padding,
  maxLines,
  paneHeight,
}: {
  content: number
  empty: boolean
  lineHeight: number
  padding: number
  maxLines: number
  /** Height of the surface the composer sits in; 0 when it cannot be measured. */
  paneHeight: number
}): PromptFit {
  const oneLine = lineHeight + padding
  const lineCap = lineHeight * maxLines + padding
  const roomCap = paneHeight > 0 ? paneHeight * PANE_SHARE : Number.POSITIVE_INFINITY
  // Never below one line, whatever the room: a composer you cannot see the
  // caret in is worse than a composer that takes half a short dock.
  const cap = Math.max(oneLine, Math.min(lineCap, roomCap))
  const wanted = empty ? oneLine : Math.max(oneLine, content)
  return { height: Math.min(wanted, cap), capped: wanted > cap }
}

/**
 * Sizes `taRef` to its content on every `value` change, and re-fits it when the
 * surface it sits in is resized (dragging the dock narrower rewraps the draft,
 * and a box left at its old height would clip it).
 *
 * The surface is the nearest `[data-prompt-bounds]` ancestor.
 */
export function usePromptAutoGrow({
  taRef,
  value,
  maxLines = 8,
}: {
  taRef: RefObject<HTMLTextAreaElement | null>
  value: string
  maxLines?: number
}): void {
  const apply = useCallback(
    (mode: 'animate' | 'instant') => {
      const ta = taRef.current
      if (!ta) return
      const previous = ta.style.height
      ta.style.height = 'auto'
      const cs = getComputedStyle(ta)
      const lineHeight = Number.parseFloat(cs.lineHeight) || 18
      const padding =
        (Number.parseFloat(cs.paddingTop) || 0) + (Number.parseFloat(cs.paddingBottom) || 0)
      const bounds = ta.closest<HTMLElement>('[data-prompt-bounds]')
      const fit = fitPromptHeight({
        content: ta.scrollHeight,
        empty: ta.value.length === 0,
        lineHeight,
        padding,
        maxLines,
        paneHeight: bounds?.clientHeight ?? 0,
      })
      const from = Number.parseFloat(previous)
      // No previous pixel height means first paint: land on the target without
      // animating, or the composer would unfurl every time the pane mounts.
      const animate = mode === 'animate' && Number.isFinite(from)
      ta.dataset.capped = fit.capped ? 'true' : 'false'
      ta.dataset.grow =
        animate && fit.height !== from ? (fit.height > from ? 'up' : 'down') : 'none'
      ta.style.height = animate ? `${from}px` : `${fit.height}px`
      // Pins the transition's start value before the target lands.
      void ta.offsetHeight
      ta.style.height = `${fit.height}px`
    },
    [taRef, maxLines],
  )

  // Layout effect, not effect: an @-mention insertion or a voice transcript can
  // add several lines at once, and re-sizing after paint shows one frame of the
  // old box with the new text clipped inside it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: value is the re-measure trigger
  useLayoutEffect(() => {
    apply('animate')
  }, [value, apply])

  useEffect(() => {
    const ta = taRef.current
    const bounds = ta?.closest<HTMLElement>('[data-prompt-bounds]')
    if (!bounds || typeof ResizeObserver === 'undefined') return
    // Observe the SURFACE, not the field: the field's own height changes on
    // every grow, and re-entering the fit mid-transition would restart it.
    let seen = `${bounds.clientWidth}x${bounds.clientHeight}`
    const ro = new ResizeObserver(() => {
      const now = `${bounds.clientWidth}x${bounds.clientHeight}`
      if (now === seen) return
      seen = now
      // A drag is continuous; animating each frame of it would lag the pointer.
      apply('instant')
    })
    ro.observe(bounds)
    return () => ro.disconnect()
  }, [taRef, apply])
}
