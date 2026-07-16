import type {
  AgentRuntimeState,
  ConversationSummaryWire,
  HostMetricsWire,
  IssueWire,
  MetadataChange,
  SessionMeta,
  TranscriptItem,
} from '@podium/protocol'

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
    sessionId: string
    prev: AgentRuntimeState | undefined
    next: AgentRuntimeState
  }
  /** A session's process ended (agentExit / reattachFailed death). */
  'session.exited': { sessionId: string; code: number }
  /** The session list changed in a way that was broadcast (post-fanout). */
  'session.listChanged': { sessions: SessionMeta[] }
  /** One issue changed and was published (single-issue fast path, issue #22). */
  'issue.updated': { issue: IssueWire }
  /** An issue reached the closed stage. */
  'issue.closed': { issueId: string }
  /** A closed issue was reopened. */
  'issue.reopened': { issueId: string }
  /** New transcript items were applied to a session's live delta buffer. */
  'transcript.delta': { sessionId: string; items: TranscriptItem[] }
  /** A machine's daemon socket attached. */
  'machine.connected': { machineId: string }
  /** A machine's daemon socket detached. */
  'machine.disconnected': { machineId: string }
  /** A host reported a fresh metrics sample. */
  'host.metrics': { sample: HostMetricsWire }
  /** An agent needs attention (the attention-notice seam notify consumes). */
  'attention.raised': { sessionId: string; title: string; body: string }
  /** Settings were replaced via setSettings (previous → next). */
  'settings.changed': {
    previous: import('@podium/runtime').PodiumSettings
    next: import('@podium/runtime').PodiumSettings
  }
  /** Durable metadata oplog rows were appended (post-record, pre/post-fanout). */
  'oplog.appended': { changes: MetadataChange[] }
  /** The conversation index changed and was broadcast. */
  'conversations.changed': { conversations: ConversationSummaryWire[] }
  /** Agent mail was sent to an issue (issue #103) — the sessions module picks a
   *  live member session to nudge. */
  'issue.mailSent': { seq: number; worktreePath?: string }
  /** The hub-reachability flag flipped (spec §2.3) — the conversation and issue
   *  mirrors rebroadcast their stale overlays on this. */
  'upstream.staleChanged': { stale: boolean }
  /** A superagent turn finished (success or failure) — the messaging bridge
   *  [spec:SP-5d81] relays `output` to external chat channels. Fired for EVERY
   *  turn on the thread regardless of who dispatched it (web UI or a bridge). */
  'superagent.turnEnded': {
    threadId: string
    podiumSessionId: string
    ok: boolean
    output?: string
    error?: string
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
    const set = this.listeners.get(event)
    if (!set) return
    // Snapshot so a listener that unsubscribes (or subscribes) mid-dispatch
    // doesn't mutate the iteration.
    for (const listener of [...set]) {
      try {
        listener(payload)
      } catch (err) {
        console.warn(`[podium:bus] listener for '${event}' threw:`, err)
      }
    }
  }

  listenerCount(event: EventName): number {
    return this.listeners.get(event)?.size ?? 0
  }

  removeAll(): void {
    this.listeners.clear()
  }
}
