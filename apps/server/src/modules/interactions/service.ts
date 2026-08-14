/**
 * THE PendingInteraction AGGREGATE (POD-2020 / W2; spec §4).
 *
 * ---------------------------------------------------------------------------
 * WHAT IT IS FOR
 * ---------------------------------------------------------------------------
 * "Stuck" today means a blocking prompt nobody saw. Under this design a blocked
 * session is, by construction, a session with an OPEN PendingInteraction —
 * enumerable, escalatable, and answerable without attaching a terminal. That is
 * the entire claim, and everything here exists to make it true for the two
 * sources Podium has today.
 *
 * ---------------------------------------------------------------------------
 * IT OBSERVES; IT DOES NOT INTERCEPT
 * ---------------------------------------------------------------------------
 * The aggregate subscribes to `session.stateChanged` on the event bus and to
 * `session.exited`. It is downstream of every existing path: the chat card still
 * renders from `agentState`, the inbox still nudges, `issues.answerQuestion`
 * still works unchanged. Nothing in the old flow consults this module, which is
 * what makes W2's "existing UI behavior unchanged" a structural fact rather than
 * a thing to be careful about.
 *
 * Answering, conversely, routes THROUGH the old path: `deliverAnswerToSession`
 * is the one implementation of "is a live menu up, and which digits may touch
 * the PTY", and this service wraps it rather than reproducing its judgement.
 *
 * ---------------------------------------------------------------------------
 * AT-LEAST-ONCE, HELD IN ONE PLACE
 * ---------------------------------------------------------------------------
 * A classifier-sourced ask has no identity: a re-rendered menu is a fresh
 * observation of the same question. The fingerprint + partial unique index in
 * `store/interactions.ts` collapses the common case; the spec requires
 * consumers to tolerate it failing on the rest. Two consequences are visible
 * here: a collapsed duplicate does NOT re-publish an `asked` event (or every
 * re-render would ping every surface), and an answer to a stale id whose row is
 * already resolved returns the typed `already-answered` rather than typing a
 * second set of digits at whatever is on screen now.
 */

import { randomUUID } from 'node:crypto'
import { createLogger } from '@podium/logger'
import type { AgentRuntimeState, SessionId } from '@podium/model'
import type {
  InteractionAnswer,
  InteractionAnsweredBy,
  InteractionAnswerOutcome,
  PendingInteractionWire,
} from '@podium/protocol'
import type { InteractionRow, InteractionsRepository } from '../../store/interactions'
import type { InboxPrincipalReference } from '../sessions/inbox'
import type { AnswerDeliveryResult } from '../superagent/answer-delivery'
import { defaultAnswerFor, resolveAnswerText } from './answers'
import { type InteractionAskSpec, type QuestionPromptInput, synthesizeAsk } from './synthesis'

const log = createLogger('server:interactions')

/** How far back the transcript is read for a live menu's options — the same
 *  window `deliverAnswerToSession` uses, for the same reason (the last
 *  AskUserQuestion call carries them as structured `toolInputJson`). */
const TRANSCRIPT_TAIL = 50

export interface InteractionServiceDeps {
  readonly store: InteractionsRepository
  now(): string
  /** Publish the row onto the durable metadata feed. Every mutation calls it;
   *  the publisher decides what a replica sees. */
  publish(row: InteractionRow): void
  /**
   * THE EXISTING DELIVERY GATE, injected rather than imported so a test can
   * drive the aggregate without a session. This is `deliverAnswerToSession`
   * bound to its own deps at the composition root — wrap, don't rewrite.
   */
  deliver(input: {
    sessionId: SessionId
    answer: string
    principal: InboxPrincipalReference
    textFallback?: boolean
  }): Promise<AnswerDeliveryResult>
  /** The transcript tail, for reading a live menu's options at synthesis time. */
  readTranscript(input: {
    sessionId: SessionId
    direction: 'before' | 'after'
    limit: number
  }): Promise<{ items: Array<{ role: string; toolName?: string; toolInputJson?: string }> }>
  /** The principal an auto-answer acts as. */
  policyPrincipal(): InboxPrincipalReference
}

/** Everything a caller needs to answer, without knowing the payload union. */
export interface AnswerInput {
  id: string
  /** Free text, resolved against the ask's own options — the CLI's path. */
  text?: string
  /** An already-typed answer — a structured surface's path. */
  answer?: InteractionAnswer
  answeredBy: InteractionAnsweredBy
  principal: InboxPrincipalReference
}

export class InteractionService {
  constructor(private readonly deps: InteractionServiceDeps) {}

  // -- reads ----------------------------------------------------------------

  /** The durable row → the wire shape. Exposed because the feed publisher needs
   *  it and must not own a second copy of the projection. */
  wireOf(row: InteractionRow): PendingInteractionWire {
    return toWire(row)
  }

  listOpen(sessionId?: SessionId): PendingInteractionWire[] {
    return this.deps.store.listOpen(sessionId).map(toWire)
  }

  get(id: string): PendingInteractionWire | null {
    const row = this.deps.store.get(id)
    return row ? toWire(row) : null
  }

  listForSession(sessionId: SessionId, limit?: number): PendingInteractionWire[] {
    return this.deps.store.listForSession(sessionId, limit).map(toWire)
  }

  // -- synthesis ------------------------------------------------------------

  /**
   * A session's agent state moved. Open an ask if the new state is one, and
   * close the open ones if it is not.
   *
   * BOTH HALVES MATTER. Opening without closing would leave a permission ask
   * open forever after the operator answered it in the terminal — the aggregate
   * would then be lying about which sessions are blocked, which is worse than
   * not having it. Leaving `needs_user` (or `idle`-in-plan-mode) is the
   * observable proof the ask is gone, whoever resolved it.
   */
  async onStateChanged(input: {
    sessionId: SessionId
    prev: AgentRuntimeState | undefined
    next: AgentRuntimeState
  }): Promise<void> {
    try {
      const questionOptions =
        input.next.phase === 'needs_user' && input.next.need?.kind === 'question'
          ? await this.readQuestionOptions(input.sessionId)
          : undefined
      const ask = synthesizeAsk(input.sessionId, input.next, { questionOptions })
      if (!ask) {
        this.closeOpen(input.sessionId, 'the session left the asking state')
        return
      }
      // A state that re-reports the SAME ask leaves the open row alone; a state
      // that reports a DIFFERENT one closes the stale row first, because two
      // open asks on one terminal session would both claim the same menu.
      for (const open of this.deps.store.listOpen(input.sessionId)) {
        if (open.fingerprint !== ask.fingerprint) this.expire(open.id)
      }
      const { row, inserted } = this.deps.store.insert({
        id: `ixn_${randomUUID()}`,
        sessionId: input.sessionId,
        kind: ask.spec.kind,
        payload: ask.spec.payload,
        source: ask.source,
        answerable: ask.answerable,
        fingerprint: ask.fingerprint,
        askedAt: this.deps.now(),
      })
      // A collapsed duplicate must not re-announce — see the header.
      if (!inserted) return
      this.deps.publish(row)
      await this.applyDefaultAnswer(row, ask.spec)
    } catch (err) {
      // NEVER THROWS INTO THE BUS. This is an observer; a fault here must not
      // break the state-change fan-out that the badge and the inbox ride on.
      log.warn('interaction synthesis failed', { err, sessionId: input.sessionId })
    }
  }

  /** A session ended: every ask it left behind stops being answerable. */
  onSessionExited(sessionId: SessionId): void {
    this.closeOpen(sessionId, 'the session ended')
  }

  private closeOpen(sessionId: SessionId, why: string): void {
    for (const id of this.deps.store.expireSession(sessionId, this.deps.now())) {
      const row = this.deps.store.get(id)
      if (row) this.deps.publish(row)
      log.debug('interaction expired', { id, why })
    }
  }

  private expire(id: string): void {
    if (!this.deps.store.expire(id, this.deps.now())) return
    const row = this.deps.store.get(id)
    if (row) this.deps.publish(row)
  }

  /** The transcript tail's last AskUserQuestion, as raw prompts. */
  private async readQuestionOptions(
    sessionId: SessionId,
  ): Promise<QuestionPromptInput[] | undefined> {
    const { items } = await this.deps.readTranscript({
      sessionId,
      direction: 'before',
      limit: TRANSCRIPT_TAIL,
    })
    const q = [...items]
      .reverse()
      .find((i) => i.role === 'tool' && i.toolName === 'AskUserQuestion' && i.toolInputJson)
    if (!q?.toolInputJson) return undefined
    try {
      const parsed = JSON.parse(q.toolInputJson) as { questions?: unknown }
      return Array.isArray(parsed.questions)
        ? (parsed.questions as QuestionPromptInput[])
        : undefined
    } catch {
      return undefined
    }
  }

  /**
   * The default answer table, applied at ask time.
   *
   * Only kinds WITH a default are touched, and the recorded `answeredBy` is
   * `policy` so the audit trail distinguishes "a human decided this" from "a
   * default did". A failed auto-answer leaves the row open — escalating to a
   * human is the correct outcome of a policy that could not act.
   */
  private async applyDefaultAnswer(row: InteractionRow, spec: InteractionAskSpec): Promise<void> {
    const answer = defaultAnswerFor(spec)
    if (!answer) return
    const outcome = await this.answer({
      id: row.id,
      answer,
      answeredBy: 'policy',
      principal: this.deps.policyPrincipal(),
    })
    if (!outcome.ok) log.debug('default answer declined', { id: row.id, reason: outcome.reason })
  }

  // -- answering ------------------------------------------------------------

  /**
   * Answer an ask. IDEMPOTENT: the second call gets a typed error, never a
   * second delivery.
   *
   * ORDER MATTERS AND IS DELIBERATE — the row is claimed BEFORE the answer is
   * delivered. Delivering first would leave a window in which two concurrent
   * answers both pass the status check and both type digits at the menu, which
   * on a `keystroke-emulated` session is not recoverable. Claiming first can
   * instead leave a row marked answered whose delivery then failed; that case is
   * recorded honestly as `deliveredVia: 'unverified'` and surfaced, rather than
   * silently reopened. The spec's own send vocabulary draws the same line for
   * the same reason.
   */
  async answer(input: AnswerInput): Promise<InteractionAnswerOutcome & { detail?: string }> {
    const row = this.deps.store.get(input.id)
    if (!row) return { ok: false, reason: 'unknown-interaction' }
    if (row.status === 'answered') return { ok: false, reason: 'already-answered' }
    if (row.status === 'expired') return { ok: false, reason: 'expired' }

    const spec = { kind: row.kind, payload: row.payload } as InteractionAskSpec
    let answer: InteractionAnswer
    if (input.answer) {
      if (input.answer.kind !== row.kind) {
        return {
          ok: false,
          reason: 'unknown-interaction',
          detail: `answer is for a ${input.answer.kind} ask; this one is ${row.kind}`,
        }
      }
      answer = input.answer
    } else {
      const resolved = resolveAnswerText(spec, input.text ?? '')
      if (!resolved.ok)
        return { ok: false, reason: 'unknown-interaction', detail: resolved.message }
      answer = resolved.answer
    }

    const claimed = this.deps.store.answer({
      id: row.id,
      answer,
      answeredBy: input.answeredBy,
      // Provisional; corrected below once delivery reports. A row that crashes
      // between here and there reads as "answered, delivery unproven", which is
      // the true statement.
      deliveredVia: 'unverified',
      at: this.deps.now(),
    })
    // Lost the race with a concurrent answer — the other one is the answer.
    if (!claimed) return { ok: false, reason: 'already-answered' }

    const delivery = await this.deliver(row, answer, input.principal)
    // `recordDelivery`, not a second `answer`: that one guards on
    // `status = 'asked'` — the guard IS the claim above — so it would update
    // nothing here and leave every delivered answer recorded as unverified.
    this.deps.store.recordDelivery(row.id, delivery.via)
    const settled = this.deps.store.get(row.id)
    if (settled) this.deps.publish(settled)
    return delivery.ok
      ? { ok: true }
      : { ok: true, detail: `recorded, but delivery failed: ${delivery.detail}` }
  }

  /**
   * Hand the typed answer to the existing delivery machinery.
   *
   * Everything Podium can actually deliver today is `keystroke-emulated`, so
   * every arm ends in text that `deliverAnswerToSession` resolves against the
   * live menu (or, with `textFallback`, sends as an ordinary message). The
   * `structured` path exists for a server-family driver and is not reachable
   * from the terminal sources W2 synthesizes from — which is why there is no
   * pretend implementation of it here.
   */
  private async deliver(
    row: InteractionRow,
    answer: InteractionAnswer,
    principal: InboxPrincipalReference,
  ): Promise<{
    ok: boolean
    via: NonNullable<PendingInteractionWire['deliveredVia']>
    detail?: string
  }> {
    const text = deliverableText(answer)
    if (text === null) {
      return {
        ok: false,
        via: 'unverified',
        detail: `a ${answer.kind} answer has no keystroke form on this session`,
      }
    }
    try {
      const result = await this.deps.deliver({
        sessionId: row.sessionId,
        answer: text,
        principal,
        // A plan verdict and a login report are PROSE, not menu digits: there is
        // no native menu for them, and the durable resumeAndSend path is how
        // they reach the agent. A permission or question answer must hit the
        // live menu, so it gets no fallback — free text landing on top of an
        // open menu is the failure the delivery gate exists to prevent.
        ...(answer.kind === 'plan-approval' || answer.kind === 'login'
          ? { textFallback: true }
          : {}),
      })
      if (!result.ok) return { ok: false, via: 'unverified', detail: result.message }
      return { ok: true, via: result.via }
    } catch (err) {
      return {
        ok: false,
        via: 'unverified',
        detail: err instanceof Error ? err.message : String(err),
      }
    }
  }
}

/**
 * The typed answer → the string the delivery gate takes.
 *
 * `null` means this answer has no keystroke form. That is not a gap to be
 * filled with a guess: an elicitation is a form, and typing something at a
 * terminal that is waiting for structured content would be worse than refusing.
 */
function deliverableText(answer: InteractionAnswer): string | null {
  switch (answer.kind) {
    case 'permission':
      // The menu's rows are "yes" / "yes, and don't ask again" / "no"; the
      // matcher resolves these labels against whatever the harness drew.
      return answer.decision === 'deny'
        ? 'no'
        : answer.decision === 'allow-always'
          ? 'always'
          : 'yes'
    case 'question': {
      // The digit path takes 1-based indices; `matchAnswerToOptions` reads a
      // bare comma-separated list of them, which is the single form that works
      // for both single- and multi-select.
      const first = answer.selections[0]
      if (!first) return null
      if (first.text !== undefined) return first.text
      return first.optionIndices.join(',')
    }
    case 'plan-approval':
      return answer.decision === 'approve'
        ? 'Approved — go ahead with the plan.'
        : `Not yet.${answer.feedback ? ` ${answer.feedback}` : ''}`
    case 'login':
      return answer.outcome === 'completed'
        ? 'The credential has been refreshed — please retry.'
        : 'Stop waiting on the login; abandon this turn.'
    case 'recovery':
      return answer.choice
    case 'elicitation':
      return null
  }
}

/** The durable row → the wire shape. The `as` is the one cast this module makes:
 *  the payload column is validated on the way IN (the synthesizer produces a
 *  typed spec) and the kind/payload pairing is what the discriminated union
 *  encodes, which SQLite cannot express. */
function toWire(row: InteractionRow): PendingInteractionWire {
  return {
    id: row.id,
    sessionId: row.sessionId,
    kind: row.kind,
    payload: row.payload,
    askedAt: row.askedAt,
    source: row.source,
    answerable: row.answerable,
    status: row.status,
    fingerprint: row.fingerprint,
    ...(row.policyVerdict ? { policyVerdict: row.policyVerdict } : {}),
    ...(row.expiresAt ? { expiresAt: row.expiresAt } : {}),
    ...(row.answeredAt ? { answeredAt: row.answeredAt } : {}),
    ...(row.answeredBy ? { answeredBy: row.answeredBy } : {}),
    ...(row.answer ? { answer: row.answer } : {}),
    ...(row.deliveredVia ? { deliveredVia: row.deliveredVia } : {}),
    ...(row.expiredAt ? { expiredAt: row.expiredAt } : {}),
  } as PendingInteractionWire
}
