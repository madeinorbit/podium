/**
 * THE IN-PROGRESS HALF OF A TURN, FOLDED ONCE AND FANNED OUT COALESCED
 * (POD-2293).
 *
 * ---------------------------------------------------------------------------
 * WHY THE ACCUMULATOR IS HERE AND NOT IN THE DAEMON
 * ---------------------------------------------------------------------------
 *
 * The spec put it in the daemon, on the argument that the daemon is the first
 * hop owning per-session state. POD-2411 landed since, and it built the
 * daemon→server carriage this needs: `runtimeFineEvent`, unretained and
 * unacknowledged, already sent by all four translators and already received by
 * `SessionRuntimeGateway`, with the durable gate returning `fine-live-only` so a
 * fragment never touches the event log. Folding in the daemon would mean a
 * SECOND daemon→server plane carrying the same facts in a different shape, and a
 * second receiver beside the one that exists.
 *
 * So the daemon carries fragments and the server folds them. The costs that
 * argument turns on are unchanged: the per-token traffic that stays local is
 * daemon→server over a machine socket, and the fan-out that must be coalesced —
 * one frame per viewer per token — is exactly the hop this sits in front of.
 *
 * ---------------------------------------------------------------------------
 * THE THREE RULES
 * ---------------------------------------------------------------------------
 *
 *   1. THE COMPLETE ITEM ALWAYS WINS. A preview row is retired the moment a
 *      durable item carrying its stream identity arrives — never merged with it,
 *      never left beside it. That is the whole reason `streamItemIdOf` exists,
 *      and getting it wrong renders the reply twice.
 *   2. A FENCED EPOCH NEVER REOPENS. Absorb, stated for previews: a turn that
 *      ended takes its preview with it, and nothing for that epoch may recreate
 *      one. The drivers enforce this at the source too; this is the consumer
 *      half, because a preview that outlived its turn is a session that looks
 *      like it is still typing.
 *   3. THE PREVIEW IS NEVER THE RECORD. Every row here is superseded by
 *      something on the durable transcript plane. Dropping all of it costs
 *      liveness and nothing else, which is what lets this whole plane be
 *      lossy on purpose.
 */

import { streamItemIdOf } from '@podium/agent-runtime'
import type { SessionId } from '@podium/model'
import type { TurnPreviewItem, TurnPreviewMessage } from '@podium/protocol'
import type { RuntimeEvent } from '@podium/protocol/daemon'

/**
 * How often a session may emit a preview frame, at most.
 *
 * 100 ms is the rate the eye reads as continuous while costing two orders of
 * magnitude fewer frames than the token rate. The FIRST fragment after a quiet
 * period is sent immediately — a leading edge, so a reply starts appearing the
 * instant it starts, rather than a tenth of a second later — and everything
 * inside the window coalesces into one trailing frame.
 */
export const TURN_PREVIEW_INTERVAL_MS = 100

export interface TurnPreviewPorts {
  /** Fan one frame out to a session's transcript subscribers. */
  publish(sessionId: SessionId, frame: TurnPreviewMessage): void
  now(): number
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
  intervalMs?: number
}

interface SessionPreview {
  turnEpoch: number
  /** Cursor ordinal of the newest event folded in — the frame's `seq`. */
  seq: number
  /** Insertion order, so the preview renders the way the turn happened. */
  order: string[]
  rows: Map<string, TurnPreviewItem>
  /** Epochs whose terminal has arrived. A fragment for one of these is dropped
   *  rather than applied — rule 2. */
  fencedThrough: number
  dirty: boolean
  timer?: ReturnType<typeof setTimeout>
  lastSentAt: number
}

export class TurnPreviewAccumulator {
  private readonly sessions = new Map<SessionId, SessionPreview>()

  constructor(private readonly ports: TurnPreviewPorts) {}

  private get intervalMs(): number {
    return this.ports.intervalMs ?? TURN_PREVIEW_INTERVAL_MS
  }

  private setTimer(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    return (this.ports.setTimer ?? ((f, m) => setTimeout(f, m)))(fn, ms)
  }

  private clearTimer(handle: ReturnType<typeof setTimeout>): void {
    ;(this.ports.clearTimer ?? ((h) => clearTimeout(h)))(handle)
  }

  /**
   * Fold one runtime event.
   *
   * Takes the WHOLE stream, coarse arms included, because two of the three
   * things it must react to are coarse: the complete item that retires a row,
   * and the turn terminal that clears the epoch. A fold that saw only the fine
   * plane would show previews that never went away.
   */
  record(sessionId: SessionId, event: RuntimeEvent): void {
    if (event.t === 'turn') {
      if (event.ev.ev === 'completed' || event.ev.ev === 'failed') this.fence(sessionId, event)
      return
    }
    if (event.t !== 'item') return

    if (event.item.kind === 'complete') {
      const state = this.sessions.get(sessionId)
      if (!state || state.turnEpoch !== event.turnEpoch) return
      this.retire(state, streamItemIdOf(event.item.item))
      this.schedule(sessionId, state, event.cursor.components.seq ?? state.seq)
      return
    }

    const state = this.open(sessionId, event.turnEpoch)
    if (!state) return
    const row: TurnPreviewItem =
      event.item.kind === 'delta'
        ? {
            kind: 'text',
            itemId: event.item.itemId,
            text: textOf(state.rows.get(event.item.itemId)) + event.item.textDelta,
          }
        : {
            kind: 'running',
            itemId: streamItemIdOf(event.item.item),
            item: event.item.item,
          }
    if (!state.rows.has(row.itemId)) state.order.push(row.itemId)
    state.rows.set(row.itemId, row)
    this.schedule(sessionId, state, event.cursor.components.seq ?? state.seq + 1)
  }

  /** The frame a late subscriber is caught up with, if the epoch is still open. */
  retained(sessionId: SessionId): TurnPreviewMessage | undefined {
    const state = this.sessions.get(sessionId)
    if (!state || state.rows.size === 0) return undefined
    return this.frameOf(sessionId, state)
  }

  /** The session is gone, rebound, or its daemon changed: no preview survives
   *  that, because the epoch numbering it was keyed on may not either. */
  forget(sessionId: SessionId): void {
    const state = this.sessions.get(sessionId)
    if (state?.timer !== undefined) this.clearTimer(state.timer)
    this.sessions.delete(sessionId)
  }

  dispose(): void {
    for (const sessionId of [...this.sessions.keys()]) this.forget(sessionId)
  }

  // -- internals ------------------------------------------------------------

  private open(sessionId: SessionId, turnEpoch: number): SessionPreview | undefined {
    const existing = this.sessions.get(sessionId)
    if (existing) {
      // RULE 2. A fragment for a fenced epoch, or for one older than the epoch
      // on screen, is a late arrival whose preview was already replaced.
      if (turnEpoch <= existing.fencedThrough) return undefined
      if (turnEpoch < existing.turnEpoch) return undefined
      if (turnEpoch > existing.turnEpoch) {
        existing.turnEpoch = turnEpoch
        existing.order = []
        existing.rows.clear()
      }
      return existing
    }
    const state: SessionPreview = {
      turnEpoch,
      seq: 0,
      order: [],
      rows: new Map(),
      fencedThrough: -1,
      dirty: false,
      lastSentAt: 0,
    }
    this.sessions.set(sessionId, state)
    return state
  }

  private retire(state: SessionPreview, itemId: string): void {
    if (!state.rows.delete(itemId)) return
    state.order = state.order.filter((id) => id !== itemId)
  }

  private fence(sessionId: SessionId, event: RuntimeEvent): void {
    const state = this.sessions.get(sessionId)
    if (!state) return
    if (event.turnEpoch < state.turnEpoch) return
    state.fencedThrough = Math.max(state.fencedThrough, event.turnEpoch)
    state.order = []
    state.rows.clear()
    if (state.timer !== undefined) {
      this.clearTimer(state.timer)
      state.timer = undefined
    }
    state.dirty = false
    // THE TERMINAL FRAME IS SENT IMMEDIATELY, never coalesced. A preview that
    // lingers a tenth of a second past its turn is the one artefact a viewer
    // reads as a bug — the reply is complete above it and something is still
    // "typing" below.
    state.seq = Math.max(state.seq, event.cursor.components.seq ?? state.seq)
    state.lastSentAt = this.ports.now()
    this.ports.publish(sessionId, { ...this.frameOf(sessionId, state), done: true })
  }

  private frameOf(sessionId: SessionId, state: SessionPreview): TurnPreviewMessage {
    return {
      type: 'turnPreview',
      sessionId,
      turnEpoch: state.turnEpoch,
      seq: state.seq,
      items: state.order
        .map((id) => state.rows.get(id))
        .filter((row): row is TurnPreviewItem => row !== undefined),
    }
  }

  private schedule(sessionId: SessionId, state: SessionPreview, seq: number): void {
    state.seq = Math.max(state.seq, seq)
    state.dirty = true
    if (state.timer !== undefined) return
    const since = this.ports.now() - state.lastSentAt
    if (since >= this.intervalMs) {
      this.flush(sessionId, state)
      return
    }
    state.timer = this.setTimer(() => {
      const live = this.sessions.get(sessionId)
      if (!live) return
      live.timer = undefined
      if (live.dirty) this.flush(sessionId, live)
    }, this.intervalMs - since)
  }

  private flush(sessionId: SessionId, state: SessionPreview): void {
    state.dirty = false
    state.lastSentAt = this.ports.now()
    this.ports.publish(sessionId, this.frameOf(sessionId, state))
  }
}

const textOf = (row: TurnPreviewItem | undefined): string => (row?.kind === 'text' ? row.text : '')
