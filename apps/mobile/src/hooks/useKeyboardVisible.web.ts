import { useEffect, useState } from 'react'

/**
 * Below this, a shrink is not a keyboard [POD-392]. Mirrors the threshold in
 * ../components/VisualViewportRoot.web — WebKit's standalone leak docks 60-70px
 * off the visual viewport and must not read as an open IME.
 */
const KEYBOARD_MIN = 140

/**
 * Whether the software keyboard is up — see ./useKeyboardVisible for why the
 * composer needs to know.
 *
 * iOS leaves the LAYOUT viewport at full height when its IME opens and shrinks
 * only the VISUAL one, so the difference between the two is the keyboard. That
 * is the same signal VisualViewportRoot uses to size the app; this hook reads
 * it rather than the app's own height, which by then has already been pinned.
 */
export function useKeyboardVisible(): boolean {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const viewport = typeof window === 'undefined' ? null : window.visualViewport
    if (!viewport) return
    const read = () => setVisible(window.innerHeight - viewport.height > KEYBOARD_MIN)
    read()
    viewport.addEventListener('resize', read)
    return () => viewport.removeEventListener('resize', read)
  }, [])

  return visible
}
