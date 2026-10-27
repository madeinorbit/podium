import { afterEach, describe, expect, it, vi } from 'vitest'
import { findTipAnchor } from './anchors'

// DOM test environments don't lay out elements. These boxes model the scroller's
// padding box and a row moving beneath it, without changing viewport visibility.
function setTipTestRect(element: HTMLElement, rect: DOMRect): void {
  vi.spyOn(element, 'getBoundingClientRect').mockImplementation(() => rect)
  vi.spyOn(element, 'getClientRects').mockImplementation(() => [rect] as unknown as DOMRectList)
  Object.defineProperties(element, {
    clientWidth: { configurable: true, get: () => rect.width },
    clientHeight: { configurable: true, get: () => rect.height },
  })
}
afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})
describe('tip anchor clipping', () => {
  it.each([
    'auto',
    'scroll',
    'hidden',
    'clip',
  ])('rejects a row partially clipped by overflow-y: %s', (overflow) => {
    const scroller = document.createElement('div')
    scroller.style.overflowY = overflow
    const anchor = scroller.appendChild(document.createElement('button'))
    anchor.dataset.tipAnchor = 'row'
    document.body.append(scroller)
    setTipTestRect(scroller, new DOMRect(20, 20, 200, 100))
    setTipTestRect(anchor, new DOMRect(30, 110, 100, 30))
    expect(findTipAnchor('row')).toBeNull()
  })
  it('checks nested horizontal clipping and accepts a fully visible row', () => {
    const outer = document.createElement('div')
    outer.style.overflowX = 'auto'
    const inner = outer.appendChild(document.createElement('div'))
    const anchor = inner.appendChild(document.createElement('button'))
    anchor.dataset.tipAnchor = 'row'
    document.body.append(outer)
    setTipTestRect(outer, new DOMRect(20, 20, 200, 100))
    setTipTestRect(anchor, new DOMRect(210, 30, 100, 30))
    expect(findTipAnchor('row')).toBeNull()
    setTipTestRect(anchor, new DOMRect(30, 30, 100, 30))
    expect(findTipAnchor('row')).toBe(anchor)
  })
  it('skips a hidden copy of a repeated name for the visible one', () => {
    const scroller = document.createElement('div')
    scroller.style.overflowY = 'auto'
    const clipped = scroller.appendChild(document.createElement('button'))
    const visible = scroller.appendChild(document.createElement('button'))
    clipped.dataset.tipAnchor = 'row'
    visible.dataset.tipAnchor = 'row'
    document.body.append(scroller)
    setTipTestRect(scroller, new DOMRect(20, 20, 200, 100))
    setTipTestRect(clipped, new DOMRect(30, -20, 100, 30))
    setTipTestRect(visible, new DOMRect(30, 40, 100, 30))
    expect(findTipAnchor('row')).toBe(visible)
    // A copy that lays out nothing (display: none pane) never shadows either.
    clipped.style.display = 'none'
    setTipTestRect(clipped, new DOMRect(0, 0, 0, 0))
    expect(findTipAnchor('row')).toBe(visible)
  })
})
