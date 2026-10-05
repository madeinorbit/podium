/**
 * THE SERVER'S SEND SEAM, AND THE ONE PLACE THE ROUTE IS READ (POD-1761 W4;
 * spec §9 phase 2, server half; one route since POD-4427).
 *
 * ---------------------------------------------------------------------------
 * EVERY AGENT SEND IS ONE DURABLE ROW (POD-4795)
 * ---------------------------------------------------------------------------
 *
 * A session with a driver behind it gets every turn — `now`, `queue`, `wake`
 * and `interrupt` alike — as one row in the server's durable queue, stored
 * under the message id and forwarded to the daemon under that same id. The
 * daemon's delivery queue decides when to type it and recognises a repeat by
 * the id; `interrupt` is a delivery MODE of that queue (the row goes ahead of
 * the waiting rows and cuts the running turn), not a second pipeline, and
 * staged files travel on the row. Nothing here reads whether the agent is
 * ready or whether older work is queued: ordering and readiness are the
 * daemon's, and there is only one queue to order.
 *
 * The caller's receipt is therefore the queue's own answer, given at once:
 * `queued`, or the refusal that kept the row out. What happened at the agent
 * comes back later as the row's delivery outcome, by id.
 *
 * Shells keep the legacy verbs: they have no driver, so the inbox's raw
 * transport is their only delivery.
 *
 * ---------------------------------------------------------------------------
 * WHY `queue` NEVER CROSSES THE WIRE
 * ---------------------------------------------------------------------------
 *
 * The durable FIFO is a server table, so a queued turn survives a daemon
 * restart, a machine going offline and a parked session. Both this seam and
 * the gateway complete it through the SAME {@link RuntimeDurableQueuePort}, so
 * there is one queue with one behaviour.
 */

import { randomUUID } from 'node:crypto'
import { basename, dirname, isAbsolute, normalize } from 'node:path'
import { createLogger } from '@podium/logger'
import type { MutationId, SessionId } from '@podium/model'
import type { ObservationInputOrigin } from '@podium/protocol'
import type { RuntimeAttachmentRef, TurnReceipt } from '@podium/protocol/daemon'
import type { InboxPrincipalReference } from './inbox'
import type { RuntimeDurableQueuePort } from './runtime-gateway'

/**
 * HOW A MIGRATED CALLER NAMES ITS INTENT.
 *
 * The vocabulary the callers already reason in. For an agent it maps onto the
 * durable row's delivery mode HERE, once: `interrupt` cuts the running turn,
 * everything else waits for the boundary (POD-4795). The four verbs still
 * differ for a shell, whose raw transport has no queue of its own to order.
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
}

/** The legacy-shaped answer. IDENTICAL in both modes by design: it is what keeps
 *  every migrated caller's control flow — and its wire contract — unchanged. */
export interface ReceiptSendResult {
  ok: boolean
  queued?: boolean
  reason?: string
  /** 1-based position in the server's durable FIFO when queued. */
  position?: number
}

/** The legacy verbs, as this seam needs them. Structurally satisfied by
 *  `SessionInbox`; named here so the module depends on what it uses. */
export interface ReceiptSendLegacyPort {
  sendText(input: ReceiptSendInput): Promise<ReceiptSendResult>
  queueText(input: ReceiptSendInput & { mutationId?: MutationId }): Promise<ReceiptSendResult>
  interruptText(input: ReceiptSendInput): Promise<ReceiptSendResult>
  resumeAndSend(input: ReceiptSendInput & { mutationId?: MutationId }): Promise<ReceiptSendResult>
}

export interface ReceiptSenderPorts {
  legacy: ReceiptSendLegacyPort
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
  /** Human-facing refusal for deliberate archive intent — the one lifecycle
   *  fact the server owns. What the agent is doing (errored, a native view
   *  holding the lease, busy) is the driver's to answer (POD-4775). */
  archiveReason?(sessionId: SessionId): string | undefined
  /** The principal an unattributed turn is queued as. Supplied by the composition
   *  root so "who is system" is answered in one visible place. */
  systemPrincipal(): InboxPrincipalReference
  now(): number
}

/** What a caller learns when the receipt lands. `via` and the input echo back so
 *  a reconciler that batched several sends can tell them apart. */
export type ReceiptReconciler = (receipt: TurnReceipt, via: ReceiptSendVia) => void

const log = createLogger('server:receipt-send')

/** A ref is usable only by the session whose daemon staging directory minted it.
 * The daemon repeats this check against the real filesystem; this structural
 * guard stops forged local paths before they cross the machine boundary. */
function attachmentMatchesSession(sessionId: SessionId, attachment: RuntimeAttachmentRef): boolean {
  if (!isAbsolute(attachment.path) || normalize(attachment.path) !== attachment.path) return false
  const sessionDir = dirname(attachment.path)
  return (
    basename(sessionDir) === sessionId &&
    basename(dirname(sessionDir)) === 'uploads' &&
    basename(attachment.path).startsWith(`${attachment.id}.`)
  )
}

export class ReceiptSender {
  constructor(private readonly ports: ReceiptSenderPorts) {}

  /** Whether this session's sends produce receipts. Callers use it to select the
   *  receipt-aware blocking path and to decide whether reconciliation is coming;
   *  the driver still owns the delivery result. */
  onContract(sessionId: SessionId): boolean {
    return this.ports.onContract(sessionId)
  }

  /**
   * Dispatch one turn.
   *
   * Resolves once the row is stored (or refused). `onReceipt` fires exactly
   * once on the contract path with that answer, and never for a legacy send,
   * so a caller can tell "no receipt is coming" from "the receipt said
   * nothing happened".
   */
  async send(
    via: ReceiptSendVia,
    input: ReceiptSendInput,
    onReceipt?: ReceiptReconciler,
  ): Promise<ReceiptSendResult> {
    // Archive is a deliberate human boundary: never enqueue, forward, or report
    // success for an archived session.
    const archiveReason = this.ports.archiveReason?.(input.sessionId)
    if (archiveReason) return { ok: false, reason: archiveReason }

    const invalidAttachment = input.attachments?.find(
      (attachment) => !attachmentMatchesSession(input.sessionId, attachment),
    )
    if (invalidAttachment) {
      return this.refuseAttachments(
        via,
        input,
        'staging_failed',
        'file attachment reference was not staged for this session',
        onReceipt,
      )
    }
    if (!this.ports.onContract(input.sessionId)) {
      if (input.attachments?.length) {
        return this.refuseAttachments(
          via,
          input,
          'unsupported',
          'this agent cannot accept file attachments',
          onReceipt,
        )
      }
      return this.legacy(via, input)
    }
    return this.enqueue(via, input, onReceipt)
  }

  /** Invoke immediately, but own completion separately from send admission.
   * Reconciliation may have partially committed: report for inspection rather
   * than replaying the receipt or resending the message automatically.
   */
  private dispatchReceipt(
    input: ReceiptSendInput,
    via: ReceiptSendVia,
    receipt: TurnReceipt,
    onReceipt?: ReceiptReconciler,
  ): void {
    if (!onReceipt) return
    const operationId = input.mutationId ?? input.sourceMessageId ?? randomUUID()
    // Await consumes even an async callback supplied through the legacy void
    // signature. The async wrapper also turns synchronous throws into rejections.
    const reconcile = async (): Promise<void> => {
      await onReceipt(receipt, via)
    }
    void reconcile().catch((error: unknown) => {
      log.error('reconciliation failed', {
        operationId,
        sessionId: input.sessionId,
        sourceMessageId: input.sourceMessageId,
        via,
        outcome: receipt.outcome,
        error,
        recovery: 'Inspect the message ledger before retrying reconciliation; delivery may already have occurred.',
      })
    })
  }

  private refuseAttachments(
    via: ReceiptSendVia,
    input: ReceiptSendInput,
    reason: 'unsupported' | 'staging_failed',
    detail: string,
    onReceipt?: ReceiptReconciler,
  ): ReceiptSendResult {
    this.dispatchReceipt(input, via, { outcome: 'refused', refusal: { reason, detail } }, onReceipt)
    return { ok: false, reason: detail }
  }

  private async enqueue(
    via: ReceiptSendVia,
    input: ReceiptSendInput,
    onReceipt?: ReceiptReconciler,
  ): Promise<ReceiptSendResult> {
    const queued = await this.ports.queue.enqueue({
      sessionId: input.sessionId,
      text: input.text,
      origin: input.inputOrigin ?? 'controller',
      principal: input.principal ?? this.ports.systemPrincipal(),
      delivery: via === 'interrupt' ? 'interrupt' : 'when-ready',
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
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
      this.dispatchReceipt(
        input,
        via,
        {
          outcome: 'refused',
          refusal: {
            reason: queued.reason,
            ...(queued.detail === undefined ? {} : { detail: queued.detail }),
          },
        },
        onReceipt,
      )
      // The legacy vocabulary for the same refusal, so an upstream branch that
      // recognises 'no resume ref' (and routes it to spawn-on-wake) still does.
      return { ok: false, reason: queued.detail ?? queued.reason }
    }
    this.dispatchReceipt(
      input,
      via,
      {
        outcome: 'queued',
        position: queued.position,
        deliveredAs: 'queue',
        at: new Date(this.ports.now()).toISOString(),
      },
      onReceipt,
    )
    return { ok: true, queued: true, position: queued.position }
  }

  private async legacy(
    via: ReceiptSendVia,
    input: ReceiptSendInput,
  ): Promise<ReceiptSendResult> {
    switch (via) {
      case 'now':
        return await this.ports.legacy.sendText(input)
      case 'interrupt':
        return await this.ports.legacy.interruptText(input)
      case 'queue':
        return await this.ports.legacy.queueText(input)
      case 'wake':
        return await this.ports.legacy.resumeAndSend(input)
    }
  }
}
