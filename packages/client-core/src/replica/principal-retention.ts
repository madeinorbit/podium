import { DEVICE_AUTHORED_DRAFT_KEYS } from '../ui/draft-keys'
import type { StorageApi } from './contract'

const AUTHORED_SUFFIXES = [
  '.uistate.v1',
  '.outbox.v1',
  '.outbox-awaiting.v1',
  '.outbox-dead-letter.v1',
] as const

/** Even a clean snapshot can become dirty in another tab during cache cleanup. */
export function isAuthoredNamespaceKey(root: string, key: string): boolean {
  return AUTHORED_SUFFIXES.some(
    (suffix) => key === `${root}${suffix}` || key.startsWith(`${root}${suffix}.`),
  )
}

/** Unreadable or unfamiliar authored data is never evidence of a clean namespace. */
export function hasPendingNamespaceSettings(storage: StorageApi, root: string): boolean {
  try {
    for (const suffix of AUTHORED_SUFFIXES.slice(1)) {
      const raw = storage.getItem(`${root}${suffix}`)
      if (raw === null) continue
      const entries: unknown = JSON.parse(raw)
      if (!Array.isArray(entries) || entries.length > 0) return true
    }
    const raw = storage.getItem(`${root}.uistate.v1`)
    if (raw === null) return false
    const document: unknown = JSON.parse(raw)
    if (!isRecord(document)) return true
    for (const key of DEVICE_AUTHORED_DRAFT_KEYS) {
      const stored = document[key]
      if (stored === undefined || stored === null || stored === '') continue
      if (typeof stored !== 'string') return true
      const draft: unknown = JSON.parse(stored)
      if (draft === null) continue
      if (!isRecord(draft)) return true
      if (key !== 'podium.drafts.v1') {
        if (Object.keys(draft).length > 0) return true
      } else if (Object.values(draft).some((entry) => !isRecord(entry) || entry.dirty !== false)) {
        // Legacy snapshots have no dirty flag. An empty dirty text is an unsent clear.
        return true
      }
    }
    return false
  } catch {
    return true
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
