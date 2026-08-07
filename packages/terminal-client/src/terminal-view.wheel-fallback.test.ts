// @vitest-environment happy-dom
//
// Integration: TerminalView wires the POD-530/POD-552 wheel fallback so a Grok-like
// terminal (no mouse tracking, no local scrollback overflow) still emits
// PageUp/PageDown on wheel (never arrows — those are prompt history).
import { beforeAll, describe, expect, it } from 'vitest'
import { TerminalView } from './terminal-view'

beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    ;(globalThis as Record<string, unknown>).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  }
})

function mountSized(): { view: TerminalView; host: HTMLElement; received: string[] } {
  const host = document.createElement('div')
  Object.defineProperty(host, 'clientWidth', { get: () => 800, configurable: true })
  Object.defineProperty(host, 'clientHeight', { get: () => 480, configurable: true })
  // xterm attaches under host; give screen/viewport measurable geometry via
  // query after mount.
  const view = new TerminalView({ renderer: 'dom' })
  view.mount(host)
  const received: string[] = []
  view.onData((d) => received.push(d))

  // happy-dom may not lay out xterm children; stub screen/viewport so the
  // fallback's rowHeight/canLocalScroll path is deterministic.
  const screen = host.querySelector('.xterm-screen') as HTMLElement | null
  const viewport = host.querySelector('.xterm-viewport') as HTMLElement | null
  if (screen) {
    Object.defineProperty(screen, 'clientHeight', { get: () => 480, configurable: true })
    Object.defineProperty(screen, 'clientWidth', { get: () => 800, configurable: true })
  }
  if (viewport) {
    Object.defineProperty(viewport, 'scrollTop', { get: () => 0, configurable: true })
    Object.defineProperty(viewport, 'clientHeight', { get: () => 480, configurable: true })
    Object.defineProperty(viewport, 'scrollHeight', { get: () => 480, configurable: true })
  }
  return { view, host, received }
}

describe('TerminalView wheel fallback (POD-530)', () => {
  it('emits PageUp on a large upward wheel when the app does not own the mouse and the viewport cannot scroll', () => {
    const { view, host, received } = mountSized()
    const xterm = host.querySelector('.xterm') as HTMLElement
    expect(xterm).toBeTruthy()

    // Grok-like: no mouse tracking (default), no local overflow (stubbed above).
    xterm.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY: -240,
        deltaMode: 0,
        bubbles: true,
        cancelable: true,
      }),
    )

    expect(received.join('')).toBe('\x1b[5~')
    view.dispose()
  })

  it('does not inject keys when the application owns the mouse', async () => {
    const { view, host, received } = mountSized()
    const term = (
      view as unknown as {
        term: {
          write(s: string, cb?: () => void): void
          modes: { mouseTrackingMode: string }
        }
      }
    ).term
    // DECSET 1000 — basic mouse tracking. write is async (parser queue); wait
    // until modes reflect it before wheeling.
    await new Promise<void>((resolve) => term.write('\x1b[?1000h', resolve))
    expect(term.modes.mouseTrackingMode).not.toBe('none')
    received.length = 0

    const xterm = host.querySelector('.xterm') as HTMLElement
    xterm.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY: -240,
        deltaMode: 0,
        bubbles: true,
        cancelable: true,
      }),
    )

    // Fallback must stay quiet; xterm may still emit mouse reports via onData
    // when tracking is on — those are application reports, not our PageUp.
    expect(received.join('')).not.toContain('\x1b[5~')
    expect(received.join('')).not.toContain('\x1b[A')
    view.dispose()
  })
})
