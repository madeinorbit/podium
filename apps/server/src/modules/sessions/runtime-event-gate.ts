import { type AgentStateEvent, compareProviderCursor } from '@podium/harness/metadata'
import { createLogger } from '@podium/logger'
import type { AgentRuntimeState, SessionId } from '@podium/model'
import type { InteractionEvent } from '@podium/protocol'
import type { SessionDurableState } from './session'
import { isRuntimeFineEvent, type RuntimeEvent, type TurnEvent } from '@podium/protocol/daemon'
import {
  type EventsRepository,
  RUNTIME_EVENT_LOG_KIND,
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
  recordRuntimeActivity(at: string, draft: SessionDurableState): boolean
  /** A kernel OOM kill the machine's supervisor observed in this session's
   *  scope (POD-2413). Explains an exit; never causes one. */
  recordOomKill(at: string, draft: SessionDurableState): void
}

/** The state transition made by an accepted causal state event. The mutation
 * happens inside the session-ledger transaction; publication happens only
 * after that transaction commits. */
export interface RuntimeStateProjection {
  prev: AgentRuntimeState | undefined
  next: AgentRuntimeState
}

export interface RuntimeEventGatePorts {
  metadata?(sessionId: SessionId, event: Extract<RuntimeEvent, { t: 'metadata' }>): Promise<void>
  binding?(sessionId: SessionId, event: Extract<RuntimeEvent, { t: 'binding' }>): Promise<void>
  delivery?(sessionId: SessionId, event: Extract<RuntimeEvent, { t: 'delivery' }>): Promise<void>
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
  persist(sessionId: SessionId, additionalWrite: () => void | Promise<void>): Promise<void>
  /** {@link persist} with the session's own durable write applied to the draft
   *  the commit persists [POD-3330]. The transaction body is handed that same
   *  draft, because the state projection inside it writes the session too — and
   *  a write that landed on the live object there would not reach the row. */
  write(
    sessionId: SessionId,
    mutate: (draft: SessionDurableState) => void,
    additionalWrite: (draft: SessionDurableState) => void | Promise<void>,
  ): Promise<void>
  /** Apply the normalized state event atomically with its runtime-event row. */
  state?(input: {
    sessionId: SessionId
    change: AgentStateEvent
    at: string
    /** The draft this event's session write persists [POD-3330]. */
    draft: SessionDurableState
  }): RuntimeStateProjection | undefined
  /** Publish the committed state to the same consumers as the compatibility
   * agentState frame. This is deliberately downstream of {@link state}. */
  stateChanged?(input: RuntimeStateProjection & { sessionId: SessionId }): Promise<void>
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
  }): Promise<void>
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
  interaction?(input: { sessionId: SessionId; ev: InteractionEvent }): Promise<void>
  /**
   * Contract-only workspace moves (cwd-changed). The legacy sessionCwd frame
   * owns this for non-contract sessions; for contract sessions this port is
   * the single projection that updates the row and adopts the issue worktree.
   * Projected through the durable oplog drain like {@link board}, so a crash
   * between commit and fan-out re-delivers rather than loses the move. The
   * consumer must be safe to repeat (row update asks "did this actually
   * change?" before writing; adoption is guarded on worktreePath null).
   */
  workspace?(input: {
    sessionId: SessionId
    eventId: number
    cwd: string
    kind?: 'main' | 'worktree' | 'none'
    branch?: string
    repoRoot?: string
    explicit?: boolean
  }): Promise<void>
  /**
   * Contract-only browser opens. The daemon's BrowserOpenManager still owns
   * the pending capability and executes the loopback callback; this port is
   * how the server's gateway learns the request without the legacy
   * sessionOpenUrl frame. Durable through the oplog drain; the gateway
   * dedupes by sessionId:requestId, so replay is safe. A URL-only event
   * degrades to a link offer with no callback capability — it never mints
   * one.
   */
  openUrl?(input: {
    sessionId: SessionId
    eventId: number
    url: string
    intent: 'login' | 'link'
    requestId?: string
    callbackTarget?: { host: 'localhost' | '127.0.0.1' | '::1'; port: number; path: string }
    expiresAt?: number
  }): Promise<void>
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
  ): Promise<void>
  now(): number
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
  private readonly readySessions = new Set<SessionId>()
  private projectionDrain: Promise<void> | undefined
  private projectionRequested = false

  async record(sessionId: SessionId, event: RuntimeEvent): Promise<RuntimeEventGateResult> {
    if (isRuntimeFineEvent(event)) return { kind: 'fine-live-only' }
    const session = this.ports.session(sessionId)
    if (!session) return { kind: 'rejected', reason: 'unknown-session' }
    if (!Number.isFinite(Date.parse(event.at))) {
      return { kind: 'rejected', reason: 'invalid-event-time' }
    }
    if (!turnEpochMatches(event)) {
      return { kind: 'rejected', reason: 'turn-epoch-mismatch' }
    }

    const current = await this.ports.events.runtimeEventCheckpoint(sessionId)
    if (current) this.readySessions.add(sessionId)
    // A brand-new generation-one stream can have an empty bootstrap snapshot.
    // Its first event is live; replacement generations still need bootstrap.
    if (!current && event.provenance !== 'bootstrap' && event.observerGeneration !== 1) {
      return { kind: 'rejected', reason: 'replacement-requires-bootstrap' }
    }
    if (current) {
      const decision = this.decide(current, event)
      if (decision.kind === 'rejected') return decision
      if (decision.kind === 'duplicate') {
        if (decision.rebaseGeneration) {
          await this.ports.persist(sessionId, async () => {
            await this.ports.events.saveRuntimeEventCheckpoint({
              ...current,
              observerGeneration: event.observerGeneration,
              updatedAt: new Date(this.ports.now()).toISOString(),
            })
          })
        }
        await this.scheduleBoardProjection()
        return { kind: 'duplicate' }
      }
    }

    const next: RuntimeEventCheckpoint = {
      sessionId,
      observerGeneration: event.observerGeneration,
      cursor: event.cursor,
      // Auxiliary workspace/browser events carry the session's identity, not a
      // turn's: their epoch is ordering only. Never regress the checkpoint's
      // turnEpoch on a late auxiliary (origin epoch < current after the next
      // turn started) — that would relabel old work as current and move the
      // fence other arms read. Take the max so late results admit without
      // moving the turn lifecycle at all.
      turnEpoch:
        event.t === 'workspace' || event.t === 'open-url'
          ? Math.max(current?.turnEpoch ?? 0, event.turnEpoch)
          : event.turnEpoch,
      closedTurnEpoch: closesTurn(event) ? event.turnEpoch : (current?.closedTurnEpoch ?? null),
      updatedAt: new Date(this.ports.now()).toISOString(),
    }
    let eventId = 0
    let stateProjection: RuntimeStateProjection | undefined
    // BOTH SESSION WRITES LAND ON THE DRAFT THIS COMMIT PERSISTS [POD-3330].
    // They used to be assigned onto the live session in the two statements
    // above this one, where a durable failure left them standing and a
    // concurrent writer could pick them up and commit them.
    await this.ports.write(
      sessionId,
      (draft) => {
        if (event.t !== 'draft' && event.t !== 'metadata' && event.t !== 'transcript-reset') session.recordRuntimeActivity(event.at, draft)
        /**
         * THE ONE RUNTIME EVENT THAT CHANGES THE ROW'S STOP REASON (POD-2413).
         *
         * Recorded here rather than in the board projection because it is not a
         * board effect and must not wait on the oplog drain: an exit frame can
         * be milliseconds behind the kill, and a session that has already been
         * stamped `exited` gets its cause corrected by this call. Persisted
         * with the event in the same session-ledger write.
         */
        if (event.t === 'process' && event.ev.ev === 'oomKilled')
          session.recordOomKill(event.at, draft)
      },
      async (draft) => {
        if (event.t === 'state') {
          stateProjection = this.ports.state?.({
            sessionId,
            change: event.change as AgentStateEvent,
            at: event.at,
            draft,
          })
        }
        eventId = await this.ports.events.appendEvent(
          {
            ts: event.at,
            kind: RUNTIME_EVENT_LOG_KIND,
            subject: sessionId,
            payload: event,
          },
          { announce: false },
        )
        await this.ports.events.saveRuntimeEventCheckpoint(next)
      },
    )
    this.readySessions.add(sessionId)
    await this.ports.events.announceEvent(eventId)
    if (stateProjection) {
      await this.ports.stateChanged?.({ sessionId, ...stateProjection })
    }
    await this.scheduleBoardProjection()
    return { kind: 'accepted', eventId }
  }

  async hydrateReady(sessionIds: Iterable<SessionId>): Promise<void> {
    const resolved = await Promise.all(
      [...sessionIds].map(async (sessionId) => ({
        sessionId,
        ready: (await this.ports.events.runtimeEventCheckpoint(sessionId)) !== null,
      })),
    )
    for (const item of resolved) {
      if (item.ready) this.readySessions.add(item.sessionId)
    }
  }

  ready(sessionId: SessionId): boolean {
    return this.readySessions.has(sessionId)
  }

  async recent(sessionId: SessionId): Promise<readonly RuntimeEvent[]> {
    return await this.ports.events.listRuntimeEvents(sessionId)
  }

  /** Drain committed coarse events through the board's durable oplog cursor.
   * Concurrent deliveries share one drain, and the cursor moves only after the
   * complete asynchronous board effect resolves. */
  async replayBoardProjection(): Promise<void> {
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

  private async scheduleBoardProjection(): Promise<void> {
    void this.replayBoardProjection().catch((err) => {
      log.warn('runtime board projection paused before cursor advance', { err })
    })
  }

  private async drainBoardProjection(): Promise<void> {
    let cursor = await this.ports.events.runtimeEventProjectionCursor(BOARD_PROJECTOR)
    for (;;) {
      const batch = await this.ports.events.listRuntimeEventsAfter(cursor, 128)
      if (batch.length === 0) return
      for (const record of batch) {
        await this.projectBoard(record)
        await this.ports.events.saveRuntimeEventProjectionCursor(
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

    // A full bootstrap in the immediately succeeding lease is a state restore,
    // not replayed activity. Its daemon-local sequence may restart at one.
    const restoringState =
      replacing &&
      event.provenance === 'bootstrap' &&
      event.t === 'state' &&
      event.change.kind === 'state_snapshot'
    if (restoringState) {
      const { seq: _oldSequence, ...before } = current.cursor.components
      const { seq: _newSequence, ...after } = event.cursor.components
      if (compareProviderCursor(
        { ...current.cursor, components: before },
        { ...event.cursor, components: after },
      ) === 'incomparable') return { kind: 'rejected', reason: 'unproven-segment-rotation' }
      // Only the driver's sequence restarts. Provider evidence cannot go backwards
      // inside the same file/segment under a fresh observer lease.
      if (current.cursor.segmentId === event.cursor.segmentId &&
          Object.entries(before).some(([key, value]) => (after[key] ?? 0) < value)) {
        return { kind: 'rejected', reason: 'cursor-not-after-checkpoint' }
      }
      if (event.turnEpoch < current.turnEpoch)
        return { kind: 'rejected', reason: 'turn-epoch-regressed' }
      return { kind: 'accept' }
    }

    const order = compareProviderCursor(current.cursor, event.cursor)
    if (order === 'incomparable') {
      return { kind: 'rejected', reason: 'unproven-segment-rotation' }
    }
    if (order === 'same_or_before') {
      return { kind: 'duplicate', rebaseGeneration: replacing }
    }
    if (
      !replacing &&
      event.provenance === 'bootstrap' &&
      !(event.t === 'state' && event.change.kind === 'state_snapshot') &&
      event.t !== 'metadata' &&
      !(current.turnEpoch === 0 && event.turnEpoch === 0) &&
      !(event.t === 'state' && event.change.kind === 'state_snapshot') &&
      event.t !== 'transcript-reset'
    ) {
      return { kind: 'rejected', reason: 'cursor-not-after-checkpoint' }
    }

    if (event.turnEpoch < current.turnEpoch) {
      // LIFECYCLE-INDEPENDENT WORKSPACE ADMISSION (POD-4308 C17).
      //
      // Workspace moves, git-activity and browser opens are auxiliary: they
      // carry the session's identity, not a turn's. A slow post-tool git
      // result can resolve after its turn completed, after the next turn
      // started, or after the cwd moved — and must still attribute exactly
      // once to the session's issue without reopening the turn, resurrecting
      // Working, or counting as next-turn work. The board attributes by
      // session/issue, never by epoch, so the epoch here is ordering only.
      // Exempting these arms from turn-epoch fences is what lets late results
      // survive while turn finality stays intact for every other arm.
      if (event.t !== 'workspace' && event.t !== 'open-url') {
        return { kind: 'rejected', reason: 'turn-epoch-regressed' }
      }
    }
    // Process and row delivery lifecycles are independent of the last turn. A child can die after
    // its final turn has closed, and that exit must remain an admissible causal
    // event rather than being mistaken for a late turn update. Workspace and
    // browser auxiliaries join that set for the same reason: a commit observed
    // after completion is still that session's commit.
    if (
      current.closedTurnEpoch !== null &&
      event.turnEpoch <= current.closedTurnEpoch &&
      event.t !== 'process' &&
      event.t !== 'delivery' &&
      event.t !== 'binding' &&
      event.t !== 'draft' &&
      event.t !== 'metadata' &&
      !(event.t === 'state' && event.change.kind === 'state_snapshot') &&
      event.t !== 'transcript-reset' &&
      event.t !== 'workspace' &&
      event.t !== 'open-url'
    ) {
      return { kind: 'rejected', reason: 'terminal-epoch-closed' }
    }
    if (event.turnEpoch > current.turnEpoch) {
      if (
        event.t !== 'workspace' &&
        event.t !== 'open-url' &&
        !(
          event.provenance === 'bootstrap' &&
          event.t === 'state' &&
          event.change.kind === 'state_snapshot'
        ) &&
        (event.turnEpoch !== current.turnEpoch + 1 || !startsTurn(event))
      ) {
        return { kind: 'rejected', reason: 'turn-epoch-jump' }
      }
    }
    return { kind: 'accept' }
  }

  private async projectBoard(record: RuntimeEventLogRecord): Promise<void> {
    const { event, id: eventId, sessionId } = record
    if (event.t === 'metadata') await this.ports.metadata?.(sessionId, event)
    if (event.t === 'binding') await this.ports.binding?.(sessionId, event)
    if (event.t === 'delivery') await this.ports.delivery?.(sessionId, event)
    if (event.t === 'workspace' && event.ev.ev === 'git-activity') {
      await this.ports.board({
        kind: 'gitActivity',
        sessionId,
        eventId,
        commits: [...event.ev.commits],
        touched: [...event.ev.touchedFiles],
      })
    }
    // Workspace moves and browser opens are durable projections, not live-only
    // turn effects: they must survive server restart via the oplog cursor, and
    // the consumers dedupe (cwd asks "did this actually change?", gateway by
    // requestId), so replay is safe. Provenance is not checked here — a
    // bootstrap cwd still corrects the row after a replacement generation.
    if (event.t === 'workspace' && event.ev.ev === 'cwd-changed') {
      await this.ports.workspace?.({
        sessionId,
        eventId,
        cwd: event.ev.cwd,
        ...(event.ev.kind ? { kind: event.ev.kind } : {}),
        ...(event.ev.branch ? { branch: event.ev.branch } : {}),
        ...(event.ev.repoRoot ? { repoRoot: event.ev.repoRoot } : {}),
        ...(event.ev.explicit ? { explicit: true } : {}),
      })
    }
    if (event.t === 'open-url') {
      await this.ports.openUrl?.({
        sessionId,
        eventId,
        url: event.ev.url,
        intent: event.ev.intent,
        ...(event.ev.requestId ? { requestId: event.ev.requestId } : {}),
        ...(event.ev.callbackTarget ? { callbackTarget: event.ev.callbackTarget } : {}),
        ...(event.ev.expiresAt !== undefined ? { expiresAt: event.ev.expiresAt } : {}),
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
    if (
      event.t === 'state' &&
      (event.change.kind === 'needs_user' ||
        (event.change.kind === 'state_snapshot' &&
          (event.change.state as { phase?: string } | undefined)?.phase === 'needs_user'))
    ) {
      await this.ports.board({ kind: 'attention', sessionId, eventId })
    }
  }
}
