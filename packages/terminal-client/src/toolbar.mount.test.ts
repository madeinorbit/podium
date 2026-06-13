// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import type { SessionConnection } from './connection'
import { mountKeyToolbar } from './toolbar'

// mountKeyToolbar only touches conn when a byte-sending key is tapped; the Paste
// button routes to opts.onPaste instead, so a minimal stub is enough.
const stubConn = (): SessionConnection => ({ sendInput: vi.fn() }) as unknown as SessionConnection
const pasteBtn = (el: HTMLElement): HTMLButtonElement | undefined =>
  [...el.querySelectorAll('button')].find((b): b is HTMLButtonElement => b.dataset.key === 'Paste')

describe('mountKeyToolbar paste key', () => {
  it('renders a Paste key only when an onPaste handler is provided', () => {
    const withHandler = document.createElement('div')
    mountKeyToolbar(withHandler, stubConn(), { onPaste: () => {} })
    expect(pasteBtn(withHandler)?.getAttribute('aria-label')).toMatch(/paste/i)

    // No handler (e.g. a context that can't paste) → no dead button.
    const without = document.createElement('div')
    mountKeyToolbar(without, stubConn())
    expect(pasteBtn(without)).toBeUndefined()
  })

  it('tapping Paste invokes onPaste (the clipboard-read + paste path)', () => {
    const el = document.createElement('div')
    const onPaste = vi.fn()
    mountKeyToolbar(el, stubConn(), { onPaste })
    pasteBtn(el)?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onPaste).toHaveBeenCalledTimes(1)
  })
})
