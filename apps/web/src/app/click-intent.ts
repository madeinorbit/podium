import { useCallback, useEffect, useMemo, useRef } from 'react'

/**
 * SINGLE CLICK AND DOUBLE CLICK ON ONE TARGET, resolved without a race.
 *
 * A preview open and a permanent open are the same gesture repeated, so the
 * first click cannot act immediately — it would leave a stray fold toggle (and a
 * second navigation) behind every double click. The first click schedules; a
 * second click inside the window cancels the schedule and promotes instead,
 * which is the "promote on the second click" arm the contract allows and the one
 * that needs no `dblclick` event to be delivered.
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
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancel = useCallback((): boolean => {
    if (pending.current === null) return false
    clearTimeout(pending.current)
    pending.current = null
    return true
  }, [])
  useEffect(() => () => void cancel(), [cancel])
  return useMemo(
    () => ({
      press: (single, double) => {
        if (cancel()) {
          double()
          return
        }
        pending.current = setTimeout(() => {
          pending.current = null
          single()
        }, DOUBLE_CLICK_MS)
      },
      commit: (double) => {
        cancel()
        double()
      },
    }),
    [cancel],
  )
}
