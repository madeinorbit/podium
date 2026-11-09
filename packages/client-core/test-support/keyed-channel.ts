type FixtureState = Record<string, unknown>

/** Test-only keyed publication for historical snapshot fixtures. Product screen
 * readers subscribe to UiStore; the engine has no local keys. */
export type LocalKey = keyof FixtureState
export type LocalsListener = (changed: ReadonlySet<LocalKey>) => void

export interface KeyedInputs {
  onLocals(keys: readonly LocalKey[], listener: LocalsListener): () => void
  readLocal<K extends LocalKey>(key: K): FixtureState[K]
}

/** Counted for the adapter wake meters (plan steps 7-9). */
export interface KeyedInputStats {
  /** Listener calls. */
  wakes: number
}

export interface KeyedInputsChannel extends KeyedInputs {
  readonly stats: KeyedInputStats
  /** The runtime's batch end: the `changed` keys. */
  emit(changed: ReadonlySet<LocalKey>): void
  dispose(): void
}

/** `read` returns the runtime's current state; the channel publishes from it
 *  only at `emit`, so a reader never sees a local it was not told about.
 *  `live` reads `read()` directly instead (fixtures that mutate a store in
 *  place and may never publish). */
export function createKeyedInputs(
  read: () => FixtureState,
  live = false,
  directKeys: readonly LocalKey[] = [],
): KeyedInputsChannel {
  const snapshot: Partial<FixtureState> = live ? {} : { ...read() }
  const direct = new Set(directKeys)
  for (const key of direct) delete snapshot[key]
  const current = (): Partial<FixtureState> => (live ? read() : snapshot)
  const byKey = new Map<LocalKey, Set<{ keys: ReadonlySet<LocalKey>; listener: LocalsListener }>>()
  const stats: KeyedInputStats = { wakes: 0 }
  let disposed = false

  function call<T>(listener: (value: T) => void, value: T): void {
    stats.wakes++
    try {
      listener(value)
    } catch {
      // One throwing adapter must not stop the others (row-source contract).
    }
  }

  return {
    stats,
    onLocals(keys, listener) {
      const entry = { keys: new Set(keys), listener }
      for (const key of entry.keys) {
        const set = byKey.get(key) ?? new Set()
        byKey.set(key, set)
        set.add(entry)
      }
      return () => {
        for (const key of entry.keys) byKey.get(key)?.delete(entry)
      }
    },
    readLocal: (key) => (direct.has(key) ? read() : current())[key] as FixtureState[typeof key],
    emit(changed) {
      if (disposed) return
      const state = read()
      for (const key of changed)
        if (!direct.has(key)) (snapshot as Record<string, unknown>)[key] = state[key]
      const woken = new Map<LocalsListener, Set<LocalKey>>()
      for (const key of changed)
        for (const entry of byKey.get(key) ?? []) {
          const keys = woken.get(entry.listener) ?? new Set<LocalKey>()
          woken.set(entry.listener, keys)
          keys.add(key)
        }
      for (const [listener, keys] of woken) call(listener, keys)
    },
    dispose() {
      disposed = true
      byKey.clear()
    },
  }
}
