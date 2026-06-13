// @vitest-environment happy-dom
import { beforeAll, describe, expect, it } from 'vitest'
import { TerminalView } from './terminal-view'

beforeAll(() => {
  // xterm's renderer touches ResizeObserver, which happy-dom lacks.
  if (!('ResizeObserver' in globalThis)) {
    ;(globalThis as Record<string, unknown>).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  }
})

const mounted = (): TerminalView => {
  const view = new TerminalView()
  view.mount(document.createElement('div'))
  return view
}

describe('TerminalView.pasteText', () => {
  it('emits pasted text through onData, so it reaches the PTY like typed input', () => {
    const view = mounted()
    const seen: string[] = []
    view.onData((d) => seen.push(d))
    view.pasteText('hello world')
    view.dispose()
    // Default (no bracketed-paste mode) sends the text verbatim.
    expect(seen.join('')).toContain('hello world')
  })

  it('ignores an empty paste (no stray PTY input)', () => {
    const view = mounted()
    const seen: string[] = []
    view.onData((d) => seen.push(d))
    view.pasteText('')
    view.dispose()
    expect(seen.join('')).toBe('')
  })
})
