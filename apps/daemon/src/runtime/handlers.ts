/**
 * THE RUNTIME CONTROL FRAMES (POD-1761 W3; `snapshot` added by W5).
 *
 * FIVE verbs share one shape: find this session's driver handle, call the
 * contract method, answer with the correlated result frame. The sixth frame is
 * the server's acknowledgement that a durable queue-abandonment correction
 * landed; it retires that named daemon outbox record and sends no reply.
 *
 * `attach` is still implemented on the driver with no frame, for W1's original
 * reason: nothing remote negotiates one, and a schema with no caller is a
 * promise this build cannot keep. `snapshot` HAS a caller as of W5 — see
 * `runtimeSnapshotRequest` at the bottom of this file and the argument in
 * `packages/protocol/src/messages/runtime.ts`.
 *
 * WHY EVERY VERB MUST ANSWER, ALWAYS. These are correlated request/reply frames
 * over the one RPC correlator. A handler that returned early without sending its
 * `*Result` would leave the server's request pending until its timeout, which is
 * the exact failure mode `readTranscript`'s "must-answer posture" comment already
 * warns about two directories away. So every path below ends in a send.
 */

import type { AgentSessionHandle } from '@podium/agent-runtime'
import type { SessionId } from '@podium/model'
import type {
  RuntimeSnapshotResultMessage,
} from '@podium/protocol/daemon'
import { stateDir } from '@podium/runtime/config'
import { runtimeAttachmentBelongsToSession } from './attachment-staging'
import type { ControlHandlers, DaemonContext } from '../control/context'

/**
 * ONE LOOKUP ACROSS EVERY RUNTIME THIS DAEMON HOLDS (POD-2023).
 *
 * W3 had exactly one — the terminal driver — so its handlers read
 * `ctx.runtime?.handleFor` directly. W5 adds a second, and the moment there are
 * two registries the question "who owns this session" needs one answer in one
 * place: five call sites each asking two registries in their own order is how
 * one verb starts reaching a different driver than the next.
 *
 * A session appears in exactly one of them by construction — the spawn path
 * chooses a driver once and registers there — so the order below is a lookup,
 * not a precedence.
 */
export function handleFor(
  ctx: DaemonContext,
  sessionId: SessionId,
): AgentSessionHandle | undefined {
  return ctx.agentRuntime?.handleFor(sessionId)
}

/** The driver that actually owns this live session, from its runtime binding. */
export function runtimeDriverIdFor(
  ctx: DaemonContext,
  sessionId: SessionId,
): AgentSessionHandle['binding']['driver'] | undefined {
  return handleFor(ctx, sessionId)?.binding.driver
}

/**
 * IS THIS SESSION BEHIND THE CONTRACT AT ALL? (POD-2023)
 *
 * The fact the daemon REPORTS on `bind`, which the server records on the row and
 * W4's migrated senders branch on. It must ask every registry for the same
 * reason {@link handleFor} does: W3 had one, and a predicate that only knew
 * about the terminal one would report `false` for a server-family session —
 * sending W4's callers down the legacy PTY path for a session that HAS no PTY,
 * where the write would go nowhere and report success.
 */
export function sessionIsBehindContract(ctx: DaemonContext, sessionId: SessionId): boolean {
  return ctx.agentRuntime?.has(sessionId) === true
}

export const runtimeHandlers: Pick<
  ControlHandlers,
  | 'runtimeStageAttachmentRequest'
  | 'runtimeSendRequest'
  | 'runtimeInterruptRequest'
  | 'runtimeAnswerRequest'
  | 'runtimeLifecycleRequest'
  | 'runtimeSnapshotRequest'
  | 'runtimeQueueDrainAbandonedAck'
  | 'runtimeEventAck'
  | 'runtimeWatch'
> = {
  /**
   * THE ONE VERB THAT ANSWERS NOTHING, AND SHOULD NOT (POD-2293).
   *
   * Every frame above ends in a send because it is a correlated request whose
   * caller is waiting. This one carries a DESIRED STATE — "this session's
   * viewers want fragments" — and there is no answer worth correlating: a
   * driver's fine watch is best-effort by contract (codex must reconnect for one
   * and declines mid-turn), so a reply could only say "asked", which the sender
   * already knows. What the server observes instead is preview frames arriving,
   * or not.
   *
   * A session with no runtime is not an error either. The frame follows a
   * viewer's subscription, and a viewer can be looking at a session this daemon
   * does not drive.
   */
  runtimeWatch: (ctx, msg) => {
    ctx.agentRuntime?.setWatchLevel(msg.sessionId, msg.level)
  },
  runtimeQueueDrainAbandonedAck: (ctx, msg) => {
    ctx.acknowledgeQueueDrainReport(msg.reportId)
  },
  runtimeEventAck: (ctx, msg) => {
    ctx.acknowledgeRuntimeEvent(msg.deliveryId)
  },

  runtimeStageAttachmentRequest: (ctx, msg) => {
    const handle = handleFor(ctx, msg.sessionId)
    if (!handle) {
      ctx.send({
        type: 'runtimeStageAttachmentResult',
        requestId: msg.requestId,
        sessionId: msg.sessionId,
        result: { reason: 'not_running', detail: 'session is not behind the runtime contract' },
      })
      return
    }
    void handle
      .stageAttachment({
        bytes: new Uint8Array(Buffer.from(msg.source.dataBase64, 'base64')),
        filename: msg.source.filename,
        mediaType: msg.source.mediaType,
      })
      .then((result) => {
        ctx.send({
          type: 'runtimeStageAttachmentResult',
          requestId: msg.requestId,
          sessionId: msg.sessionId,
          result,
        })
      })
      .catch((err: unknown) => {
        ctx.send({
          type: 'runtimeStageAttachmentResult',
          requestId: msg.requestId,
          sessionId: msg.sessionId,
          result: { reason: 'staging_failed', detail: String(err) },
        })
      })
  },

  runtimeSendRequest: (ctx, msg) => {
    const handle = handleFor(ctx, msg.sessionId)
    if (!handle) {
      ctx.send({
        type: 'runtimeSendResult',
        requestId: msg.requestId,
        sessionId: msg.sessionId,
        receipt: {
          outcome: 'refused',
          refusal: { reason: 'not_running', detail: 'session is not behind the runtime contract' },
        },
      })
      return
    }
    const invalidAttachment = msg.attachments?.find(
      (attachment) =>
        !runtimeAttachmentBelongsToSession(stateDir(), msg.sessionId, attachment),
    )
    if (invalidAttachment) {
      ctx.send({
        type: 'runtimeSendResult',
        requestId: msg.requestId,
        sessionId: msg.sessionId,
        receipt: {
          outcome: 'refused',
          refusal: {
            reason: 'staging_failed',
            detail: 'file attachment reference was not staged for this session',
          },
        },
      })
      return
    }
    void handle
      .send(
        { id: msg.turnId, text: msg.text, attachments: msg.attachments },
        { origin: msg.origin, delivery: msg.delivery },
      )
      .then((receipt) => {
        ctx.send({
          type: 'runtimeSendResult',
          requestId: msg.requestId,
          sessionId: msg.sessionId,
          receipt,
        })
      })
      .catch((err: unknown) => {
        // A THROW IS NOT AN OUTCOME. The four outcomes are the contract's whole
        // honesty commitment, so an unexpected failure is reported as the one
        // that is true — we could not prove the send did anything — rather than
        // as a silence the caller has to time out on.
        ctx.send({
          type: 'runtimeSendResult',
          requestId: msg.requestId,
          sessionId: msg.sessionId,
          receipt: {
            outcome: 'refused',
            refusal: { reason: 'not_running', detail: String(err) },
          },
        })
      })
  },

  runtimeInterruptRequest: (ctx, msg) => {
    const handle = handleFor(ctx, msg.sessionId)
    // `interrupt()` REQUESTS a fence and returns nothing to await, so its reply
    // is the lifecycle result shape: the request was accepted, or it was refused.
    // The fence itself arrives — or does not — on the causal stream.
    const answer = (result: { ok: true } | { reason: 'not_running' }): void => {
      ctx.send({
        type: 'runtimeLifecycleResult',
        requestId: msg.requestId,
        sessionId: msg.sessionId,
        result,
      })
    }
    if (!handle) {
      answer({ reason: 'not_running' })
      return
    }
    void handle
      .interrupt()
      .then(() => answer({ ok: true }))
      .catch(() => answer({ reason: 'not_running' }))
  },

  runtimeAnswerRequest: (ctx, msg) => {
    const handle = handleFor(ctx, msg.sessionId)
    if (!handle) {
      ctx.send({
        type: 'runtimeAnswerResult',
        requestId: msg.requestId,
        sessionId: msg.sessionId,
        outcome: { ok: false, reason: 'unknown-interaction' },
      })
      return
    }
    void handle
      .answer(msg.interactionId, msg.answer)
      .then((outcome) => {
        ctx.send({
          type: 'runtimeAnswerResult',
          requestId: msg.requestId,
          sessionId: msg.sessionId,
          outcome,
        })
      })
      .catch(() => {
        ctx.send({
          type: 'runtimeAnswerResult',
          requestId: msg.requestId,
          sessionId: msg.sessionId,
          outcome: { ok: false, reason: 'unknown-interaction' },
        })
      })
  },

  runtimeLifecycleRequest: (ctx, msg) => {
    const handle = handleFor(ctx, msg.sessionId)
    const answer = (result: { ok: true } | { reason: 'not_running' | 'no_resume_ref' }): void => {
      ctx.send({
        type: 'runtimeLifecycleResult',
        requestId: msg.requestId,
        sessionId: msg.sessionId,
        result,
      })
    }
    if (!handle) {
      answer({ reason: 'not_running' })
      return
    }
    const verb =
      msg.verb === 'hibernate'
        ? handle.hibernate()
        : msg.verb === 'kill'
          ? handle.kill().then(() => ({ ok: true as const }))
          : handle.stop().then(() => ({ ok: true as const }))
    void verb
      .then((result) => {
        // `hibernate` legitimately REFUSES without a resume ref. That is an
        // outcome the caller handles, not an error, so it travels as the value
        // the handle returned.
        answer('ok' in result ? { ok: true } : { reason: result.reason as 'no_resume_ref' })
      })
      .catch(() => answer({ reason: 'not_running' }))
  },

  /**
   * THE OBSERVATION BOOTSTRAP (POD-2023) — the frame that makes the runtime event stream's
   * recovery contract stand on its own.
   *
   * A server that missed events re-reads from `snapshot()` and its cursor. That
   * was the recovery story from W1 onward, and until this handler existed it
   * named a call no remote caller could make. There is no interpretation here:
   * the snapshot is what the handle returned, and a session that is not behind
   * the contract answers `not_running`, which is the true statement rather than
   * an empty snapshot a consumer would mistake for "nothing has happened".
   */
  runtimeSnapshotRequest: (ctx, msg) => {
    const answer = (result: RuntimeSnapshotResultMessage['result']): void => {
      ctx.send({
        type: 'runtimeSnapshotResult',
        requestId: msg.requestId,
        sessionId: msg.sessionId,
        result,
      })
    }
    const handle = handleFor(ctx, msg.sessionId)
    if (!handle) {
      answer({ reason: 'not_running' })
      return
    }
    void handle
      .snapshot()
      // CAST AT THE ONE PLACE THE TWO HALVES MEET. `SessionSnapshot`'s wire
      // schema carries `state` as an open record — `AgentRuntimeState` is
      // `@podium/model`'s and is re-narrowed above protocol, the same
      // directional constraint the runtime family's header explains — so the
      // contract value is WIDER than the schema's inferred type in exactly that
      // one field and identical everywhere else.
      .then((snapshot) =>
        answer({
          snapshot: snapshot as RuntimeSnapshotResultMessage['result'] extends { snapshot: infer S }
            ? S
            : never,
        }),
      )
      .catch(() => answer({ reason: 'not_running' }))
  },
}
