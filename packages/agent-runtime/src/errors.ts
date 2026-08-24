// Part of the Agent Runtime contract (POD-1761 W1). See ./index.ts for the
// surface's five governing rules and the core-vs-extended tier boundary.

import type { InputOrigin, Refusal, RefusalReason } from './turns.js'

// ---------------------------------------------------------------------------
// Failure semantics (spec §3)
// ---------------------------------------------------------------------------

/**
 * Errors are not a primitive — they are a normalized vocabulary threading
 * through the three channels the surface already has: a {@link Refusal}
 * (synchronous), a {@link TurnFailed} (in the causal stream), or a
 * {@link ProcessEvent}.
 *
 * TRANSPORT FAILURES ARE DELIBERATELY OUTSIDE SESSION SEMANTICS. A machine being
 * unreachable or a driver crashing is not a session failure: the session may be
 * alive and adoptable even while the path to it is down. Conflating the two is
 * how ghost sessions happen, so there is no arm for it here.
 */
export type TurnFailureReason =
  | 'rate-limit'
  | 'auth-expired'
  | 'context-overflow'
  | 'provider-error'
  | 'timeout'
  | 'interrupted'

/**
 * ONE ROUTING RULE KEEPS SESSIONS UNSTUCK: every failure is classified, and
 * `needs-human` failures MATERIALIZE AS PendingInteractions — auth-expired
 * becomes a `login` interaction, context-overflow becomes a `recovery` one.
 * That is the mechanism by which a blocked session is always an enumerable one.
 */
export type FailureDisposition = 'retryable' | 'needs-human' | 'fatal'

export interface TurnFailed {
  ev: 'failed'
  turnEpoch: number
  reason: TurnFailureReason
  disposition: FailureDisposition
  /** Harness-specific detail preserved verbatim for diagnostics, generalizing
   *  today's superagent harness-error mapping to every consumer. */
  detail?: string
}

export interface TurnStarted {
  ev: 'started'
  turnEpoch: number
  origin: InputOrigin
}

export interface TurnCompleted {
  ev: 'completed'
  turnEpoch: number
  verdict: 'done' | 'question' | 'approval' | 'open_todos' | 'interrupted'
}

export type TurnEvent = TurnStarted | TurnCompleted | TurnFailed

/** Process failure is its own channel: a session's process tree dying is not a
 *  turn outcome. `adopted` is here rather than in lifecycle because a consumer
 *  watching the stream needs to know the binding changed under it. */
export type ProcessEvent =
  | { ev: 'exited'; code: number | null; signal: string | null; classification: ExitClassification }
  | { ev: 'oomKilled'; scopeUnit?: string }
  | { ev: 'adopted'; bindingVersion: number }

export type ExitClassification = 'clean' | 'crashed' | 'killed' | 'oom'

// ---------------------------------------------------------------------------
// The refusal channel for verbs that have no room for one in their return type
// ---------------------------------------------------------------------------

/**
 * A TYPED REFUSAL FROM A VERB THAT CANNOT RETURN ONE (POD-2703, review 1).
 *
 * ---------------------------------------------------------------------------
 * WHY A CLASS AND NOT JUST A THROW
 * ---------------------------------------------------------------------------
 *
 * Rule 3 is "every write returns a receipt or a TYPED refusal", and most of the
 * surface honours it in its return type: `send` resolves a {@link Refusal},
 * `hibernate` resolves `Refusal | {ok:true}`. Two CORE verbs cannot.
 * `resume()` resolves an `AgentSessionHandle` and `export()` a
 * {@link SessionArchive}; neither has an arm for "this harness does not do
 * that", so the only honest answer is to reject.
 *
 * That left refuse-not-degrade enforced as ANY thrown exception. A driver whose
 * `export()` refused correctly and one whose `export()` dereferenced undefined
 * were INDISTINGUISHABLE to a caller and to the conformance corpus — both
 * "threw". A caller cannot branch on that, which is the whole point of a typed
 * refusal: the archive scheduler that must skip a harness with no archive reads
 * the same `unsupported` a `send` caller reads, instead of matching on a message
 * string or treating every failure as permanent.
 *
 * ---------------------------------------------------------------------------
 * IDENTIFIED STRUCTURALLY, NOT BY `instanceof`
 * ---------------------------------------------------------------------------
 *
 * This package is resolved as SOURCE by its own tests and as `dist` by some
 * consumers, so two copies of this class can coexist in one process and
 * `instanceof` silently answers `false` across them — the failure mode would be
 * a caller quietly reclassifying a real refusal as an unknown crash. So
 * {@link isDriverRefusal} checks the SHAPE: the marker and a `reason` the wire
 * schema accepts. That is also the mechanism a remote caller sees, because the
 * refusal crosses the daemon WS as data rather than as a class.
 */
export class DriverRefusalError extends Error {
  /** The structural marker {@link isDriverRefusal} reads. Not a nominal type:
   *  see the class header for why `instanceof` is not load-bearing here. */
  readonly isDriverRefusal = true as const
  readonly refusal: Refusal

  constructor(refusal: Refusal, context?: string) {
    super(
      context
        ? `${context}: refused (${refusal.reason})${refusal.detail ? ` — ${refusal.detail}` : ''}`
        : `refused (${refusal.reason})${refusal.detail ? ` — ${refusal.detail}` : ''}`,
    )
    this.name = 'DriverRefusalError'
    this.refusal = refusal
  }
}

/** Every {@link RefusalReason}, as DATA. The union is a type and a caller
 *  checking a value at runtime needs the members; `schemas.ts` pins this against
 *  the wire enum in both directions, so the two cannot drift. */
export const REFUSAL_REASONS = [
  'needs_user',
  'lease_held',
  'unsupported',
  'no_resume_ref',
  'session_ended',
  'not_running',
  'staging_failed',
  'busy',
] as const satisfies readonly RefusalReason[]

/**
 * Is this thrown value a driver REFUSING, as opposed to a driver BREAKING?
 *
 * The distinction is the caller's whole decision: a refusal is expected and
 * branchable, an error is not. Structural for the reason in the class header.
 */
export function isDriverRefusal(error: unknown): error is DriverRefusalError {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { isDriverRefusal?: unknown; refusal?: { reason?: unknown } }
  if (candidate.isDriverRefusal !== true) return false
  const reason = candidate.refusal?.reason
  return (REFUSAL_REASONS as readonly string[]).includes(reason as string)
}
