/**
 * Finger scrolling for the terminal pane (#339).
 *
 * xterm.js has its own touch fallback, but it is guarded by
 * `!coreMouseService.areMouseEventsActive`: the moment the running program turns
 * on mouse tracking (Claude Code's REPL sets `CSI ?1000;1002;1003;1006 h` at
 * startup, alongside `?1049h` for the alternate screen) xterm stops scrolling on
 * touch and forwards the gesture to the application as mouse reports instead. On
 * a desktop that is invisible — the wheel listener still translates a wheel into
 * an application mouse report, or into cursor keys when the alternate screen has
 * no scrollback — but an iPad has no wheel, so the pane simply stops scrolling.
 *
 * So we translate a one-finger vertical drag into synthetic wheel events and let
 * xterm's OWN wheel handling decide what a wheel means right now:
 *   - application owns the mouse → an encoded wheel report (the app scrolls, as
 *     it does for a desktop wheel, in whatever encoding it negotiated);
 *   - alternate screen, no mouse   → cursor-up/down keys (pagers, vim);
 *   - normal buffer                → the scrollback viewport moves.
 *
 * Only the first two are taken over — the states where xterm's fallback either
 * never runs or has nothing to move. A plain shell in the normal buffer keeps
 * xterm's own touch handler, which scrolls the viewport pixel-for-pixel with the
 * finger instead of by whole rows; there is nothing to fix there, and a wheel
 * would only make it coarser.
 */

/** Vertical travel before a drag counts as a scroll rather than a tap. Small, so
 *  the first cancelled touchmove still suppresses the compatibility mouse events
 *  the browser would otherwise synthesize at the end of the gesture. */
const SLOP_PX = 6

/** A fling can jump many rows between two touchmove frames; cap the reports we
 *  emit for one frame so a flick can't flood the PTY with wheel sequences. */
const MAX_NOTCHES_PER_FRAME = 8

/** The terminal seen by the gesture engine — the whole xterm surface reduced to
 *  what a scroll gesture needs, so the engine is testable without a DOM. */
export interface TouchScrollTerminal {
  /** True while the application has mouse tracking on — the state in which xterm
   *  refuses to touch-scroll and hands the gesture to the application instead. */
  appOwnsMouse(): boolean
  /** True while the alternate screen is up: xterm's touch handler still runs but
   *  there is no scrollback under it, so the drag moves nothing. */
  altBuffer(): boolean
  /** Height of one text row in CSS pixels, or 0 when it can't be measured. */
  rowHeight(): number
  /** xterm's `scrollSensitivity` — it multiplies every pixel wheel delta. */
  sensitivity(): number
  /** Dispatch one wheel notch of `deltaY` pixels at a viewport point. */
  wheel(deltaY: number, clientX: number, clientY: number): void
}

/**
 * One-finger drag → wheel notches. Pure bookkeeping: the caller feeds it touch
 * coordinates and cancels the browser event whenever a call reports `true`.
 */
export class TouchScrollEngine {
  private readonly term: TouchScrollTerminal
  /** This gesture is one we handle instead of xterm — decided at touch-down, so
   *  a mode flip mid-drag can't split one gesture across two owners. */
  private takeover = false
  /** Past the slop — from here every frame is ours and gets cancelled. */
  private engaged = false
  private startX = 0
  private startY = 0
  private lastY = 0
  /** Finger travel not yet paid out as whole notches. */
  private carry = 0

  constructor(term: TouchScrollTerminal) {
    this.term = term
  }

  down(clientX: number, clientY: number): void {
    this.startX = clientX
    this.startY = clientY
    this.lastY = clientY
    this.carry = 0
    this.engaged = false
    this.takeover = (this.term.appOwnsMouse() || this.term.altBuffer()) && this.term.rowHeight() > 0
  }

  /** @returns true when the gesture is being scrolled by us — cancel the event. */
  move(clientX: number, clientY: number): boolean {
    if (!this.takeover) return false
    this.carry += this.lastY - clientY
    this.lastY = clientY
    if (!this.engaged) {
      const dy = Math.abs(clientY - this.startY)
      // Vertical intent only: a horizontal drag stays the application's (its own
      // mouse-drag semantics), and a diagonal one is not a scroll.
      if (dy < SLOP_PX || dy <= Math.abs(clientX - this.startX)) return false
      this.engaged = true
    }
    const row = this.term.rowHeight()
    if (row <= 0) return true
    const notches = Math.trunc(this.carry / row)
    if (notches !== 0) {
      this.carry -= notches * row
      // One row of finger travel = one scrolled line: xterm multiplies a pixel
      // delta by scrollSensitivity before dividing it by the row height, so the
      // delta has to be pre-divided by the same factor.
      const delta = row / Math.max(1, this.term.sensitivity())
      const count = Math.min(Math.abs(notches), MAX_NOTCHES_PER_FRAME)
      for (let i = 0; i < count; i++) {
        this.term.wheel(notches > 0 ? delta : -delta, clientX, clientY)
      }
    }
    return true
  }

  /** @returns true when this gesture scrolled — cancel the touchend too, so the
   *  browser fires no click at the release point. */
  end(): boolean {
    const scrolled = this.engaged
    this.engaged = false
    this.takeover = false
    this.carry = 0
    return scrolled
  }
}

/**
 * Wire {@link TouchScrollEngine} to a mounted terminal. Listens on the CONTAINER
 * in the capture phase: the container is an ancestor of xterm's own element, so
 * a scroll frame is claimed (and stopped) before xterm's handlers can turn it
 * into an application mouse report.
 *
 * @returns a disposer.
 */
export function wireTouchScroll(
  container: HTMLElement,
  term: {
    modes: { mouseTrackingMode: string }
    buffer: { active: { type: string } }
    rows: number
    options: { scrollSensitivity?: number }
  },
): () => void {
  const screen = (): HTMLElement | null =>
    container.querySelector('.xterm-screen') as HTMLElement | null

  const engine = new TouchScrollEngine({
    appOwnsMouse: () => term.modes.mouseTrackingMode !== 'none',
    altBuffer: () => term.buffer.active.type === 'alternate',
    rowHeight: () => {
      const h = screen()?.clientHeight ?? container.clientHeight
      return term.rows > 0 && h > 0 ? h / term.rows : 0
    },
    sensitivity: () => term.options.scrollSensitivity ?? 1,
    wheel: (deltaY, clientX, clientY) => {
      const target = screen() ?? container
      target.dispatchEvent(
        new WheelEvent('wheel', {
          deltaY,
          deltaMode: 0, // DOM_DELTA_PIXEL — xterm accumulates fractional rows
          clientX,
          clientY,
          bubbles: true,
          cancelable: true,
        }),
      )
    },
  })

  const onStart = (e: TouchEvent): void => {
    // Multi-touch is the browser's (pinch zoom) — never ours.
    if (e.touches.length !== 1) {
      engine.end()
      return
    }
    const t = e.touches[0]
    if (t) engine.down(t.clientX, t.clientY)
  }
  const onMove = (e: TouchEvent): void => {
    if (e.touches.length !== 1) return
    const t = e.touches[0]
    if (!t || !engine.move(t.clientX, t.clientY)) return
    e.preventDefault()
    e.stopPropagation()
  }
  const onEnd = (e: TouchEvent): void => {
    if (!engine.end()) return
    e.preventDefault()
    e.stopPropagation()
  }

  const capture = { capture: true } as const
  container.addEventListener('touchstart', onStart, { capture: true, passive: true })
  container.addEventListener('touchmove', onMove, { capture: true, passive: false })
  container.addEventListener('touchend', onEnd, { capture: true, passive: false })
  container.addEventListener('touchcancel', onEnd, { capture: true, passive: false })

  return () => {
    container.removeEventListener('touchstart', onStart, capture)
    container.removeEventListener('touchmove', onMove, capture)
    container.removeEventListener('touchend', onEnd, capture)
    container.removeEventListener('touchcancel', onEnd, capture)
  }
}
