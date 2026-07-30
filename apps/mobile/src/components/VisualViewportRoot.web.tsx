import type { CSSProperties, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { color } from '../theme/theme'

function currentViewportHeight(): number | string {
  if (typeof window === 'undefined') return '100dvh'
  return Math.round(window.visualViewport?.height ?? window.innerHeight)
}

/**
 * Pin Expo web to the visual viewport, matching the retired mobile-web shell.
 * iOS leaves the layout viewport at full height when its IME opens; sizing the
 * app to visualViewport.height keeps bottom accessories immediately above the
 * IME and lets their flex content (including xterm) refit to the visible area.
 */
export function VisualViewportRoot({ children }: { children: ReactNode }) {
  const [height, setHeight] = useState<number | string>(currentViewportHeight)

  useEffect(() => {
    const viewport = window.visualViewport
    const pinDocument = () => {
      if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0)
    }
    const update = () => {
      setHeight(Math.round(viewport?.height ?? window.innerHeight))
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
