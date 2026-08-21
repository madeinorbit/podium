import { createLogger } from '@podium/logger'
import { compareProviderCursor } from '@podium/harness/metadata'
import type { SessionId } from '@podium/model'
import type { InteractionEvent } from '@podium/protocol'
import type { RuntimeEvent, TurnEvent } from '@podium/protocol/daemon'
import {
  RUNTIME_EVENT_LOG_KIND,
  type EventsRepository,
  type RuntimeEventCheckpoint,
  type RuntimeEventLogRecord,
} from '../../store/events'

const log = createLogger('server:runtime-event-gate')
const BOARD_PROJECTOR = 'runtime.board.v1'

export type RuntimeEventGateResult =
  | { kind: 'accepted'; eventId: number }
  | { kind: 'duplicate' }
  | {
      kind: 'rejected'
      reason:
        | 'unknown-session'
        | 'invalid-event-time'
        | 'stale-observer-generation'
        | 'observer-generation-jump'
        | 'replacement-requires-bootstrap'
        | 'cursor-not-after-checkpoint'
        | 'unproven-segment-rotation'
        | 'turn-epoch-mismatch'
        | 'turn-epoch-regressed'
        | 'turn-epoch-jump'
        | 'terminal-epoch-closed'
    }
  | { kind: 'fine-live-only' }

export interface RuntimeEventSessionProjection {
  readonly sessionId: SessionId
  recordRuntimeActivity(at: string): boolean
  /** A kernel OOM kill the machine's supervisor observed in this session's
   *  scope (POD-2413). Explains an exit; never causes one. */
  recordOomKill(at: string): void
}

export interface RuntimeEventGatePorts {
  events: Pick<
    EventsRepository,
    | 'appendEvent'
    | 'announceEvent'
    | 'listRuntimeEvents'
    | 'listRuntimeEventsAfter'
    | 'runtimeEventCheckpoint'
    | 'saveRuntimeEventCheckpoint'
    | 'runtimeEventProjectionCursor'
    | 'saveRuntimeEventProjectionCursor'
  >
  session(sessionId: SessionId): RuntimeEventSessionProjection | undefined
  persist(sessionId: SessionId, additionalWrite: () => void): void
  /**
   * COARSE TURN BOUNDARIES, for the failure→interaction gate (POD-2414).
   *
   * A separate port from {@link board} rather than another arm of it, because
   * the two answer different questions: the board is a RECENCY projection and
   * this one decides whether a human has to be told a session stopped. Folding
   * them would make every future board consumer a consumer of failure semantics.
   *
   * Awaited on the same terms as the board effect — the durable event-id cursor
   * advances only after it resolves — so a crash between commit and projection
   * re-delivers rather than loses the failure. The consumer is therefore
   * required to be safe to repeat, which the aggregate's fingerprint dedupe and
   * no-op close already are.
   */
  turn?(input: {
    sessionId: SessionId
    ev: TurnEvent
    /** EVENT time, not observe time — the ask is stamped when the turn failed. */
    at: string
  }): void | Promise<void>
  /**
   * THE DRIVER'S OWN INTERACTION RESOLUTIONS (POD-2414).
   *
   * A protocol-sourced ask is opened by `runtimeInteractionAsked` and, until
   * this port existed, was closed by NOTHING — the compatibility frame carries
   * only the `asked` arm, so an ask a person answered in the harness's own TUI
   * stayed open in the aggregate forever. The coarse stream carries all three
   * arms, so the driver that raised the ask is also what retires it.
   *
   * Awaited on the same terms as {@link turn}.
   */
  interaction?(input: { sessionId: SessionId; ev: InteractionEvent }): void | Promise<void>
  board(
    event:
      | { kind: 'attention' | 'turnEnd'; sessionId: SessionId; eventId: number }
      | {
          kind: 'gitActivity'
          sessionId: SessionId
          eventId: number
          commits?: string[]
          touched?: string[]
        },
  ): void | Promise<void>
  now(): number
}

function isFineOnly(event: RuntimeEvent): boolean {
  return event.t === 'item' && event.item.kind === 'delta'
}

function closesTurn(event: RuntimeEvent): boolean {
  return event.t === 'turn' && (event.ev.ev === 'completed' || event.ev.ev === 'failed')
}

function startsTurn(event: RuntimeEvent): boolean {
  return event.t === 'turn' && event.ev.ev === 'started'
}

function turnEpochMatches(event: RuntimeEvent): boolean {
  return event.t !== 'turn' || event.ev.turnEpoch === event.turnEpoch
}

/**
 * The single durable application gate for the coarse Agent Runtime stream.
 *
 * Ingress orders/deduplicates, then commits the event-log row, restart head and
 * session-recency projection in one session-ledger transaction. The board is a
 * separate oplog projector: it advances its own durable event-id cursor only
 * after a safe-repeat application, so a crash after ingress but before fan-out
 * is recovered by {@link replayBoardProjection} at boot or the next delivery.
 */
export class RuntimeEventGate {
  constructor(private readonly ports: RuntimeEventGatePorts) {}
  private projectionDrain: Promise<void> | undefined
  private projectionRequested = false

  record(sessionId: SessionId, event: RuntimeEvent): RuntimeEventGateResult {
    if (isFineOnly(event)) return { kind: 'fine-live-only' }
    const session = this.ports.session(sessionId)
    if (!session) return { kind: 'rejected', reason: 'unknown-session' }
    if (!Number.isFinite(Date.parse(event.at))) {
      return { kind: 'rejected', reason: 'invalid-event-time' }
    }
    if (!turnEpochMatches(event)) {
      return { kind: 'rejected', reason: 'turn-epoch-mismatch' }
    }

    const current = this.ports.events.runtimeEventCheckpoint(sessionId)
    if (!current && event.provenance !== 'bootstrap') {
      return { kind: 'rejected', reason: 'replacement-requires-bootstrap' }
    }
    if (current) {
      const decision = this.decide(current, event)
      if (decision.kind === 'rejected') return decision
      if (decision.kind === 'duplicate') {
        if (decision.rebaseGeneration) {
          this.ports.persist(sessionId, () => {
            this.ports.events.saveRuntimeEventCheckpoint({
              ...current,
              observerGeneration: event.observerGeneration,
              updatedAt: new Date(this.ports.now()).toISOString(),
            })
          })
        }
        this.scheduleBoardProjection()
        return { kind: 'duplicate' }
      }
    }

    const next: RuntimeEventCheckpoint = {
      sessionId,
      observerGeneration: event.observerGeneration,
      cursor: event.cursor,
      turnEpoch: event.turnEpoch,
      closedTurnEpoch: closesTurn(event) ? event.turnEpoch : (current?.closedTurnEpoch ?? null),
      updatedAt: new Date(this.ports.now()).toISOString(),
    }
    session.recordRuntimeActivity(event.at)
    /**
     * THE ONE RUNTIME EVENT THAT CHANGES THE ROW'S STOP REASON (POD-2413).
     *
     * Recorded here rather than in the board projection because it is not a
     * board effect and must not wait on the oplog drain: an exit frame can be
     * milliseconds behind the kill, and a session that has already been stamped
     * `exited` gets its cause corrected by this call. Persisted with the event
     * in the same session-ledger write below.
     */
    if (event.t === 'process' && event.ev.ev === 'oomKilled') session.recordOomKill(event.at)
    let eventId = 0
    this.ports.persist(sessionId, () => {
      eventId = this.ports.events.appendEvent(
        {
          ts: event.at,
          kind: RUNTIME_EVENT_LOG_KIND,
          subject: sessionId,
          payload: event,
        },
        { announce: false },
      )
      this.ports.events.saveRuntimeEventCheckpoint(next)
    })
    this.ports.events.announceEvent(eventId)
    this.scheduleBoardProjection()
    return { kind: 'accepted', eventId }
  }

  ready(sessionId: SessionId): boolean {
    return this.ports.events.runtimeEventCheckpoint(sessionId) !== null
  }

  recent(sessionId: SessionId): readonly RuntimeEvent[] {
    return this.ports.events.listRuntimeEvents(sessionId)
  }

  /** Drain committed coarse events through the board's durable oplog cursor.
   * Concurrent deliveries share one drain, and the cursor moves only after the
   * complete asynchronous board effect resolves. */
  replayBoardProjection(): Promise<void> {
    this.projectionRequested = true
    if (this.projectionDrain) return this.projectionDrain
    const drain = this.runBoardProjection()
    this.projectionDrain = drain
    return drain
  }

  private async runBoardProjection(): Promise<void> {
    try {
      do {
        this.projectionRequested = false
        await this.drainBoardProjection()
      } while (this.projectionRequested)
    } finally {
      // Clear before this runner resolves: a later microtask must start a new
      // drain rather than observe a completed promise during teardown.
      this.projectionDrain = undefined
    }
  }

  private scheduleBoardProjection(): void {
    void this.replayBoardProjection().catch((err) => {
      log.warn('runtime board projection paused before cursor advance', { err })
    })
  }

  private async drainBoardProjection(): Promise<void> {
    let cursor = this.ports.events.runtimeEventProjectionCursor(BOARD_PROJECTOR)
    for (;;) {
      const batch = this.ports.events.listRuntimeEventsAfter(cursor, 128)
      if (batch.length === 0) return
      for (const record of batch) {
        await this.projectBoard(record)
        this.ports.events.saveRuntimeEventProjectionCursor(
          BOARD_PROJECTOR,
          record.id,
          new Date(this.ports.now()).toISOString(),
        )
        cursor = record.id
      }
    }
  }

  private decide(
    current: RuntimeEventCheckpoint,
    event: RuntimeEvent,
  ):
    | { kind: 'accept' }
    | { kind: 'duplicate'; rebaseGeneration: boolean }
    | Extract<RuntimeEventGateResult, { kind: 'rejected' }> {
    if (event.observerGeneration < current.observerGeneration) {
      return { kind: 'rejected', reason: 'stale-observer-generation' }
    }

    const replacing = event.observerGeneration > current.observerGeneration
    if (replacing) {
      if (event.observerGeneration !== current.observerGeneration + 1) {
        return { kind: 'rejected', reason: 'observer-generation-jump' }
      }
      if (event.provenance !== 'bootstrap') {
        return { kind: 'rejected', reason: 'replacement-requires-bootstrap' }
      }
    }

    const order = compareProviderCursor(current.cursor, event.cursor)
    if (order === 'incomparable') {
      return { kind: 'rejected', reason: 'unproven-segment-rotation' }
    }
    if (order === 'same_or_before') {
      return { kind: 'duplicate', rebaseGeneration: replacing }
    }
    if (!replacing && event.provenance === 'bootstrap') {
      return { kind: 'rejected', reason: 'cursor-not-after-checkpoint' }
    }

    if (event.turnEpoch < current.turnEpoch) {
      return { kind: 'rejected', reason: 'turn-epoch-regressed' }
    }
    if (current.closedTurnEpoch !== null && event.turnEpoch <= current.closedTurnEpoch) {
      return { kind: 'rejected', reason: 'terminal-epoch-closed' }
    }
    if (event.turnEpoch > current.turnEpoch) {
      if (event.turnEpoch !== current.turnEpoch + 1 || !startsTurn(event)) {
        return { kind: 'rejected', reason: 'turn-epoch-jump' }
      }
    }
    return { kind: 'accept' }
  }

  private async projectBoard(record: RuntimeEventLogRecord): Promise<void> {
    const { event, id: eventId, sessionId } = record
    if (event.t === 'workspace' && event.ev.ev === 'git-activity') {
      await this.ports.board({
        kind: 'gitActivity',
        sessionId,
        eventId,
        commits: [...event.ev.commits],
        touched: [...event.ev.touchedFiles],
      })
    }
    if (event.provenance !== 'live') return
    if (event.t === 'turn') {
      await this.ports.turn?.({ sessionId, ev: event.ev, at: event.at })
    }
    if (event.t === 'interaction') {
      await this.ports.interaction?.({ sessionId, ev: event.ev })
    }
    if (closesTurn(event)) await this.ports.board({ kind: 'turnEnd', sessionId, eventId })
    if (event.t === 'state' && event.change.kind === 'needs_user') {
      await this.ports.board({ kind: 'attention', sessionId, eventId })
    }
  }
}
