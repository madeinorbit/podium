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

// Swap navigator.clipboard / matchMedia for a test, restoring them after.
const ORIGINAL_CLIPBOARD = Object.getOwnPropertyDescriptor(globalThis.navigator, 'clipboard')
const ORIGINAL_MATCH_MEDIA = Object.getOwnPropertyDescriptor(globalThis, 'matchMedia')
const setClipboard = (value: unknown): void => {
  Object.defineProperty(globalThis.navigator, 'clipboard', { value, configurable: true })
}
// Pointer type drives the paste path: coarse (touch) → capture field; fine → Clipboard API.
// The stub must be a full MediaQueryList — xterm's CoreBrowserService calls
// matchMedia(...).addListener() to track DPR, so the no-op listeners are required.
const setPointer = (kind: 'coarse' | 'fine'): void => {
  Object.defineProperty(globalThis, 'matchMedia', {
    value: (query: string) => ({
      matches: query.includes(kind),
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => false,
    }),
    configurable: true,
    writable: true,
  })
}
const captureField = (): Element | null =>
  document.querySelector('[role="dialog"][aria-label="Paste into the terminal"]')
afterEach(() => {
  if (ORIGINAL_CLIPBOARD)
    Object.defineProperty(globalThis.navigator, 'clipboard', ORIGINAL_CLIPBOARD)
  if (ORIGINAL_MATCH_MEDIA) Object.defineProperty(globalThis, 'matchMedia', ORIGINAL_MATCH_MEDIA)
  else delete (globalThis as Record<string, unknown>).matchMedia
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
  it('on desktop (fine pointer), pastes directly via the Clipboard API, no field', async () => {
    setPointer('fine')
    setClipboard({ readText: async () => 'from clipboard' })
    const view = mounted()
    const seen: string[] = []
    view.onData((d) => seen.push(d))
    await view.requestPaste()
    view.dispose()
    expect(seen.join('')).toContain('from clipboard')
    // No permission-prompt-THEN-field double step.
    expect(captureField()).toBeNull()
  })

  it('on desktop, an empty/declined read pastes nothing and shows no field', async () => {
    setPointer('fine')
    setClipboard({ readText: async () => '' })
    const view = mounted()
    const seen: string[] = []
    view.onData((d) => seen.push(d))
    await view.requestPaste()
    view.dispose()
    expect(seen.join('')).toBe('')
    expect(captureField()).toBeNull()
  })

  it('on touch (coarse pointer), uses the capture field, NOT the Clipboard API', async () => {
    setPointer('coarse')
    // readText would resolve, but iOS Safari's readText UX is the bug — the touch
    // path must skip it and use the paste-event field (no permission prompt).
    let readTextCalled = false
    setClipboard({
      readText: async () => {
        readTextCalled = true
        return 'should not be used'
      },
    })
    const view = mounted()
    const seen: string[] = []
    view.onData((d) => seen.push(d))
    await view.requestPaste()
    expect(captureField()).not.toBeNull()
    expect(readTextCalled).toBe(false)
    expect(seen.join('')).toBe('')
    view.dispose()
  })

  it('falls back to the capture field when there is no async clipboard read', async () => {
    setPointer('fine')
    setClipboard(undefined)
    const view = mounted()
    await view.requestPaste()
    expect(captureField()).not.toBeNull()
    view.dispose()
  })
})
