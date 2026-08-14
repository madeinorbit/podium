// Part of the Agent Runtime contract (POD-1761 W1). See ./index.ts for the
// surface's five governing rules and the core-vs-extended tier boundary.

import type { InputOrigin } from './turns.js'

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
