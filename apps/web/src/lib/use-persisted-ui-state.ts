import type { RoutedUiState } from '@podium/client-core/ui-state'
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { useStoreSelector } from '@/app/store'

/**
 * SUBSCRIBE to a persisted ui-state key — never seed it into local state.
 *
 * A `useState(() => ui.get(key))` initializer runs once, on the first render,
 * and never again. That is correct only for DEVICE-LOCAL keys, which the replica
 * has already loaded from synchronous storage by the time anything mounts. Every
 * PER-USER REPLICATED key (`sidebar.collapsed`, `rightPanel`,
 * `superagent.mode`, the file-mode maps…) arrives later, over the wire: the
 * initializer reads `null`, falls back to the default, and the surface is stuck
 * on that default forever after even though the stored row is right there.
 *
 * That asymmetry is exactly why a resized column kept its width across a reload
 * while a collapsed one came back expanded (POD-540). Subscribing removes the
 * race by construction — the persisted value IS the state, so there is no second
 * source of truth to fall out of step, and a late replica simply re-renders.
 *
 * `parse` is applied outside the store read (so it may allocate) and memoized on
 * the raw string; pass a module-level or `useCallback`-stable `parse` if you
 * want a stable object identity out.
 */
export function usePersistedUiValue<T>(key: string, parse: (raw: string | null) => T): T {
  // Lightweight consumers (tests, embeds) may not expose the UI collection at
  // all; fall back to the parsed default rather than making a surface depend on
  // optional preference storage. Same guard as chat-verbosity / sticky-prompts.
  const ui = useStoreSelector((s) => s.uiState) as RoutedUiState | undefined
  const raw = useSyncExternalStore(
    ui ? (cb) => ui.subscribe(cb) : subscribeUnavailable,
    ui ? () => ui.get(key) : readUnavailable,
    readUnavailable,
  )
  return useMemo(() => parse(raw), [raw, parse])
}

/**
 * {@link usePersistedUiValue} plus a writer, shaped like `useState` so a seeded
 * call site converts by swapping the hook. The setter only writes: the new value
 * comes back through the subscription, which is what keeps the rendered state
 * and the stored row from diverging.
 *
 * `serialize` returning `null` deletes the key (back to the default).
 */
export function usePersistedUiState<T>(
  key: string,
  parse: (raw: string | null) => T,
  serialize: (value: T) => string | null,
): [T, (next: T) => void] {
  const ui = useStoreSelector((s) => s.uiState) as RoutedUiState | undefined
  const value = usePersistedUiValue(key, parse)
  const set = useCallback(
    (next: T) => {
      ui?.set(key, serialize(next))
    },
    [ui, key, serialize],
  )
  return [value, set]
}

const subscribeUnavailable = (): (() => void) => () => {}
const readUnavailable = (): null => null
