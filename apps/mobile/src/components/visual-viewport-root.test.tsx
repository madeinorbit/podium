/**
 * THE INSTALLED APP DOES NOT SHRINK FOR GOOD (POD-392).
 *
 * WebKit permanently docks ~60-70px off `visualViewport.height` the first time
 * an Add-to-Home-Screen app raises the keyboard, and never fires a resize
 * putting it back. Sizing the root to whatever the last measurement said meant
 * the app rendered a Safari-toolbar short of the screen for the rest of the
 * launch, with the body's background banding the bottom — which is what the
 * screenshot on this issue shows. The keyboard itself still has to move the
 * root, so the two cases are told apart by how far the drop goes.
 */
import { cleanup, render } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { VisualViewportRoot } from './VisualViewportRoot.web'

const SCREEN = 900
/** WebKit's leak: too small to be a keyboard. */
const LEAKED = 832
/** A keyboard: it takes half the screen. */
const KEYBOARD = 460

class FakeViewport extends EventTarget {
  height = SCREEN
  resizeTo(height: number) {
    this.height = height
    this.dispatchEvent(new Event('resize'))
  }
}

let viewport: FakeViewport

function install(standalone: boolean) {
  viewport = new FakeViewport()
  Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true })
  Object.defineProperty(window, 'matchMedia', {
    value: (query: string) => ({
      matches: standalone && query.includes('standalone'),
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }),
    configurable: true,
  })
}

/** The pixel height the root is pinned to. */
function rootHeight(container: HTMLElement): string {
  const root = container.querySelector('[data-mobile-visual-viewport-root]')
  return (root as HTMLElement).style.height
}

beforeEach(() => {
  window.history.replaceState({}, '', '/')
})

afterEach(() => {
  cleanup()
})

describe('installed app', () => {
  it('follows the keyboard down and ignores the leak it leaves behind', () => {
    install(true)
    const { container } = render(<VisualViewportRoot>app</VisualViewportRoot>)
    expect(rootHeight(container)).toBe(`${SCREEN}px`)

    act(() => viewport.resizeTo(KEYBOARD))
    expect(rootHeight(container)).toBe(`${KEYBOARD}px`)

    // The keyboard goes; WebKit hands back less than it took and stays there.
    act(() => viewport.resizeTo(LEAKED))
    expect(rootHeight(container)).toBe(`${SCREEN}px`)
  })
})

describe('safari tab', () => {
  it('follows the viewport, because there the chrome really does resize it', () => {
    install(false)
    const { container } = render(<VisualViewportRoot>app</VisualViewportRoot>)

    act(() => viewport.resizeTo(LEAKED))
    expect(rootHeight(container)).toBe(`${LEAKED}px`)
  })
})
