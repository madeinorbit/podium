import { clockStore, now, nowForAge } from '@podium/mobx-helpers'
import { useMemo, useSyncExternalStore } from 'react'
import { useContentVisible } from './visible-content'

export function useClock(precision: number, enabled = true): number {
  const visible = useContentVisible()
  const store = useMemo(
    () => clockStore(() => now(precision), enabled && visible),
    [precision, enabled, visible],
  )
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}
/** Age text defaults to minutes; only a visible elapsed-seconds column opts in. */
export function useAgeNow(
  since: number | string,
  baseMs = 0,
  enabled = true,
  secondsUntil = 0,
): number {
  const visible = useContentVisible()
  const store = useMemo(
    () => clockStore(() => nowForAge(since, baseMs, secondsUntil), enabled && visible),
    [since, baseMs, enabled, secondsUntil, visible],
  )
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}
