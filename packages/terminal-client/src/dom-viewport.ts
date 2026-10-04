import type { ViewportSize, ViewportSource } from './viewport'

export class DomViewportSource implements ViewportSource {
  private readonly el: HTMLElement
  private readonly cbs = new Set<(s: ViewportSize) => void>()
  private readonly ro: ResizeObserver
  private readonly onVv = () => this.emit()
  private lastReported: { size: ViewportSize; padding: string } | undefined

  constructor(el: HTMLElement) {
    this.el = el
    this.ro = new ResizeObserver(() => this.emit())
    this.ro.observe(el)
    globalThis.visualViewport?.addEventListener('resize', this.onVv)
  }

  current(): ViewportSize {
    const rect = this.el.getBoundingClientRect()
    const vvH = globalThis.visualViewport?.height ?? rect.height
    return {
      width: rect.width,
      height: Math.min(rect.height, vvH),
      dpr: globalThis.devicePixelRatio ?? 1,
    }
  }

  onChange(cb: (s: ViewportSize) => void): () => void {
    this.cbs.add(cb)
    return () => this.cbs.delete(cb)
  }

  dispose(): void {
    this.ro.disconnect()
    globalThis.visualViewport?.removeEventListener('resize', this.onVv)
    this.cbs.clear()
  }

  private emit(): void {
    const s = this.current()
    const style = getComputedStyle(this.el)
    const padding = `${style.paddingLeft} ${style.paddingRight} ${style.paddingTop} ${style.paddingBottom}`
    const last = this.lastReported
    // ResizeObserver observes the content box, which can change when the
    // terminal's own output toggles a scrollbar inside an unchanged viewport.
    // Only a change to the measured box, its inset, or its pixel density is a
    // sizing trigger. Attach/reveal/font events still state the box separately.
    if (
      last &&
      last.size.width === s.width &&
      last.size.height === s.height &&
      last.size.dpr === s.dpr &&
      last.padding === padding
    ) {
      return
    }
    this.lastReported = { size: s, padding }
    for (const cb of [...this.cbs]) cb(s)
  }
}
