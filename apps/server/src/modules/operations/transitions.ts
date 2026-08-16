import type { Operation, OperationStep, StepPlace } from '@podium/protocol'
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
 * WHEN THIS STEP WAS LAST HEARD FROM, per place where it has any (POD-2167).
 *
 * A step's own `lastProgressAt` is stamped by ANY accepted report, and for a
 * step acting on many places at once that is the wrong quantity entirely: three
 * machines updating together means the healthy two keep re-arming the budget
 * while the third is dead, so silence cannot begin until the whole wave has
 * finished — which is exactly when nobody needs a timeout any more.
 *
 * So a step with places is as silent as its QUIETEST place. Which places count
 * is not a question this file can answer, and deliberately does not ask: the
 * kind states it by stamping the ones the step is waiting on and leaving the
 * rest bare (see `StepPlace.lastProgressAt`). No places carrying a stamp means
 * no per-place claim was made, and the step's own clock stands — which is both
 * the honest reading and what every kind written before this did.
 */
function silentSince(step: OperationStep): number | undefined {
  let oldest: number | undefined
  for (const place of step.places ?? []) {
    const at = place.lastProgressAt
    if (typeof at !== 'number') continue
    if (oldest === undefined || at < oldest) oldest = at
  }
  return oldest ?? step.lastProgressAt
}

/**
 * Restart the clock on every place the step is waiting on, at `at`.
 *
 * The engine's own act of (re-)attempting a step is progress for everything
 * that step is waiting on — the same reason `applyStepPatch` stamps the step.
 * Without this a retry inherits the silence that caused it and is failed before
 * it can run, and an operation adopted after a restart is judged on how long the
 * DEAD process was quiet for.
 *
 * A place with no stamp stays bare: presence is the kind's claim to make, and
 * this must never invent one for a place whose turn has not come.
 */
export function restartPlaceClocks(
  places: readonly StepPlace[] | undefined,
  at: number,
): StepPlace[] | undefined {
  if (!places) return undefined
  return places.map((place) =>
    typeof place.lastProgressAt === 'number' ? { ...place, lastProgressAt: at } : place,
  )
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
    dues.push((silentSince(step) ?? step.startedAt ?? now) + budget.silenceMs)
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
  /**
   * The places whose own clocks have run out — WHO the silence is about
   * (POD-2167). Empty when the step made no per-place claim, and empty on a
   * `total` breach, which is about the step rather than about anyone in it.
   *
   * This is what lets a kind turn a generic `stalled` into "vmi3407763 stopped
   * responding", which is the whole reason §7 gave an error `places` at all.
   */
  places: string[]
}

export function deadlineBreach(
  step: OperationStep,
  budget: StepDeadlines | undefined,
  now: number,
): DeadlineBreach {
  const silentMs = now - (silentSince(step) ?? step.startedAt ?? now)
  const elapsedMs = now - (step.startedAt ?? now)
  if (!budget) return { kind: 'none', silentMs, elapsedMs, places: [] }
  // Total is checked first: when both are over, the one with no retry wins.
  if (budget.totalMs !== undefined && elapsedMs >= budget.totalMs) {
    return { kind: 'total', silentMs, elapsedMs, places: [] }
  }
  if (budget.silenceMs !== undefined && silentMs >= budget.silenceMs) {
    const overdue = budget.silenceMs
    return {
      kind: 'silence',
      silentMs,
      elapsedMs,
      places: (step.places ?? [])
        .filter(
          (place) =>
            typeof place.lastProgressAt === 'number' && now - place.lastProgressAt >= overdue,
        )
        .map((place) => place.id),
    }
  }
  return { kind: 'none', silentMs, elapsedMs, places: [] }
}
