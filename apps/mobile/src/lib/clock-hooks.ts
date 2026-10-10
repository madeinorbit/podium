import { clockStore, now, nowForAge } from '@podium/mobx-helpers'
import { useMemo, useSyncExternalStore } from 'react'

export function useClock(precision: number, enabled = true): number {
  const store = useMemo(() => clockStore(() => now(precision), enabled), [precision, enabled])
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}
export function useAgeNow(since: number | string, baseMs = 0, enabled = true): number {
  const store = useMemo(() => clockStore(() => nowForAge(since, baseMs), enabled), [since, baseMs, enabled])
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}
