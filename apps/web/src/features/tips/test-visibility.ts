import { vi } from 'vitest'

/**
 * DOM test environments neither lay out elements nor intersect them. `place`
 * gives an element a box (inside or outside the viewport) and reports it to
 * the IntersectionObserver watching it, as a scroll or fold would.
 */
export function stubTipVisibility(): {
  place(element: Element, rect: DOMRect): void
  /** Make `element` a scroller whose padding box is `rect`. */
  clip(element: HTMLElement, rect: DOMRect): void
  watched(): Element[]
} {
  const watching = new Map<Element, () => void>()
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      private readonly elements = new Set<Element>()
      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe(element: Element): void {
        this.elements.add(element)
        watching.set(element, () => {
          const rect = element.getBoundingClientRect()
          const isIntersecting =
            rect.bottom > 0 &&
            rect.right > 0 &&
            rect.top < window.innerHeight &&
            rect.left < window.innerWidth
          this.callback(
            [{ target: element, isIntersecting } as unknown as IntersectionObserverEntry],
            this as never,
          )
        })
      }
      disconnect(): void {
        for (const element of this.elements) watching.delete(element)
        this.elements.clear()
      }
    },
  )
  return {
    place(element, rect) {
      vi.spyOn(element, 'getBoundingClientRect').mockImplementation(() => rect)
      vi.spyOn(element, 'getClientRects').mockImplementation(() => [rect] as unknown as DOMRectList)
      watching.get(element)?.()
    },
    clip(element, rect) {
      element.style.overflow = 'hidden'
      vi.spyOn(element, 'getBoundingClientRect').mockImplementation(() => rect)
      Object.defineProperties(element, {
        clientWidth: { configurable: true, get: () => rect.width },
        clientHeight: { configurable: true, get: () => rect.height },
      })
    },
    watched: () => [...watching.keys()],
  }
}

/** The scroller `clip` tests use: the top-left 400×300. */
export const PANE = new DOMRect(0, 0, 400, 300)
/** Fully on screen. */
export const ON_SCREEN = new DOMRect(20, 20, 120, 40)
/** Below the fold. */
export const OFF_SCREEN = new DOMRect(20, 5000, 120, 40)
/** Inside PANE but for its last 0.6px: what a fold paused at 99% shows. */
export const NEARLY = new DOMRect(20, 260.6, 120, 40)
