type Sweep = { element: HTMLElement; visible: boolean }

/** One observer and visibility listener per document, only while sweeps are mounted. */
const documents = new WeakMap<Document, SweepVisibility>()

class SweepVisibility {
  private readonly sweeps = new Map<Element, Sweep>()
  private readonly observer: IntersectionObserver | undefined

  constructor(private readonly document: Document) {
    const Observer = document.defaultView?.IntersectionObserver
    if (Observer) {
      this.observer = new Observer((entries) => {
        for (const entry of entries) {
          const sweep = this.sweeps.get(entry.target)
          if (!sweep) continue
          // Exclude edge contact. A segment entering its width transition can
          // have zero area but ratio 1; treating that as invisible would strand
          // it paused, since growth to full visibility need not cross a threshold.
          sweep.visible = entry.isIntersecting && entry.intersectionRatio > 0
          this.update(sweep)
        }
      })
    }
    document.addEventListener('visibilitychange', this.onVisibilityChange)
  }

  private update(sweep: Sweep): void {
    const state =
      sweep.visible && this.document.visibilityState !== 'hidden' ? 'running' : 'paused'
    if (sweep.element.style.animationPlayState !== state) {
      sweep.element.style.animationPlayState = state
    }
  }

  private readonly onVisibilityChange = (): void => {
    for (const sweep of this.sweeps.values()) this.update(sweep)
  }

  add(element: HTMLElement, segment: HTMLElement): () => void {
    const sweep = { element, visible: !this.observer }
    this.sweeps.set(segment, sweep)
    this.update(sweep)
    // Observe the stationary run segment, not the translated sheen. The default
    // root also accounts for clipping by the sidebar's scroll containers.
    this.observer?.observe(segment)
    return () => {
      this.observer?.unobserve(segment)
      this.sweeps.delete(segment)
      if (this.sweeps.size === 0) {
        this.observer?.disconnect()
        this.document.removeEventListener('visibilitychange', this.onVisibilityChange)
        documents.delete(this.document)
      }
    }
  }
}

/** React ref cleanup preserves the CSS animation's phase through pause/resume. */
export function observeRowProgressSweep(element: HTMLSpanElement): () => void {
  const segment = element.parentElement
  if (!segment) return () => {}
  const document = element.ownerDocument
  let visibility = documents.get(document)
  if (!visibility) {
    visibility = new SweepVisibility(document)
    documents.set(document, visibility)
  }
  return visibility.add(element, segment)
}
