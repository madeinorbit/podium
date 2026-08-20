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
  'session.created': { sessionId: SessionId; agentKind: AgentKind }
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
        kind: 'activity' | 'attention' | 'turnEnd'
        sessionId: SessionId
        eventId: number
      }
  /** A remote session asked its host to open a browser URL. [spec:SP-a43e] */
  'session.openUrl': SessionOpenUrlMessage
  /** One issue changed and was published (single-issue fast path, issue #22). */
  'issue.updated': { issue: IssueWire }
  /** An issue reached the closed stage. */
  'issue.closed': { issueId: IssueId }
  /** A closed issue was reopened. */
  'issue.reopened': { issueId: IssueId }
  /** New transcript items were applied to a session's live delta buffer. */
  'transcript.delta': { sessionId: SessionId; items: TranscriptItem[] }
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
  'attention.raised': { sessionId: SessionId; title: string; body: string }
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
  /** Agent mail was sent to an issue (issue #103) — the sessions module picks a
   *  live member session to nudge. */
  'issue.mailSent': { seq: number; worktreePath?: string }
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
}

export type EventName = keyof EventMap
export type Listener<E extends EventName> = (payload: EventMap[E]) => void

/**
 * Minimal typed emitter over {@link EventMap}. Synchronous dispatch (emit
 * returns after every listener ran) so ordering stays deterministic for tests;
 * per-listener try/catch so one broken observer can't break the emitter or
 * its sibling subscribers.
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
      listener(payload)
    })
    return dispose
  }

  emit<E extends EventName>(event: E, payload: EventMap[E]): void {
    this.dispatch(event, payload, false)
  }

  /** Durable projector dispatch: finish sibling listeners, then report failure
   * so the caller can leave its oplog cursor before the unprojected row. */
  emitDurable<E extends EventName>(event: E, payload: EventMap[E]): void {
    this.dispatch(event, payload, true)
  }

  private dispatch<E extends EventName>(event: E, payload: EventMap[E], rethrow: boolean): void {
    const set = this.listeners.get(event)
    if (!set) return
    let failure: unknown
    for (const listener of [...set]) {
      try {
        listener(payload)
      } catch (err) {
        failure ??= err
        log.warn('event listener threw', { err, event })
      }
    }
    if (rethrow && failure) throw failure
  }

  listenerCount(event: EventName): number {
    return this.listeners.get(event)?.size ?? 0
  }

  removeAll(): void {
    this.listeners.clear()
  }
}
