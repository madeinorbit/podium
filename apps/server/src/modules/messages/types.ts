/**
 * The send vocabulary — the nouns every messages module and every caller of the
 * delivery service speaks (POD-1397).
 *
 * These types were declared in `service.ts` and imported from there by the issue
 * registry, the session command plane and the mailbox surface. They live here so
 * that a module which speaks them does not have to import the service that
 * implements them: a type-only cycle still binds two files together in a
 * reader's head, and it is the same "each half reaches into the other" shape a
 * split is supposed to remove.
 *
 * `service.ts` re-exports them, so existing importers are unaffected.
 */

import type { Attribution, IssueId, SessionId, ThreadId } from '@podium/model'
import type { RuntimeAttachmentRef } from '@podium/protocol/daemon'
import type {
  IssueMessageRow,
  MessageKind,
  MessageLifecycle,
  MessageRow,
  MessageUrgency,
} from '../../store'

/** What actually happened to a send, surfaced to the sender so a message that
 *  reached no one is never a bare success [POD-834 §04b]:
 *   - `delivered`   CONFIRMED in the target's transcript (echo or turn boundary),
 *                   or injection-is-delivery for an unwrapped operator body;
 *   - `queued`      handed to the harness input queue (or held for a live target's
 *                   next boundary) — NOT yet transcript-observed [spec:SP-cb9f];
 *   - `accepted`    a blocking send's budget expired with the row still queued
 *                   (busy / composer-draft-held / lost echo) — durably captured,
 *                   not yet confirmed; the sender queries `podium mail status`;
 *   - `held`        issue-addressed, issue live but NO live session — held for
 *                   the issue's next session (delivered at its next boundary);
 *   - `spawning`    a wake spawned a fresh agent to receive it;
 *   - `dead_letter` the target was gone; NOT delivered. */
export type SendDisposition =
  | 'delivered'
  | 'queued'
  | 'accepted'
  | 'held'
  | 'spawning'
  | 'dead_letter'

/** The authenticated sender principal — derived by the SURFACE from its caller
 *  identity (capability / in-process authority), never from client input. */
export type MessageSenderIdentity =
  | { kind: 'operator' }
  | { kind: 'superagent' }
  | { kind: 'system'; name?: string }
  | { kind: 'agent'; issueId?: IssueId; sessionId?: SessionId }

export type MessageSender = MessageSenderIdentity & {
  readonly attribution?: Attribution
  readonly delegationRef?: string | null
}

export interface MessageSendInput {
  to: { kind: 'issue' | 'session' | 'operator'; id?: string }
  body: string
  /** Staged machine-local refs, never paths spliced into the human's prose. */
  attachments?: readonly RuntimeAttachmentRef[]
  /** Internal id supplied by session chat; public mail inputs cannot set it. */
  correlationId?: string
  kind?: MessageKind
  urgency?: MessageUrgency
  lifecycle?: MessageLifecycle
  threadId?: ThreadId
  inReplyTo?: string
  expiresAt?: string
  /** Opt into a reply [POD-835 §04b]: `--expect-response`. Only then does the
   *  system expect (and, on settle, nag about) a response. A `question` implies it;
   *  an `ack`/`notification` can never set it. Omitted = false (receipt-only). */
  expectsResponse?: boolean
  /** Internal-only arbiter identity for message-backed notifications. */
  notificationFact?: { factKey: string; target: string }
}

/** Internal delivery option used by the blocking caller. Legacy callers keep
 * the optimistic send path; contract-backed callers opt into waiting for the
 * driver's already-existing receipt. */
export interface MessageSendOptions {
  awaitReceipt?: boolean
}

export interface MessageSendResult {
  message: MessageRow
  /** sendText/queueText-compatible outcome (existing CLI/tool wire shapes). */
  ok: boolean
  queued?: boolean
  reason?: string
  position?: number
  /** The honest, sender-facing outcome [POD-834]: what happened to the message,
   *  so `held` and `dead_letter` are never a silent success. */
  disposition: SendDisposition
  /** The legacy issue_messages mirror row (issue-addressed sends only) — keeps
   *  mail inbox/claim/pending working until those readers migrate. */
  legacy?: IssueMessageRow
}

/**
 * The agent identity the built-in superagent sends mail under (POD-2838).
 *
 * IT IS NOT A SESSION ID, and everything downstream has to know that. The
 * superagent is an in-process server job with no transport row, so the
 * capability minted for it carries this literal where a delegated agent would
 * carry its own `SessionId`. A reader that assumes "agent principal ⇒ resolvable
 * session" is wrong here, and `SessionAuthz.authorizeQueuedInputAtApply` used to
 * be exactly that reader: it fed this string to `capabilityForSession`, got back
 * the empty capability an unknown session produces, and threw out of the drain
 * tick instead of returning a verdict.
 *
 * Named here rather than spelled at each site so the identity and the code that
 * has to recognise it cannot drift apart. `types.ts` is the leaf vocabulary
 * module by design — importing it does not pull the delivery service in.
 */
export const SUPERAGENT_AGENT_IDENTITY = 'superagent'
