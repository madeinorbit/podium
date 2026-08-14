/**
 * THE SERVER'S HALF OF THE AGENT RUNTIME CONTRACT (POD-1761 W3; spec §9 phase 2).
 *
 * ---------------------------------------------------------------------------
 * WHY THE DELIVERY MODES SPLIT ACROSS THE WIRE
 * ---------------------------------------------------------------------------
 *
 * `send()` is one verb with four deliveries, and exactly one of them is already
 * complete on this side of the socket. `queue` means DURABLE: the FIFO is a
 * server DB table, so a queued turn survives a daemon restart, a machine going
 * offline and a session being parked — none of which a machine-local queue could
 * promise. Forwarding it would move the promise to the one place that cannot
 * keep it.
 *
 * So this gateway answers `queued(position)` from the durable queue itself and
 * never forwards, while `when-ready` and `interrupt` go to the driver, which runs
 * the injection state machine and answers with a receipt it can actually prove.
 * `steer` is the interesting one: the terminal family has no native steer, so it
 * degrades to `queue` — and the receipt reports `deliveredAs: 'queue'` rather
 * than quietly pretending the steer happened. That downgrade is decided HERE
 * because the queue that receives it is here.
 *
 * ---------------------------------------------------------------------------
 * WHAT W3 DELIBERATELY DOES NOT DO
 * ---------------------------------------------------------------------------
 *
 * It does not migrate a single caller. The ~29 send sites — messages, steward,
 * superagent, automations, revival — keep using `SessionInbox` exactly as they
 * do today; W4 moves them, cluster by cluster, behind the same flag. This module
 * is the destination that has to exist first, and its acceptance criterion is
 * that nothing routes through it yet and everything still works.
 */

import type { MachineId, MutationId, SessionId } from '@podium/model'
import type {
  InteractionAnswerOutcome,
  ObservationInputOrigin,
  Refusal,
  RuntimeEvent,
  TurnDelivery,
  TurnReceipt,
} from '@podium/protocol'
import type { InboxPrincipalReference } from './inbox'

/**
 * The durable FIFO, as this gateway needs it.
 *
 * `position` is 1-BASED and it is the queue's real depth, not a counter this
 * module keeps: the conformance corpus reads a position as a promise about
 * ordering, and a number that drifted from the table would be a promise nothing
 * kept.
 */
export interface RuntimeDurableQueuePort {
  enqueue(input: {
    sessionId: SessionId
    text: string
    origin: ObservationInputOrigin
    /**
     * WHO THE QUEUED TURN BELONGS TO.
     *
     * `SessionInbox.drain` re-authorizes with this immediately before the bytes
     * cross to the daemon — its own comment calls that call site "the security
     * boundary … Nothing accepted at enqueue is trusted now", because a row can
     * sit in the queue across a revocation, an ownership change or a session
     * moving machines. A queue that forgot its sender can only be drained as
     * whatever the default is, which grants every deferred turn privileges its
     * sender never had.
     */
    principal: InboxPrincipalReference
    /**
     * IDEMPOTENCY, CARRIED (POD-1761 W4).
     *
     * The durable row's primary key. Steward nudges and automation runs key it
     * to a fact/run id precisely so a crash-retry or a second poll re-enqueues
     * NOTHING — `queueText` recognises the id as already applied. Dropping it on
     * the way through would turn every retry into a duplicate turn.
     */
    mutationId?: MutationId
    /**
     * WHICH LEDGER ROW THIS TURN IS (POD-1761 W4).
     *
     * The messages module correlates the queued row back to its message by this
     * id: it is how a drain confirms the right row (`onQueuedInputApplied`), how
     * a cancellation finds the still-pending turns to delete
     * (`cancelQueuedMessage`), and how the sweep knows not to re-push something
     * already sitting in the queue (`hasQueuedMessage`). A queued turn that
     * forgot it would be undeliverable-to-the-ledger, uncancellable, and
     * re-pushed by the next sweep.
     */
    sourceMessageId?: string
  }): { ok: true; position: number } | { ok: false; reason: Refusal['reason']; detail?: string }
}

/** The four verbs that reach a machine. Structurally satisfied by
 *  `DaemonRpcService`; named here so this module depends on what it uses.
 *  `attach` and `snapshot` are contract verbs the DRIVER implements and no
 *  frame carries yet — see `packages/protocol/src/messages/runtime.ts`. */
export interface RuntimeDaemonRpcPort {
  runtimeSend(
    input: {
      sessionId: SessionId
      text: string
      origin: ObservationInputOrigin
      delivery: TurnDelivery
    },
    machineId: MachineId,
  ): Promise<TurnReceipt>
  runtimeInterrupt(
    sessionId: SessionId,
    machineId: MachineId,
  ): Promise<{ result: { ok: true } | Refusal }>
  runtimeAnswer(
    input: { sessionId: SessionId; interactionId: string; answer: Record<string, unknown> },
    machineId: MachineId,
  ): Promise<InteractionAnswerOutcome>
  runtimeLifecycle(
    input: { sessionId: SessionId; verb: 'stop' | 'hibernate' | 'kill' },
    machineId: MachineId,
  ): Promise<{ result: { ok: true } | Refusal }>
}

export interface SessionRuntimeGatewayPorts {
  rpc: RuntimeDaemonRpcPort
  queue: RuntimeDurableQueuePort
  /** The principal a send that named none is queued as. Supplied by the
   *  composition root rather than defaulted here, so "who does an unattributed
   *  turn act as" is answered in one visible place. */
  systemPrincipal(): InboxPrincipalReference
  /** Which machine holds this session, or undefined when nothing does. */
  machineOf(sessionId: SessionId): MachineId | undefined
  now(): number
}

/**
 * How many events per session the sink retains.
 *
 * SMALL ON PURPOSE. This is a diagnostic tail for the phase in which nothing
 * subscribes yet, not a replacement for the causal stream's own recovery story:
 * a consumer that missed events re-reads from `snapshot()` and its cursor, which
 * is the whole reason the envelope exists. A large buffer here would look like a
 * durability guarantee and would not be one.
 */
const EVENT_TAIL_SIZE = 64

export type RuntimeEventListener = (sessionId: SessionId, event: RuntimeEvent) => void

export class SessionRuntimeGateway {
  private readonly tails = new Map<SessionId, RuntimeEvent[]>()
  private readonly listeners = new Set<RuntimeEventListener>()

  constructor(private readonly ports: SessionRuntimeGatewayPorts) {}

  /**
   * Deliver one turn through the contract.
   *
   * Every path returns one of the four outcomes. A session on no machine is
   * `not_running` — which is what it is, and is the answer that lets a caller
   * branch instead of retrying into a socket that is not there.
   */
  async send(input: {
    sessionId: SessionId
    text: string
    origin: ObservationInputOrigin
    delivery: TurnDelivery
    /**
     * The party this send acts for.
     *
     * THE SERVER'S OWN PRINCIPAL TYPE, not the contract's reduced
     * `ActingPrincipal`, and deliberately so: this value's destination is the
     * durable queue row, which carries an attribution and a delegation
     * REFERENCE that `authorizeAtDrain` resolves against the live world. Passing
     * the contract's two-field shape here would mean reconstructing that
     * reference on the way back out, and a reconstructed delegation is exactly
     * the kind of guess an authorization boundary must not make.
     *
     * OPTIONAL ONLY AS A MIGRATION AFFORDANCE. Every caller W4 moves onto
     * receipts passes it; the fallback below is the composition root's system
     * default and is the weakness this field exists to close.
     */
    principal?: InboxPrincipalReference
  }): Promise<TurnReceipt> {
    if (input.delivery === 'queue' || input.delivery === 'steer') {
      const queued = this.ports.queue.enqueue({
        sessionId: input.sessionId,
        text: input.text,
        origin: input.origin,
        // NEVER A LOCAL DEFAULT. When a caller did not name itself the
        // composition root's own system principal is used — declared there,
        // where a reader can see what "system" means and W4 can watch it stop
        // being reached.
        principal: input.principal ?? this.ports.systemPrincipal(),
      })
      if (!queued.ok) {
        return {
          outcome: 'refused',
          refusal: {
            reason: queued.reason,
            ...(queued.detail === undefined ? {} : { detail: queued.detail }),
          },
        }
      }
      return {
        outcome: 'queued',
        position: queued.position,
        // THE DOWNGRADE, REPORTED. A caller that asked to steer learns it did not
        // steer — which is the difference between a degraded delivery and a lie.
        deliveredAs: 'queue',
        at: new Date(this.ports.now()).toISOString(),
      }
    }
    const machineId = this.ports.machineOf(input.sessionId)
    if (!machineId) {
      return { outcome: 'refused', refusal: { reason: 'not_running', detail: 'no machine' } }
    }
    return this.ports.rpc.runtimeSend(input, machineId)
  }

  /** REQUEST a fence. Nothing here waits for one: fences arrive only as
   *  provider-confirmed terminal events on the causal stream. */
  async interrupt(sessionId: SessionId): Promise<{ ok: true } | Refusal> {
    const machineId = this.ports.machineOf(sessionId)
    if (!machineId) return { reason: 'not_running', detail: 'no machine' }
    return (await this.ports.rpc.runtimeInterrupt(sessionId, machineId)).result
  }

  async answer(input: {
    sessionId: SessionId
    interactionId: string
    answer: Record<string, unknown>
  }): Promise<InteractionAnswerOutcome> {
    const machineId = this.ports.machineOf(input.sessionId)
    if (!machineId) return { ok: false, reason: 'unknown-interaction' }
    return this.ports.rpc.runtimeAnswer(input, machineId)
  }

  async lifecycle(
    sessionId: SessionId,
    verb: 'stop' | 'hibernate' | 'kill',
  ): Promise<{ ok: true } | Refusal> {
    const machineId = this.ports.machineOf(sessionId)
    if (!machineId) return { reason: 'not_running', detail: 'no machine' }
    return (await this.ports.rpc.runtimeLifecycle({ sessionId, verb }, machineId)).result
  }

  // -- the inbound stream ---------------------------------------------------

  /** The daemon's `runtimeEvent` frames, already ownership-checked by the
   *  session lifecycle that routes them here. */
  record(_machineId: MachineId, msg: { sessionId: SessionId; event: RuntimeEvent }): void {
    const tail = this.tails.get(msg.sessionId) ?? []
    tail.push(msg.event)
    if (tail.length > EVENT_TAIL_SIZE) tail.splice(0, tail.length - EVENT_TAIL_SIZE)
    this.tails.set(msg.sessionId, tail)
    for (const listener of [...this.listeners]) listener(msg.sessionId, msg.event)
  }

  /** Subscribe. Returns an unsubscribe, so a consumer that goes away cannot leak
   *  a listener into the next one's fan-out. */
  onEvent(listener: RuntimeEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** The retained tail for a session, newest last. Diagnostics only — see
   *  {@link EVENT_TAIL_SIZE} for why this is not a recovery mechanism. */
  recentEvents(sessionId: SessionId): readonly RuntimeEvent[] {
    return this.tails.get(sessionId) ?? []
  }

  forget(sessionId: SessionId): void {
    this.tails.delete(sessionId)
  }
}
