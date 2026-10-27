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
})
