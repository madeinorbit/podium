import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { handleCodeCopyClick } from './code-copy'

describe('handleCodeCopyClick', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    })
  })

  it('copies the sibling code text when a copy button is clicked', () => {
    document.body.innerHTML = `<pre><code>const x = 1</code><button class="code-copy"></button></pre>`
    const btn = document.querySelector('.code-copy') as HTMLElement
    let prevented = false
    const handled = handleCodeCopyClick({
      target: btn,
      preventDefault: () => {
        prevented = true
      },
    })
    expect(handled).toBe(true)
    expect(prevented).toBe(true)
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('const x = 1')
  })

  it('still resolves the button when the click lands on a child (e.g. the icon)', () => {
    document.body.innerHTML = `<pre><code>npm test</code><button class="code-copy"><span></span></button></pre>`
    const span = document.querySelector('.code-copy span') as HTMLElement
    const handled = handleCodeCopyClick({ target: span, preventDefault: () => {} })
    expect(handled).toBe(true)
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('npm test')
  })

  it('returns false for a click that is not on a copy button (lets file-link logic run)', () => {
    document.body.innerHTML = `<div><a class="file-link">x</a></div>`
    const a = document.querySelector('.file-link') as HTMLElement
    expect(handleCodeCopyClick({ target: a, preventDefault: () => {} })).toBe(false)
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled()
  })
})
