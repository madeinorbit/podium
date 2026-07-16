// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { isMacPlatform, RefHoverTooltip } from './ref-hover-tooltip'

const ORIGINAL_PLATFORM = Object.getOwnPropertyDescriptor(globalThis.navigator, 'platform')
const setPlatform = (value: string): void => {
  Object.defineProperty(globalThis.navigator, 'platform', { value, configurable: true })
}

afterEach(() => {
  document.body.innerHTML = ''
  if (ORIGINAL_PLATFORM) {
    Object.defineProperty(globalThis.navigator, 'platform', ORIGINAL_PLATFORM)
  }
})

describe('isMacPlatform', () => {
  it('detects mac and iOS', () => {
    expect(isMacPlatform({ platform: 'MacIntel' })).toBe(true)
    expect(isMacPlatform({ platform: 'iPhone' })).toBe(true)
    expect(isMacPlatform({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' })).toBe(
      true,
    )
  })

  it('is false for windows/linux and when nothing is known', () => {
    expect(isMacPlatform({ platform: 'Win32' })).toBe(false)
    expect(isMacPlatform({ platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; Linux)' })).toBe(
      false,
    )
    expect(isMacPlatform(undefined)).toBe(false)
  })
})

describe('RefHoverTooltip', () => {
  const hoverEvent = (): MouseEvent =>
    new MouseEvent('mousemove', { clientX: 40, clientY: 60, bubbles: true })

  it('show() appends a non-interactive tooltip naming the platform modifier; hide() removes it', () => {
    setPlatform('Linux x86_64')
    const tip = new RefHoverTooltip()
    tip.show(hoverEvent())
    const el = document.body.lastElementChild as HTMLElement
    expect(el).toBeTruthy()
    expect(el.textContent).toContain('Ctrl') // platform-derived modifier, not mac
    expect(el.style.pointerEvents).toBe('none') // must not swallow the hover it decorates
    tip.hide()
    expect(document.body.contains(el)).toBe(false)
  })

  it('names the mac modifier when the platform is mac', () => {
    setPlatform('MacIntel')
    const tip = new RefHoverTooltip()
    tip.show(hoverEvent())
    expect(document.body.lastElementChild?.textContent).toContain('⌘')
    tip.hide()
  })

  it('reuses one element across repeated hovers', () => {
    setPlatform('Linux x86_64')
    const tip = new RefHoverTooltip()
    tip.show(hoverEvent())
    const first = document.body.lastElementChild
    tip.hide()
    tip.show(hoverEvent())
    expect(document.body.lastElementChild).toBe(first)
    tip.hide()
  })
})
