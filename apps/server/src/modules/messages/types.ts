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

import type { Attribution, IssueId, SessionId } from '@podium/model'
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
  kind?: MessageKind
  urgency?: MessageUrgency
  lifecycle?: MessageLifecycle
  threadId?: string
  inReplyTo?: string
  expiresAt?: string
  /** Opt into a reply [POD-835 §04b]: `--expect-response`. Only then does the
   *  system expect (and, on settle, nag about) a response. A `question` implies it;
   *  an `ack`/`notification` can never set it. Omitted = false (receipt-only). */
  expectsResponse?: boolean
  /** Internal-only arbiter identity for message-backed notifications. */
  notificationFact?: { factKey: string; target: string }
}

export interface MessageSendResult {
  message: MessageRow
  /** sendText/queueText-compatible outcome (existing CLI/tool wire shapes). */
  ok: boolean
  queued?: boolean
  reason?: string
  /** The honest, sender-facing outcome [POD-834]: what happened to the message,
   *  so `held` and `dead_letter` are never a silent success. */
  disposition: SendDisposition
  /** The legacy issue_messages mirror row (issue-addressed sends only) — keeps
   *  mail inbox/claim/pending working until those readers migrate. */
  legacy?: IssueMessageRow
}
