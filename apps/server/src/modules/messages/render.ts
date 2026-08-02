/**
 * What the receiver actually sees, and how that shape decides confirmation.
 *
 * Extracted from `MessageDeliveryService` (POD-1397). This module is PURE with
 * respect to delivery: it owns no mutable state, arms no timer, and writes
 * nothing — it reads issue/session metadata to build labels and returns text.
 * There is deliberately no `dispose()` because there is nothing to dispose.
 *
 * It is one seam rather than two because the rendering and the confirmation
 * mode are the same decision read twice. `renderFor` turns an fyi/oversized
 * issue-addressed row into an inbox pointer instead of an inline body; that row
 * therefore carries no id into the transcript and can only be confirmed by an
 * inbox READ. Before this module those two facts lived in three places kept in
 * lockstep by comment — `renderFor`, `deliveryMode`, and `deliverBatch`'s
 * pointer filter each restated the predicate. {@link MessageRenderer.isPointer}
 * is now the single statement of it and all three call it.
 */

import { deliversUnwrapped, type MailSenderPrincipal } from '@podium/commands'
import type { SessionMeta } from '@podium/model'
import type { MessageRow } from '../../store'
import type { IssueService } from '../issues/service'

/** Bodies past this render as a pointer, not inline (issue-addressed only —
 *  they are readable via `podium issue mail inbox`). */
export const INLINE_BODY_MAX = 6_000

/** How a rendered message is confirmed as reaching the agent [POD-834]:
 *   - `echo`      enveloped body carrying the msg id → confirmed by transcript echo;
 *   - `pointer`   a coalesced "you have mail" nudge (fyi / oversized issue mail) →
 *                 the body isn't shown inline, so it is confirmed by an inbox READ,
 *                 never echo — and is never auto-requeued (no re-nudge storm);
 *   - `unwrapped` an operator's byte-faithful body (no envelope, no id) → no echo
 *                 is possible, so injection itself is the confirmation. */
export type DeliveryMode = 'echo' | 'pointer' | 'unwrapped'

/**
 * The L1 principal projection of a stored row, for the policy functions in
 * `@podium/commands`.
 *
 * `user` is `null` on purpose — see the note on `principalOf` in `service.ts`:
 * a `MessageRow` has no column to hold the human at the root of the delegation
 * chain until POD-1075 lands the User aggregate, and stamping one side of a
 * compared pair alone silently disables both the cooldown and the same-sender
 * guard.
 */
export const principalOfRow = (m: MessageRow): MailSenderPrincipal =>
  ({
    kind: m.fromKind,
    user: m.attribution?.onBehalfOf ?? null,
    ...(m.fromIssue ? { issueId: m.fromIssue } : {}),
    ...(m.fromSession ? { sessionId: m.fromSession } : {}),
    ...(m.fromName ? { name: m.fromName } : {}),
  }) as MailSenderPrincipal

/**
 * SUBSTRATE-boundary body sanitizer: message bodies are typed into the target
 * agent's PTY inside a bracketed paste (ESC[200~ … ESC[201~), so a body
 * containing the paste-END marker would terminate the paste early and
 * everything after it would run as raw keystrokes — command injection into
 * another agent session. Strip every C0/C1 control character except newline
 * and tab (killing ESC neutralizes ESC[201~ and all other escape sequences).
 * Applied at rendering/delivery ONLY — typeText itself stays byte-faithful for
 * operator/UI direct typing.
 */
export function sanitizeBody(body: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the point
  return body.replace(/[\u0000-\u0008\u000b-\u001f\u007f\u0080-\u009f]/g, '')
}

/** Render the delivery envelope. Server-only: bodies never carry frames of
 *  their own — a spoofed "[podium message …]" inside `body` lands INSIDE the
 *  real frame and reads as quoted text. */
export function renderEnvelope(
  m: MessageRow,
  fromLabel: string,
  toLabel: string,
  note?: string,
): string {
  // The seance constraint [spec:SP-34d7 read-toolkit tier 4]: a question's
  // frame binds the receiver — answer from existing context, reply, then
  // RESUME. Server-rendered like the rest of the frame, never client text.
  const questionRule =
    m.kind === 'question'
      ? `[this is a question: answer it from your existing context with \`podium mail reply ${m.id}\`, ` +
        `then RETURN TO WHAT YOU WERE DOING — do not take up new work because of it]\n`
      : ''
  // A --expect-response message [spec:SP-bf44] carries the same reply directive a
  // question does, minus the answer-then-resume binding: the sender wants a reply
  // (else the steward will nag them that none came), but it is not a seance. A
  // question already gets its own, stronger rule above, so this is question-exempt.
  const responseRule =
    m.expectsResponse && m.kind !== 'question'
      ? `[a response was requested: reply within this thread (\`podium mail reply ${m.id}\`) ` +
        `when you have handled it — any substantive reply satisfies it]\n`
      : ''
  return (
    `[podium message ${m.id} · from ${fromLabel} · to ${toLabel} · reply: podium mail reply ${m.id}]\n` +
    `${m.body}\n` +
    (note ? `${note}\n` : '') +
    questionRule +
    responseRule +
    `[end podium message ${m.id}]`
  )
}

/**
 * What the renderer needs to build a label. `issues` is derived from the real
 * service rather than restated; `listSessions` is the model type the delivery
 * service already hands around, narrowed to the one read this module makes.
 */
export interface MessageRenderDeps {
  issues: Pick<IssueService, 'getMeta' | 'niceRef'>
  listSessions(): SessionMeta[]
  /** Human-readable machine name for cross-machine provenance [POD-658];
   *  absent (tests) = raw machine id. */
  machineName?(id: string): string
}

export class MessageRenderer {
  constructor(private readonly deps: MessageRenderDeps) {}

  /**
   * THE pointer predicate — one statement, three readers.
   *
   * An issue-addressed row that is fyi, or whose body is too large to paste
   * inline, is delivered as a coalesced nudge rather than an inline body.
   * `renderFor` renders it as one, `deliveryMode` reports it cannot echo, and
   * the idle drain batches it with the other pointers. Those three MUST agree:
   * a row rendered inline but classified `pointer` would wait forever for an
   * inbox read that never comes, and one rendered as a pointer but classified
   * `echo` would be re-injected by the sweep every pass.
   */
  isPointer(message: MessageRow): boolean {
    return (
      message.toKind === 'issue' &&
      (message.urgency === 'fyi' || message.body.length > INLINE_BODY_MAX)
    )
  }

  /** The exact text the receiver sees: enveloped for every principal EXCEPT the
   *  operator — only the human's own words land unwrapped. Oversized
   *  issue-addressed bodies render as an inbox pointer instead of inline. */
  renderFor(message: MessageRow, receiverSessionId?: string): string {
    if (message.toKind === 'issue' && message.body.length > INLINE_BODY_MAX) {
      return this.pointerText([message])
    }
    // Operator bodies are BYTE-FAITHFUL: the human's bytes are their own —
    // they can already type anything directly into their own terminal, so
    // there is no escalation to prevent. Unwrapped AND unsanitized. The ONE
    // exception is a question [spec:SP-34d7 read-toolkit tier 4]: the ask
    // round-trip needs the reply frame (message id + `podium mail reply`) or
    // the target can never ack and awaitAck always times out — so operator
    // questions render the frame around the still-byte-faithful body.
    if (message.fromKind === 'operator') {
      if (message.kind !== 'question') return message.body
      return renderEnvelope(message, 'the operator', this.toLabel(message))
    }
    // Substrate boundary: every NON-operator delivered body is control-stripped
    // so it can never break out of the bracketed paste (ESC[201~) in typeText.
    const body = sanitizeBody(message.body)
    return renderEnvelope(
      { ...message, body },
      this.fromLabel(message),
      this.toLabel(message),
      this.crossMachineNote(message, receiverSessionId),
    )
  }

  /** The coalesced pointer rendering (also used for oversized bodies). */
  pointerText(rows: MessageRow[]): string {
    const senders = [...new Set(rows.map((m) => this.fromLabel(m)))]
    return (
      `[podium] ${rows.length} message(s) from ${senders.join(', ')} — ` +
      `run 'podium issue mail inbox' to read them`
    )
  }

  /** Cross-machine provenance [spec:SP-6d57]: when the sending session runs on a
   *  DIFFERENT machine than the receiver, say so and how to inspect its working
   *  state — built only from what podium already knows (session machineIds),
   *  zero storage. */
  private crossMachineNote(message: MessageRow, receiverSessionId?: string): string | undefined {
    if (!receiverSessionId || message.fromKind !== 'agent' || !message.fromSession) return undefined
    const sessions = this.deps.listSessions()
    const senderMachine = sessions.find((s) => s.sessionId === message.fromSession)?.machineId
    const receiverMachine = sessions.find((s) => s.sessionId === receiverSessionId)?.machineId
    if (!senderMachine || !receiverMachine || senderMachine === receiverMachine) return undefined
    const name = this.deps.machineName?.(senderMachine) ?? senderMachine
    return `[this agent runs on machine "${name}" — inspect its working tree with: podium workspace fetch ${message.fromSession}]`
  }

  fromLabel(message: MessageRow): string {
    if (message.fromKind === 'agent') {
      if (message.fromIssue) {
        // Nice-id form (#474): `issue:POD-13` — clickable in the web transcript
        // and the reference form agents are told to use; `#seq` only before a
        // repo prefix exists (niceRef's own fallback).
        const issues = this.deps.issues
        const issue = issues.getMeta(message.fromIssue)
        return issue ? `issue:${issues.niceRef(issue)}` : message.fromIssue
      }
      if (message.fromSession) return `session:${message.fromSession}`
      return 'agent'
    }
    if (message.fromKind === 'system')
      return `system${message.fromName ? `:${message.fromName}` : ''}`
    return message.fromKind // superagent
  }

  private toLabel(message: MessageRow): string {
    if (message.toKind === 'issue') {
      const issues = this.deps.issues
      const issue = issues.getMeta(message.toId ?? '')
      return issue ? `your issue ${issues.niceRef(issue)}` : `your issue ${message.toId}`
    }
    if (message.toKind === 'session') return 'your session'
    return 'the operator'
  }

  /** How a message reaches the agent, deciding how (and whether) its delivery is
   *  confirmed [POD-834]. Reads {@link isPointer} rather than restating it, so it
   *  cannot drift from what `renderFor` actually produced. */
  deliveryMode(message: MessageRow): DeliveryMode {
    if (this.isPointer(message)) return 'pointer'
    if (deliversUnwrapped(principalOfRow(message), message.kind)) return 'unwrapped'
    return 'echo'
  }

  /** A message whose push into the PTY is itself the confirmation — no transcript
   *  echo is awaited and the sweep never re-injects it [POD-853]. Two cases: an
   *  unwrapped operator body (no id to echo), and a best-effort ack/notification.
   *  Pointer/pull-path rows are NOT confirmed on injection (an inbox read confirms
   *  those), so best-effort applies only to inline echo-mode rows. */
  confirmedOnInjection(message: MessageRow): boolean {
    const mode = this.deliveryMode(message)
    return mode === 'unwrapped' || (mode === 'echo' && this.isBestEffort(message))
  }

  /** Fire-and-forget kinds [POD-853, spec:SP-34d7 acks & notifications]: an ack is
   *  never itself acked and its ack-confirms-original side effect fires at send
   *  time regardless; a steward/subscription notification never expects an ack.
   *  Chasing their transcript echo only risks the mid-turn re-inject loop, so they
   *  are delivered once (injection = confirmation) and never auto-requeued. */
  private isBestEffort(message: MessageRow): boolean {
    return message.kind === 'ack' || message.kind === 'notification'
  }
}
