/**
 * THE FAILURE → INTERACTION GATE (POD-2414; spec §3 "Failure semantics", §4).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * The contract states one routing rule and states it as an invariant, not as a
 * suggestion (`packages/agent-runtime/src/errors.ts`): "every failure is
 * classified, and `needs-human` failures MATERIALIZE AS PendingInteractions".
 * That rule is the entire mechanism behind §4's claim that a blocked session is
 * an ENUMERABLE session — if a failure can stop a session without minting an
 * ask, then "open PendingInteraction" no longer means "blocked" and the list
 * stops being the thing you can trust.
 *
 * Before this module the rule held for exactly one shape: an `errored` phase
 * whose harness error class matched an auth-shaped regex. Everything else — a
 * billing failure, a usage cap, a context overflow, a driver-reported
 * `TurnFailed{disposition:'needs-human'}`, and a `needs_user` phase whose prompt
 * the observation path could not classify — left the session sitting there with
 * nothing on any list saying so.
 *
 * ---------------------------------------------------------------------------
 * IT IS PURE, AND IT IS THE ONLY CLASSIFIER
 * ---------------------------------------------------------------------------
 * Evidence in, an ask (or null) out. Both producers route through it — the
 * state-derived path in `synthesis.ts` and the causal `TurnFailed` path off the
 * runtime event gate — so "which failures need a human, and which kind of ask
 * they become" is answered in one place for every family. A second copy of this
 * table is how one driver's blocked sessions become invisible again.
 *
 * ---------------------------------------------------------------------------
 * THE MAPPING, AND WHY IT ENDS AT TWO KINDS
 * ---------------------------------------------------------------------------
 * The spec names the two it cares about — auth-expired → `login`,
 * context-overflow → `recovery` — and the kind vocabulary is CLOSED (six kinds,
 * schema-checked, with a SQLite check constraint behind them). So every other
 * needs-human failure lands on `recovery` with `reason: 'unknown'` rather than
 * growing a seventh kind: what a person does about a billing failure or a usage
 * cap is exactly what `RecoveryChoice` already describes — resume the session
 * once the cause is fixed, or stop waiting on it.
 *
 * WHAT DOES NOT MATERIALIZE, deliberately:
 *  - `retryable` failures. A rate-limit that the harness will retry is not a
 *    blocked session, and minting an ask for it would put rows in the list that
 *    resolve themselves — which dilutes the property the list exists for.
 *  - `fatal` failures and process exits. The process is gone; `session.exited`
 *    already closes the session's asks, and an ask nobody can answer against a
 *    dead process is a row that can only expire.
 *  - transport failures. The contract puts them outside session semantics on
 *    purpose (a session may be alive and adoptable while the path to it is
 *    down), and this module has no arm for them for that reason.
 */

import type {
  InteractionAskSpec,
  RecoveryChoice,
} from '@podium/protocol'
import type {
  FailureDisposition,
  TurnFailureReason,
} from '@podium/protocol/daemon'

/**
 * WHAT A FAILURE-MATERIALIZED RECOVERY OFFERS.
 *
 * `full-resume` ALONE, and every omission is a promise the answer path could
 * not keep — `RecoveryAsk.offered` is contractually "which choices this harness
 * offers ... a choice absent here must not be sent".
 *
 * `summary-resume` is a HARNESS capability (a resume path that replays a
 * summary instead of the transcript) and nothing about a failed turn says the
 * harness has one. `fresh-session` would mean spawning a new session — a
 * different verb with different ownership, not something answering an ask does.
 *
 * `abandon` WAS offered here and was removed (POD-2414 review, P0/2). Podium
 * has no "stop waiting" verb for this: every keystroke-emulated answer reaches
 * the session through the durable send path, so `abandon` was delivered by
 * WAKING a parked session to tell it to stop — the exact opposite of what the
 * button said, and a side effect the person pressing it did not ask for. A card
 * that stays open on a session that is genuinely still blocked is the true
 * statement; a dismissal affordance needs a verb that actually dismisses, and
 * inventing one is not this issue's to invent.
 */
const FAILURE_RECOVERY_CHOICES: readonly RecoveryChoice[] = ['full-resume']

/** Error classes that mean "this session needs a credential, not a retry". The
 *  harness vocabulary is open, so this matches rather than enumerates. */
const AUTH_ERROR = /auth|login|credential|unauthor|forbidden|api[_-]?key/i

/** Error classes that mean the conversation outgrew its window. Same open
 *  vocabulary, same reason for matching rather than enumerating. */
const OVERFLOW_ERROR = /context|overflow|too[_-]?long|token[_-]?limit/i

/**
 * The evidence a failure arrives as. Two arms because Podium observes failures
 * two ways and both must reach the same table.
 *
 * `turn-failed` is the contract's own causal event — already classified by the
 * driver that saw it, so its `disposition` is authoritative and this module
 * does not second-guess it. `agent-state` is the legacy normalized observation
 * (`AgentRuntimeState.error`), which carries a harness error class and a
 * retry hint but no disposition, so one is derived.
 */
export type FailureEvidence =
  | {
      readonly evidence: 'turn-failed'
      readonly reason: TurnFailureReason
      readonly disposition: FailureDisposition
      readonly detail?: string
      /** The provider whose credential a `login` ask should name, when the
       *  caller knows it (the session's harness). */
      readonly provider?: string
    }
  | {
      readonly evidence: 'agent-state'
      /** The harness's own error class, verbatim — `billing_error`,
       *  `usage_limit`, `authentication`, … */
      readonly errorClass: string
      readonly retryable: boolean
      readonly provider?: string
    }

/**
 * Is this failure one a human has to resolve?
 *
 * For a driver-reported turn failure the answer is already on the event and is
 * taken as given. For a legacy state error it is derived, and the derivation is
 * deliberately conservative in one direction: a NON-retryable failure whose
 * class means nothing to us is treated as needs-human rather than as fatal,
 * because the cost of a spurious row in a list somebody reads is a row somebody
 * dismisses, and the cost of the other mistake is the bug this whole aggregate
 * exists to prevent.
 */
export function failureDisposition(evidence: FailureEvidence): FailureDisposition {
  if (evidence.evidence === 'turn-failed') return evidence.disposition
  // AN AUTH FAILURE IS NEEDS-HUMAN WHATEVER THE RETRY HINT SAYS. `retryable` on
  // the legacy state means "a blind continue is worth offering", and for an
  // expired credential it is not — continuing re-fails. This is also what keeps
  // the pre-existing behaviour of the `errored` arm exactly intact: it minted a
  // `login` for every auth-shaped class and never consulted the flag.
  if (AUTH_ERROR.test(evidence.errorClass)) return 'needs-human'
  return evidence.retryable ? 'retryable' : 'needs-human'
}

/**
 * The ask a needs-human failure becomes, or `null` when it is not one.
 *
 * `null` is the common answer and must stay cheap: most failures are retryable,
 * and a caller wired onto the causal stream sees this function far more often
 * than it sees a blocked session.
 */
export function materializeFailure(evidence: FailureEvidence): InteractionAskSpec | null {
  if (failureDisposition(evidence) !== 'needs-human') return null
  const kind = failureInteractionKind(evidence)
  if (kind === 'login') {
    return {
      kind: 'login',
      payload: {
        v: 1,
        // The harness's own naming when the caller supplied it, the error class
        // otherwise. Never a guess at a provider we were not told: `provider` is
        // rendered to a person deciding which credential to refresh.
        provider: evidence.provider ?? classOf(evidence),
        reason: 'auth-expired',
      },
    }
  }
  return {
    kind: 'recovery',
    payload: {
      v: 1,
      reason: kind === 'overflow' ? 'context-overflow' : 'unknown',
      prompt: failurePrompt(evidence, kind),
      offered: FAILURE_RECOVERY_CHOICES,
    },
  }
}

type FailureShape = 'login' | 'overflow' | 'other'

function failureInteractionKind(evidence: FailureEvidence): FailureShape {
  if (evidence.evidence === 'turn-failed') {
    if (evidence.reason === 'auth-expired') return 'login'
    if (evidence.reason === 'context-overflow') return 'overflow'
    return 'other'
  }
  if (AUTH_ERROR.test(evidence.errorClass)) return 'login'
  if (OVERFLOW_ERROR.test(evidence.errorClass)) return 'overflow'
  return 'other'
}

function classOf(evidence: FailureEvidence): string {
  const raw = evidence.evidence === 'turn-failed' ? evidence.reason : evidence.errorClass
  return raw.trim().length > 0 ? raw : 'unknown'
}

/**
 * WHAT THE CARD SAYS.
 *
 * `RecoveryAsk.prompt` is "what the harness actually asked, for a surface that
 * renders it" — and a failure asked nothing, so this is the one place the
 * server writes the sentence itself. It names the failure and stops: the
 * DECISION is carried by `offered`, and a prompt that also proposed a course of
 * action would be a policy recommendation from a module that explicitly has no
 * policy.
 */
function failurePrompt(evidence: FailureEvidence, shape: FailureShape): string {
  const cause = classOf(evidence)
  const detail =
    evidence.evidence === 'turn-failed' && evidence.detail?.trim() ? ` — ${evidence.detail}` : ''
  if (shape === 'overflow') {
    return `This session's turn failed because the conversation outgrew the model's context window (${cause})${detail}.`
  }
  return `This session stopped on a failure it cannot resolve by retrying (${cause})${detail}.`
}
