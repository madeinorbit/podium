/**
 * POD-4608 (L1e) — the locals channel: selection and the coarse clock, as the
 * arms see them (`LocalsSource`, `arm.ts`). The rows half is `row-source.ts`;
 * this is its mirror for locals.
 *
 * ONE DRAIN, LIKE THE ROW SOURCE. A signal (an engine publication, a `set`)
 * marks the source dirty and schedules one microtask drain; `flush()` drains
 * synchronously for tests, through the same path. The drain reads the input
 * once, compares each key with the published value, and — only if a key
 * moved — publishes a new frozen value and notifies once with the keys that
 * moved. Between drains `get()` returns the published value, so an arm never
 * observes a local it was not told about.
 *
 * KEY EQUALITY. `Object.is` per key, except the fold latch, where absent and
 * `false` are the same value (`groupKeyOf` reads `!== true`).
 *
 * COUNTING. `LocalsSourceStats` (`stats.ts`): the shared place locals traffic
 * is counted, whatever an arm does with it.
 */

import type { LocalsSource } from './arm'
import { LOCALS_KEYS, type LocalsKey, type SliceLocals } from './slice-types'
import type { LocalsSourceStats } from './stats'

export interface LocalsSourceHandle {
  readonly source: LocalsSource
  readonly stats: LocalsSourceStats
  /** Drain a pending signal synchronously; returns the keys notified, if any. */
  flush(): ReadonlySet<LocalsKey> | null
  dispose(): void
}

export interface SettableLocalsHandle extends LocalsSourceHandle {
  /** Merge `patch` into the input and signal; published at the next drain. */
  set(patch: Partial<SliceLocals>): void
}

function sameKey(key: LocalsKey, a: SliceLocals, b: SliceLocals): boolean {
  if (key === 'selectedIssueWasFolded') {
    return (a.selectedIssueWasFolded ?? false) === (b.selectedIssueWasFolded ?? false)
  }
  return Object.is(a[key], b[key])
}

function zeroKeys(): Record<LocalsKey, number> {
  return { selectedIssueId: 0, selectedIssueWasFolded: 0, coarseNow: 0 }
}

/**
 * A locals source over any input. `read` returns the current locals; `signal`
 * registers a wake-up for when they may have moved and returns its teardown.
 */
export function createLocalsSource(
  read: () => SliceLocals,
  signal: (wake: () => void) => () => void,
): LocalsSourceHandle {
  let published: SliceLocals = Object.freeze({ ...read() })
  const listeners = new Set<(changed: ReadonlySet<LocalsKey>) => void>()
  let dirty = false
  let scheduled = false
  let disposed = false

  const stats: LocalsSourceStats = {
    notifications: 0,
    keys: zeroKeys(),
    flushes: 0,
    reset() {
      stats.notifications = 0
      stats.keys = zeroKeys()
      stats.flushes = 0
    },
  }

  function flush(): ReadonlySet<LocalsKey> | null {
    if (disposed || !dirty) return null
    dirty = false
    stats.flushes += 1
    const next = read()
    const changed = new Set<LocalsKey>()
    for (const key of LOCALS_KEYS) if (!sameKey(key, published, next)) changed.add(key)
    if (changed.size === 0) return null
    published = Object.freeze({ ...next })
    stats.notifications += 1
    for (const key of changed) stats.keys[key] += 1
    for (const listener of [...listeners]) {
      try {
        listener(changed)
      } catch {
        // One throwing arm must not stop the others (row-source contract).
      }
    }
    return changed
  }

  function wake(): void {
    if (disposed) return
    dirty = true
    if (scheduled) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      flush()
    })
  }

  const off = signal(wake)

  return {
    source: {
      get: () => published,
      subscribe(listener) {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    },
    stats,
    flush,
    dispose() {
      if (disposed) return
      disposed = true
      listeners.clear()
      try {
        off()
      } catch {
        // Teardown is best-effort, matching the row source.
      }
    },
  }
}

/** Locals that never move: unit tests and one-shot runs. Never notifies. */
export function fixedLocals(value: SliceLocals): LocalsSourceHandle {
  return createLocalsSource(
    () => value,
    () => () => {},
  )
}

/** Locals a test drives by hand: `set` a patch, then drain (or await a microtask). */
export function settableLocals(initial: SliceLocals): SettableLocalsHandle {
  let current: SliceLocals = { ...initial }
  let wake: () => void = () => {}
  const handle = createLocalsSource(
    () => current,
    (w) => {
      wake = w
      return () => {
        wake = () => {}
      }
    },
  )
  return {
    ...handle,
    set(patch: Partial<SliceLocals>): void {
      current = { ...current, ...patch }
      wake()
    },
  }
}
