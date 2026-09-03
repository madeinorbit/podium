/**
 * The post-commit mechanisms, reachable from a span body while the store is
 * still SYNCHRONOUS [POD-3260, spec §3.3, spec §6 rule 17].
 *
 * WHY THIS EXISTS AT ALL. B0.5 has to move every non-database call out of every
 * transaction body and into one of the three mechanisms, and it has to do it
 * NOW, before the flip, while every one of those moves is reversible and
 * observable in a synchronous world. But `postCommit()` needs an executor
 * transaction scope, and today's spans are `SessionStore.transact` ->
 * `transaction(db, fn)`: no scope, no registry, nothing to register against.
 * This module is the seam that gives a synchronous span the scope, so the call
 * sites can be written ONCE, in their final form, against the real API.
 *
 * WHAT IT IS NOT. It is not a second implementation of the post-commit
 * contract: registration goes through the executor's own `PostCommitRegistry`
 * and `postCommit()`, and the failures are the executor's own error classes.
 * The only thing this module owns is the DRAIN, which has to be synchronous
 * because `SessionStore.transact` returns `T` and not `Promise<T>`. Defer a
 * durable follow-up into a microtask here and `LockService.steal` would return
 * before the mail it just promised exists — a behaviour change, in the phase
 * whose whole purpose is to make no behaviour changes.
 *
 * SO A STEP MAY NOT BE ASYNCHRONOUS, and a step that returns a thenable is
 * REFUSED rather than dropped, for the same reason `transaction(db, fn)`
 * refuses an async body. The one exception is an external effect (mechanism 3),
 * which nobody waits for by contract: its promise is allowed and its rejection
 * is routed to the effect sink instead of escaping.
 *
 * THIS MODULE IS AN INSTRUMENT. It is deleted at the flip, when the executor's
 * own `PostCommitRunner` takes the drain over and the call sites do not change
 * — that is the point of writing them against `postCommit()` today. Its
 * deletion is filed as POD-3327.
 */

import { createLogger } from '@podium/logger'
import {
  assertAddressable,
  closeFrame,
  createFrame,
  currentScope,
  runInScope,
  type TransactionFrame,
} from './context'
import { PostCommitError, StoreUnhealthyError } from './errors'
import { PostCommitRegistry, type PostCommitStep } from './post-commit'
import type { Lease } from './scheduler'

const log = createLogger('server:store')

/**
 * The lease a synchronous frame carries.
 *
 * A frame needs one, and there is honestly none here: the synchronous store
 * owns its connection outright and this frame routes no statement through the
 * executor. Every member therefore THROWS rather than returning a plausible
 * value — if the flip ever reaches this object it is because something started
 * routing through a frame that has no connection to route to, and a loud
 * refusal is the only useful answer.
 */
const SYNCHRONOUS_LEASE: Lease = {
  id: 0,
  lane: 'write',
  get session(): never {
    throw new Error(
      'the synchronous span bridge holds no driver session: the synchronous store owns its ' +
        'own connection and this frame routes no statements (POD-3260).',
    )
  },
  begin: () => {
    throw new Error('the synchronous span bridge does not open transactions (POD-3260).')
  },
  atomicWrite: () => {
    throw new Error('the synchronous span bridge does not run atomic writes (POD-3260).')
  },
  heldMs: () => 0,
}

/** Where a mechanism's failure is reported. Replaceable for tests. */
export interface SpanEffectSinks {
  /** Mechanism 1 failed: the projection and the database have diverged. */
  markUnhealthy: (error: unknown, label: string) => void
  /** Mechanism 3 failed: reported, never rethrown. */
  effectSink: (error: unknown, label: string) => void
  /** A sink itself threw. See {@link PostCommitRunnerOptions.onReportFailure}. */
  onReportFailure: (error: unknown, label: string) => void
}

const DEFAULT_SINKS: SpanEffectSinks = {
  markUnhealthy: (error, label) =>
    log.error('a commit application failed; the in-memory projection is behind the database', {
      err: error,
      label,
    }),
  effectSink: (error, label) => log.warn('a post-commit effect failed', { err: error, label }),
  onReportFailure: () => {
    /* the report sink threw; there is nowhere further to send it */
  },
}

let sinks: SpanEffectSinks = DEFAULT_SINKS

/**
 * Install the failure sinks. A PROBE SEAM: production runs on the defaults
 * above, and a test installs its own to assert that an isolated failure was
 * reported rather than swallowed. Returns the previous sinks so a test can put
 * them back.
 */
export function setSpanEffectSinks(next: Partial<SpanEffectSinks>): SpanEffectSinks {
  const previous = sinks
  sinks = { ...sinks, ...next }
  return previous
}

/** Put the sinks back to what {@link setSpanEffectSinks} returned. */
export function restoreSpanEffectSinks(previous: SpanEffectSinks): void {
  sinks = previous
}

/**
 * The drain in progress on this call stack, if any.
 *
 * A follow-up that commits re-entrantly must NOT recurse: its registry queues
 * behind the current batch so batch N reaches every step before N+1 begins.
 * That is the same rule, and the same reason, as `PostCommitRunner.drain`'s
 * queue — a plain recursive call delivers N+1 in the middle of N and hands
 * delta clients a permanent gap.
 *
 * Module-level rather than ambient, because a synchronous drain cannot be
 * interleaved with another one: there is no await between the two lines that
 * set and clear it.
 */
let activeDrain: SynchronousDrain | undefined

class SynchronousDrain {
  private readonly queue: PostCommitRegistry[] = []

  push(registry: PostCommitRegistry): void {
    if (!registry.empty) this.queue.push(registry)
  }

  run(): void {
    let failure: unknown
    while (this.queue.length > 0) {
      const batch = this.queue.shift() as PostCommitRegistry
      for (const entry of batch.commitApplications) {
        try {
          runStep(entry.step, entry.label, 'commit application')
        } catch (error) {
          report(sinks.markUnhealthy, error, entry.label)
          // Not skippable and not recoverable: stop rather than fold further
          // batches into a projection already known to be wrong.
          throw new StoreUnhealthyError(
            `commit application "${entry.label}" failed; the store is unhealthy and needs a ` +
              'reseed or a restart. The transaction itself committed.',
            error,
            // The COMMIT already happened. This is not a rollback, and a caller
            // that retried it would duplicate a durable write.
            { committed: true },
          )
        }
      }
      for (const entry of batch.followUps) {
        try {
          runStep(entry.step, entry.label, 'durable follow-up')
        } catch (error) {
          // Keep draining: the remaining batches must still reach their
          // subscribers in order. The first failure is what the caller sees.
          failure ??= new PostCommitError(
            'follow-up',
            `durable follow-up "${entry.label}" failed after the transaction committed`,
            error,
          )
        }
      }
      for (const entry of batch.effects) dispatch(entry.step, entry.label)
    }
    if (failure) throw failure
  }
}

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
 * An external effect: isolated, reported, never waited for.
 *
 * An asynchronous one IS allowed here and nowhere else, because the contract
 * for mechanism 3 already says the outer promise does not wait for it. What it
 * may not do is reject into nothing, so the rejection is routed to the sink.
 */
function dispatch(step: PostCommitStep, label: string): void {
  let result: void | Promise<void>
  try {
    result = step()
  } catch (error) {
    report(sinks.effectSink, error, label)
    return
  }
  if (!isThenable(result)) return
  void result.then(undefined, (error: unknown) => {
    report(sinks.effectSink, error, label)
  })
}

/** Call a report sink without letting it become the failure it was reporting. */
function report(
  sink: (error: unknown, label: string) => void,
  error: unknown,
  label: string,
): void {
  try {
    sink(error, label)
  } catch (sinkError) {
    try {
      sinks.onReportFailure(sinkError, label)
    } catch {
      /* the last-resort sink threw; there is nowhere further to report it */
    }
  }
}

/**
 * Open a transaction scope around a SYNCHRONOUS span, and drain its registered
 * post-commit work once the outermost span has committed.
 *
 * `SessionStore.transact` wraps its `transaction(this.db, fn)` in this, so
 * every span body in the server can call `postCommit()`. A nested call is a
 * SAVEPOINT: it gets its own registry, which merges into the parent on success
 * and is discarded on a throw, because a savepoint release is not a commit —
 * the work belongs to whoever actually commits.
 */
export function runSynchronousSpan<T>(body: () => T): T {
  const scope = currentScope()
  const parent = scope.kind === 'transaction' ? scope.frame : undefined
  if (parent) assertAddressable(parent)
  const registry = new PostCommitRegistry()
  const frame = createFrame({
    lane: 'write',
    lease: SYNCHRONOUS_LEASE,
    parent,
    postCommit: registry,
  })
  if (parent) parent.child = frame
  let result: T
  try {
    result = runInScope({ kind: 'transaction', frame }, body)
  } catch (error) {
    registry.discard()
    closeFrame(frame)
    throw error
  }
  closeFrame(frame)
  if (parent) {
    // A savepoint released, not a commit: hand the work up.
    registry.mergeInto(parent.postCommit)
    return result
  }
  drain(registry)
  return result
}

/**
 * Drain one committed registry.
 *
 * When a drain is already running — the caller is a follow-up committing
 * re-entrantly — the registry is QUEUED behind the current batch and this
 * returns at once. The outer drain runs it, and because the drain is
 * synchronous the outer `transact` call still returns only after it has.
 */
function drain(registry: PostCommitRegistry): void {
  if (activeDrain) {
    activeDrain.push(registry)
    return
  }
  if (registry.empty) return
  const running = new SynchronousDrain()
  running.push(registry)
  activeDrain = running
  try {
    running.run()
  } finally {
    activeDrain = undefined
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
export function applyAfterCommit(step: PostCommitStep, label: string): void {
  const scope = currentScope()
  if (!spanOpen() || scope.kind !== 'transaction') {
    throw new Error(
      `commit application "${label}" was registered with no open transaction scope: there is ` +
        'nothing for it to follow (POD-3328).',
    )
  }
  scope.frame.postCommit.applyCommit(step, label)
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
