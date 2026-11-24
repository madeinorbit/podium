import { relativeTimeNextChangeAt } from '@podium/client-core/focus'
import { type AgeNextChange, clockStore, now, nowForAge } from '@podium/mobx-helpers'
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
/** Age text observes its next change; only a visible elapsed column opts into ticks. */
export function useAgeNow(
  since: number | string,
  baseMs = 0,
  enabled = true,
  secondsUntil = 0,
  nextChangeAt: AgeNextChange = relativeTimeNextChangeAt,
): number {
  const visible = useContentVisible()
  const store = useMemo(
    () =>
      clockStore(() => nowForAge(since, nextChangeAt, baseMs, secondsUntil), enabled && visible),
    [since, baseMs, enabled, secondsUntil, nextChangeAt, visible],
  )
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}
