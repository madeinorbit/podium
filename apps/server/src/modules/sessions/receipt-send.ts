/**
 * THE SERVER'S SEND SEAM, AND THE ONE PLACE THE FLAG IS READ (POD-1761 W4;
 * spec §9 phase 2, server half).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT AN `await send()`
 * ---------------------------------------------------------------------------
 *
 * The obvious migration is to make every caller `await` a `TurnReceipt`. It is
 * the wrong one, and the acceptance criteria are what rule it out.
 *
 * A receipt is PROOF, and proof takes time: the terminal driver anchors
 * `accepted` on Claude's `UserPromptSubmit` hook and otherwise waits out a
 * verification window before it will say `unverified`. The verbs it replaces
 * (`sendText` / `queueText` / `interruptText`) are synchronous and answer a
 * different, smaller question — "were the bytes dispatched". Turning the path
 * async would defer every ledger write by at least a microtask, which reorders
 * the FLAG-OFF path that this item is required to leave byte-identical, and it
 * would break the messages module's own wire contract, whose `DeliveryOutcome`
 * is returned synchronously to CLI and tool callers.
 *
 * So a migrated caller still gets its answer synchronously, and the receipt
 * arrives later through `onReceipt` to RECONCILE what the caller recorded. That
 * is not a workaround for the contract; it is the policy this item was given —
 * mail and steward reconcile to delivered-unconfirmed (ledger-visible, never a
 * blind retry), chat keeps its optimistic bubble and reconciles on the echo.
 *
 * ---------------------------------------------------------------------------
 * WHAT ACTUALLY FLIPS
 * ---------------------------------------------------------------------------
 *
 * Not WHEN a caller hears something — WHERE THE OUTCOME COMES FROM.
 *
 * Flag off, an outcome is inferred: the server peeks at queue depth and session
 * status, predicts whether the PTY is ready, and reports its own prediction.
 * Flag on, the server states the delivery mode it wants and the driver reports
 * what actually happened, including a `deliveredAs` downgrade it would otherwise
 * have had to guess at. The urgency x lifecycle table above this seam keeps
 * reading phase to CHOOSE the mode — that is product policy and it is unchanged.
 * Phase stops being consulted for the RESULT.
 *
 * ---------------------------------------------------------------------------
 * WHY `queue` NEVER CROSSES THE WIRE
 * ---------------------------------------------------------------------------
 *
 * For the same reason `SessionRuntimeGateway` does not forward it: the durable
 * FIFO is a server table, so a queued turn survives a daemon restart, a machine
 * going offline and a parked session, and forwarding it would move that promise
 * to the one place that cannot keep it. Both this seam and the gateway complete
 * `queue` through the SAME {@link RuntimeDurableQueuePort}, so there is one
 * queue with one behaviour and two synchronous entrances to it.
 *
 * It also keeps W3's second review precondition satisfied by construction:
 * `host.authorizeAtDrain` has no provider on the daemon, so a forwarded
 * driver-side queue would drain unauthorized. Nothing here forwards one.
 */

import type { MutationId, SessionId } from '@podium/model'
import type { ObservationInputOrigin } from '@podium/protocol'
import type { RuntimeAttachmentRef, TurnDelivery, TurnReceipt } from '@podium/protocol/daemon'
import type { InboxPrincipalReference } from './inbox'
import type { RuntimeDurableQueuePort } from './runtime-gateway'

/**
 * HOW A MIGRATED CALLER NAMES ITS INTENT.
 *
 * Deliberately the vocabulary the callers already reason in, not the contract's
 * four deliveries: `messages` picks between "inject now", "ride the durable
 * queue" and "interrupt the open turn", and `wake` is the resume-then-send shape
 * steward and the superagent use. Mapping them onto `TurnDelivery` happens HERE,
 * once, where the reasoning can be written down — rather than at each of the ~29
 * call sites, where it would be re-derived slightly differently every time.
 */
export type ReceiptSendVia = 'now' | 'queue' | 'interrupt' | 'wake'

export interface ReceiptSendInput {
  sessionId: SessionId
  text: string
  attachments?: readonly RuntimeAttachmentRef[]
  inputOrigin?: ObservationInputOrigin
  principal?: InboxPrincipalReference
  sourceMessageId?: string
  mutationId?: MutationId
  /** Only the existing recovery interaction may cross a terminal provider failure. */
  allowErrored?: boolean
}

/** The legacy-shaped answer. IDENTICAL in both modes by design: it is what keeps
 *  every migrated caller's control flow — and its wire contract — unchanged. */
export interface ReceiptSendResult {
  ok: boolean
  queued?: boolean
  reason?: string
}

/** The legacy verbs, as this seam needs them. Structurally satisfied by
 *  `SessionInbox`; named here so the module depends on what it uses. */
export interface ReceiptSendLegacyPort {
  sendText(input: ReceiptSendInput): ReceiptSendResult
  queueText(input: ReceiptSendInput & { mutationId?: MutationId }): ReceiptSendResult
  interruptText(input: ReceiptSendInput): ReceiptSendResult
  resumeAndSend(input: ReceiptSendInput & { mutationId?: MutationId }): ReceiptSendResult
}

/** The contract path's machine-crossing half. `queue` is absent on purpose —
 *  see the header: it completes on this side and never travels. */
export interface ReceiptSendContractPort {
  send(input: {
    sessionId: SessionId
    turnId?: string
    text: string
    origin: ObservationInputOrigin
    delivery: Exclude<TurnDelivery, 'queue' | 'steer'>
    attachments?: readonly RuntimeAttachmentRef[]
    principal?: InboxPrincipalReference
  }): Promise<TurnReceipt>
}

export interface ReceiptSenderPorts {
  legacy: ReceiptSendLegacyPort
  contract: ReceiptSendContractPort
  /** The SAME durable FIFO the gateway completes `queue` through. */
  queue: RuntimeDurableQueuePort
  /**
   * Is this session driven through the contract RIGHT NOW.
   *
   * Per-session, never a global: receipts exist only for sessions the daemon
   * built a driver handle for, and a server that answered from its own env would
   * send callers down the receipt path for legacy-driven sessions on the same
   * machine. The fact is reported by the daemon on bind — see `BindMessage`.
   */
  onContract(sessionId: SessionId): boolean
  /**
   * Is there a live process to hand a turn to, with nothing already queued ahead
   * of it — the condition `resumeAndSend` uses today to send straight through
   * instead of riding the durable queue.
   *
   * A LIFECYCLE question, not a readiness prediction, and the distinction is the
   * whole reason it survives the migration. "Is the agent ready for bytes" is
   * exactly the guess receipts replace. "Does a process exist at all" is not
   * guessable from a receipt: `when-ready` to a parked session is refused
   * `not_running` by a driver that cannot wake anything, so routing a wake
   * through it would turn every steward nudge and superagent resume from "wakes
   * the session" into "dropped".
   */
  liveWithEmptyQueue(sessionId: SessionId): boolean
  /**
   * Is there older work in the SERVER's durable queue ahead of this send —
   * anything queued, or a drain in flight.
   *
   * An ordering fact, not a readiness one, and the driver cannot supply it: the
   * durable table is the server's and the driver has never seen it. See the
   * `orderingHold` note in `send` for why the distinction decides whether a
   * `now` may go straight to the driver.
   */
  queueNotEmpty(sessionId: SessionId): boolean
  /** Human-facing refusal for deliberate archive intent. Never overridable. */
  archiveReason?(sessionId: SessionId): string | undefined
  /** Human-facing refusal when the session is stopped on a non-retryable provider error. */
  failureReason?(sessionId: SessionId): string | undefined
  /** The principal an unattributed turn is queued as. Supplied by the composition
   *  root so "who is system" is answered in one visible place. */
  systemPrincipal(): InboxPrincipalReference
  now(): number
}

/** What a caller learns when the receipt lands. `via` and the input echo back so
 *  a reconciler that batched several sends can tell them apart. */
export type ReceiptReconciler = (receipt: TurnReceipt, via: ReceiptSendVia) => void

export class ReceiptSender {
  constructor(private readonly ports: ReceiptSenderPorts) {}

  /** Whether this session's sends produce receipts. Callers use it to decide
   *  whether a reconciliation is coming, never to decide delivery. */
  onContract(sessionId: SessionId): boolean {
    return this.ports.onContract(sessionId)
  }

  /**
   * Dispatch one turn.
   *
   * Returns the same synchronous answer the legacy verb would have returned. On
   * the contract path `onReceipt` fires later with the honest outcome — exactly
   * once, and never for a legacy send, so a caller can tell "no receipt is
   * coming" from "the receipt said nothing happened".
   */
  send(
    via: ReceiptSendVia,
    input: ReceiptSendInput,
    onReceipt?: ReceiptReconciler,
  ): ReceiptSendResult {
    // Archive is a deliberate human boundary, not an errored run. Recovery may
    // override the provider failure below, but it must never enqueue, forward,
    // or report success for an archived session.
    const archiveReason = this.ports.archiveReason?.(input.sessionId)
    if (archiveReason) return { ok: false, reason: archiveReason }
    const failureReason = this.ports.failureReason?.(input.sessionId)
    if (failureReason && !input.allowErrored) return { ok: false, reason: failureReason }
    if (!this.ports.onContract(input.sessionId)) {
      if (input.attachments?.length) {
        return this.refuseAttachments(via, 'this agent cannot accept file attachments', onReceipt)
      }
      return this.legacy(via, input)
    }

    // THE DURABLE MODES COMPLETE HERE, synchronously, through the same table the
    // gateway uses — so the caller's answer is as immediate and as true as it was
    // before, and the receipt it reconciles with is built from the same enqueue.
    //
    // `now` JOINS THEM WHENEVER THE SERVER FIFO IS NOT EMPTY, and that guard is
    // load-bearing rather than defensive. `sendText` queues instead of typing
    // when anything is already queued or draining, and it does so to preserve
    // ORDER: there are two queues once a driver exists — the server's durable
    // table and the driver's in-memory one — and nothing sequences between them.
    // A `when-ready` sent past a non-empty server queue would be typed BEFORE the
    // older messages still waiting to drain, silently reordering a conversation.
    //
    // This is the same distinction `liveWithEmptyQueue` draws for `wake`, and it
    // is worth being precise about, because "the server stops predicting
    // readiness" is exactly the kind of principle that eats an invariant it was
    // never aimed at: readiness ("can the agent take bytes now") is the driver's
    // question and the migration hands it over. Ordering ("is there older work
    // ahead of this") is a fact about the server's own table, which the driver
    // cannot see and therefore cannot answer.
    //
    // It applies to `wake` as well as `now`, and that is not belt-and-braces:
    // `liveWithEmptyQueue` reads the queue COUNT, which is already zero while
    // the last row is being drained. A wake arriving in that window would pass
    // the liveness check and overtake the row currently going out.
    const orderingHold =
      (via === 'now' || via === 'wake') && this.ports.queueNotEmpty(input.sessionId)
    if (
      via === 'queue' ||
      orderingHold ||
      (via === 'wake' && !this.ports.liveWithEmptyQueue(input.sessionId))
    ) {
      if (input.attachments?.length) {
        return this.refuseAttachments(
          via,
          'files cannot wait behind another turn; try again when pending messages have delivered',
          onReceipt,
        )
      }
      return this.enqueue(via, input, onReceipt)
    }

    // WHEN-READY IS THE HEART OF THE MIGRATION. Flag off, the server predicts
    // whether the PTY can take bytes right now (queue depth, `starting`, raw
    // first turn) and queues on its own guess. Flag on it says "when ready" and
    // the driver's injection state machine answers with what it did — including
    // `deliveredAs: 'queue'`, the downgrade the server used to have to infer.
    const delivery = via === 'interrupt' ? ('interrupt' as const) : ('when-ready' as const)
    const settled = this.ports.contract.send({
      sessionId: input.sessionId,
      ...(input.sourceMessageId ? { turnId: input.sourceMessageId } : {}),
      text: input.text,
      origin: input.inputOrigin ?? 'controller',
      delivery,
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      principal: input.principal ?? this.ports.systemPrincipal(),
    })
    // THE REJECTION IS HANDLED WHETHER OR NOT ANYONE IS LISTENING, and the
    // `onReceipt`-shaped version of this was a bug: a caller with no reconciler
    // to run (the superagent's spawn tool, an automation) still produces a
    // promise, and an unobserved rejection from a daemon that went away is an
    // unhandled rejection — which is a process-level event, not a quiet one. So
    // the handler is attached unconditionally and the reconciler is what is
    // optional.
    //
    // A RECEIPT THAT NEVER ARRIVES MUST NOT BE SILENT EITHER. A driver that died
    // mid-window rejects, and a caller waiting to reconcile a row would
    // otherwise wait forever — so the failure is reported AS a receipt, in the
    // vocabulary the caller already handles.
    settled.then(
      (receipt) => {
        onReceipt?.(receipt, via)
      },
      (err: unknown) => {
        onReceipt?.(
          {
            outcome: 'refused',
            refusal: {
              reason: 'not_running',
              detail: err instanceof Error ? err.message : String(err),
            },
          },
          via,
        )
      },
    )
    // OPTIMISTIC, AND THE RECONCILIATION IS WHAT MAKES IT HONEST. The bytes are
    // on their way; the receipt says whether they landed. This is the same claim
    // `sendText` makes today, made by a path that will later correct itself.
    return { ok: true }
  }

  private refuseAttachments(
    via: ReceiptSendVia,
    detail: string,
    onReceipt?: ReceiptReconciler,
  ): ReceiptSendResult {
    onReceipt?.({ outcome: 'refused', refusal: { reason: 'unsupported', detail } }, via)
    return { ok: false, reason: detail }
  }

  private enqueue(
    via: ReceiptSendVia,
    input: ReceiptSendInput,
    onReceipt?: ReceiptReconciler,
  ): ReceiptSendResult {
    const queued = this.ports.queue.enqueue({
      sessionId: input.sessionId,
      text: input.text,
      origin: input.inputOrigin ?? 'controller',
      principal: input.principal ?? this.ports.systemPrincipal(),
      ...(input.allowErrored ? { allowErrored: true } : {}),
      // EVERYTHING THE LEGACY VERB CARRIED, CARRIED. A queued turn that lost its
      // `mutationId` makes every steward/automation retry a duplicate rather
      // than a no-op; one that lost its `sourceMessageId` is invisible to the
      // ledger that has to confirm it, uncancellable, and re-pushed by the next
      // sweep. Neither failure would surface at the send — both surface later,
      // as duplicated or stuck work.
      ...(input.mutationId ? { mutationId: input.mutationId } : {}),
      ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
    })
    if (!queued.ok) {
      onReceipt?.(
        {
          outcome: 'refused',
          refusal: {
            reason: queued.reason,
            ...(queued.detail === undefined ? {} : { detail: queued.detail }),
          },
        },
        via,
      )
      // The legacy vocabulary for the same refusal, so an upstream branch that
      // recognises 'no resume ref' (and routes it to spawn-on-wake) still does.
      return { ok: false, reason: queued.detail ?? queued.reason }
    }
    onReceipt?.(
      {
        outcome: 'queued',
        position: queued.position,
        deliveredAs: 'queue',
        at: new Date(this.ports.now()).toISOString(),
      },
      via,
    )
    return { ok: true, queued: true }
  }

  private legacy(via: ReceiptSendVia, input: ReceiptSendInput): ReceiptSendResult {
    switch (via) {
      case 'now':
        return this.ports.legacy.sendText(input)
      case 'interrupt':
        return this.ports.legacy.interruptText(input)
      case 'queue':
        return this.ports.legacy.queueText(input)
      case 'wake':
        return this.ports.legacy.resumeAndSend(input)
    }
  }
}
