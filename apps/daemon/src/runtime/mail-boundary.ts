import type { AgentSessionHandle, RuntimeEvent, SendOptions } from '@podium/harness/driver/host'
import type { SessionId } from '@podium/model'
import { hookBoolean, hookEventName, isGrokHookPayload } from '../hook-payload'

export type MailBoundaryContext = (
  sessionId: SessionId,
  signal?: AbortSignal,
) => Promise<string | null>
export const MAIL_BOUNDARY_OPTIONS = {
  origin: 'mail',
  delivery: 'at-boundary',
  principal: { kind: 'system', ref: 'issue-mail' },
} as const satisfies SendOptions

/** The hook response is a private driver transport. Stop vetoes keep the current
 * harness turn active; Grok denies one tool attempt, which the agent may retry.
 * An active Stop hook must not even poll (ack polling persists reminded_at). */
export async function respondToMailBoundary(
  context: MailBoundaryContext | undefined,
  sessionId: SessionId,
  payload: unknown,
  signal?: AbortSignal,
): Promise<string | null> {
  const grok = isGrokHookPayload(payload)
  const event = hookEventName(payload)
  if (grok ? event !== 'PreToolUse' : event !== 'Stop') return null
  if (!grok && hookBoolean(payload, 'stop_hook_active', 'stopHookActive') === true) return null
  const text = await readBoundaryContext(context, sessionId, signal)
  return text === null ? null : JSON.stringify({ decision: grok ? 'deny' : 'block', reason: text })
}

/** Bound a failed/hung relay without blocking the event pump or the harness.
 * Cancellation releases the source claim; a late relay cannot consume the
 * next policy or clear a newer claim. */
async function readBoundaryContext(
  context: MailBoundaryContext | undefined,
  sessionId: SessionId,
  signal?: AbortSignal,
): Promise<string | null> {
  if (!context || signal?.aborted) return null
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, 2_500)
  let finish!: () => void
  const expired = new Promise<null>((resolve) => {
    finish = () => resolve(null)
  })
  controller.signal.addEventListener('abort', finish, { once: true })
  try {
    return await Promise.race([
      Promise.resolve().then(() =>
        controller.signal.aborted ? null : context(sessionId, controller.signal),
      ),
      expired,
    ])
  } catch {
    return null
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    controller.signal.removeEventListener('abort', finish)
  }
}

/** Native providers have already completed: a boundary send opens a NEW epoch,
 * never reopens the completed one. The harness becomes active on acceptance;
 * there may be an idle gap while the relay resolves. Only a live, non-mail
 * turn observed by this driver may cause a continuation. A bootstrap start can
 * describe an initial prompt still running; only its LIVE completion acts. Replayed
 * completion, duplicates, stale handles and our own mail turns cannot loop. */
export function createMailContinuation(
  handle: AgentSessionHandle,
  context: MailBoundaryContext | undefined,
  isCurrent: () => boolean,
  reportFailure: (error: unknown) => void,
): (event: RuntimeEvent) => void {
  let current: { epoch: number; mail: boolean; completed: boolean } | undefined
  let highWater = -1
  return (event) => {
    if (!context || !isCurrent() || event.t !== 'turn') return
    if (event.provenance !== 'live' && event.provenance !== 'bootstrap') return
    if (event.ev.ev === 'started') {
      if (event.ev.turnEpoch <= highWater) return
      highWater = event.ev.turnEpoch
      current = { epoch: event.ev.turnEpoch, mail: event.ev.origin === 'mail', completed: false }
      return
    }
    const turn = current
    if (event.provenance === 'bootstrap') {
      if (turn && turn.epoch === event.ev.turnEpoch) turn.completed = true
      return
    }
    if (event.ev.ev !== 'completed' || event.ev.verdict !== 'done') return
    if (!turn || turn.mail || turn.completed || turn.epoch !== event.ev.turnEpoch) return
    turn.completed = true // claim before the first await
    void (async () => {
      try {
        const text = await readBoundaryContext(context, handle.binding.sessionId)
        if (!text || !isCurrent() || current !== turn) return
        const receipt = await handle.send({ text }, MAIL_BOUNDARY_OPTIONS)
        if (receipt.outcome === 'refused' || receipt.outcome === 'unverified')
          reportFailure(receipt)
      } catch (error) {
        reportFailure(error)
      }
    })()
  }
}
