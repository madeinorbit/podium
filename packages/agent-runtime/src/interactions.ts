// Part of the Agent Runtime contract (POD-1761 W1). See ./index.ts for the
// surface's five governing rules and the core-vs-extended tier boundary.

import type { SessionId } from '@podium/model'

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
 * The per-kind ask payload — tool and input for `permission`, options for
 * `question`, the plan text for `plan-approval`, the url for `login`.
 *
 * TYPED IN W2, NOT HERE. The spec names the per-kind payload and answer schemas
 * as a phase-1 deliverable and says in as many words that they are "the hard
 * part of this aggregate", specified in phase 1 rather than in the architecture
 * doc: W2 normalizes Codex approval requests, opencode's once/always/reject, the
 * SDK's `canUseTool`/AskUserQuestion and classified terminal menus into one
 * vocabulary and replaces this alias with a discriminated union keyed on `kind`.
 *
 * Deliberately OPAQUE rather than absent: the interaction's own shape (id, kind,
 * source, answerability, lifecycle) is stable and testable now, and pinning a
 * payload union here would fix the vocabulary before the normalization work that
 * decides it. It is a JSON OBJECT rather than `unknown` because every payload
 * the spec names is one, and because `unknown` on the wire makes the key
 * optional — which would say a payload-less ask is legal when none is.
 */
export type InteractionPayload = Readonly<Record<string, unknown>>

export interface PendingInteraction {
  id: string
  sessionId: SessionId
  kind: InteractionKind
  payload: InteractionPayload
  askedAt: string
  source: InteractionSource
  answerable: InteractionAnswerability
  /** Set once a policy has ruled. `escalated` means it is waiting on a human. */
  policyVerdict?: 'auto-allowed' | 'auto-denied' | 'escalated'
  /** ESCALATION DEADLINE, NOT AUTO-DENY. The spec is explicit: passing this
   *  raises the ask's visibility; it never answers it. */
  expiresAt?: string
}

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
