/**
 * The executor's refusals, one class per rule so a test can pin the rule rather
 * than a message [POD-3248].
 *
 * Every one of these is a REFUSAL, not a failure: the scheduler would rather
 * reject a call than let it run in a scope whose guarantees it no longer has.
 * That is the whole point of the token — see `scheduler.ts`.
 */

/** Base class so a caller can catch "the executor refused" without listing the set. */
export class StoreExecutorError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/**
 * An operation addressed a transaction scope that is no longer open.
 *
 * The common cause is a promise the body never awaited: it resolves after the
 * body returned, the token is already invalid, and the statement would otherwise
 * run in autocommit — the "nothing runs after its commit" rule.
 */
export class StaleTransactionError extends StoreExecutorError {}

/**
 * Two nested scopes were opened on one transaction at the same time.
 *
 * Savepoints are a stack, not a tree: two branches interleaving their statements
 * inside one `BEGIN` would release each other's savepoints. Sequential nesting is
 * the supported form; `Promise.all` of two `transact` calls is not.
 */
export class ParallelNestedTransactionError extends StoreExecutorError {}

/** `exclusive` was requested from inside a lease it would have to wait for. */
export class ExclusiveInsideLeaseError extends StoreExecutorError {}

/** A write was requested inside a read lease, which has no write to commit. */
export class WriteInsideReadLeaseError extends StoreExecutorError {}

/** Work was submitted after the scheduler stopped accepting it. */
export class SchedulerClosedError extends StoreExecutorError {}

/**
 * A post-commit step failed. The transaction IS committed; `committed` says so,
 * because a caller must never read this as "the write was rolled back"
 * (spec §3.3).
 */
export class PostCommitError extends StoreExecutorError {
  readonly committed = true
  constructor(
    readonly mechanism: 'commit-application' | 'follow-up',
    message: string,
    override readonly cause: unknown,
  ) {
    super(message)
  }
}

/**
 * An invariant in the internal commit application failed, so the in-memory
 * projection no longer matches the database. Today's contract is a reseed or a
 * restart; the store refuses further work until then.
 */
export class StoreUnhealthyError extends StoreExecutorError {
  /**
   * True when the failure happened AFTER the commit — the mechanism-1 case. The
   * write is durable and the caller must never read the rejection as a
   * rollback, which is the same guarantee {@link PostCommitError} carries
   * (spec §3.3, rule 7). False when the store was already unhealthy and refused
   * the work before it ran: nothing was written, so nothing committed.
   */
  readonly committed: boolean
  constructor(
    message: string,
    override readonly cause: unknown,
    options: { readonly committed?: boolean } = {},
  ) {
    super(message)
    this.committed = options.committed ?? false
  }
}

/** No transaction scope is open, so there is nothing for post-commit work to follow. */
export class NoPostCommitScopeError extends StoreExecutorError {}
