/**
 * Compatibility call-site helpers over the executor transaction context.
 * The executor owns transaction scopes and post-commit draining.
 */

import { assertAddressable, currentScope, type TransactionFrame } from './context'
import { PostCommitError } from './errors'
import type { CommitRegistration, PostCommitStep } from './post-commit'

/**
 * Run a step and refuse an asynchronous one.
 *
 * The refusal is the same rule `transaction(db, fn)` applies to a body: with a
 * synchronous drain there is nobody to await the promise, so a step that
 * returned one would have its work happen at an unspecified later time while
 * the caller was told it was done.
 */
function runStep(step: PostCommitStep, label: string, mechanism: string): void {
  const result = step()
  if (isThenable(result)) {
    throw new TypeError(
      `the ${mechanism} "${label}" returned a thenable. The store is still synchronous, so the ` +
        'drain cannot await it and the caller would be told the work was done before it ran. ' +
        'Make the step synchronous, or classify it as an external effect, which nobody waits ' +
        'for (POD-3260, spec §3.3).',
    )
  }
}

/**
 * Register an external effect (mechanism 3) that must not run inside an open
 * span, from code that is reached BOTH inside a span and outside one.
 *
 * The choke points this issue moves — the event log's feed announcement, the
 * mail nudge — are called from a span body on one path and from a plain handler
 * on another, and the honest answer differs: inside a span the effect waits for
 * the commit, outside one there is nothing to wait for and deferring it would
 * change when the caller's own next line observes it. So with no span open the
 * step RUNS NOW.
 *
 * AND IT RUNS UNGUARDED, which is the asymmetry worth stating rather than
 * hiding. Mechanism 3 isolates an effect because the transaction has already
 * committed and a socket failure must not be reported as a rollback. Outside a
 * transaction there is no commit to protect, and catching there would be a
 * behaviour change at every one of these sites — the event log's listener call
 * is deliberately unguarded today, precisely so a wiring fault surfaces instead
 * of leaving a pane that silently never updates.
 *
 * A read scope is treated as "no span": it commits nothing, so there is nothing
 * for the effect to follow, which is the same argument `postCommit()` makes
 * when it refuses one.
 */
export function afterCommit(step: PostCommitStep, label: string): void {
  const scope = currentScope()
  if (scope.kind !== 'transaction' || scope.frame.lane === 'read' || !addressable(scope.frame)) {
    void step()
    return
  }
  scope.frame.postCommit.effect(step, label)
}

/**
 * Register a DURABLE FOLLOW-UP (mechanism 2) from a tail that may already be
 * outside the commit it follows.
 *
 * Like {@link afterCommit}, a caller inside an enclosing span registers on that
 * span so a rollback discards the work and a commit drains it afterwards. When
 * no span is open, the caller is already on the far side of its commit, so the
 * step runs now. Unlike an external effect, its failure remains visible and is
 * wrapped with the committed guarantee: retrying the original write would be
 * wrong even though its follow-up failed.
 */
export function followUpAfterCommit(step: PostCommitStep, label: string): void {
  const scope = currentScope()
  if (scope.kind === 'transaction' && scope.frame.lane !== 'read' && addressable(scope.frame)) {
    scope.frame.postCommit.followUp(step, label)
    return
  }
  try {
    runStep(step, label, 'durable follow-up')
  } catch (error) {
    throw new PostCommitError(
      'follow-up',
      `durable follow-up "${label}" failed after the transaction committed`,
      error,
    )
  }
}

/**
 * Is a unit of work open whose COMMIT a fold must wait for [POD-3328]?
 *
 * The same predicate {@link afterCommit} applies, named so a caller can ask
 * BEFORE it stages anything. A read scope answers false for the reason
 * `postCommit()` refuses one: a read commits nothing, so there is nothing to
 * wait for.
 */
export function spanOpen(): boolean {
  const scope = currentScope()
  return scope.kind === 'transaction' && scope.frame.lane !== 'read' && addressable(scope.frame)
}

/**
 * Register a COMMIT APPLICATION (mechanism 1) — the baseline fold and the
 * mandatory cache invalidations — to run after the outermost commit.
 *
 * Unlike {@link afterCommit} this refuses when there is no span, rather than
 * running the step now. A commit application is an invariant of a commit that
 * happened; a caller with no span open has no commit to hang one off, and
 * {@link spanOpen} is how it finds that out before it stages the work.
 */
export function applyAfterCommit(step: PostCommitStep, label: string): CommitRegistration {
  const scope = currentScope()
  if (!spanOpen() || scope.kind !== 'transaction') {
    throw new Error(
      `commit application "${label}" was registered with no open transaction scope: there is ` +
        'nothing for it to follow (POD-3328).',
    )
  }
  // The handle is what lets a staged value see a MIDDLE span's rollback while
  // the outer span carries on: `spanOpen()` still answers true there, and only
  // this registration knows its own registry was discarded [POD-3364].
  return scope.frame.postCommit.applyCommit(step, label)
}

/** `assertAddressable` as a predicate: is this frame still the one to register on? */
function addressable(frame: TransactionFrame): boolean {
  try {
    assertAddressable(frame)
    return true
  } catch {
    return false
  }
}

function isThenable(value: unknown): value is Promise<void> {
  return (
    value != null &&
    typeof value === 'object' &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}
