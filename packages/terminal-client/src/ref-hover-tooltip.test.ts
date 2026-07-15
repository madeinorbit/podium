// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { isMacPlatform, RefHoverTooltip, refTooltipText } from './ref-hover-tooltip'

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

describe('refTooltipText', () => {
  it('names the Cmd modifier on mac', () => {
    expect(refTooltipText(true)).toBe('Click to preview · ⌘-click to open')
  })

  it('names the Ctrl modifier elsewhere', () => {
    expect(refTooltipText(false)).toBe('Click to preview · Ctrl-click to open')
  })
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

  it('show() appends a tooltip with the platform text; hide() removes it', () => {
    setPlatform('Linux x86_64')
    const tip = new RefHoverTooltip()
    tip.show(hoverEvent())
    const el = document.body.lastElementChild as HTMLElement
    expect(el).toBeTruthy()
    expect(el.textContent).toBe('Click to preview · Ctrl-click to open')
    expect(el.style.pointerEvents).toBe('none')
    tip.hide()
    expect(document.body.contains(el)).toBe(false)
  })

  it('shows the ⌘ wording on mac', () => {
    setPlatform('MacIntel')
    const tip = new RefHoverTooltip()
    tip.show(hoverEvent())
    expect(document.body.lastElementChild?.textContent).toBe('Click to preview · ⌘-click to open')
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
