/**
 * THE CLIENT HALF OF THE EVENT-STREAM READ CURSOR (POD-1380).
 *
 * The feature (the superagent chat's "you were here" divider and its unread dot)
 * used to read and write `podium:superfeed:cursor` in the device's ui-state
 * collection. It now reads and writes ONE PERSON'S row through
 * `readPosition.get` / `readPosition.advance`, so the position follows them to
 * another machine — `docs/multi-user-readiness.md` §3.3.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT PART OF THE REPLICATED UI-STATE PORT
 * ---------------------------------------------------------------------------
 * That port routes a key to `user_layout`, whose merge is last-writer-wins per
 * key. A cursor must be monotonic: a device that writes before its hydration
 * lands proposes a stale-but-legal position, and LWW would move the marker
 * BACKWARD and re-mark read events unread. The server clamps to `max`, and this
 * port keeps a local projection that never regresses either, so the divider does
 * not flicker backward between the write and its response.
 *
 * ---------------------------------------------------------------------------
 * THE ONE-SHOT LEGACY MIGRATION
 * ---------------------------------------------------------------------------
 * {@link createReadPositionClient} takes the DEVICE-local ui-state collection only
 * to drain it: on hydrate, an old local value is forwarded once through
 * `advance` on the ACTING principal and then deleted. It is safe by construction
 * for two reasons that are worth separating:
 *
 *   - the collection is principal-scoped (the Replica folded raw localStorage
 *     into the acting principal's namespace), so a second person on the same
 *     device does not find the first person's value; and
 *   - the forward is MONOTONIC, so even a stale or replayed local value cannot
 *     move a server position backward. The migration is idempotent because the
 *     merge rule is, not because it runs exactly once.
 */

import { isReadStreamId, type ReadPositionSnapshot, type ReadStreamId } from '@podium/model'
import { submitNow } from '@podium/protocol'
import type { PodiumClientApi } from './api'
import type { UiState } from './replica/contract'
import { READ_POSITION_UI_KEY } from './ui-state'

/** One person's position in one stream, as the feature reads it. */
export interface ReadPositionValue {
  /** Highest acknowledged event id; 0 = never seen this stream. */
  readonly lastEventId: number
  /** When it last advanced — the divider's clock label. */
  readonly seenAt: string | null
}

/** The "never read this stream" value. Absence has exactly one spelling. */
export const NO_READ_POSITION: ReadPositionValue = { lastEventId: 0, seenAt: null }

export interface ReadPositionPort {
  /** This person's position, or {@link NO_READ_POSITION} before hydration. */
  get(streamId: ReadStreamId): ReadPositionValue
  /** Propose a position. A proposal at or behind the current one is a no-op. */
  advance(streamId: ReadStreamId, next: ReadPositionValue): void
  /** Forward the legacy device-local value once, then forget it. */
  drainLegacy(): void
  /**
   * Install this principal's positions as the replica holds them (POD-6673: the
   * synced `userReadPosition` kind; a second device moved, or a reload). Merged
   * monotonically, like the server, so a local advance still on its way is never
   * moved back by an older row.
   */
  replace(snapshot: ReadPositionSnapshot): void
  subscribe(listener: () => void): () => void
}

/** Parse the legacy device-local JSON blob, or null when absent/corrupt. */
export function readLegacyCursorBlob(raw: string | null): ReadPositionValue | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { id?: unknown; ts?: unknown }
    if (typeof parsed.id !== 'number' || !Number.isFinite(parsed.id) || parsed.id < 0) return null
    return {
      lastEventId: Math.floor(parsed.id),
      seenAt: typeof parsed.ts === 'string' ? parsed.ts : null,
    }
  } catch {
    return null
  }
}

export function createReadPositionClient(init: {
  api: PodiumClientApi
  /** Device-local collection — read ONCE per stream, to drain the legacy key. */
  local: Pick<UiState, 'get' | 'set'>
  /** Reported rather than thrown: a cursor is never worth breaking a render for. */
  onError?: (message: string) => void
}): ReadPositionPort {
  const { api, local, onError } = init
  let snapshot: Record<string, ReadPositionValue> = {}
  const listeners = new Set<() => void>()

  const emit = (): void => {
    for (const listener of listeners) listener()
  }

  const current = (streamId: string): ReadPositionValue => snapshot[streamId] ?? NO_READ_POSITION

  /** Local projection, monotonic like the server's. Returns true when it moved. */
  const paint = (streamId: string, next: ReadPositionValue): boolean => {
    if (next.lastEventId <= current(streamId).lastEventId) return false
    snapshot = { ...snapshot, [streamId]: next }
    emit()
    return true
  }

  const install = (incoming: ReadPositionSnapshot): void => {
    let next = snapshot
    for (const [streamId, value] of Object.entries(incoming)) {
      // A row for a stream this build does not know is dropped rather than
      // rendered: an unknown feed has no surface to be a position in.
      if (!isReadStreamId(streamId)) continue
      if (value.lastEventId <= current(streamId).lastEventId) continue
      next = { ...next, [streamId]: { lastEventId: value.lastEventId, seenAt: value.seenAt } }
    }
    if (next === snapshot) return
    snapshot = next
    emit()
  }

  const send = (streamId: string, value: ReadPositionValue): void => {
    const input = { streamId, lastEventId: value.lastEventId, seenAt: value.seenAt }
    // On the sync write entry point (POD-6412). LEGACY(remove-after: 2027-03): an
    // older server has no `sync.submit` and takes the command's own route.
    void submitNow<ReadPositionSnapshot>(api, 'readPosition.advance', input, {
      action: 'save your read position',
      legacy: async () => await api.readPosition.advance.mutate(input),
    })
      .then(install)
      .catch((error: unknown) => {
        // The next visible tick re-proposes the same position, so a failed
        // advance costs a round trip and not a read position.
        onError?.(
          `Couldn't save your read position — ${
            error instanceof Error ? error.message : 'the server is unreachable'
          }`,
        )
      })
  }

  return {
    get: (streamId) => current(streamId),
    advance: (streamId, next) => {
      if (!paint(streamId, next)) return
      send(streamId, next)
    },
    drainLegacy: () => {
      const legacy = readLegacyCursorBlob(local.get(READ_POSITION_UI_KEY))
      if (legacy !== null) {
        // Drain first: a failed forward must not leave the key to be re-consumed
        // by whoever signs in next. The value is not lost — the server position
        // is already at least as far along, or the next visible tick re-proposes.
        local.set(READ_POSITION_UI_KEY, null)
        if (paint('issueEvents', legacy)) send('issueEvents', legacy)
      }
    },
    replace: install,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
