/**
 * The executor's refusals, one class per rule so a test can pin the rule rather
 * than a message [POD-3248].
 *
 * Every one of these is a REFUSAL, not a failure: the scheduler would rather
 * reject a call than let it run in a scope whose guarantees it no longer has.
 * That is the whole point of the token — see `scheduler.ts`.
 */

/**
 * WHERE THE SCOPES A REFUSAL NAMES WERE OPENED [POD-3805].
 *
 * A refusal's message names transaction ids — `transaction 4 has an open nested
 * scope (5)` — and an id is not a code site. POD-3802 spent a day on exactly that
 * gap, so every refusal that has a frame in hand carries the stack captured where
 * that frame's `transact`/`read` call was made.
 *
 * Diagnostics only: nothing branches on these, and a refusal that has no frame to
 * name simply has neither.
 */
export interface RefusalOrigin {
  /** The scope the refused operation addressed. */
  readonly openedAt?: string
  /**
   * The nested scope that blocks it, when the refusal names one. This is the
   * field that names the DEFECT: in POD-3802 the refused statement belonged to
   * the lock span, and the bug was the unawaited `sendMail` whose transaction
   * joined it as a savepoint.
   */
  readonly nestedOpenedAt?: string
}

/** Base class so a caller can catch "the executor refused" without listing the set. */
export class StoreExecutorError extends Error {
  /**
   * See {@link RefusalOrigin.openedAt}.
   *
   * `declare`, so the field is not DEFINED when there is no origin to put in it.
   * A plain optional field compiles to `openedAt = undefined` under ES2022 class
   * semantics, which every serializer then shows: vitest prints
   * `Serialized Error: { openedAt: undefined }` on an unhandled refusal, and the
   * diagnostic becomes noise on the errors it has nothing to say about.
   */
  declare readonly openedAt?: string
  /** See {@link RefusalOrigin.nestedOpenedAt}. Declared, as above. */
  declare readonly nestedOpenedAt?: string
  constructor(message: string, origin: RefusalOrigin = {}) {
    super(message)
    this.name = new.target.name
    if (origin.openedAt !== undefined) this.openedAt = origin.openedAt
    if (origin.nestedOpenedAt !== undefined) this.nestedOpenedAt = origin.nestedOpenedAt
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

/**
 * A transaction boundary failed and the engine's transaction state is no longer
 * known, so the unit is refused rather than guessed at.
 *
 * A remote `RELEASE` or `ROLLBACK TO` that rejects on the network leaves the
 * caller unable to say whether the savepoint is still open. Committing on top
 * of that would commit a local frame stack that no longer describes the remote
 * transaction, so everything under the unit refuses from here and the top level
 * rolls back.
 */
export class TransactionPoisonedError extends StoreExecutorError {
  constructor(
    message: string,
    override readonly cause: unknown,
    origin: RefusalOrigin = {},
  ) {
    super(message, origin)
  }
}

/**
 * A body returned while a nested scope it opened was still open.
 *
 * The savepoint under it never released, so what the engine holds is not what
 * the frame stack says, and the nested body may still be parked on an await.
 * Committing would commit a unit whose inner half nobody has finished, so the
 * transaction rolls back instead. `Promise.all` over a `transact` the body
 * forgot to await is the usual cause.
 */
export class AbandonedNestedTransactionError extends StoreExecutorError {}

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
