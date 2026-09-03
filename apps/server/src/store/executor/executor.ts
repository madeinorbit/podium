/**
 * The executor: what a repository is bound to [POD-3248, spec §3.1].
 *
 * `store.x` is the repository set bound to the ROOT executor and it routes
 * ambiently — with no transaction context a call runs on the root through the
 * scheduler, with a live context it runs on that transaction, with a dead token
 * it rejects. `tx.x` is the same classes bound to a transaction and is the
 * explicit form inside the store and the kernel. Services keep their narrowed
 * dependency lambdas and their call shapes; nothing they hold changes.
 *
 * THE OBJECT REPOSITORIES TAKE is `{ drizzle, transact, read, legacy, context }`:
 *   drizzle — the query-layer client, bound to whatever scope the executor is.
 *             The root's client resolves the scope PER STATEMENT, which is what
 *             makes ambient routing possible at all; a client that closed over a
 *             connection could not do it.
 *   transact/read — methods, never the raw handle.
 *   legacy  — the raw handle for repositories not yet converted. It is a
 *             transitional instrument: deleted at Stage A exit, which is a free
 *             second completeness check (POD-3267 holds the deletion).
 *   context — the tenant seam. Empty today; multi-tenancy is a later epic and
 *             this slot is what keeps it a context value rather than a redesign.
 *
 * The prototype's client is `QueryClient` because no query layer exists yet —
 * this issue lands before it, deliberately, so the interfaces stop moving. What
 * the shape fixes is that the client is BUILT FROM A ROUTER and is therefore
 * scope-bound.
 */

import type { SqlDatabase } from '@podium/runtime/sqlite'
import {
  ALWAYS_ALIVE,
  assertAddressable,
  closeFrame,
  createFrame,
  createInFlight,
  currentScope,
  poisonUnit,
  runInScope,
  settleInFlight,
  type TransactionFrame,
} from './context'
import type {
  BatchRouter,
  DriverSession,
  Lane,
  QueryClient,
  Statement,
  StatementRouter,
  StoreDriver,
} from './driver'
import {
  AbandonedNestedTransactionError,
  ExclusiveInsideLeaseError,
  NoPostCommitScopeError,
  StaleTransactionError,
  StoreUnhealthyError,
  TransactionPoisonedError,
  WriteInsideReadLeaseError,
} from './errors'
import { type PostCommitRegistrar, PostCommitRegistry, PostCommitRunner } from './post-commit'
import { createScheduler, type Lease, type Scheduler, type WatchdogReport } from './scheduler'

/** The tenant seam. Empty today, by decision (spec §1, tenancy postponed). */
export type StoreContext = Readonly<Record<string, never>>

export interface StoreExecutor<TClient = QueryClient> {
  readonly drizzle: TClient
  readonly legacy: SqlDatabase | undefined
  readonly context: StoreContext
  transact<T>(fn: (tx: StoreExecutor<TClient>) => Promise<T>): Promise<T>
  read<T>(fn: (tx: StoreExecutor<TClient>) => Promise<T>): Promise<T>
}

export interface StoreDiagnostics {
  /** Post-commit runners still owned: those still draining or still settling effects. */
  readonly retainedRunners: number
}

export interface StoreHealth {
  readonly healthy: boolean
  readonly error: unknown
}

export interface RootStoreExecutor<TClient = QueryClient> extends StoreExecutor<TClient> {
  /** Nothing else runs: migration, checkpoint, backup, the transfer fence, close. */
  exclusive<T>(fn: (session: DriverSession) => Promise<T>): Promise<T>
  /**
   * The one deliberate committed-view read from inside a body. It runs on a
   * connection outside the lanes, so it sees the committed rows and not the
   * open transaction's — which is the whole point, and why a driver without a
   * reader connection refuses it instead of quietly returning the body's own
   * uncommitted writes.
   */
  outsideTransaction<T>(fn: (view: StoreExecutor<TClient>) => Promise<T>): Promise<T>
  readonly scheduler: Scheduler
  readonly health: StoreHealth
  /**
   * What the executor is still holding. `retainedRunners` is the one that grows
   * with lifetime write volume if a runner is ever kept past its work, so it is
   * the number a leak test can pin (spec §3.3).
   */
  readonly diagnostics: StoreDiagnostics
  /** Every external effect started on any lease so far has settled. */
  effectsSettled(): Promise<void>
  close(): Promise<void>
}

export interface StoreExecutorOptions<TClient> {
  driver: StoreDriver<TClient>
  /** The raw handle, for repositories not yet converted. Transitional. */
  legacy?: SqlDatabase
  watchdog?: { budgetMs: number; report: (report: WatchdogReport) => void }
  now?: () => number
  /** Mechanism 3's report sink. Failures are reported, never rethrown. */
  effectSink?: (error: unknown, label: string) => void
  /** Called when mechanism 1 fails and the store becomes unhealthy. */
  onUnhealthy?: (error: unknown, label: string) => void
  /**
   * A report sink (`effectSink`, `onUnhealthy`) threw. Sinks are called through
   * a guard so an adapter that throws cannot turn an isolated post-commit
   * failure into an unmarked rejection of a committed write.
   */
  onReportFailure?: (error: unknown, label: string) => void
}

/**
 * The registrar for the three post-commit mechanisms, from inside a body.
 * Registered on the innermost open scope; a savepoint's registrations merge
 * into its parent when it releases and are discarded when it rolls back,
 * because a savepoint release is not a commit.
 */
export function postCommit(): PostCommitRegistrar {
  const scope = currentScope()
  if (scope.kind !== 'transaction') {
    throw new NoPostCommitScopeError(
      'postCommit() needs an open transaction scope: there is nothing for the work to follow',
    )
  }
  if (scope.frame.lane === 'read') {
    // A read scope never commits, so `runTopLevel` is given no runner and its
    // registry is dropped on the floor. Registering here USED to succeed and
    // then silently do nothing, which is the worst of the three outcomes: a
    // refusal is visible and a drain is correct.
    throw new NoPostCommitScopeError(
      'postCommit() inside a read scope: a read commits nothing, so there is nothing for the ' +
        'work to follow. Open the write scope at the top of the operation instead.',
    )
  }
  assertAddressable(scope.frame)
  return scope.frame.postCommit
}

export function createStoreExecutor<TClient>(
  options: StoreExecutorOptions<TClient>,
): RootStoreExecutor<TClient> {
  const { driver } = options
  const effectSink =
    options.effectSink ??
    (() => {
      /* dropped by default; the server injects a logger */
    })
  /**
   * Call a report sink without letting it become the failure it was reporting.
   * The same guard `PostCommitRunner` uses, for the same reason: an adapter
   * that throws must not turn an isolated failure into a rejection of an
   * already-committed write.
   */
  function report(error: unknown, label: string): void {
    try {
      effectSink(error, label)
    } catch (sinkError) {
      try {
        options.onReportFailure?.(sinkError, label)
      } catch {
        /* the last-resort sink threw; there is nowhere further to report it */
      }
    }
  }
  const scheduler = createScheduler({
    driver: driver as StoreDriver<unknown>,
    watchdog: options.watchdog,
    now: options.now,
    // Publication is flushed on idle, and idle is raised from inside the
    // release of the operation that just committed. Reported, never rethrown.
    onIdleFailure: (error) => report(error, 'scheduler-idle'),
  })
  const runners = new Set<PostCommitRunner>()
  let healthy = true
  let healthError: unknown

  function markUnhealthy(error: unknown, label: string): void {
    healthy = false
    healthError = error
    options.onUnhealthy?.(error, label)
  }

  function assertHealthy(): void {
    if (healthy) return
    throw new StoreUnhealthyError(
      'the store is unhealthy: a commit application failed, so the in-memory projection no ' +
        'longer matches the database. A reseed or a restart is required.',
      healthError,
    )
  }

  /**
   * A runner belongs to ONE root operation, so the executor may only own it
   * while it still has work. Held past that it is a leak with two costs: a
   * queue, an effect set and an option closure retained per committed or
   * rolled-back write for the lifetime of the process, and an `effectsSettled()`
   * that scans every runner the store has ever created.
   *
   * Retirement waits for the effects, because they outlive the drain by design:
   * dropping the runner at the end of the drain would make `effectsSettled()`
   * blind to exactly the work it exists to wait for.
   */
  function retire(runner: PostCommitRunner): void {
    void runner.effectsSettled().then(
      () => runners.delete(runner),
      () => runners.delete(runner),
    )
  }

  function newRunner(): PostCommitRunner {
    const runner = new PostCommitRunner({
      markUnhealthy,
      effectSink,
      ...(options.onReportFailure ? { onReportFailure: options.onReportFailure } : {}),
    })
    runners.add(runner)
    return runner
  }

  /**
   * The ambient router. One statement, resolved against the scope it is issued
   * in — this is the mechanism the whole "root set routes ambiently" sentence
   * rests on.
   */
  const ambientRouter: StatementRouter = async (statement) => {
    assertHealthy()
    const scope = currentScope()
    if (scope.kind === 'transaction') {
      assertAddressable(scope.frame)
      assertWritable(scope.frame, [statement])
      return scope.frame.unit.inFlight.track(() => scope.frame.lease.session.execute(statement))
    }
    if (scope.kind === 'post-commit') {
      // The transaction is closed, so this is a root statement — but it stays
      // on the held lease, inside the scheduler's ordered operation.
      assertDraining(scope)
      return scope.inFlight.track(() => scope.lease.session.execute(statement))
    }
    const lane: Lane = laneFor([statement])
    return scheduler.run(lane, async (lease) => {
      // AGAIN, on the far side of admission. The check above ran when the call
      // was made; a write can sit in the queue behind the very transaction
      // whose commit application fails, and mechanism 1 says the store refuses
      // further work from that moment — including work already waiting.
      assertHealthy()
      return lane === 'write'
        ? lease.atomicWrite(() => lease.session.execute(statement))
        : lease.session.execute(statement)
    })
  }

  /**
   * The post-commit half of the token rule. The lease is released when the
   * drain ends, so a continuation that resolves after it — a follow-up promise
   * the drain did not await — must be refused rather than issued on a
   * connection the scheduler has already handed back.
   */
  function assertDraining(scope: { active(): boolean }): void {
    if (scope.active()) return
    throw new StaleTransactionError(
      'the post-commit scope this operation addressed has ended, so its lease is released. ' +
        'A promise the post-commit work did not await is the usual cause.',
    )
  }

  /**
   * The batch form of the ambient router. Same three routes, one driver call —
   * a batch that resolved its scope per statement would be N round trips again
   * and would lose the atomicity the batch is for.
   */
  const ambientBatchRouter: BatchRouter = async (statements) => {
    assertHealthy()
    const scope = currentScope()
    if (scope.kind === 'transaction') {
      assertAddressable(scope.frame)
      assertWritable(scope.frame, statements)
      return scope.frame.unit.inFlight.track(() =>
        scope.frame.lease.session.executeBatch(statements),
      )
    }
    if (scope.kind === 'post-commit') {
      assertDraining(scope)
      return scope.inFlight.track(() => scope.lease.session.executeBatch(statements))
    }
    const lane = laneFor(statements)
    return scheduler.run(lane, async (lease) => {
      assertHealthy()
      return lane === 'write'
        ? lease.atomicWrite(() => lease.session.executeBatch(statements))
        : lease.session.executeBatch(statements)
    })
  }

  /**
   * The lane a root statement or batch takes, from DECLARED intent.
   *
   * NEVER FROM `method` (spec §6 rule 2, POD-3318): drizzle emits `all` for an
   * `INSERT ... RETURNING`, so a lane chosen from the method sends a write past
   * the single write slot and, on a driver with `openReader`, onto a read-only
   * connection. Anything that writes takes the write lane; a batch is one
   * transaction, so one writing statement in it is enough.
   */
  function laneFor(statements: readonly Statement[]): Lane {
    return statements.some((statement) => statement.intent === 'write') ? 'write' : 'read'
  }

  /**
   * A read scope may not be written on.
   *
   * The lane was chosen when the scope opened: a read lease opens no
   * transaction, so a write issued on it AUTOCOMMITS — outside the unit of
   * work, unrollbackable, and on a driver whose read lane is a separate
   * connection, on the wrong one. `read()` is a promise about what the body
   * does, and this is what keeps it one.
   */
  function assertWritable(frame: TransactionFrame, statements: readonly Statement[]): void {
    if (frame.lane !== 'read') return
    if (!statements.some((statement) => statement.intent === 'write')) return
    throw new WriteInsideReadLeaseError(
      `a write was issued inside read scope ${frame.id}: a read lease opens no transaction, so ` +
        'the statement would autocommit outside any unit of work. Open the write scope at the ' +
        'top of the operation instead.',
    )
  }

  function frameRouter(frame: TransactionFrame): StatementRouter {
    return async (statement) => {
      assertHealthy()
      assertAddressable(frame)
      assertWritable(frame, [statement])
      return frame.unit.inFlight.track(() => frame.lease.session.execute(statement))
    }
  }

  function frameBatchRouter(frame: TransactionFrame): BatchRouter {
    return async (statements) => {
      assertHealthy()
      assertAddressable(frame)
      assertWritable(frame, statements)
      return frame.unit.inFlight.track(() => frame.lease.session.executeBatch(statements))
    }
  }

  const boundExecutors = new WeakMap<TransactionFrame, StoreExecutor<TClient>>()

  function executorForFrame(frame: TransactionFrame): StoreExecutor<TClient> {
    const cached = boundExecutors.get(frame)
    if (cached) return cached
    const bound: StoreExecutor<TClient> = {
      drizzle: driver.client(frameRouter(frame), frameBatchRouter(frame)),
      legacy: options.legacy,
      context: {},
      transact: (fn) => transactOn(frame, fn),
      read: (fn) => readOn(frame, fn),
    }
    boundExecutors.set(frame, bound)
    return bound
  }

  /** A frame over a session that the scheduler does not lease (the reader). */
  function detachedLease(session: DriverSession): Lease {
    // No transaction and no scheduler slot: the reader connection is its own
    // snapshot, so `begin` has nothing to open and nothing to retry.
    return {
      id: 0,
      lane: 'read',
      session,
      begin: async () => undefined,
      // Nothing to acquire and nothing to serialise against: a read on the
      // reader connection has no write lock to be busy for.
      atomicWrite: (attempt) => attempt(),
      heldMs: () => 0,
    }
  }

  /**
   * The lease this transaction runs on went back to the scheduler while one of
   * its own awaits was still in flight. Nothing further may touch the session:
   * it is not ours any more, and on a reusable remote client a statement issued
   * now executes on whoever holds it next.
   */
  function leaseReleased(): StaleTransactionError {
    return new StaleTransactionError(
      'the post-commit scope this transaction was started from has ended, so the lease it runs ' +
        'on is released. A follow-up that did not return its transaction promise is the usual ' +
        'cause.',
    )
  }

  async function runTopLevel<T>(
    lease: Lease,
    lane: Lane,
    fn: (tx: StoreExecutor<TClient>) => Promise<T>,
    runner: PostCommitRunner | undefined,
    /**
     * The lifetime of the SCOPE that started this transaction, when that is not
     * the root: phase 3's drain owns the lease and can end under us.
     */
    alive: () => boolean = ALWAYS_ALIVE,
  ): Promise<T> {
    const registry = new PostCommitRegistry()
    const frame = createFrame({ lane, lease, parent: undefined, postCommit: registry, alive })
    // Through the LEASE, so the driver's bounded busy retry applies: this is
    // the last point at which nothing of the body has run.
    await lease.begin(lane)
    if (!alive()) {
      // `begin` was issued while the drain still held the lease and resolved
      // after it ended. The body has not run, and the session is no longer ours
      // to roll back on.
      //
      // The close here is hygiene and NOT observable: `executorForFrame` is
      // only ever called inside `runInScope` for this same frame, so a frame
      // whose body never ran hands out no handle and is never the current
      // scope. Nothing can address it, so no test can distinguish its absence.
      closeFrame(frame)
      registry.discard()
      throw leaseReleased()
    }
    let result: T
    try {
      result = await runInScope({ kind: 'transaction', frame }, () => fn(executorForFrame(frame)))
    } catch (error) {
      // BEFORE the rollback, for the same reason the success arm waits before
      // the commit: a statement the body dropped is still running on this
      // session, and a ROLLBACK issued underneath it is a second operation on a
      // connection that is already busy.
      await settleInFlight(frame.unit.inFlight)
      closeFrame(frame)
      registry.discard()
      if (alive()) await lease.session.rollback()
      throw error
    }
    // A statement the body ADMITTED and did not await. The token cannot help
    // here — it was let through while the scope was open — so the scope waits
    // for it rather than committing and handing the connection back with a
    // round trip still on it (POD-3317).
    await settleInFlight(frame.unit.inFlight)
    // A nested scope the body opened and never awaited. Read BEFORE the close,
    // which cascades through exactly this chain.
    const abandoned = frame.child
    // The token dies HERE: before the callback's result is returned and before
    // the connection is released. Anything the body left in flight now rejects.
    closeFrame(frame)
    if (!alive()) {
      registry.discard()
      throw leaseReleased()
    }
    if (abandoned) {
      // Its savepoint never released, so the frame stack does not describe what
      // the engine holds, and the nested body may still be parked. Committing
      // would commit a unit whose inner half nobody finished.
      registry.discard()
      await lease.session.rollback()
      throw new AbandonedNestedTransactionError(
        `transaction ${frame.id} is rolled back: it returned while nested scope ` +
          `${abandoned.id} was still open. A transact the body did not await is the usual cause.`,
      )
    }
    if (frame.unit.poisoned !== undefined) {
      // A boundary failed somewhere under this transaction and the body carried
      // on regardless. Committing would commit a frame stack that no longer
      // describes what the engine holds.
      registry.discard()
      await lease.session.rollback()
      throw new TransactionPoisonedError(
        'the transaction is rolled back: a savepoint boundary failed, so what the engine held ' +
          'open was no longer known and the commit could not be trusted.',
        frame.unit.poisoned,
      )
    }
    await lease.session.commit()
    if (runner) {
      // The scope dies when the drain does, for the same reason the frame's
      // token dies before the commit: the lease goes back to the scheduler.
      let draining = true
      const inFlight = createInFlight()
      try {
        await runInScope(
          { kind: 'post-commit', lease, runner, inFlight, active: () => draining },
          () => runner.drain(registry),
        )
        // The drain waits for what its steps RETURN; a step that issued a
        // statement and dropped the promise leaves a round trip in flight on
        // the lease the scheduler is about to take back.
        await settleInFlight(inFlight)
      } finally {
        draining = false
      }
    }
    return result
  }

  /**
   * May this frame's unit still be issued on? A savepoint's boundaries live on
   * the SAME session as its parent, so a parent that has already rolled back
   * and gone home takes the whole stack with it — including the right to issue
   * the `ROLLBACK TO`/`RELEASE` that would otherwise tidy up.
   */
  function unitUsable(frame: TransactionFrame): boolean {
    return frame.active && frame.alive()
  }

  function enclosingScopeEnded(parent: TransactionFrame): StaleTransactionError {
    return new StaleTransactionError(
      `the transaction ${parent.id} this nested scope was opened on has ended, so its lease is ` +
        'no longer held. A nested transact the body did not await is the usual cause.',
    )
  }

  async function runNested<T>(
    parent: TransactionFrame,
    fn: (tx: StoreExecutor<TClient>) => Promise<T>,
  ): Promise<T> {
    const registry = new PostCommitRegistry()
    const frame = createFrame({
      lane: parent.lane,
      lease: parent.lease,
      parent,
      postCommit: registry,
    })
    // Claimed before the first await, so a second branch opened in the same
    // turn is refused rather than racing for the savepoint stack.
    parent.child = frame
    const name = `podium_sp_${frame.depth}`
    try {
      await parent.lease.session.enterSavepoint(name)
    } catch (error) {
      // The scope never opened, so the parent gets its addressability back
      // rather than being left with a child that will never close. Nothing ran
      // inside it, and an outer COMMIT closes a savepoint that did get created.
      closeFrame(frame)
      throw error
    }
    if (!unitUsable(parent)) {
      // The parent returned while this savepoint was being opened, and rolled
      // the whole unit back. The body must not run, and there is nothing left
      // to roll back to on a session the scheduler has taken back.
      //
      // Hygiene, and not observable, for the reason given at the same branch in
      // `runTopLevel`: the body never ran, so no handle escaped. The
      // `parent.child` this clears cannot be seen either — `assertAddressable`
      // refuses on the parent's own dead token long before it looks at a child.
      closeFrame(frame)
      registry.discard()
      throw enclosingScopeEnded(parent)
    }
    let result: T
    try {
      result = await runInScope({ kind: 'transaction', frame }, () => fn(executorForFrame(frame)))
    } catch (error) {
      await settleInFlight(frame.unit.inFlight)
      closeFrame(frame)
      registry.discard()
      if (!unitUsable(parent)) throw error
      try {
        await parent.lease.session.rollbackToSavepoint(name)
        await parent.lease.session.releaseSavepoint(name)
      } catch (boundaryError) {
        // The body's own error is what the caller asked about, so it still
        // wins — but the transaction state is now unknown, and an outer body
        // that catches this must not go on to commit on top of it.
        poisonUnit(parent, boundaryError)
      }
      throw error
    }
    // The unit's, not this frame's: a savepoint's statements run on the SAME
    // session as its parent's, so the boundary below cannot be issued while any
    // of them is still in flight.
    await settleInFlight(frame.unit.inFlight)
    const abandoned = frame.child
    closeFrame(frame)
    if (!unitUsable(parent)) {
      registry.discard()
      throw enclosingScopeEnded(parent)
    }
    if (abandoned) {
      // The same rule one level down: a savepoint that returned over an open
      // scope of its own is rolled back rather than released, so the parent is
      // left exactly as this scope found it.
      registry.discard()
      try {
        await parent.lease.session.rollbackToSavepoint(name)
        await parent.lease.session.releaseSavepoint(name)
      } catch (boundaryError) {
        poisonUnit(parent, boundaryError)
      }
      throw new AbandonedNestedTransactionError(
        `nested transaction ${frame.id} is rolled back: it returned while nested scope ` +
          `${abandoned.id} was still open. A transact the body did not await is the usual cause.`,
      )
    }
    try {
      await parent.lease.session.releaseSavepoint(name)
    } catch (error) {
      poisonUnit(parent, error)
      throw error
    }
    // A savepoint release is not a commit: the work follows whoever commits.
    registry.mergeInto(parent.postCommit)
    return result
  }

  /**
   * The EXPLICIT form: `tx.transact` addresses the frame the handle came from,
   * not whatever scope the caller happens to be in. A handle whose scope has
   * ended rejects — which is what makes a leaked `tx` a refusal rather than a
   * silent new transaction on the root.
   */
  async function transactOn<T>(
    frame: TransactionFrame,
    fn: (tx: StoreExecutor<TClient>) => Promise<T>,
  ): Promise<T> {
    assertHealthy()
    assertAddressable(frame)
    if (frame.lane === 'read') {
      throw new WriteInsideReadLeaseError(
        'transact() inside a read lease: a read lease has no write to commit. Open the write ' +
          'scope at the top of the operation instead.',
      )
    }
    return runNested(frame, fn)
  }

  async function readOn<T>(
    frame: TransactionFrame,
    fn: (tx: StoreExecutor<TClient>) => Promise<T>,
  ): Promise<T> {
    assertHealthy()
    assertAddressable(frame)
    // Already inside a unit of work: a read sees its own writes, so it needs no
    // scope of its own.
    return fn(executorForFrame(frame))
  }

  /**
   * The AMBIENT form: `store.transact` resolves the caller's scope. Every
   * refusal is a rejection, never a synchronous throw, so a caller never has to
   * guard the call site as well as the promise.
   */
  async function transact<T>(fn: (tx: StoreExecutor<TClient>) => Promise<T>): Promise<T> {
    assertHealthy()
    const scope = currentScope()
    if (scope.kind === 'transaction') return transactOn(scope.frame, fn)
    if (scope.kind === 'post-commit') {
      // A follow-up committing durably: the same lease, a fresh transaction,
      // and its own post-commit work queued behind the batch being drained.
      assertDraining(scope)
      // BOUND TO THE DRAIN across every await inside it. The drain can only
      // wait for what a step returns, so a follow-up that starts a transaction
      // and drops its promise would otherwise go on begin-ing, writing and
      // committing on a lease the scheduler has taken back.
      return runTopLevel(scope.lease, 'write', fn, scope.runner, () => scope.active())
    }
    return scheduler.run('write', async (lease) => {
      // On the far side of admission: a write queued behind the transaction
      // whose commit application failed must be refused, not committed into a
      // store already known to have diverged.
      assertHealthy()
      const runner = newRunner()
      try {
        return await runTopLevel(lease, 'write', fn, runner)
      } finally {
        retire(runner)
      }
    })
  }

  async function read<T>(fn: (tx: StoreExecutor<TClient>) => Promise<T>): Promise<T> {
    assertHealthy()
    const scope = currentScope()
    if (scope.kind === 'transaction') return readOn(scope.frame, fn)
    if (scope.kind === 'post-commit') {
      assertDraining(scope)
      return runTopLevel(scope.lease, 'read', fn, undefined, () => scope.active())
    }
    return scheduler.run('read', async (lease) => {
      assertHealthy()
      return runTopLevel(lease, 'read', fn, undefined)
    })
  }

  const root: RootStoreExecutor<TClient> = {
    drizzle: driver.client(ambientRouter, ambientBatchRouter),
    legacy: options.legacy,
    context: {},
    transact,
    read,
    async exclusive(fn) {
      assertHealthy()
      const scope = currentScope()
      if (scope.kind !== 'root') {
        throw new ExclusiveInsideLeaseError(
          `exclusive() requested from inside a ${scope.kind} scope, which already holds the ` +
            'lane it would have to wait for. Take it from the root.',
        )
      }
      return scheduler.run('exclusive', async (lease) => {
        assertHealthy()
        return fn(lease.session)
      })
    },
    async outsideTransaction(fn) {
      assertHealthy()
      const scope = currentScope()
      if (scope.kind !== 'transaction') return read(fn)
      // The context is only a permission to look outside a transaction that is
      // still open. A continuation the body left in flight carries the scope
      // with it, so without this it would resume after the commit and read the
      // committed view successfully — the token rule with a hole in it.
      assertAddressable(scope.frame)
      const caller = scope.frame
      return scheduler.detachedRead(async (session) => {
        const frame = createFrame({
          lane: 'read',
          lease: detachedLease(session),
          parent: undefined,
          postCommit: new PostCommitRegistry(),
          // BOUND TO THE CALLER'S SCOPE, not just checked on the way in. The
          // reader frame is a fresh top-level frame, so its own token stays
          // open for as long as `fn` runs — and a `fn` whose promise the body
          // dropped goes on reading the committed view after the transaction it
          // was permission to look outside of has committed and gone home
          // (POD-3317).
          alive: () => unitUsable(caller),
        })
        try {
          // The scope is REPLACED, not nested: an ambient call inside `fn` must
          // reach the reader connection, never be routed back into the open
          // transaction the caller is trying to look outside of.
          return await runInScope({ kind: 'transaction', frame }, () => fn(executorForFrame(frame)))
        } finally {
          closeFrame(frame)
        }
      })
    },
    scheduler,
    get health() {
      return { healthy, error: healthError }
    },
    get diagnostics() {
      return { retainedRunners: runners.size }
    },
    async effectsSettled() {
      await Promise.all([...runners].map((runner) => runner.effectsSettled()))
    },
    close: () => scheduler.close(),
  }
  return root
}
