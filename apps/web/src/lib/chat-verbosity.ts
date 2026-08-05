import type { UiState } from '@podium/client-core/replica'
import { CHAT_VERBOSITY_KEY } from '@podium/client-core/ui-state'
import type { ChatVerbosity } from '@podium/client-core/viewmodels'
import { parseChatVerbosity } from '@podium/client-core/viewmodels'
import { useSyncExternalStore } from 'react'
import { useStoreSelector } from '@/app/store'

export { CHAT_VERBOSITY_KEY }

/**
 * How much of a transcript this device renders (POD-376) — device-local, like
 * the sticky-prompt preference next door, because it describes how you read
 * rather than anything about the session.
 *
 * Absent means `normal`, which is exactly today's feed, so the switcher ships
 * without changing a single existing view.
 */
const subscribeUnavailable = (): (() => void) => () => {}
const readUnavailable = (): null => null

export function useChatVerbosityPreference(): {
  verbosity: ChatVerbosity
  setVerbosity: (v: ChatVerbosity) => void
} {
  // Lightweight consumers (tests, embeds) may not expose the device-local UI
  // collection; fall back to the default rather than making the feed depend on
  // optional preference storage.
  const ui = useStoreSelector((s) => s.uiState) as UiState | undefined
  const raw = useSyncExternalStore(
    ui ? (cb) => ui.subscribe(cb) : subscribeUnavailable,
    ui ? () => ui.get(CHAT_VERBOSITY_KEY) : readUnavailable,
    readUnavailable,
  )
  return {
    verbosity: parseChatVerbosity(raw),
    // `normal` is stored as absence, so the default stays the default even if
    // the vocabulary grows later.
    setVerbosity: (v) => ui?.set(CHAT_VERBOSITY_KEY, v === 'normal' ? null : v),
  }
}
