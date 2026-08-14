/**
 * THE RUNTIME CONTROL FRAMES (POD-1761 W3).
 *
 * FOUR verbs, one shape: find this session's driver handle, call the contract
 * method, answer with the correlated result frame. `attach` and `snapshot` are
 * implemented on the driver but have no frame — see the note in
 * `packages/protocol/src/messages/runtime.ts`: nothing remote asks for them
 * until W4 and W5, and carrying a frame nobody sends would mean resurrecting
 * payload schemas W1's review deleted for exactly that reason. There is no interpretation
 * here — a refusal is a value the handle returned and travels as one, and an
 * unregistered session produces `not_running`, which is the honest answer to
 * "drive this through the contract" for a session that is not behind it.
 *
 * WHY EVERY VERB MUST ANSWER, ALWAYS. These are correlated request/reply frames
 * over the one RPC correlator. A handler that returned early without sending its
 * `*Result` would leave the server's request pending until its timeout, which is
 * the exact failure mode `readTranscript`'s "must-answer posture" comment already
 * warns about two directories away. So every path below ends in a send.
 */

import type { ControlHandlers } from '../control/context'

export const runtimeHandlers: Pick<
  ControlHandlers,
  | 'runtimeSendRequest'
  | 'runtimeInterruptRequest'
  | 'runtimeAnswerRequest'
  | 'runtimeLifecycleRequest'
> = {
  runtimeSendRequest: (ctx, msg) => {
    const handle = ctx.runtime?.handleFor(msg.sessionId)
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
    const handle = ctx.runtime?.handleFor(msg.sessionId)
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
    const handle = ctx.runtime?.handleFor(msg.sessionId)
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
    const handle = ctx.runtime?.handleFor(msg.sessionId)
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
}
