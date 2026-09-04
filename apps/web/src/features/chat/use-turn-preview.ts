import type { ConnectionHealth } from '@podium/client-core/socket-transport'
import type { SessionId } from '@podium/model/browser'
import type { TurnPreviewItem, TurnPreviewMessage } from '@podium/protocol'
import { useEffect, useState } from 'react'
import type { Store } from '@/app/store'

/**
 * THE IN-PROGRESS TURN, AS THE CHAT VIEW SEES IT (POD-2293).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS NOT
 * ---------------------------------------------------------------------------
 *
 * It is not a transcript. Every row it holds is superseded by a durable item on
 * the transcript plane, usually within a second, and the server has already
 * retired each row the moment its item landed. So this hook keeps no history,
 * merges nothing by cursor, and reconstructs nothing after a gap: it holds the
 * last snapshot the server sent and drops it when the turn ends.
 *
 * That is why there is no accumulation here even though the underlying stream is
 * token fragments. The FOLD happens once, on the server, and what crosses the
 * socket is the whole preview each time — so a dropped frame costs nothing, a
 * reordered pair is resolved by `(turnEpoch, seq)`, and a client that connects
 * mid-turn is caught up by the single frame the server retained.
 *
 * ---------------------------------------------------------------------------
 * THE THREE WAYS IT CLEARS, AND WHY THERE ARE THREE
 * ---------------------------------------------------------------------------
 *
 *   1. `done` — the turn fenced. The authoritative one; the server sends it
 *      uncoalesced for exactly this reason.
 *   2. THE SOCKET DROPPED. The plane is live-only, so a preview that survived a
 *      disconnect would be a claim about a turn we stopped being able to see.
 *      A session that is still working re-sends on the next frame.
 *   3. STALENESS. Neither of the above is guaranteed to arrive: a daemon that
 *      died mid-turn sends no terminal, and the socket may stay up. Without this
 *      the chat would show half a reply, apparently still being typed, forever.
 *
 * There is deliberately NO fourth rule keying off transcript growth. The
 * headless overlay clears on `blockCount` because it has no identity to join on;
 * this plane does — the server retires each row against the durable item that
 * supersedes it, so a preview still on screen is one the transcript genuinely
 * does not have yet.
 */

/** How long a preview may go without a frame before it is assumed orphaned. A
 *  turn producing anything at all refreshes far inside this; a turn producing
 *  nothing has nothing to preview. */
const STALE_AFTER_MS = 20_000

export interface TurnPreview {
  turnEpoch: number
  items: readonly TurnPreviewItem[]
}

export function useTurnPreview(sessionId: SessionId, hub: Store['hub']): TurnPreview | null {
  const [preview, setPreview] = useState<TurnPreview | null>(null)

  useEffect(() => {
    setPreview(null)
    let seen: { turnEpoch: number; seq: number } | null = null
    let stale: ReturnType<typeof setTimeout> | undefined
    const armStaleness = (): void => {
      if (stale !== undefined) clearTimeout(stale)
      stale = setTimeout(() => {
        seen = null
        setPreview(null)
      }, STALE_AFTER_MS)
    }
    const disarm = (): void => {
      if (stale !== undefined) clearTimeout(stale)
      stale = undefined
    }

    // Optional-chained: older hub fakes in tests do not implement `on`.
    const off = hub.on?.('turnPreview', (sid: SessionId, frame: TurnPreviewMessage) => {
      if (sid !== sessionId) return
      if (frame.done) {
        // A terminal for an epoch we already moved past is a late arrival, and
        // clearing on it would wipe the turn that came after.
        if (seen && frame.turnEpoch < seen.turnEpoch) return
        disarm()
        seen = null
        setPreview(null)
        return
      }
      // APPLY IF NEWER. Older epoch, or the same epoch at an earlier cursor,
      // means this frame lost a race with one already applied.
      if (
        seen &&
        (frame.turnEpoch < seen.turnEpoch ||
          (frame.turnEpoch === seen.turnEpoch && frame.seq <= seen.seq))
      ) {
        return
      }
      seen = { turnEpoch: frame.turnEpoch, seq: frame.seq }
      armStaleness()
      setPreview(frame.items.length > 0 ? { turnEpoch: frame.turnEpoch, items: frame.items } : null)
    })

    const offHealth = hub.on?.('connectionHealth', (health: ConnectionHealth) => {
      if (health.status !== 'down') return
      disarm()
      seen = null
      setPreview(null)
    })

    return () => {
      disarm()
      off?.()
      offHealth?.()
    }
  }, [hub, sessionId])

  return preview
}
