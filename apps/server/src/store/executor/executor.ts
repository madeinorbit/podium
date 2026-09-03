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
  assertAddressable,
  closeFrame,
  createFrame,
  currentScope,
  runInScope,
  type TransactionFrame,
} from './context'
import type { DriverSession, Lane, QueryClient, StatementRouter, StoreDriver } from './driver'
import {
  ExclusiveInsideLeaseError,
  NoPostCommitScopeError,
  StoreUnhealthyError,
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
  assertAddressable(scope.frame)
  return scope.frame.postCommit
}

export function createStoreExecutor<TClient>(
  options: StoreExecutorOptions<TClient>,
): RootStoreExecutor<TClient> {
  const { driver } = options
  const scheduler = createScheduler({
    driver: driver as StoreDriver<unknown>,
    watchdog: options.watchdog,
    now: options.now,
  })
  const effectSink =
    options.effectSink ??
    (() => {
      /* dropped by default; the server injects a logger */
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
      return scope.frame.lease.session.execute(statement)
    }
    if (scope.kind === 'post-commit') {
      // The transaction is closed, so this is a root statement — but it stays
      // on the held lease, inside the scheduler's ordered operation.
      return scope.lease.session.execute(statement)
    }
    const lane: Lane = statement.method === 'run' ? 'write' : 'read'
    return scheduler.run(lane, (lease) => lease.session.execute(statement))
  }

  function frameRouter(frame: TransactionFrame): StatementRouter {
    return async (statement) => {
      assertHealthy()
      assertAddressable(frame)
      return frame.lease.session.execute(statement)
    }
  }

  const boundExecutors = new WeakMap<TransactionFrame, StoreExecutor<TClient>>()

  function executorForFrame(frame: TransactionFrame): StoreExecutor<TClient> {
    const cached = boundExecutors.get(frame)
    if (cached) return cached
    const bound: StoreExecutor<TClient> = {
      drizzle: driver.client(frameRouter(frame)),
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
    return { id: 0, lane: 'read', session, heldMs: () => 0 }
  }

  async function runTopLevel<T>(
    lease: Lease,
    lane: Lane,
    fn: (tx: StoreExecutor<TClient>) => Promise<T>,
    runner: PostCommitRunner | undefined,
  ): Promise<T> {
    const registry = new PostCommitRegistry()
    const frame = createFrame({ lane, lease, parent: undefined, postCommit: registry })
    await lease.session.begin(lane)
    let result: T
    try {
      result = await runInScope({ kind: 'transaction', frame }, () => fn(executorForFrame(frame)))
    } catch (error) {
      closeFrame(frame)
      registry.discard()
      await lease.session.rollback()
      throw error
    }
    // The token dies HERE: before the callback's result is returned and before
    // the connection is released. Anything the body left in flight now rejects.
    closeFrame(frame)
    await lease.session.commit()
    if (runner) {
      await runInScope({ kind: 'post-commit', lease, runner }, () => runner.drain(registry))
    }
    return result
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
    await parent.lease.session.enterSavepoint(name)
    let result: T
    try {
      result = await runInScope({ kind: 'transaction', frame }, () => fn(executorForFrame(frame)))
    } catch (error) {
      closeFrame(frame)
      registry.discard()
      await parent.lease.session.rollbackToSavepoint(name)
      await parent.lease.session.releaseSavepoint(name)
      throw error
    }
    closeFrame(frame)
    await parent.lease.session.releaseSavepoint(name)
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
      return runTopLevel(scope.lease, 'write', fn, scope.runner)
    }
    return scheduler.run('write', (lease) => runTopLevel(lease, 'write', fn, newRunner()))
  }

  async function read<T>(fn: (tx: StoreExecutor<TClient>) => Promise<T>): Promise<T> {
    assertHealthy()
    const scope = currentScope()
    if (scope.kind === 'transaction') return readOn(scope.frame, fn)
    if (scope.kind === 'post-commit') return runTopLevel(scope.lease, 'read', fn, undefined)
    return scheduler.run('read', (lease) => runTopLevel(lease, 'read', fn, undefined))
  }

  const root: RootStoreExecutor<TClient> = {
    drizzle: driver.client(ambientRouter),
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
      return scheduler.run('exclusive', (lease) => fn(lease.session))
    },
    async outsideTransaction(fn) {
      assertHealthy()
      const scope = currentScope()
      if (scope.kind !== 'transaction') return read(fn)
      return scheduler.detachedRead(async (session) => {
        const frame = createFrame({
          lane: 'read',
          lease: detachedLease(session),
          parent: undefined,
          postCommit: new PostCommitRegistry(),
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
    async effectsSettled() {
      await Promise.all([...runners].map((runner) => runner.effectsSettled()))
    },
    close: () => scheduler.close(),
  }
  return root
}
