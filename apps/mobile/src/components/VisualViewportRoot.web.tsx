import type { CSSProperties, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { color } from '../theme/theme'

/**
 * Below this, a shrink is not a keyboard [POD-392]. Software keyboards take
 * 250px and up; WebKit's standalone leak (see below) takes 60-70px.
 */
const KEYBOARD_MIN = 140

function currentViewportHeight(): number | string {
  if (typeof window === 'undefined') return '100dvh'
  return measure()
}

function measure(): number {
  return Math.round(window.visualViewport?.height ?? window.innerHeight)
}

/**
 * The screen itself — the one height WebKit's leak does not touch, because it
 * is not a viewport [POD-420]. An installed app is full-screen by definition, so
 * in that mode this is what the root should fill. Returns null where it cannot
 * be trusted or read.
 */
function screenHeight(): number | null {
  const height = Math.round(window.screen?.height ?? 0)
  return height > 0 ? height : null
}

/** True in an Add-to-Home-Screen launch, false in a Safari tab. */
function isInstalled(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  )
}

/**
 * Pin Expo web to the visual viewport, matching the retired mobile-web shell.
 * iOS leaves the layout viewport at full height when its IME opens; sizing the
 * app to visualViewport.height keeps bottom accessories immediately above the
 * IME and lets their flex content (including xterm) refit to the visible area.
 *
 * In an INSTALLED app that measurement cannot be trusted on its own [POD-392].
 * The first time iOS raises the keyboard, WebKit docks ~60-70px off innerHeight,
 * visualViewport.height and 100dvh for the rest of the launch, and fires no
 * resize when the keyboard leaves — so the app went on rendering into a
 * viewport a Safari-toolbar shorter than the screen, banding the bottom with
 * the body's background. The login field sits on the launch path, so the first
 * run of a freshly installed app walks straight into it. We therefore hold the
 * tallest height this launch has seen and only follow the measurement down when
 * the drop is big enough to actually be a keyboard. A Safari tab is left alone:
 * there the browser's own chrome legitimately resizes the visual viewport.
 */
export function VisualViewportRoot({ children }: { children: ReactNode }) {
  const [height, setHeight] = useState<number | string>(currentViewportHeight)

  useEffect(() => {
    const viewport = window.visualViewport
    const installed = isInstalled()
    let tallest = measure()
    const pinDocument = () => {
      if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0)
    }
    const update = () => {
      const measured = measure()
      // Holding the tallest measurement only rescues a launch that saw a full
      // one FIRST [POD-420]. It does not, and the app came back from the
      // background already docked — so every measurement this launch was short,
      // `tallest` had nothing better to hold, and the app ran a toolbar's worth
      // above the bottom of the screen for good. Once the tab bar stopped
      // owning that strip, the band showed: a dead margin the list would not
      // scroll into. The screen is the arbiter, and only within leak range, so
      // a genuinely smaller viewport is still believed.
      const screen = installed ? screenHeight() : null
      if (screen !== null && screen - measured < KEYBOARD_MIN) tallest = Math.max(tallest, screen)
      tallest = Math.max(tallest, measured)
      const keyboardOpen = tallest - measured >= KEYBOARD_MIN
      setHeight(installed && !keyboardOpen ? tallest : measured)
      pinDocument()
    }

    update()
    viewport?.addEventListener('resize', update)
    viewport?.addEventListener('scroll', update)
    window.addEventListener('resize', update)
    window.addEventListener('scroll', pinDocument)
    return () => {
      viewport?.removeEventListener('resize', update)
      viewport?.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', pinDocument)
    }
  }, [])

  const style = {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    height,
    minHeight: height,
    maxHeight: height,
    overflow: 'hidden',
    backgroundColor: color.bg,
  } satisfies CSSProperties

  return (
    <div data-mobile-visual-viewport-root style={style}>
      {children}
    </div>
  )
}
