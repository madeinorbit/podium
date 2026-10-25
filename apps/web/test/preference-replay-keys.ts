import { UI_STATE_KEYS } from '@podium/client-core/ui-state'
import { isLayoutKey, layoutKeyFromLegacy } from '@podium/model'

/** Replay declared layout keys; stored rows can outlive their declarations. */
export function preferenceReplayKeys(values: Record<string, unknown>): string[] {
  const known = [...Object.values(UI_STATE_KEYS), 'podium:sidebar:pinned', 'podium:superagent:mode']
  const keys = Object.keys(values)
    .filter(isLayoutKey)
    .map(
      (canonical) =>
        known.find((key) => layoutKeyFromLegacy(key) === canonical) ??
        (canonical.startsWith('sidebar.section.')
          ? `podium:sidebar:${canonical.slice('sidebar.section.'.length)}`
          : null),
    )
  const unsupported = keys.filter((key) => key === null).length
  if (unsupported)
    throw new Error(`Replay needs declarations for ${unsupported} stored key positions`)
  return keys.filter((key): key is string => key !== null)
}
