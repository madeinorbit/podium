// @vitest-environment happy-dom
//
// Appearance plumbing: construction options land in xterm's options, and
// setAppearance() applies/resets them on the LIVE terminal (the no-remount
// contract the settings UI depends on). Undefined fields mean "the default",
// so a partial setAppearance is a full reset-to-exactly-this, not a merge.
import { beforeAll, describe, expect, it } from 'vitest'
import {
  DEFAULT_FONT_SIZE,
  DEFAULT_LINE_HEIGHT,
  DEFAULT_THEME,
  TerminalView,
} from './terminal-view'

beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    ;(globalThis as Record<string, unknown>).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  }
})

// Reach into the private xterm instance to observe the applied options.
function xtermOptions(view: TerminalView): Record<string, unknown> {
  return (view as unknown as { term: { options: Record<string, unknown> } }).term.options
}

describe('TerminalView appearance', () => {
  it('applies construction-time appearance options', () => {
    const view = new TerminalView({
      fontSize: 16,
      fontFamily: 'Iosevka, monospace',
      lineHeight: 1.4,
      theme: { ...DEFAULT_THEME, background: '#0a1a3a' },
    })
    const o = xtermOptions(view)
    expect(o.fontSize).toBe(16)
    expect(o.fontFamily).toBe('Iosevka, monospace')
    expect(o.lineHeight).toBe(1.4)
    expect((o.theme as { background?: string }).background).toBe('#0a1a3a')
    view.dispose()
  })

  it('defaults to the pinned font size / line height / theme', () => {
    const view = new TerminalView()
    const o = xtermOptions(view)
    expect(o.fontSize).toBe(DEFAULT_FONT_SIZE)
    expect(o.lineHeight).toBe(DEFAULT_LINE_HEIGHT)
    expect((o.theme as { background?: string }).background).toBe(DEFAULT_THEME.background)
    view.dispose()
  })

  it('setAppearance applies to the live terminal and resets omitted fields', () => {
    const view = new TerminalView({ fontSize: 16, lineHeight: 1.4 })
    view.setAppearance({ theme: { ...DEFAULT_THEME, background: '#003' } })
    const o = xtermOptions(view)
    // omitted → back to defaults (set-to-exactly-this, not a merge)
    expect(o.fontSize).toBe(DEFAULT_FONT_SIZE)
    expect(o.lineHeight).toBe(DEFAULT_LINE_HEIGHT)
    expect((o.theme as { background?: string }).background).toBe('#003')
    view.dispose()
  })

  it('setAppearance after dispose is a no-op (never throws)', () => {
    const view = new TerminalView()
    view.dispose()
    expect(() => view.setAppearance({ fontSize: 20 })).not.toThrow()
  })
})
