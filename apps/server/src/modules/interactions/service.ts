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
  InteractionAnswerability,
  InteractionAnsweredBy,
  InteractionAnswerOutcome,
  InteractionEvent,
  InteractionKind,
  InteractionSource,
  PendingInteractionWire,
  TurnEvent,
} from '@podium/protocol'
import type { InteractionRow, InteractionsRepository } from '../../store/interactions'
import type { InboxPrincipalReference } from '../sessions/inbox'
import type { AnswerDeliveryResult } from '../superagent/answer-delivery'
import { defaultAnswerFor, resolveAnswerText } from './answers'
import { materializeFailure } from './materialize'
import {
  hasReliableIdentity,
  type InteractionAskSpec,
  interactionFingerprint,
  type QuestionPromptInput,
  synthesizeAsk,
} from './synthesis'

const log = createLogger('server:interactions')

/** How far back the transcript is read for a live menu's options — the same
 *  window `deliverAnswerToSession` uses, for the same reason (the last
 *  AskUserQuestion call carries them as structured `toolInputJson`). */
const TRANSCRIPT_TAIL = 50

/**
 * THE SOURCES THE STATE PATH OWNS.
 *
 * `onStateChanged` closes the session's open asks when the state stops being an
 * ask, and that half is load-bearing — without it a permission row answered at
 * the terminal would stay open forever and the list would lie about which
 * sessions are blocked. But it must close only what it SYNTHESIZED. A
 * protocol-sourced ask has its own resolution event coming from the driver that
 * raised it, and an ask materialized from a causal turn failure is closed by the
 * next turn boundary; wiping either one because an unrelated terminal
 * observation moved is how a session ends up blocked on a prompt whose row was
 * deleted out from under it (POD-2414).
 *
 * `hook` and `screen-classifier` are exactly the two `sourceFor` can return.
 */
const STATE_DERIVED_SOURCES: ReadonlySet<InteractionSource> = new Set(['hook', 'screen-classifier'])

/**
 * THE KINDS A TURN BOUNDARY RESOLVES.
 *
 * A session that just started or finished a turn is demonstrably not waiting on
 * a credential or on a resume decision, so any open `login`/`recovery` row is
 * stale whoever opened it — the operator refreshed the token, answered the
 * resume prompt at the terminal, or the harness recovered by itself.
 *
 * The mid-turn kinds are deliberately absent. A `permission` or `question` ask
 * IS a turn in progress; closing those on a turn event would close them the
 * instant they were raised.
 */
const TURN_BOUNDARY_RESOLVES: ReadonlySet<InteractionKind> = new Set(['login', 'recovery'])

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
  /**
   * STRUCTURED DELIVERY — the seam W2 left for a protocol driver, filled by W5
   * (POD-2023).
   *
   * Bound at the composition root to the runtime gateway's `runtimeAnswer`,
   * which reaches the session's driver and replies over the harness's own
   * protocol: for opencode, `POST /permission/{id}/reply` with once/always/
   * reject, or `POST /question/{id}/reply` with the selected labels.
   *
   * OPTIONAL, and the optionality is honest rather than defensive: a build with
   * no daemon RPC wired cannot deliver a structured answer, and
   * {@link unsupportedAnswerReason} refuses in that case exactly as it did
   * before this existed. What must never happen is accepting the answer and
   * doing nothing, which is why the refusal is keyed on this being ABSENT rather
   * than on a hardcoded "not yet".
   */
  deliverStructured?(input: {
    sessionId: SessionId
    interactionId: string
    answer: InteractionAnswer
  }): Promise<InteractionAnswerOutcome>
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
  /**
   * THE INGRESS — record an ask, whoever observed it.
   *
   * This is the seam W5's opencode driver and W6's codex driver land on, and it
   * is public for that reason: a driver that watched a `permission.updated`
   * event knows strictly more than the bus subscription does, and must be able
   * to say so rather than have the server re-derive a worse version.
   *
   * THE CALLER'S IDENTITY SURVIVES. `id` is taken as given — W3's terminal
   * driver mints `ask:<transitionId>`, a server driver has a provider request id
   * — because that id is what the driver will need to answer THROUGH later. Only
   * a caller that supplies none gets a server mint.
   *
   * `fingerprint` is likewise the caller's when supplied: a driver with reliable
   * ask identity should not have the server guess a digest for it. When absent
   * the server computes one, and consults it only where the source says identity
   * is unreliable (see {@link hasReliableIdentity}).
   *
   * Returns the row now open for this ask — the fresh one, or the duplicate it
   * collapsed into.
   */
  async ask(input: {
    interaction: InteractionAskSpec & {
      id?: string
      sessionId: SessionId
      source: InteractionSource
      answerable: InteractionAnswerability
      askedAt?: string
      expiresAt?: string
      fingerprint?: string
    }
  }): Promise<{ row: PendingInteractionWire; inserted: boolean }> {
    const a = input.interaction
    const spec = { kind: a.kind, payload: a.payload } as InteractionAskSpec
    const fingerprint =
      a.fingerprint ??
      interactionFingerprint(
        a.sessionId,
        spec,
        // A caller with reliable identity and no fingerprint of its own still
        // must not have two distinct asks merged; its supplied id is the
        // discriminator, and falling back to the ask instant covers a mint.
        hasReliableIdentity(a.source) ? (a.id ?? this.deps.now()) : undefined,
      )
    const { row, inserted } = this.deps.store.insert({
      id: a.id ?? `ixn_${randomUUID()}`,
      sessionId: a.sessionId,
      kind: a.kind,
      payload: a.payload,
      source: a.source,
      answerable: a.answerable,
      fingerprint,
      askedAt: a.askedAt ?? this.deps.now(),
      ...(a.expiresAt ? { expiresAt: a.expiresAt } : {}),
    })
    // A collapsed duplicate must not re-announce — see the header.
    if (inserted) {
      this.deps.publish(row)
      await this.applyDefaultAnswer(row, spec)
    }
    const settled = this.deps.store.get(row.id) ?? row
    return { row: toWire(settled), inserted }
  }

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
        // SUPERSEDED, not expired: the overwhelmingly common cause is a person
        // answering at the terminal, which is a resolution. A list that
        // reported those as expirations would read as a pile of failures.
        //
        // Scoped to what this path synthesized — see {@link STATE_DERIVED_SOURCES}.
        this.closeOpen(input.sessionId, 'superseded', 'the session left the asking state', (row) =>
          STATE_DERIVED_SOURCES.has(row.source),
        )
        return
      }
      // A state that re-reports the SAME ask leaves the open row alone; a state
      // that reports a DIFFERENT one closes the stale row first, because two
      // open asks on one terminal session would both claim the same menu. Same
      // scoping: a driver's own ask is not this path's to supersede.
      for (const open of this.deps.store.listOpen(input.sessionId)) {
        if (!STATE_DERIVED_SOURCES.has(open.source)) continue
        if (open.fingerprint !== ask.fingerprint) this.supersede(open.id)
      }
      // ONE INTERNAL CALLER of the public ingress: the bus path has no more
      // authority than a driver does, and routing it through `ask()` is what
      // keeps the two from growing separate insert/publish/auto-answer logic.
      await this.ask({
        interaction: {
          ...ask.spec,
          sessionId: input.sessionId,
          source: ask.source,
          answerable: ask.answerable,
          fingerprint: ask.fingerprint,
        },
      })
    } catch (err) {
      // NEVER THROWS INTO THE BUS. This is an observer; a fault here must not
      // break the state-change fan-out that the badge and the inbox ride on.
      log.warn('interaction synthesis failed', { err, sessionId: input.sessionId })
    }
  }

  /**
   * THE FAILURE INGRESS — a causal turn event, from the runtime event gate
   * (POD-2414; spec §3 "Failure semantics").
   *
   * This is the second half of the routing rule the contract states as an
   * invariant: needs-human failures materialize as PendingInteractions. The
   * classification is `materialize.ts`'s, shared with the state path, so a
   * driver that reports `TurnFailed{disposition:'needs-human'}` and a daemon
   * that reports an `errored` phase produce the same ask for the same cause.
   *
   * BOTH DIRECTIONS ARE HERE, and the closing half matters as much as the
   * opening one. A turn that STARTS or COMPLETES is proof the session is not
   * waiting on a credential or a resume decision any more — whoever fixed it —
   * so the stale row closes. Without that, the first billing failure of a
   * session's life would pin a row open for the rest of it.
   *
   * DEDUPE IS BY FINGERPRINT AND DELIBERATELY HAS NO OCCURRENCE DISCRIMINATOR.
   * A session hitting the same wall on three consecutive turns is one blocked
   * session, not three asks; the partial unique index collapses them while the
   * first is still open, and a genuinely new failure after the first is answered
   * opens a fresh row.
   *
   * SAFE TO REPEAT, because the gate's board projector may replay it: the
   * durable event-id cursor advances only after this resolves, so a crash
   * between commit and projection re-delivers the event. Insert-on-conflict and
   * a close that no-ops on an already-closed row are what make that harmless.
   */
  async onTurnEvent(input: {
    sessionId: SessionId
    ev: TurnEvent
    at: string
    /** The harness a `login` ask should name as the provider, when the caller
     *  knows it. */
    provider?: string
  }): Promise<void> {
    try {
      if (input.ev.ev !== 'failed') {
        this.closeOpen(
          input.sessionId,
          'superseded',
          'a turn boundary passed, so the session is no longer blocked on it',
          (row) => TURN_BOUNDARY_RESOLVES.has(row.kind),
        )
        return
      }
      const spec = materializeFailure({
        evidence: 'turn-failed',
        reason: input.ev.reason,
        disposition: input.ev.disposition,
        ...(input.ev.detail ? { detail: input.ev.detail } : {}),
        ...(input.provider ? { provider: input.provider } : {}),
      })
      if (!spec) return
      await this.ask({
        interaction: {
          ...spec,
          sessionId: input.sessionId,
          // THE DRIVER OBSERVED IT. `protocol` is the provenance of a causal
          // event off the contract stream, and it is what keeps this row out of
          // the state path's supersede sweep.
          source: 'protocol',
          // NOT `structured`, and the distinction is the honest one: the ask
          // came over a protocol, but the ANSWER is prose the durable send path
          // delivers ("continue where you left off"), not a reply to a request
          // id the harness is holding open. Claiming `structured` would route it
          // to a driver with nothing to reply to.
          answerable: 'keystroke-emulated',
          askedAt: input.at,
          fingerprint: interactionFingerprint(input.sessionId, spec),
        },
      })
    } catch (err) {
      // Never throws into the projector — a fault here must not stall the
      // board's durable cursor behind an interaction the aggregate could not
      // record. The event is logged and the stream keeps moving.
      log.warn('failure materialization failed', { err, sessionId: input.sessionId })
    }
  }

  /**
   * A DRIVER RETIRED ONE OF ITS OWN ASKS (POD-2414).
   *
   * The compatibility frame that opens a protocol ask carries only the `asked`
   * arm, so before this the aggregate had no way to learn that a person had
   * answered a permission prompt in opencode's own UI: the row stayed open, and
   * a list whose promise is "these sessions are blocked" accumulated sessions
   * that were not. The coarse stream carries all three arms; this is the other
   * two.
   *
   * SUPERSEDED, NOT ANSWERED, for the `answered` arm — the aggregate did not
   * record the decision and must not claim to know what it was. `expired` is
   * expired: the harness withdrew the ask and nobody decided anything.
   *
   * Safe to repeat: `close` guards on `status = 'asked'`, so a row this
   * aggregate already answered is untouched, which is exactly the common case —
   * an answer delivered through `deliverStructured` comes straight back as an
   * `answered` event from the driver that applied it.
   */
  onInteractionResolved(input: { sessionId: SessionId; ev: InteractionEvent }): void {
    if (input.ev.ev === 'asked') return
    const row = this.deps.store.get(input.ev.id)
    // A resolution for a row this server never saw is not an error: the ask may
    // predate the aggregate's knowledge of the session, or belong to a replica.
    if (!row || row.sessionId !== input.sessionId) return
    if (
      !this.deps.store.close(
        row.id,
        input.ev.ev === 'expired' ? 'expired' : 'superseded',
        this.deps.now(),
      )
    )
      return
    const settled = this.deps.store.get(row.id)
    if (settled) this.deps.publish(settled)
  }

  /** A session ended: every ask it left behind stops being answerable. EXPIRED
   *  rather than superseded — the menu went away with the process, and nobody
   *  answered it. */
  onSessionExited(sessionId: SessionId): void {
    this.closeOpen(sessionId, 'expired', 'the session ended')
  }

  private closeOpen(
    sessionId: SessionId,
    status: 'expired' | 'superseded',
    why: string,
    only?: (row: InteractionRow) => boolean,
  ): void {
    if (!only) {
      for (const id of this.deps.store.closeSession(sessionId, status, this.deps.now())) {
        const row = this.deps.store.get(id)
        if (row) this.deps.publish(row)
        log.debug('interaction closed', { id, status, why })
      }
      return
    }
    // The filtered form closes row by row rather than in one statement. The
    // set is at most a handful — an open ask means a session is blocked — and a
    // predicate the caller owns cannot be pushed into SQL without this module
    // deciding for every future caller which columns a filter may name.
    for (const row of this.deps.store.listOpen(sessionId)) {
      if (!only(row)) continue
      if (!this.deps.store.close(row.id, status, this.deps.now())) continue
      const settled = this.deps.store.get(row.id)
      if (settled) this.deps.publish(settled)
      log.debug('interaction closed', { id: row.id, status, why })
    }
  }

  private supersede(id: string): void {
    if (!this.deps.store.close(id, 'superseded', this.deps.now())) return
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
    if (!outcome.ok) {
      // A REFUSED default never claimed the row, so it is still open. Nothing to
      // undo; the human sees it, which is the escalation.
      log.debug('default answer declined', { id: row.id, reason: outcome.reason })
      return
    }
    // ACCEPTED BUT UNDELIVERED IS THE CASE THAT USED TO SWALLOW THE ASK
    // (POD-2414). `answer()` claims the row before delivering, and reports a
    // failed delivery as `ok: true` with a detail — correct for a human, who is
    // told their answer was recorded and could not be proven to land. For the
    // POLICY it is wrong: the row leaves `listOpen` and the feed, so a session
    // that stalled at a recovery prompt the default could not deliver becomes a
    // session stalled with nothing on any surface. §4's order is policy, then
    // triage, then a human — so a policy that could not act hands it back.
    const settled = this.deps.store.get(row.id)
    if (settled?.deliveredVia !== 'unverified') return
    // A FRESH DUPLICATE IS ALREADY THE ESCALATION. Between the claim and here a
    // re-observation can have opened another row for the same fingerprint, and
    // the partial unique index would refuse a second open one — correctly, since
    // the session is visibly blocked either way.
    if (this.deps.store.openByFingerprint(row.sessionId, row.fingerprint)) return
    if (!this.deps.store.reopen(row.id)) return
    const reopened = this.deps.store.get(row.id)
    if (reopened) this.deps.publish(reopened)
    log.info('default answer could not be delivered; escalating to a human', {
      id: row.id,
      kind: row.kind,
      detail: outcome.detail,
    })
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

    // SUPERSEDED READS AS ALREADY-ANSWERED, not expired, and the distinction is
    // the caller's not ours: the overwhelmingly common way a row supersedes is a
    // person answering at the terminal. "Expired" would tell an operator their
    // answer was too late for an ask nobody handled; "already answered" tells
    // them the true thing, which is that somebody got there first.
    if (row.status === 'superseded') return { ok: false, reason: 'already-answered' }

    // ---------------------------------------------------------------------
    // THE UNSHIPPED PATHS REFUSE HERE — BEFORE THE ROW IS CLAIMED.
    // ---------------------------------------------------------------------
    // Order is the whole point. Refusing after the claim would mark the ask
    // ANSWERED and drop it out of `listOpen`, so a session that is still sitting
    // on a permission prompt would vanish from the one list whose promise is
    // that a blocked session appears in it. The ask stays open and the refusal
    // is typed.
    const unsupported = unsupportedAnswerReason(row, {
      structuredDelivery: this.deps.deliverStructured !== undefined,
    })
    if (unsupported) return { ok: false, reason: 'not-yet-supported', detail: unsupported }

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
    /**
     * THE STRUCTURED PATH GOES FIRST, and it never falls back to keystrokes.
     *
     * A `structured` ask came from a protocol driver and is answered over that
     * protocol; if the round-trip fails, the honest report is that delivery
     * failed and the row stays `unverified`. Degrading to typing digits at a
     * session that has no terminal would be answering a menu that does not
     * exist.
     */
    if (row.answerable === 'structured' && this.deps.deliverStructured) {
      try {
        const outcome = await this.deps.deliverStructured({
          sessionId: row.sessionId,
          interactionId: row.id,
          answer,
        })
        return outcome.ok
          ? { ok: true, via: 'structured' }
          : { ok: false, via: 'unverified', detail: outcome.reason }
      } catch (err) {
        return {
          ok: false,
          via: 'unverified',
          detail: err instanceof Error ? err.message : String(err),
        }
      }
    }
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
        //
        // A `recovery` verdict joins them (POD-2414): a resume decision and a
        // failure acknowledgement are prose too, and the ask that carries them
        // is raised precisely when there is no menu — at startup, or after a
        // turn died. `resumeAndSend` is the path that wakes a parked session and
        // queues while one is still starting, which is what makes a STARTING
        // recovery answerable instead of deadlocked.
        ...(answer.kind === 'plan-approval' || answer.kind === 'login' || answer.kind === 'recovery'
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
 * WHY THIS ASK CANNOT BE ANSWERED YET, or `null` if it can.
 *
 * Two paths are specified and deliberately unshipped, and both refuse rather
 * than degrade.
 *
 * PERMISSION BY KEYSTROKE — POD-707. The evidence file
 * (`docs/agents/evidence/pod-707-permission-menu.md` §5) lists what a PTY run
 * still has to establish: whether `1` approves an ordinary Bash ask or lands in
 * a `yesInputMode` field, whether Esc rejects cleanly, and whether the reject
 * path needs a settle delay. Until those are answered the ordinals are not
 * known to be stable per ask, which means a "deny" keystroke can approve. The
 * always-allow rows are worse: they are conditional and ordered per tool, so
 * they must never be pressed programmatically — `canAlwaysAllow` exists so a
 * surface can SAY the option is in the terminal, not so anything can reach it.
 *
 * STRUCTURED, ANY KIND — no protocol driver exists yet. W5/W6 land the first
 * one; this refusal is the clean seam they replace.
 *
 * Refusing leaves the session visibly blocked and a human answers at the
 * terminal, which is strictly better than a silent wrong keystroke reported as
 * success.
 */
export function unsupportedAnswerReason(
  row: {
    kind: InteractionRow['kind']
    answerable: InteractionRow['answerable']
  },
  capabilities: { structuredDelivery: boolean } = { structuredDelivery: false },
): string | null {
  if (row.answerable === 'structured') {
    // W5 (POD-2023) SHIPPED THE FIRST PROTOCOL DRIVER, so this is no longer a
    // blanket refusal — it is a refusal for a build with no route to one. An
    // opencode server session's ask is answered over REST against the harness's
    // own request id, which is the whole reason its `answerable` says
    // `structured` in the first place.
    return capabilities.structuredDelivery
      ? null
      : 'structured answering needs a protocol driver, and no structured delivery route is wired on this server'
  }
  if (row.kind === 'permission') {
    return (
      'answering a permission prompt by keystroke is not shipped (POD-707): the native menu’s ' +
      'ordinals vary per ask, so a denial can approve, and the always-allow rows must never be ' +
      'pressed programmatically. Answer it at the terminal.'
    )
  }
  return null
}

/**
 * The typed answer → the string the delivery gate takes.
 *
 * `null` means this answer has no keystroke form. That is not a gap to be
 * filled with a guess: an elicitation is a form, and typing something at a
 * terminal that is waiting for structured content would be worse than refusing.
 *
 * There is NO `permission` arm, and its absence is the POD-707 rule made
 * structural — see {@link unsupportedAnswerReason}. A permission answer never
 * reaches this function.
 */
function deliverableText(answer: InteractionAnswer): string | null {
  switch (answer.kind) {
    case 'permission':
      return null
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
    /**
     * THE RESUME VERDICT AS PROSE, not as its enum name.
     *
     * `answer.choice` used to be returned verbatim, which meant a delivered
     * recovery answer typed the literal string `full-resume` at an agent. The
     * choice is a CONTRACT token for the surfaces; what reaches the session has
     * to be a sentence it can act on, exactly as the `login` arm above already
     * decided for the same reason.
     *
     * `fresh-session` has no prose form and returns null: it means spawn a NEW
     * session, which is a different verb with different ownership, and a
     * sentence asking an agent to do it would be delivered as if it had. The
     * refusal is honest and the ask stays open.
     */
    case 'recovery':
      switch (answer.choice) {
        case 'full-resume':
          return 'Continue where you left off.'
        case 'summary-resume':
          return 'Continue from a summary of the conversation so far.'
        case 'abandon':
          return 'Stop waiting on this; abandon the turn.'
        case 'fresh-session':
          return null
      }
      return null
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
