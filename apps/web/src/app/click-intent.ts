import { useCallback, useEffect, useMemo, useRef } from 'react'

/**
 * SINGLE CLICK AND DOUBLE CLICK ON ONE TARGET, resolved without a wait.
 *
 * The first click acts at once (POD-5444): the 260 ms hold this hook used to
 * impose is gone, so a session click paints without an idle window first. A
 * second click inside the window then runs the caller's upgrade — promoting a
 * preview tab to a kept one (deck rows, file tree) — on top of what the first
 * click already did. That upgrade must therefore be safe to run after the
 * single: same tab, kept rather than reopened, no extra navigation and no
 * undone state. Where the double action is a rename instead (workspace tabs,
 * sidebar rows), it rides the native `dblclick`, not this hook.
 *
 * One instance per row, so a fast click on one row followed by another row is
 * two singles rather than a double.
 *
 * Lives here rather than in the flight deck because the file tree opens files on
 * the same contract (POD-788): one click previews, two keep the tab. Two
 * spellings of "how long is a double click" is how the two surfaces drift.
 */
export const DOUBLE_CLICK_MS = 260

export interface ClickIntent {
  press: (single: () => void, double: () => void) => void
  /** Enter is the keyboard's double click; it also drops anything pending. */
  commit: (double: () => void) => void
}

export function useClickIntent(): ClickIntent {
  const windowTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearWindow = useCallback((): boolean => {
    if (windowTimer.current === null) return false
    clearTimeout(windowTimer.current)
    windowTimer.current = null
    return true
  }, [])
  useEffect(() => () => void clearWindow(), [clearWindow])
  return useMemo(
    () => ({
      press: (single, double) => {
        if (clearWindow()) {
          // Second click inside the window: the single already ran on the
          // first press, so this only upgrades (promotes the preview the
          // first press opened). Never re-fires the single.
          double()
          return
        }
        // First click: act at once, then hold the window open for the upgrade.
        single()
        windowTimer.current = setTimeout(() => {
          windowTimer.current = null
        }, DOUBLE_CLICK_MS)
      },
      commit: (double) => {
        clearWindow()
        double()
      },
    }),
    [clearWindow],
  )
}
