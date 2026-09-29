/**
 * What the receiver actually sees, and how that shape decides confirmation.
 *
 * Extracted from `MessageDeliveryService` (POD-1397). This module is PURE with
 * respect to delivery: it owns no mutable state, arms no timer, and writes
 * nothing — it reads issue/session metadata to build labels and returns text.
 * There is deliberately no `dispose()` because there is nothing to dispose.
 *
 * It is one seam rather than two because the rendering and the confirmation
 * mode are the same decision read twice. `renderFor` turns an oversized
 * issue-addressed row into an inbox pointer instead of an inline body; that row
 * therefore carries no id into the transcript and can only be confirmed by an
 * inbox READ. Every other row, fyi included, is typed inline and confirmed by
 * the daemon's settlement or its echo. The rule is stated once, as the store's
 * `isPointerMessage` beside the pending-mail SQL that restates it, and
 * {@link MessageRenderer.isPointer} is how this module reads it [POD-4845].
 */

import { AUTO_CONTINUE_SENDER, deliversUnwrapped, type MailSenderPrincipal } from '@podium/commands'
import type { SessionMeta, SessionId } from '@podium/model'
import type { MessageRow } from '../../store'
import type { IssueService } from '../issues/service'
import { INLINE_BODY_MAX, isPointerMessage } from '../../store/messages'
import { sanitizeForInjection } from '../sessions/paste'

/** Bodies past this render as a pointer, not inline (issue-addressed only). */
export { INLINE_BODY_MAX }

/** How a rendered message is confirmed as reaching the agent [POD-834]:
 *   - `echo`      enveloped body carrying the msg id (the full envelope or the
 *                 short frame) → confirmed by transcript echo;
 *   - `pointer`   a "you have mail" line typed in place of an oversized issue
 *                 body → the body isn't shown inline, so it is confirmed by an
 *                 inbox READ, never echo — and is never auto-requeued;
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
 * The rendered body's control-character strip — the SAME rule the injection
 * point applies, borrowed rather than restated (POD-2708).
 *
 * IT USED TO BE THE ONLY DEFENSE, and that was the defect. A body containing
 * the paste-END marker (ESC[201~) terminates the bracketed paste it is typed
 * inside and everything after it runs as raw keystrokes — command injection into
 * another agent session — and this function, in a RENDERING layer, was the one
 * thing standing in the way. Every caller that reached the PTY by another road
 * (the steward's nudges, the automations drain, the driver's own `send`) got no
 * protection at all. The rule now lives where the envelope is applied, in
 * `../sessions/paste.ts` and in the driver's `paste.ts` beside it, and both
 * apply it unconditionally.
 *
 * IT STILL EARNS ITS CALL SITE. The rendered body is also what is STORED and
 * shown, so stripping here keeps control characters out of a transcript, a
 * client and a log — a display concern the injection point cannot serve. FOR THE
 * BODIES THAT REACH IT: `renderFor` returns an operator body before this call, so
 * an operator's control characters are stored and displayed as typed and are
 * removed only where the envelope is applied. That is a gap in the display
 * concern, not in the safety one — nothing below depends on this call. And
 * because it is literally the same idempotent function, doing it twice produces
 * exactly the bytes doing it once produces.
 */
export const sanitizeBody = sanitizeForInjection

/**
 * How a mail-handling turn must END [POD-604].
 *
 * Mail only ever lands on an IDLE session — a running one queues until its turn
 * ends — so almost every delivery interrupts an agent that has just finished
 * and reported. Two things the human relies on are then at risk, and they fail
 * in opposite directions:
 *
 *  - the SUMMARY genuinely is lost: the mail-handling turn appends after it, so
 *    a human returning hours later reads "replied to POD-588" where the account
 *    of the actual work used to be. It has to be restated.
 *  - the OFFER is not lost — a `mail`-origin turn deliberately does not clear it
 *    (`userOpenedTurn`, POD-118) — but `podium offer` REPLACES rather than
 *    stacks, so an agent that posts a mail-flavoured card destroys the
 *    "ready to merge" one the human was coming back to click. The instruction is
 *    therefore to leave it alone, NOT to re-post it.
 */
export const TURN_CLOSE_RULE =
  `[before you go idle: a human returning here reads only your LAST message. In one or two plain ` +
  `sentences say who mailed you, what they wanted and what you did — then repeat, below that, the ` +
  `summary of your own work this interrupted, so it is still what they see.]\n` +
  `[your standing offer survived this mail: leave it, or re-post it unchanged — never replace it ` +
  `with one about the mail. Check the issue stage still matches reality before you stop.]\n`

/**
 * A PERSON'S WORDS THAT A SERVER JOB DELIVERED (POD-4846): an automation's
 * prompt, stored as its owner's message and attributed to the automation. The
 * owner wrote the words, but nobody is at the keyboard: it does not act on a
 * standing offer, the job records its own failure, and it is typed in the short
 * frame rather than bare (POD-4868).
 */
export const deliveredByAJob = (m: MessageRow): boolean =>
  m.fromKind === 'operator' && m.attribution?.actor.kind === 'system'

/**
 * THE MESSAGES A SERVER JOB TYPES THAT NO AGENT ANSWERS (POD-4868): an
 * automation's prompt and auto-continue's 'continue'. Neither is a person
 * typing, so both carry their id in the text like all other mail — the agent's
 * history then names them exactly, and only a person's own words have to be
 * found by their text. Neither is mail an agent replies to, so they get the
 * {@link renderShortFrame short frame}, not the envelope.
 */
export const typedByAJob = (m: MessageRow): boolean =>
  deliveredByAJob(m) || (m.fromKind === 'system' && m.fromName === AUTO_CONTINUE_SENDER)

/**
 * The short frame (POD-4868): the envelope's id line and end line around the
 * body, without the reply, question, response and turn-close rules. The head
 * line keeps the envelope's shape minus its reply part, so the transcript echo
 * confirms it by id and the chat reads it as Podium's, never the person's.
 */
export function renderShortFrame(m: MessageRow, fromLabel: string, toLabel: string): string {
  return (
    `[podium message ${m.id} · from ${fromLabel} · to ${toLabel}]\n` +
    `${m.body}\n` +
    `[end podium message ${m.id}]`
  )
}

/** Render the delivery envelope. Server-only: bodies never carry frames of
 *  their own — a spoofed "[podium message …]" inside `body` lands INSIDE the
 *  real frame and reads as quoted text. */
export function renderEnvelope(
  m: MessageRow,
  fromLabel: string,
  toLabel: string,
  note?: string,
  opts?: { turnClose?: boolean },
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
    (opts?.turnClose ? TURN_CLOSE_RULE : '') +
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
  /** ONE session by id — the only session read the renderer makes [POD-3857]. */
  sessionById(sessionId: SessionId): Promise<SessionMeta | undefined>
  /** Human-readable machine name for cross-machine provenance [POD-658];
   *  absent (tests) = raw machine id. */
  machineName?(id: string): string | Promise<string>
}

export class MessageRenderer {
  constructor(private readonly deps: MessageRenderDeps) {}

  /**
   * THE pointer predicate: the store's {@link isPointerMessage}, which the
   * pending-mail SQL states too. `renderFor` types a pointer exactly when it
   * holds, and `deliveryMode` and the daemon's settlement read it for how the
   * row is confirmed. They MUST agree: a row typed inline but classified
   * `pointer` stays `typed` and nags until an inbox read nobody needs
   * [POD-4845], and one typed as a pointer but classified `echo` waits for an
   * echo of an id it never carried.
   */
  isPointer(message: MessageRow): boolean {
    return isPointerMessage(message)
  }

  /** The exact text the receiver sees: enveloped for every principal EXCEPT the
   *  operator — only the human's own words land unwrapped. A server job's
   *  message no agent answers gets the short frame. A pointer ({@link isPointer}:
   *  an oversized issue-addressed body) renders as an inbox pointer instead. */
  async renderFor(message: MessageRow, receiverSessionId?: SessionId): Promise<string> {
    if (this.isPointer(message)) {
      return await this.pointerText([message])
    }
    // An automation's prompt and auto-continue (POD-4868): the words are kept,
    // control-stripped like every non-person body, inside the short frame. Ahead
    // of the operator branch because an automation's row is the owner's. A plain
    // shell gets them bare: they are its command line, there is no agent to read
    // a frame, and a frame typed at a shell would run as a command.
    if (typedByAJob(message)) {
      if (await this.receiverIsShell(receiverSessionId)) return sanitizeBody(message.body)
      return renderShortFrame(
        { ...message, body: sanitizeBody(message.body) },
        await this.fromLabel(message),
        await this.toLabel(message),
      )
    }
    // Operator bodies are UNWRAPPED and rendered verbatim: the human's own words
    // land as their own words, with no envelope and no id around them.
    //
    // "AND UNSANITIZED" USED TO BE PART OF THAT SENTENCE, and it is not any more
    // (POD-2708). The old argument — the human can already type anything into
    // their own terminal, so there is no escalation to prevent — did not survive
    // the boundary moving: this body is typed into an ARBITRARY session, not the
    // sender's own, and it reaches the PTY through a bracketed paste rather than
    // through a key parser, so the exemption was a cross-session escalation
    // wearing a byte-faithfulness argument. The injection point now applies the
    // same rule to every origin (`../sessions/paste.ts`), which is what makes it
    // a boundary rather than a habit. What is preserved here is what the operator
    // path was actually for: no envelope, no id, no frame.
    //
    // The ONE exception is a question [spec:SP-34d7 read-toolkit tier 4]: the ask
    // round-trip needs the reply frame (message id + `podium mail reply`) or
    // the target can never ack and awaitAck always times out — so operator
    // questions render the frame around the operator's own body. That body is NOT
    // byte-faithful by the time a CLI sees it, and this comment used to say it
    // was: what the operator path preserves is the absence of a frame, not the
    // bytes — the injection point strips this body like any other.
    if (message.fromKind === 'operator') {
      if (message.kind !== 'question') return message.body
      return renderEnvelope(message, 'the operator', await this.toLabel(message))
    }
    // Substrate boundary: every NON-operator delivered body is control-stripped
    // so it can never break out of the bracketed paste (ESC[201~) in typeText.
    const body = sanitizeBody(message.body)
    // `turnClose` is for mail an AGENT will act on [POD-604]. Two exclusions,
    // both about who actually reads the frame: the operator path above is the
    // human typing into a session they are still watching, and a `toKind:
    // operator` row is an escalation queued for UI pickup — its reader is the
    // human, who has no turn to close and no offer to preserve.
    return renderEnvelope(
      { ...message, body },
      await this.fromLabel(message),
      await this.toLabel(message),
      await this.crossMachineNote(message, receiverSessionId),
      { turnClose: message.toKind !== 'operator' },
    )
  }

  private async receiverIsShell(receiverSessionId?: SessionId): Promise<boolean> {
    if (!receiverSessionId) return false
    return (await this.deps.sessionById(receiverSessionId))?.agentKind === 'shell'
  }

  /** The pointer rendering: the line typed in place of an oversized body. */
  async pointerText(rows: MessageRow[]): Promise<string> {
    const senders = [...new Set(await Promise.all(rows.map(async (m) => await this.fromLabel(m))))]
    // The pointer path leads to the same interrupted-turn problem the envelope's
    // TURN_CLOSE_RULE covers [POD-604] — reading the inbox is still a turn that
    // buries the summary the human was coming back to. Said in one line here
    // because a coalesced nudge has to stay a nudge.
    return (
      `[podium] ${rows.length} message(s) from ${senders.join(', ')} — ` +
      `run 'podium issue mail inbox' to read them, then close your turn by saying briefly ` +
      `who mailed you and what you did, repeating your previous summary below that, and ` +
      `leaving your standing offer as it is`
    )
  }

  /** Cross-machine provenance [spec:SP-6d57]: when the sending session runs on a
   *  DIFFERENT machine than the receiver, say so and how to inspect its working
   *  state — built only from what podium already knows (session machineIds),
   *  zero storage. */
  private async crossMachineNote(
    message: MessageRow,
    receiverSessionId?: SessionId,
  ): Promise<string | undefined> {
    if (!receiverSessionId || message.fromKind !== 'agent' || !message.fromSession) return undefined
    const find = async (id: SessionId) => await this.deps.sessionById(id)
    const senderMachine = (await find(message.fromSession))?.machineId
    const receiverMachine = (await find(receiverSessionId))?.machineId
    if (!senderMachine || !receiverMachine || senderMachine === receiverMachine) return undefined
    const name = (await this.deps.machineName?.(senderMachine)) ?? senderMachine
    return `[this agent runs on machine "${name}" — inspect its working tree with: podium workspace fetch ${message.fromSession}]`
  }

  async fromLabel(message: MessageRow): Promise<string> {
    // The job that delivered a person's words names itself (`automation:<id>`),
    // not the person: the frame says who typed it.
    const actor = message.attribution?.actor
    if (deliveredByAJob(message) && actor?.kind === 'system') return actor.job
    if (message.fromKind === 'agent') {
      if (message.fromIssue) {
        // Nice-id form (#474): `issue:POD-13` — clickable in the web transcript
        // and the reference form agents are told to use; `#seq` only before a
        // repo prefix exists (niceRef's own fallback).
        const issues = this.deps.issues
        const issue = await issues.getMeta(message.fromIssue)
        return issue ? `issue:${await issues.niceRef(issue)}` : message.fromIssue
      }
      if (message.fromSession) return `session:${message.fromSession}`
      return 'agent'
    }
    if (message.fromKind === 'system')
      return `system${message.fromName ? `:${message.fromName}` : ''}`
    return message.fromKind // superagent
  }

  private async toLabel(message: MessageRow): Promise<string> {
    if (message.toKind === 'issue') {
      const issues = this.deps.issues
      const issue = await issues.getMeta(message.toId ?? '')
      return issue ? `your issue ${await issues.niceRef(issue)}` : `your issue ${message.toId}`
    }
    if (message.toKind === 'session') return 'your session'
    return 'the operator'
  }

  /** How a message reaches the agent, deciding how (and whether) its delivery is
   *  confirmed [POD-834]. Reads {@link isPointer} rather than restating it, so it
   *  cannot drift from what `renderFor` actually produced. */
  deliveryMode(message: MessageRow, receiver?: Pick<SessionMeta, 'agentKind'>): DeliveryMode {
    if (this.isPointer(message)) return 'pointer'
    // A server job's text is framed (echo) except to a plain shell, which gets
    // it bare — the same receiver test `renderFor` makes.
    if (typedByAJob(message)) return receiver?.agentKind === 'shell' ? 'unwrapped' : 'echo'
    if (deliversUnwrapped(principalOfRow(message), message.kind)) return 'unwrapped'
    return 'echo'
  }

  /** A message whose push into the PTY is itself the confirmation — no transcript
   *  echo is awaited and the sweep never re-injects it [POD-853]. Two cases: an
   *  unwrapped body (an operator's, or a job's bare text to a shell — no id to
   *  echo), and a best-effort ack/notification.
   *  Pointer/pull-path rows are NOT confirmed on injection (an inbox read confirms
   *  those), so best-effort applies only to inline echo-mode rows. */
  confirmedOnInjection(message: MessageRow, receiver?: Pick<SessionMeta, 'agentKind'>): boolean {
    const mode = this.deliveryMode(message, receiver)
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
