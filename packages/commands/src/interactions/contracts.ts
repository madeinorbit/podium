/**
 * THE ONE INTERACTION WRITE — `interactions.answer` (POD-2020, spec §4).
 *
 * The PendingInteraction aggregate has exactly one mutation, and that is a
 * design claim rather than a small surface: asks are SYNTHESIZED from what the
 * runtime observes and expired by what it observes next, so nothing outside the
 * server may mint or cancel one. Answering is the only thing a human, a policy
 * or a superagent does to an interaction, which is why it is the only contract
 * here. The reads (`list`, `forSession`) are a query table in the module, on the
 * same split every family in this phase made: a `visibility` class describes
 * what a command WRITES, and a read writes nothing.
 *
 * L1 DATA ONLY. The handler is `InteractionService.answer` in
 * `apps/server/src/modules/interactions/service.ts`, joined by that module's
 * `registry.ts`.
 *
 * ---------------------------------------------------------------------------
 * WHY `personal`
 * ---------------------------------------------------------------------------
 * An ask is readable by exactly the audience of the session it blocks, and it is
 * addressed to whoever is watching that session — the same "routed to a human's
 * attention" argument ADR 1's `approvals` row makes, applied to the aggregate
 * that generalizes approvals. NOT `per-user-state`: an ask is one durable row
 * with one answer, not a per-viewer projection of a shared one. Two operators
 * looking at the same blocked session must not each get their own copy of a
 * prompt that can only be answered once — that is precisely what the
 * idempotency guarantee below is about.
 *
 * ---------------------------------------------------------------------------
 * WHY `manage` AND NOT `write`
 * ---------------------------------------------------------------------------
 * Answering does not edit the interaction; it RELEASES a blocked agent, and on a
 * `permission` ask what it releases is a tool call the answerer may not be able
 * to make themselves. ADR 3 D2 grades by what a command lets happen. The
 * approval broker reached the same grade for the same reason, and this aggregate
 * subsumes it: `interactions.answer` on a permission ask is the general form of
 * `approvals.approve`.
 */

import { z } from 'zod'
import type {
  AttributionPolicy,
  CommandContract,
  DeliveryPolicy,
  ErrorConsistency,
  RedactionPolicy,
  TransportTag,
  VisibilityClass,
} from '../contract'

/**
 * `trpc` and `cli`, and the second one is the point of the item.
 *
 * W2's acceptance criterion is that a blocking prompt is "answerable without
 * attaching a terminal", from a headless machine — which is `podium interactions
 * answer`. An operator CLI call reaches the same tRPC procedure over the same
 * credential (`makeOperatorIssueClient`), so `cli` here is a declaration that the
 * verb exists on that transport, not a second implementation.
 *
 * No `mcp`: the superagent already answers questions through `answer_question`,
 * and adding a second tool for the same act before anything asks for it would be
 * ADR 3 D3 opening a surface nobody measured.
 */
const SERVED_ON: readonly TransportTag[] = ['trpc', 'cli']

const INTERACTION_VISIBILITY: VisibilityClass = 'personal'

/**
 * ONLINE-ONLY, and the reason is sharper here than for approvals.
 *
 * An answer is delivered by TYPING AT A LIVE MENU on every source W2
 * synthesizes from. A queued answer replayed after a drain window would type
 * digits at whatever is on screen then — which is not merely stale, it is the
 * exact failure the `keystroke-emulated` answerability flag exists to warn
 * about. The ask may also have expired with its session, in which case the
 * durable row refuses the replay and the queue would have carried an answer to
 * nothing.
 */
const INTERACTION_DELIVERY: DeliveryPolicy = {
  class: 'online-only',
  outboxReconciliation:
    'NEVER queued. Every source W2 synthesizes from is answered by typing at a LIVE native menu ' +
    '(`answerable: "keystroke-emulated"`), so a replayed answer types digits at whatever the ' +
    'terminal shows at replay time — the unrecoverable case the answerability flag exists to warn ' +
    'about. The aggregate also expires open asks when their session ends, so a drained answer ' +
    'commonly has no row left to resolve.',
  applyTimeReauthorization:
    'Re-authorized live at apply against the delegation resolved at that moment (ADR 9 D5 A1). A ' +
    'principal who has lost read access to the session between seeing the ask and answering it is ' +
    'refused, and the row stays open — the agent keeps waiting, which is the honest outcome.',
}

/**
 * Reviewed, with the candidate named so the short list reads as a finding.
 *
 * The ask PAYLOAD can describe a command about to run (`permission.inputSummary`
 * is a truncated shell command or file path). It does not cross this surface:
 * `answer` carries an opaque server-minted `id` plus the answer, and the payload
 * rides the reads. `text` and the answer's own free-text fields are operator
 * prose and are logged as such.
 *
 * What is deliberately absent from the whole vocabulary, and worth recording
 * here because a reviewer will look: NO CREDENTIAL ever crosses it. A `login`
 * ask is answered with `completed` / `cancelled` — a report that the credential
 * was refreshed elsewhere — never with the credential.
 */
const INTERACTION_REDACTION: RedactionPolicy = {
  reviewed: true,
  inputPaths: [],
  outputPaths: [],
  note:
    'The command carries an opaque server-minted `id` and the answer. The one candidate — the ask ' +
    'payload, which for a `permission` names the command about to run — rides the READS, not this ' +
    'write. The `login` answer is deliberately a report (`completed`/`cancelled`) and never a ' +
    'credential, so no secret exists on this surface to redact.',
}

/**
 * Both halves stamped from the transport principal.
 *
 * WHO ANSWERED is the durable point of the row. A headless run's whole safety
 * argument is that a decision it made without a human is attributable — the
 * aggregate records `answeredBy: policy | superagent | human` beside the
 * principal — and a value claimed from the payload would let an agent record a
 * human's decision.
 */
const INTERACTION_ATTRIBUTION: AttributionPolicy = {
  actor: 'from-capability',
  onBehalfOf: 'from-delegation',
  wirePlacement: 'separate-field',
  reservedWireKeys: ['actor', 'onBehalfOf'],
  rationale:
    'WHO ANSWERED is why the row is durable: a fully-headless worker is safe only if the decisions ' +
    'it made unattended are attributable. Both halves come from the transport principal, never the ' +
    'payload — otherwise an agent could record a human’s consent to its own tool call, which is the ' +
    'single worst thing this aggregate could be made to do. `id` is a routing address; Amendment 1 ' +
    'D17 forbids it doubling as the accountability record.',
}

/**
 * `callerSuppliedTargetId: true` — the id could otherwise be iterated to learn
 * which sessions are blocked, which leaks the existence of sessions across an
 * ownership boundary. An ask this principal may not see fails identically to one
 * that does not exist.
 *
 * The three refusal reasons the contract DOES distinguish — `already-answered`,
 * `expired`, `unknown-interaction` — are all statements about a row the caller
 * may already see, so none of them widens what an unauthorized caller learns.
 */
const INTERACTION_ERRORS: ErrorConsistency = {
  callerSuppliedTargetId: true,
  invisibleFailsAs: 'nonexistent',
  distinguishesUnauthorizedFromUnreachable: false,
  note:
    'The `id` is caller-supplied and iterable, and an ask’s existence reveals that a session exists ' +
    'and is blocked — so D20.2 governs and an invisible row fails as a nonexistent one. The typed ' +
    'refusals (`already-answered`, `expired`) are only ever returned for a row the caller may ' +
    'already read, so they widen nothing. M5’s carve-out does not apply: no machine is nameable on ' +
    'this surface.',
}

const CREATES_NOTHING = {
  creates: [],
  note:
    'Resolves an ask the runtime synthesized; mints no entity and moves no ownership. Interactions ' +
    'have no create verb at all — nothing outside the server may raise one.',
} as const

/**
 * INTENT IN, RESOLUTION SERVER-SIDE.
 *
 * `text` is free text resolved against the ask's OWN recorded options by
 * `modules/interactions/answers.ts`; `answer` is an already-typed value from a
 * surface that rendered the payload. Exactly one is required, and that is
 * enforced here rather than in the handler so the refusal is a parse error at
 * the boundary.
 *
 * The typed arm is deliberately NOT `InteractionAnswer` from `@podium/protocol`:
 * this package is L1 and must not take a protocol dependency for one field. It
 * is a passthrough object whose `kind` is checked against the row's kind by the
 * service, which is where the pairing can actually be verified against the ask.
 */
export const interactionsAnswerInput = z
  .object({
    id: z.string().min(1),
    text: z.string().min(1).optional(),
    answer: z.object({ kind: z.string().min(1) }).passthrough().optional(),
  })
  .refine((v) => (v.text === undefined) !== (v.answer === undefined), {
    message: 'answer takes exactly one of `text` (resolved server-side) or `answer` (already typed)',
  })

export const interactionsAnswerContract = {
  name: 'interactions.answer',
  version: 1,
  visibility: INTERACTION_VISIBILITY,
  input: interactionsAnswerInput,
  policy: {
    action: 'manage',
    roleFloor: 'member',
    resource: 'none',
    confirmation: 'none',
    rationale:
      'MANAGE, not write: answering does not edit the ask, it RELEASES a blocked agent — and on a ' +
      '`permission` ask what it releases is a tool call the answerer may not be able to make ' +
      'directly. ADR 3 D2 grades by what a command lets happen, and this is the general form of ' +
      '`approvals.approve`, which reached the same grade for the same reason. `roleFloor: member` ' +
      'because the person watching a blocked session is routinely an ordinary member and an admin ' +
      'floor would strand their own agent (Amendment 1 D15: the floor is what you may ATTEMPT, the ' +
      'action is what you may TOUCH). `resource: none` because the gate is the SESSION named in the ' +
      'row, checked by the aggregate, rather than a containing entity on the wire. NO CONFIRMATION: ' +
      'this surface IS the confirmation — an interaction exists because something already stopped ' +
      'to ask.',
  },
  exposure: SERVED_ON,
  delivery: INTERACTION_DELIVERY,
  redaction: INTERACTION_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: INTERACTION_ATTRIBUTION,
  errorConsistency: INTERACTION_ERRORS,
  conflict: 'cmd',
  conflictRule:
    'THE FIRST ANSWER SETTLES IT, and this is load-bearing rather than conventional: the durable ' +
    'row is claimed by a conditional UPDATE on `status = asked`, so two concurrent answers race ' +
    'there and exactly one proceeds to touch the PTY. The loser gets `already-answered`. On a ' +
    'keystroke-emulated ask a second delivery is not a redundant write — it types digits at a menu ' +
    'that has already moved.',
} as const satisfies CommandContract<typeof interactionsAnswerInput>

export const INTERACTION_CONTRACTS = {
  answer: interactionsAnswerContract,
} as const

export type InteractionContractName = keyof typeof INTERACTION_CONTRACTS

export const INTERACTION_CONTRACT_NAMES = Object.keys(
  INTERACTION_CONTRACTS,
).sort() as InteractionContractName[]
