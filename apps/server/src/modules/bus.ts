import { createLogger } from '@podium/logger'
import type {
  AgentKind,
  AgentRuntimeState,
  ConversationSummaryWire,
  HarnessAgent,
  HostMetricsWire,
  IssueWire,
  SessionId,
  SessionMeta,
  TranscriptItem,
  UserId,
  IssueId,
  MachineId,
  ThreadId,
} from '@podium/model'
import type { LogOrigin } from '@podium/commands'
import type { AgentObservation, MetadataChange, SessionOpenUrlMessage } from '@podium/protocol'
import type { DaemonMessage } from '@podium/protocol/daemon'
import type { InboxPrincipalReference } from './sessions/inbox'
import type { HarnessErrorKind } from './superagent/harness-error'

const log = createLogger('server:bus')

/**
 * The typed in-process event map (architecture redesign, issue #13 Phase 2).
 *
 * Feature modules communicate through this bus when a call is a NOTIFICATION
 * (fire-and-forget, no return value); calls that need an answer stay direct
 * service-to-service calls on an acyclic dependency graph (see modules/index.ts).
 *
 * Rules:
 * - No wildcard/stringly events: every event name and payload is declared here.
 * - Emit AFTER the state change is applied (subscribers observe the new world).
 * - Subscriber errors are isolated per-listener (an observer must never take
 *   down the mutation path that emitted).
 */
export interface EventMap {
  /**
   * A human client authenticated (POST /auth/login, either delivery shape).
   * Emitted AFTER the session row is written, so a login that failed to persist
   * is never reported as one.
   */
  'auth.login': { userId: UserId; delivery: 'cookie' | 'native'; platform?: string }
  /** A session's agent runtime state changed (daemon agentState message). */
  'session.stateChanged': {
    sessionId: SessionId
    prev: AgentRuntimeState | undefined
    /** Owning human for per-user attention routing; absent events fail closed. */
    ownerUserId?: UserId
    next: AgentRuntimeState
    /** Present only for a v1 accepted causal live transition [spec:SP-cdb2]. */
    observation?: AgentObservation
  }
  /** A session was created by an operator/programmatic caller (createSession —
   *  the one funnel for fresh spawns; resumes and reattaches do not fire it). */
  'session.created': { sessionId: SessionId; agentKind: AgentKind; issueId?: IssueId }
  /** A session's process ended (agentExit / reattachFailed death). */
  'session.exited': { sessionId: SessionId; code: number }
  /** Durable queued input requested a best-effort asynchronous wake. */
  'session.wakeRequested': { sessionId: SessionId; principal: InboxPrincipalReference }
  /** System derived-field maintenance driven by committed/live session facts. */
  'issue.sessionDerived':
    | {
        kind: 'gitActivity'
        sessionId: SessionId
        eventId?: number
        commits?: string[]
        touched?: string[]
      }
    | {
        kind: 'activity' | 'attention' | 'turnEnd' | 'removedOrArchived'
        sessionId: SessionId
        eventId?: number
      }
    | {
        kind: 'adoptWorktree'
        issueId: IssueId
        machineId: MachineId
        message: Extract<DaemonMessage, { type: 'sessionCwd' }>
      }
  /** Oplog-replayed board/recency vertical slice; every input has a durable id. */
  'issue.runtimeDerived':
    | {
        kind: 'gitActivity'
        sessionId: SessionId
        eventId: number
        commits?: string[]
        touched?: string[]
      }
    | {
        kind: 'attention' | 'turnEnd'
        sessionId: SessionId
        eventId: number
      }
  /** A remote session asked its host to open a browser URL. [spec:SP-a43e] */
  'session.openUrl': SessionOpenUrlMessage
  /**
   * An issue was created by the create funnel — NOT any later mutation. The
   * in-process twin of the `issue.created` row `crud.ts` already appends to the
   * durable event log, emitted from the same line, so the two can never disagree
   * about when an issue came into existence.
   */
  'issue.created': { issueId: IssueId; title: string; ownerUserId: UserId }
  /** One issue changed and was published (single-issue fast path, issue #22). */
  'issue.updated': { issue: IssueWire }
  /** An issue reached the closed stage. */
  'issue.closed': { issueId: IssueId }
  /** A closed issue was reopened. */
  'issue.reopened': { issueId: IssueId }
  /** New transcript items were applied to a session's live delta buffer. */
  'transcript.delta': { sessionId: SessionId; items: TranscriptItem[]; reset?: boolean }
  /** A machine's daemon socket attached. */
  'machine.connected': { machineId: MachineId }
  /** A machine's daemon socket detached. */
  'machine.disconnected': { machineId: MachineId }
  /** Durable machine metadata changed; session machine-name projections recapture.
   * `inventory` distinguishes a fresh daemon report from rename/grant changes. */
  'machine.metadataChanged': { machineId: MachineId; inventory?: true }
  /** Host integration degradation, scoped from the authenticated daemon principal. */
  'machine.diagnostic': {
    machineId: MachineId
    code: string
    title: string
    body: string
    description?: string
    observedVersion?: string
  }
  /** A host reported a fresh metrics sample. */
  'host.metrics': { sample: HostMetricsWire }
  /** An agent needs attention (the attention-notice seam notify consumes). */
  'attention.raised': {
    sessionId: SessionId
    ownerUserId: UserId
    title: string
    body: string
  }
  /** Per-user Telegram delivery requested after notification policy decides to push. */
  'notification.telegramRequested': {
    ownerUserId: UserId
    text: string
    sessionId?: SessionId
  }
  /** Settings were replaced via setSettings (previous → next). */
  'settings.changed': {
    previous: import('@podium/runtime').PodiumSettings
    next: import('@podium/runtime').PodiumSettings
  }
  /** Durable metadata oplog rows were appended (post-record, pre/post-fanout). */
  /** The ordered metadata feed published through `seq`; projections may advance. */
  'feed.published': { seq: number }
  'oplog.appended': { changes: MetadataChange[] }
  /** The conversation index changed and was broadcast. */
  'conversations.changed': { conversations: ConversationSummaryWire[] }
  /** Agent mail was sent to an issue (issue #103) — the sessions module resolves
   *  live membership and coordinator from the canonical issue id. */
  'issue.mailSent': { issueId: IssueId; seq: number }
  /** Durable refusal committed; sender notification is an asynchronous nudge. */
  'message.deadLettered': { messageId: string; reason: string }
  /** The hub-reachability flag flipped (spec §2.3) — the conversation and issue
   *  mirrors rebroadcast their stale overlays on this. */
  'upstream.staleChanged': { stale: boolean }
  /** A superagent turn finished (success or failure) — the messaging bridge
   *  [spec:SP-5d81] relays `output` to external chat channels. Fired for EVERY
   *  turn on the thread regardless of who dispatched it (web UI or a bridge). */
  'superagent.turnEnded': {
    /** Owner of the personal superagent thread; outbound reactions route by it. */
    ownerUserId?: UserId
    threadId: ThreadId
    podiumSessionId: SessionId
    ok: boolean
    output?: string
    error?: string
    /** Present when a failed turn was classified by the harness classifier. */
    harness?: HarnessAgent
    harnessErrorKind?: HarnessErrorKind
  }
  /**
   * A client crash was stored (modules/logs/service.ts).
   *
   * Carries the serialized error AS IT ARRIVED and deliberately NOT
   * `input.snapshot`: the snapshot is the client's whole log ring buffer, which
   * is what makes the durable crash event useful to support and exactly what a
   * subscriber that only needs the error has no business forwarding anywhere.
   */
  'client.crashed': { origin: LogOrigin; err: unknown; crashId?: string }
}

export type EventName = keyof EventMap
export type Listener<E extends EventName> = (payload: EventMap[E]) => unknown

/**
 * Minimal typed emitter over {@link EventMap}. Regular dispatch invokes every
 * listener synchronously and observes asynchronous rejection without blocking;
 * durable dispatch additionally awaits every listener before it returns.
 */
export class EventBus {
  private readonly listeners = new Map<EventName, Set<Listener<EventName>>>()

  on<E extends EventName>(event: E, listener: Listener<E>): () => void {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(listener as Listener<EventName>)
    return () => this.off(event, listener)
  }

  off<E extends EventName>(event: E, listener: Listener<E>): void {
    this.listeners.get(event)?.delete(listener as Listener<EventName>)
  }

  once<E extends EventName>(event: E, listener: Listener<E>): () => void {
    const dispose = this.on(event, (payload) => {
      dispose()
      return listener(payload)
    })
    return dispose
  }

  emit<E extends EventName>(event: E, payload: EventMap[E]): void {
    const set = this.listeners.get(event)
    if (!set) return
    for (const listener of [...set]) {
      try {
        void Promise.resolve(listener(payload)).catch((err) =>
          log.warn('event listener rejected', { err, event }),
        )
      } catch (err) {
        log.warn('event listener threw', { err, event })
      }
    }
  }

  /** Durable projector dispatch: await every sibling listener, then report the
   * first failure so the caller leaves its oplog cursor before the row. */
  async emitDurable<E extends EventName>(event: E, payload: EventMap[E]): Promise<void> {
    const set = this.listeners.get(event)
    if (!set) return
    const pending: Promise<unknown>[] = []
    for (const listener of [...set]) {
      try {
        pending.push(Promise.resolve(listener(payload)))
      } catch (err) {
        pending.push(Promise.reject(err))
      }
    }
    const settled = await Promise.allSettled(pending)
    let failure: unknown
    for (const result of settled) {
      if (result.status === 'rejected') {
        failure ??= result.reason
        const err = result.reason
        log.warn('durable event listener rejected', { err, event })
      }
    }
    if (failure) throw failure
  }

  listenerCount(event: EventName): number {
    return this.listeners.get(event)?.size ?? 0
  }

  removeAll(): void {
    this.listeners.clear()
  }
}
