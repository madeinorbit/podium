import { useEffect, useState } from 'react'

/**
 * Anchor names are values, never caller-supplied CSS selectors. A name may be
 * carried by several mounted elements (a hidden chat pane beside a visible
 * native one, sub-task rows in a clipped list); the first visible one wins.
 */
export function findTipAnchor(name: string): HTMLElement | null {
  for (const element of document.querySelectorAll<HTMLElement>('[data-tip-anchor]'))
    if (element.getAttribute('data-tip-anchor') === name && isTipAnchorVisible(element))
      return element
  return null
}

/** The one visibility criterion for anchors: the whole element on screen. */
export function isTipAnchorVisible(anchor: HTMLElement): boolean {
  if (!anchor.isConnected || !anchor.getClientRects().length) return false
  const rect = anchor.getBoundingClientRect()
  if (
    !rect.width ||
    !rect.height ||
    rect.bottom <= 0 ||
    rect.right <= 0 ||
    rect.top >= window.innerHeight ||
    rect.left >= window.innerWidth
  )
    return false
  const style = getComputedStyle(anchor)
  if (style.visibility === 'hidden' || style.display === 'none') return false
  // A row can be inside the viewport but underneath its scroller's footer.
  // Require the whole anchor on each clipped axis, so its beacon never outlines hidden content.
  for (let parent = anchor.parentElement; parent; parent = parent.parentElement) {
    const parentStyle = getComputedStyle(parent)
    const clips = (overflow: string) => /^(auto|scroll|hidden|clip|overlay)$/.test(overflow)
    const clipX = clips(parentStyle.overflowX || parentStyle.overflow)
    const clipY = clips(parentStyle.overflowY || parentStyle.overflow)
    if (!clipX && !clipY) continue
    const bounds = parent.getBoundingClientRect()
    const scaleX = parent.offsetWidth ? bounds.width / parent.offsetWidth : 1
    const scaleY = parent.offsetHeight ? bounds.height / parent.offsetHeight : 1
    const left = bounds.left + parent.clientLeft * scaleX
    const top = bounds.top + parent.clientTop * scaleY
    const right = left + parent.clientWidth * scaleX
    const bottom = top + parent.clientHeight * scaleY
    if (clipX && (rect.left < left - 0.5 || rect.right > right + 0.5)) return false
    if (clipY && (rect.top < top - 0.5 || rect.bottom > bottom + 0.5)) return false
  }
  return true
}

// Fine steps near the top: a fold that settles at 99% and then opens fully
// crosses a threshold either way, so each step re-checks the real criterion.
const THRESHOLDS = [0, 0.25, 0.5, 0.75, 0.9, 0.95, 0.98, 0.99, 1]

/**
 * Whether `element` passes `isTipAnchorVisible`, re-checked whenever its
 * on-screen share crosses a threshold. A moment that is active only while this
 * is true gets a fresh edge each time the anchor comes fully into view, so an
 * attempt the engine rejected is retried the next time it can succeed.
 * Pass null to stop watching (no element, or the moment is already seen).
 */
export function useTipAnchorVisible(element: HTMLElement | null): boolean {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (!element) return
    // Without IntersectionObserver (some test environments) assume on screen.
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return () => setVisible(false)
    }
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(!!entry?.isIntersecting && isTipAnchorVisible(element)),
      { threshold: THRESHOLDS },
    )
    observer.observe(element)
    return () => {
      observer.disconnect()
      setVisible(false)
    }
  }, [element])
  return visible
}
