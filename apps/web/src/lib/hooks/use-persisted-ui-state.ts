import type { UiState } from '@podium/client-core/replica'
import { useMemo, useSyncExternalStore } from 'react'
import { useStoreSelector } from '@/app/store'

/**
 * Subscribe to a ui-state key rather than seeding local React state from it.
 *
 * Per-user REPLICATED layout keys (`sidebar.collapsed`, `dock.section.*`,
 * `rightPanel`, `superagent.mode`, …) live in `user_layout` and are not in the
 * replica on the first render. A `useState(() => ui.get(key))` initializer
 * reads null once, falls back to the surface default, and never runs again —
 * so a stored collapse/fold is lost across reload even though the write path
 * updated the row correctly. Device-local keys do not hit this race (they are
 * in the local cache at mount), which is why a resized column kept its width
 * while a collapsed one did not keep its collapse.
 *
 * Same idiom as `use-terminal-appearance` / sticky-prompts / chat-verbosity:
 * the subscribed value IS the state.
 */
export function usePersistedUiState<T>(key: string, parse: (raw: string | null) => T): T {
  const ui = useStoreSelector((s) => s.uiState) as UiState
  return usePersistedUiStateFrom(ui, key, parse)
}

/**
 * Same as {@link usePersistedUiState} but takes an explicit ui-state handle —
 * for call sites that already hold `ui` (or tests that inject a fake).
 */
export function usePersistedUiStateFrom<T>(
  ui: Pick<UiState, 'get' | 'subscribe'>,
  key: string,
  parse: (raw: string | null) => T,
): T {
  // Snapshot the raw string (stable under Object.is) so React does not loop;
  // parse outside so object parsers (e.g. issues display) can still memoize.
  const raw = useSyncExternalStore(
    (onChange) => ui.subscribe(onChange),
    () => ui.get(key),
    () => ui.get(key),
  )
  return useMemo(() => parse(raw), [raw, parse])
}
