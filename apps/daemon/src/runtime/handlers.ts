/**
 * THE RUNTIME CONTROL FRAMES (POD-1761 W3; `snapshot` added by W5).
 *
 * FIVE verbs, one shape: find this session's driver handle, call the contract
 * method, answer with the correlated result frame. There is no interpretation
 * here — a refusal is a value the handle returned and travels as one, and an
 * unregistered session produces `not_running`, which is the honest answer to
 * "drive this through the contract" for a session that is not behind it.
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
import type { RuntimeSnapshotResultMessage } from '@podium/protocol'
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
function handleFor(ctx: DaemonContext, sessionId: SessionId): AgentSessionHandle | undefined {
  return ctx.runtime?.handleFor(sessionId) ?? ctx.opencodeRuntime?.handleFor(sessionId)
}

export const runtimeHandlers: Pick<
  ControlHandlers,
  | 'runtimeSendRequest'
  | 'runtimeInterruptRequest'
  | 'runtimeAnswerRequest'
  | 'runtimeLifecycleRequest'
  | 'runtimeSnapshotRequest'
> = {
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
    void handle
      .send({ text: msg.text }, { origin: msg.origin, delivery: msg.delivery })
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
   * THE OBSERVATION BOOTSTRAP (POD-2023) — the frame that makes `runtimeEvent`'s
   * `stream.live` classification stand on its own.
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
      .then((snapshot) => answer({ snapshot: snapshot as RuntimeSnapshotResultMessage['result'] extends { snapshot: infer S } ? S : never }))
      .catch(() => answer({ reason: 'not_running' }))
  },
}
