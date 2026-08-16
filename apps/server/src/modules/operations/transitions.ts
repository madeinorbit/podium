import type { Operation, OperationStep } from '@podium/protocol'
import type { StepDeadlines, StepProgressPatch } from './kinds'
import type { PersistedOperation } from './store'

/**
 * HOW AN OPERATION CHANGES, as arithmetic (POD-2097).
 *
 * Everything here is a pure function of an operation, a patch and a timestamp.
 * The engine next door decides WHEN a transition happens — a runner returned,
 * a report arrived, a timer fired — and this file says WHAT the resulting
 * object is. The split is not for line count: these are the rules a reviewer
 * has to check against §3.1 and §3.3 of the spec, and they are much easier to
 * check when nothing around them touches a database, a clock or a timer.
 *
 * Nothing here reads the current time. `at` is always passed in, so the same
 * inputs always produce the same object — which is what lets the engine's
 * fake-clock tests assert on exact timestamps.
 */

export function isStepFinished(state: OperationStep['state']): boolean {
  return state === 'done' || state === 'skipped' || state === 'failed'
}

/** The step the engine is currently watching: at most one, by construction. */
export function inFlightStep(operation: Operation): OperationStep | undefined {
  return (operation.steps ?? []).find((s) => s.state === 'running' || s.state === 'stalled')
}

/** The first step still to be done — the plan's cursor. */
export function nextStep(operation: Operation): OperationStep | undefined {
  return (operation.steps ?? []).find((s) => !isStepFinished(s.state))
}

/**
 * Fold a patch into one step and hand back the whole operation.
 *
 * UNKNOWN FIELDS RIDE THROUGH UNTOUCHED, on the step and on the operation
 * alike. The store writes the object back whole, so a field dropped here is
 * dropped for good — and the fields most likely to be unknown are exactly the
 * ones a NEWER server wrote before this one adopted its operation.
 *
 * A VALUE THE PATCH NAMES IS REPLACED, NOT MERGED, and that is deliberate:
 * `progress` and `places` are a report of how things stand NOW, so merging
 * would carry a field from an older report forward and present it as current —
 * a stale `bytesPerSecond` sitting under a live percentage is worse than no
 * field at all, on a contract whose whole subject is liveness. What the frozen
 * law requires is that a value NOBODY named survives, and it does: the spreads
 * below are conditional on the patch carrying the key, and no patch the engine
 * builds for itself carries either of these.
 *
 * `lastProgressAt` is stamped on every patch: the heartbeat is the point (P4).
 * `extra` is how a caller adds bookkeeping the patch has no vocabulary for —
 * an attempt count, a stall count, or a deliberate refusal to refresh the
 * heartbeat when the "progress" is only that we noticed a stall.
 */
export function applyStepPatch(
  operation: Operation,
  stepId: string,
  patch: StepProgressPatch,
  at: number,
  extra: (step: OperationStep) => OperationStep = (s) => s,
): Operation {
  const steps = (operation.steps ?? []).map((step) => {
    if (step.id !== stepId) return step
    const merged: OperationStep = extra({
      ...step,
      ...(patch.state ? { state: patch.state } : {}),
      ...(patch.progress ? { progress: patch.progress } : {}),
      ...(patch.places ? { places: patch.places } : {}),
      ...(patch.detail !== undefined ? { detail: patch.detail } : {}),
      ...(patch.error !== undefined ? { error: patch.error } : {}),
      lastProgressAt: at,
    })
    if (isStepFinished(merged.state)) merged.finishedAt = at
    return merged
  })
  return { ...operation, steps }
}

/**
 * Put back the three facts the store requires, inventing none of them. An
 * operation that has been through the store already carries them; one a kind
 * rebuilt during `reconcile` may not, and its group must not be guessed from
 * anything but the definition that owns the kind.
 */
export function withPersistenceFacts(
  operation: Operation,
  fallbackGroup: string | undefined,
  at: number,
): PersistedOperation {
  return {
    ...operation,
    exclusionGroup: operation.exclusionGroup ?? fallbackGroup ?? operation.kind,
    createdAt: operation.createdAt ?? at,
    updatedAt: at,
  }
}

/**
 * When this step next owes an answer, or `undefined` if its kind set it no
 * budget. Silence is measured from the last accepted progress; the total from
 * when the step began. The earlier of the two is what a timer is armed for.
 */
export function deadlineDue(
  step: OperationStep,
  budget: StepDeadlines | undefined,
  now: number,
): number | undefined {
  if (!budget) return undefined
  const dues: number[] = []
  if (budget.silenceMs !== undefined) {
    dues.push((step.lastProgressAt ?? step.startedAt ?? now) + budget.silenceMs)
  }
  if (budget.totalMs !== undefined) dues.push((step.startedAt ?? now) + budget.totalMs)
  return dues.length > 0 ? Math.min(...dues) : undefined
}

export interface DeadlineBreach {
  /**
   * `silence` earns one retry — the usual cause is a lost message and
   * `ensure()` is idempotent by contract. `total` earns none: a step that has
   * used its whole allowance will not be rescued by starting it again.
   */
  kind: 'none' | 'silence' | 'total'
  /** Milliseconds since the last accepted progress. */
  silentMs: number
  /** Milliseconds since the step began. */
  elapsedMs: number
}

export function deadlineBreach(
  step: OperationStep,
  budget: StepDeadlines | undefined,
  now: number,
): DeadlineBreach {
  const silentMs = now - (step.lastProgressAt ?? step.startedAt ?? now)
  const elapsedMs = now - (step.startedAt ?? now)
  if (!budget) return { kind: 'none', silentMs, elapsedMs }
  // Total is checked first: when both are over, the one with no retry wins.
  if (budget.totalMs !== undefined && elapsedMs >= budget.totalMs) {
    return { kind: 'total', silentMs, elapsedMs }
  }
  if (budget.silenceMs !== undefined && silentMs >= budget.silenceMs) {
    return { kind: 'silence', silentMs, elapsedMs }
  }
  return { kind: 'none', silentMs, elapsedMs }
}
