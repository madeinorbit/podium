// Part of the Agent Runtime contract (POD-1761 W1). See ./index.ts for the
// surface's five governing rules and the core-vs-extended tier boundary.

import type { PendingInteraction } from '@podium/protocol'

// ---------------------------------------------------------------------------
// Interactions (spec §3, §4)
// ---------------------------------------------------------------------------

export type InteractionKind =
  | 'permission'
  | 'question'
  | 'plan-approval'
  | 'elicitation'
  | 'login'
  /** Resume-time prompts — "session fell out of cache, resume from summary?",
   *  trust re-prompts. Asked while the handle is still STARTING, which is why
   *  the lifecycle phase cannot gate interactions. */
  | 'recovery'

/**
 * PROVENANCE ⇒ CONFIDENCE. This field is what makes fidelity visible instead of
 * assumed, and it carries a hard consumer obligation: consumers of
 * `screen-classifier` interactions must treat asked→answered as AT-LEAST-ONCE,
 * never exactly-once. A re-rendered menu can mint a duplicate ask, and a
 * keystroke answer cannot prove it acted on the exact menu it classified.
 */
export type InteractionSource = 'protocol' | 'sdk-callback' | 'hook' | 'screen-classifier'

/** Whether answering is structured (a protocol reply) or emulated (menu
 *  keystrokes). The second cannot prove what it acted on — see
 *  {@link InteractionSource}. */
export type InteractionAnswerability = 'structured' | 'keystroke-emulated'

/**
 * THE PER-KIND ASK AND ANSWER VOCABULARY — W1 left this opaque and named W2 as
 * its owner; POD-2020 typed it.
 *
 * The schemas are `@podium/protocol`'s (`messages/runtime.ts`), for this
 * package's standing directional reason, and the types below are re-exported
 * from there rather than restated: this is the one region of the contract where
 * inferring FROM zod is right, because none of these payloads reference
 * `Declared<T>` or anything else defined above protocol, and a hand-written
 * mirror would be a second source of truth for a vocabulary five drivers have to
 * agree on. `./schemas.ts` still asserts the composed `PendingInteraction`
 * exact, so the drift guard is unchanged.
 */
export type {
  ElicitationAnswer,
  ElicitationAsk,
  InteractionAnswer,
  InteractionAskSpec,
  LoginAnswer,
  LoginAsk,
  PendingInteraction,
  PermissionAnswer,
  PermissionAsk,
  PlanApprovalAnswer,
  PlanApprovalAsk,
  QuestionAnswer,
  QuestionAsk,
  QuestionOption,
  QuestionPrompt,
  QuestionSelection,
  RecoveryAnswer,
  RecoveryAsk,
  RecoveryChoice,
} from '@podium/protocol'

/** Answering is idempotent; a second answer returns a typed error rather than
 *  double-acting. */
export type InteractionAnswerOutcome =
  | { ok: true }
  | { ok: false; reason: 'already-answered' | 'expired' | 'unknown-interaction' }

export interface InteractionAsked {
  ev: 'asked'
  interaction: PendingInteraction
}
export interface InteractionAnswered {
  ev: 'answered'
  id: string
  /** Who resolved it: a policy, the superagent, or a human on some surface. */
  answeredBy: 'policy' | 'superagent' | 'human'
  at: string
}
export interface InteractionExpired {
  ev: 'expired'
  id: string
  at: string
}
