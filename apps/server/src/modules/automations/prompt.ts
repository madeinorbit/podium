import { actorSystem, type SessionId, type SessionMeta, type UserId } from '@podium/model'
import { automationPromptMessageId } from '../../message-ids'
import type { MessageDeliveryService } from '../messages/service'

/** One run's prompt, to the session the run chose. */
export interface AutomationPrompt {
  automationId: string
  ownerUserId: UserId
  runId: string
  sessionId: SessionId
  text: string
  /** Resume mode: the previous run's session, woken if it is parked. */
  resume: boolean
}

export type DeliverAutomationPrompt = (
  prompt: AutomationPrompt,
) => Promise<{ ok: boolean; reason?: string }>

/**
 * AN AUTOMATION'S PROMPT IS A MESSAGE FROM ITS OWNER (POD-4846).
 *
 * The owner wrote the words, so the row is the operator's — typed without an
 * envelope, shown as the owner's own bubble — and it is attributed to the
 * automation that delivered them (`actor: system automation:<id>`, on behalf of
 * the owner). The message service treats a person's words delivered by a job
 * as such: they do not count as the person acting on a standing offer, and a
 * failure is the run's to record, so no failure notice is mailed.
 *
 * One id per run and target, so a repeated run stores and types it once.
 *
 * A RESUME THAT CANNOT HAPPEN IS ANSWERED, NOT SENT. The automation's own
 * fallback for a previous session that is gone or has no resume reference is a
 * fresh automation issue and session; a wake message would instead spawn on the
 * old session's issue under the mail rule, and the run would never learn that
 * session. So those two cases are answered here, before anything is stored,
 * with the reasons the automation already falls back on.
 */
export function automationPromptSender(deps: {
  messages: Pick<MessageDeliveryService, 'send'>
  sessionById(sessionId: SessionId): Promise<SessionMeta | undefined>
}): DeliverAutomationPrompt {
  return async (prompt) => {
    if (prompt.resume) {
      const session = await deps.sessionById(prompt.sessionId)
      if (!session) return { ok: false, reason: 'unknown session' }
      const parked = session.status === 'hibernated' || session.status === 'exited'
      if (parked && session.agentKind !== 'shell' && !session.resumable) {
        return { ok: false, reason: 'no resume ref' }
      }
    }
    const r = await deps.messages.send(
      {
        kind: 'operator',
        attribution: {
          actor: actorSystem(`automation:${prompt.automationId}`),
          onBehalfOf: prompt.ownerUserId,
        },
        delegationRef: null,
      },
      {
        messageId: automationPromptMessageId(prompt.runId, prompt.sessionId),
        to: { kind: 'session', id: prompt.sessionId },
        kind: 'message',
        urgency: 'next-turn',
        lifecycle: 'wake',
        body: prompt.text,
      },
    )
    // Stored is accepted: a push the transport refused leaves the row for the
    // delivery sweep. Only a prompt that ended undelivered is the run's failure.
    return r.disposition === 'dead_letter' ? { ok: false, ...(r.reason ? { reason: r.reason } : {}) } : { ok: true }
  }
}
