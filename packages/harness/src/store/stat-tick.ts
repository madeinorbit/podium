import type { SharedStatTick, StatTick } from '../transcript-types.js'

const STAT_POLL_MS = 700

export type { SharedStatTick, StatTick } from '../transcript-types.js'

/**
 * Fan every registered stat watcher out from one interval. The callback list is
 * snapshotted per batch so lifecycle changes during one watcher cannot perturb
 * the rest of that batch. The interval is lazy and disappears with the last
 * watcher, so an idle daemon holds no polling timer. [spec:SP-c29e]
 */
export function createSharedStatTick(pollMs = STAT_POLL_MS): SharedStatTick {
  const watchers = new Set<() => void>()
  let timer: ReturnType<typeof setInterval> | undefined

  const stopTimer = (): void => {
    if (!timer) return
    clearInterval(timer)
    timer = undefined
  }

  const startTimer = (): void => {
    if (timer) return
    timer = setInterval(() => {
      for (const watcher of [...watchers]) watcher()
    }, pollMs)
    timer.unref?.()
  }

  return {
    subscribe(watcher) {
      watchers.add(watcher)
      startTimer()
      let subscribed = true
      return () => {
        if (!subscribed) return
        subscribed = false
        watchers.delete(watcher)
        if (watchers.size === 0) stopTimer()
      }
    },
    stop() {
      watchers.clear()
      stopTimer()
    },
  }
}

/** Register on a shared daemon tick when supplied, otherwise preserve the
 * package's standalone interval behavior and custom test cadence. */
export function scheduleStatPoll(
  watcher: () => void,
  opts: { statTick?: StatTick; pollMs: number },
): () => void {
  if (opts.statTick) return opts.statTick.subscribe(watcher)
  const timer = setInterval(watcher, opts.pollMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
