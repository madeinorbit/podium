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
  return style.visibility === 'hidden' || style.display === 'none' ? null : anchor
}
