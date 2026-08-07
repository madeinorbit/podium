/**
 * Wheel fallback for TUIs that neither enable mouse tracking nor leave local
 * scrollback (Grok's fullscreen native view, POD-530).
 *
 * xterm.js wheel handling, in order:
 *   1. application owns the mouse → SGR/X10 wheel report (Claude Code works);
 *   2. alternate screen, no mouse  → cursor-up/down keys (pagers, vim);
 *   3. normal buffer with scrollback → move the local viewport.
 *
 * Grok's fullscreen TUI often lands in a dead zone of (3) with no overflow to
 * scroll (full-screen redraw in the normal buffer, or alt screen without mouse
 * tracking and a zeroed row-height so (2) emits nothing). The wheel then
 * produces zero PTY input and the transcript never moves.
 *
 * When the app does not own the mouse AND the local viewport cannot absorb the
 * wheel, we inject PageUp/PageDown (big deltas) or cursor-up/down (small ones)
 * through xterm's data path so the TUI can scroll itself.
 */

/** Pixel delta at or above this becomes a PageUp/PageDown rather than N arrows. */
const PAGE_DELTA_PX = 80

/** Cap arrows per event so a trackpad fling can't flood the PTY. */
const MAX_ARROWS_PER_EVENT = 6

export interface WheelFallbackTerminal {
  /** True while the application has mouse tracking on — xterm already reports
   *  wheel as mouse events; leave those alone. */
  appOwnsMouse(): boolean
  /**
   * True when xterm's own local viewport can still move in `deltaY`'s direction
   * (normal-buffer scrollback with room above/below). When true, leave the
   * event to xterm.
   */
  canLocalScroll(deltaY: number): boolean
  /** Height of one text row in CSS pixels, or 0 when unmeasurable. */
  rowHeight(): number
  /** Write bytes to the PTY (cursor keys / PageUp / PageDown). */
  sendKeys(data: string): void
}

/**
 * Decide what, if anything, to send for one wheel event. Pure: the caller
 * cancels the browser event when this returns a non-empty string.
 */
export function wheelFallbackKeys(
  term: WheelFallbackTerminal,
  deltaY: number,
): string | null {
  if (deltaY === 0) return null
  if (term.appOwnsMouse()) return null
  if (term.canLocalScroll(deltaY)) return null

  // Big notch → one page; small → one arrow per row of travel.
  if (Math.abs(deltaY) >= PAGE_DELTA_PX) {
    // CSI 5~ = PageUp, CSI 6~ = PageDown. Finger/wheel UP (deltaY < 0) shows
    // older content → PageUp.
    return deltaY < 0 ? '\x1b[5~' : '\x1b[6~'
  }

  const row = term.rowHeight()
  const lines =
    row > 0
      ? Math.min(MAX_ARROWS_PER_EVENT, Math.max(1, Math.round(Math.abs(deltaY) / row)))
      : 1
  const key = deltaY < 0 ? '\x1b[A' : '\x1b[B'
  return key.repeat(lines)
}

/**
 * Wire {@link wheelFallbackKeys} onto a mounted xterm via
 * `attachCustomWheelEventHandler`. Runs before xterm's own wheel path; returns
 * false (and cancels) only when we emit keys.
 *
 * @returns a disposer that clears the custom handler.
 */
export function wireWheelFallback(
  term: {
    attachCustomWheelEventHandler(handler: (event: WheelEvent) => boolean): void
    modes: { mouseTrackingMode: string }
    buffer: { active: { type: string; viewportY: number; baseY: number } }
    rows: number
    element: HTMLElement | undefined
  },
  sendKeys: (data: string) => void,
): () => void {
  const screen = (): HTMLElement | null =>
    (term.element?.querySelector('.xterm-screen') as HTMLElement | null) ?? null
  const viewport = (): HTMLElement | null =>
    (term.element?.querySelector('.xterm-viewport') as HTMLElement | null) ?? null

  const api: WheelFallbackTerminal = {
    appOwnsMouse: () => term.modes.mouseTrackingMode !== 'none',
    canLocalScroll: (deltaY) => {
      // Alternate screen never has local scrollback xterm can move.
      if (term.buffer.active.type === 'alternate') return false
      const vp = viewport()
      if (!vp) {
        // Fall back to buffer geometry when the DOM node is missing.
        const { viewportY, baseY } = term.buffer.active
        if (deltaY < 0) return viewportY > 0 // room above
        return viewportY < baseY // room below
      }
      // Room in the scroll direction?
      if (deltaY < 0) return vp.scrollTop > 0
      return vp.scrollTop + vp.clientHeight < vp.scrollHeight - 1
    },
    rowHeight: () => {
      const h = screen()?.clientHeight ?? term.element?.clientHeight ?? 0
      return term.rows > 0 && h > 0 ? h / term.rows : 0
    },
    sendKeys,
  }

  term.attachCustomWheelEventHandler((e) => {
    // Let the browser/page zoom handle ctrl/meta+wheel.
    if (e.ctrlKey || e.metaKey) return true
    const keys = wheelFallbackKeys(api, e.deltaY)
    if (!keys) return true
    api.sendKeys(keys)
    e.preventDefault()
    return false
  })

  // xterm has no detach API for the custom handler — replace with a pass-through
  // on dispose so a remounted view doesn't double-handle via a stale closure.
  return () => {
    term.attachCustomWheelEventHandler(() => true)
  }
}
