/** Anchor names are values, never caller-supplied CSS selectors. */
export function findTipAnchor(name: string): HTMLElement | null {
  const anchor = [...document.querySelectorAll<HTMLElement>('[data-tip-anchor]')].find(
    (element) => element.getAttribute('data-tip-anchor') === name,
  )
  if (!anchor?.isConnected || !anchor.getClientRects().length) return null
  const rect = anchor.getBoundingClientRect()
  if (
    !rect.width ||
    !rect.height ||
    rect.bottom <= 0 ||
    rect.right <= 0 ||
    rect.top >= window.innerHeight ||
    rect.left >= window.innerWidth
  )
    return null
  const style = getComputedStyle(anchor)
  if (style.visibility === 'hidden' || style.display === 'none') return null
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
    if (clipX && (rect.left < left - 0.5 || rect.right > right + 0.5)) return null
    if (clipY && (rect.top < top - 0.5 || rect.bottom > bottom + 0.5)) return null
  }
  return anchor
}
