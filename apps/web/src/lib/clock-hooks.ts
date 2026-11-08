import { clockStore, deadlineClock, now, nowForAge } from '@podium/mobx-helpers'
import { useMemo, useSyncExternalStore } from 'react'
import { usePanelVisible } from '@/app/panel-visible'

export function useClock(precision: number, enabled = true): number {
  const visible = usePanelVisible()
  const store = useMemo(
    () => clockStore(() => now(precision), enabled && visible),
    [precision, enabled, visible],
  )
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}

export function useAgeNow(since: number | string, baseMs = 0, enabled = true): number {
  const visible = usePanelVisible()
  const store = useMemo(
    () => clockStore(() => nowForAge(since, baseMs), enabled && visible),
    [since, baseMs, enabled, visible],
  )
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}

/** Tick a visible countdown at its display precision, then stop at its exact deadline. */
export function useCountdown(at: number | undefined, precision = 1_000): number {
  const visible = usePanelVisible()
  const store = useMemo(
    () =>
      clockStore(
        () => {
          if (at === undefined || !Number.isFinite(at) || deadlineClock.reached(at)) return 0
          return Math.max(0, at - now(precision))
        },
        visible && at !== undefined,
      ),
    [at, precision, visible],
  )
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}

/** A boolean boundary never subscribes to the precision clock. */
export function useDeadlineNow(at: number | undefined): number {
  const visible = usePanelVisible()
  const store = useMemo(() => {
    const clock = deadlineClock
    return clockStore(
      () => {
        if (at !== undefined && Number.isFinite(at)) clock.reached(at)
        return clock.peekNow()
      },
      visible && at !== undefined,
    )
  }, [at, visible])
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}
