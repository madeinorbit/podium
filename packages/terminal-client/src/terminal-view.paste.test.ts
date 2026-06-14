// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
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

// Swap navigator.clipboard for a test, restoring it after.
const ORIGINAL_CLIPBOARD = Object.getOwnPropertyDescriptor(globalThis.navigator, 'clipboard')
const setClipboard = (value: unknown): void => {
  Object.defineProperty(globalThis.navigator, 'clipboard', { value, configurable: true })
}
const captureField = (): Element | null =>
  document.querySelector('[role="dialog"][aria-label="Paste into the terminal"]')
afterEach(() => {
  if (ORIGINAL_CLIPBOARD)
    Object.defineProperty(globalThis.navigator, 'clipboard', ORIGINAL_CLIPBOARD)
  captureField()?.remove()
})

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

describe('TerminalView.requestPaste', () => {
  it('with the Clipboard API, pastes directly and does NOT open the capture field', async () => {
    setClipboard({ readText: async () => 'from clipboard' })
    const view = mounted()
    const seen: string[] = []
    view.onData((d) => seen.push(d))
    await view.requestPaste()
    view.dispose()
    expect(seen.join('')).toContain('from clipboard')
    // The whole point of the fix: no permission-prompt-THEN-field double step.
    expect(captureField()).toBeNull()
  })

  it('an empty/declined clipboard read pastes nothing and shows no field', async () => {
    setClipboard({ readText: async () => '' })
    const view = mounted()
    const seen: string[] = []
    view.onData((d) => seen.push(d))
    await view.requestPaste()
    view.dispose()
    expect(seen.join('')).toBe('')
    expect(captureField()).toBeNull()
  })

  it('falls back to the capture field only when there is no async clipboard read', async () => {
    setClipboard(undefined)
    const view = mounted()
    await view.requestPaste()
    expect(captureField()).not.toBeNull()
    view.dispose()
  })
})
