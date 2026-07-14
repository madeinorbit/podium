// @vitest-environment happy-dom
//
// Mode 2031 (contour's colour-scheme-update notifications, the protocol Claude
// Code speaks in `theme: auto`): a TUI sends CSI ? 2031 h to subscribe to
// colour-scheme changes; the terminal answers a change with the DSR
// CSI ? 997 ; 1 n (dark) / CSI ? 997 ; 2 n (light), whereupon the app
// re-queries OSC 11 and repaints. TerminalView TRACKS the subscription;
// session-mount pushes the report on a real background change — as PTY input,
// so it obeys the controller-only input rule.
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { SessionCallbacks, SocketHub } from './connection'
import { mountSession } from './session-mount'
import { colorSchemeReport, DEFAULT_THEME, isLightBackground, TerminalView } from './terminal-view'

beforeAll(() => {
  // happy-dom's WebGL is real enough to load but crashes on theme changes —
  // keep these tests on the DOM renderer via the documented escape hatch.
  localStorage.setItem('podium:gpu', 'off')
  if (!('ResizeObserver' in globalThis)) {
    ;(globalThis as Record<string, unknown>).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  }
})

describe('isLightBackground', () => {
  it('classifies the Podium surfaces and tints as dark', () => {
    expect(isLightBackground('#0e0e12')).toBe(false) // terminal base
    expect(isLightBackground('#1d1a26')).toBe(false) // violet-tinted pane
    expect(isLightBackground('#16161c')).toBe(false)
  })

  it('classifies light backgrounds as light, including #rgb shorthand', () => {
    expect(isLightBackground('#ffffff')).toBe(true)
    expect(isLightBackground('#f7f7f9')).toBe(true)
    expect(isLightBackground('#fff')).toBe(true)
  })

  it('treats unknown or unparseable colours as dark', () => {
    expect(isLightBackground(undefined)).toBe(false)
    expect(isLightBackground('rgb(255, 255, 255)')).toBe(false)
    expect(isLightBackground('tomato')).toBe(false)
  })
})

describe('colorSchemeReport', () => {
  it('reports 1 for dark and 2 for light (contour DSR semantics)', () => {
    expect(colorSchemeReport('#0e0e12')).toBe('\x1b[?997;1n')
    expect(colorSchemeReport('#ffffff')).toBe('\x1b[?997;2n')
  })
})

function mountView(): TerminalView {
  const view = new TerminalView({ cols: 40, rows: 10 })
  const el = document.createElement('div')
  document.body.appendChild(el)
  view.mount(el)
  return view
}

describe('TerminalView mode-2031 tracking', () => {
  it('tracks DECSET/DECRST ?2031 from the output stream', async () => {
    const view = mountView()
    expect(view.colorSchemeNotifyEnabled()).toBe(false)

    view.write('\x1b[?2031h')
    await vi.waitFor(() => expect(view.colorSchemeNotifyEnabled()).toBe(true))

    view.write('\x1b[?2031l')
    await vi.waitFor(() => expect(view.colorSchemeNotifyEnabled()).toBe(false))
    view.dispose()
  })

  it('ignores other private modes and leaves them for xterm to process', async () => {
    const view = mountView()
    // Alt-screen + bracketed paste — a chord Claude Code actually sends.
    view.write('\x1b[?2004h\x1b[?1049h')
    view.write('marker')
    await vi.waitFor(() => {
      const term = (view as unknown as { term: { buffer: { active: { type: string } } } }).term
      expect(term.buffer.active.type).toBe('alternate') // 1049 still processed
    })
    expect(view.colorSchemeNotifyEnabled()).toBe(false)
    view.dispose()
  })
})

/** Fake hub whose connection role and input sink the test controls. */
function fakeHub(role: () => 'controller' | 'spectator'): {
  hub: SocketHub
  sendInput: ReturnType<typeof vi.fn>
} {
  const sendInput = vi.fn()
  const connection = {
    sendResize: () => {},
    sendInput,
    requestControl: () => {},
    redraw: () => {},
    state: () => ({ role: role(), cols: 80, rows: 24, epoch: 0, connected: true }),
  }
  const hub = {
    attach: (_id: string, _cb: SessionCallbacks = {}) => connection,
    detach: () => {},
  } as unknown as SocketHub
  return { hub, sendInput }
}

const dark = { ...DEFAULT_THEME, background: '#0e0e12' }
const tinted = { ...DEFAULT_THEME, background: '#1d1a26' }
const light = { ...DEFAULT_THEME, background: '#f7f7f9' }

describe('session-mount colour-scheme report', () => {
  async function subscribe(mounted: { view: TerminalView }): Promise<void> {
    mounted.view.write('\x1b[?2031h')
    await vi.waitFor(() => expect(mounted.view.colorSchemeNotifyEnabled()).toBe(true))
  }

  it('reports a background change to a subscribed app (controller only)', async () => {
    const { hub, sendInput } = fakeHub(() => 'controller')
    const mounted = mountSession(document.createElement('div'), {
      hub,
      sessionId: 's1',
      appearance: { theme: dark },
    })
    await subscribe(mounted)

    mounted.setAppearance({ theme: tinted }) // dark → dark tint: still reported
    expect(sendInput).toHaveBeenCalledWith('\x1b[?997;1n')
    mounted.setAppearance({ theme: light })
    expect(sendInput).toHaveBeenLastCalledWith('\x1b[?997;2n')
    expect(sendInput).toHaveBeenCalledTimes(2)
    mounted.dispose()
  })

  it('stays silent when the background did not change or nothing subscribed', async () => {
    const { hub, sendInput } = fakeHub(() => 'controller')
    const mounted = mountSession(document.createElement('div'), {
      hub,
      sessionId: 's1',
      appearance: { theme: dark },
    })
    mounted.setAppearance({ theme: tinted }) // no subscription yet
    expect(sendInput).not.toHaveBeenCalled()

    await subscribe(mounted)
    mounted.setAppearance({ theme: tinted }) // same background
    expect(sendInput).not.toHaveBeenCalled()

    mounted.view.write('\x1b[?2031l')
    await vi.waitFor(() => expect(mounted.view.colorSchemeNotifyEnabled()).toBe(false))
    mounted.setAppearance({ theme: light }) // unsubscribed again
    expect(sendInput).not.toHaveBeenCalled()
    mounted.dispose()
  })

  it('a spectator never speaks for the session', async () => {
    const { hub, sendInput } = fakeHub(() => 'spectator')
    const mounted = mountSession(document.createElement('div'), {
      hub,
      sessionId: 's1',
      appearance: { theme: dark },
    })
    await subscribe(mounted)
    mounted.setAppearance({ theme: light })
    expect(sendInput).not.toHaveBeenCalled()
    mounted.dispose()
  })
})
