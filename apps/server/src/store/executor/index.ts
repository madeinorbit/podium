/**
 * The store executor [POD-3248].
 *
 * WHERE THIS LIVES AND WHY. `apps/server/src/store/executor`, not
 * `packages/runtime`: the executor's `drizzle` field is the query layer, and
 * the working rules keep drizzle inside persistence (spec §6 rule 2) — the
 * store, the operations store, the migrations and the sync SQLite adapter.
 * Splitting the scheduler into `packages/runtime` would put half of these
 * interfaces outside the directories the boundary lint family watches, for no
 * second consumer: nothing but the store schedules the database. The one thing
 * that does belong to the runtime package stays there — `SqlDatabase`, which is
 * the driver seam this prototype is written against.
 */

export {
  type BunDriverOptions,
  createBunSqliteDriver,
} from './bun-driver'
export {
  assertAddressable,
  currentScope,
  type InFlight,
  type StoreScope,
  type TransactionFrame,
  type TransactionToken,
  type TransactionUnit,
} from './context'
export {
  type BatchRouter,
  type BusyRetryPolicy,
  type DriverLimits,
  type DriverSession,
  type FailureClass,
  type Lane,
  type LanePolicy,
  NO_BUSY_RETRY,
  type QueryClient,
  queryClientOver,
  type SqlParam,
  type SqlRunResult,
  type Statement,
  type StatementIntent,
  type StatementMethod,
  type StatementResult,
  type StatementRouter,
  type StoreDriver,
  UNBOUNDED_WRITE_BUDGET_MS,
} from './driver'
export {
  ExclusiveInsideLeaseError,
  NoPostCommitScopeError,
  ParallelNestedTransactionError,
  PostCommitError,
  SchedulerClosedError,
  StaleTransactionError,
  StoreExecutorError,
  StoreUnhealthyError,
  TransactionPoisonedError,
  WriteInsideReadLeaseError,
} from './errors'
export {
  createStoreExecutor,
  postCommit,
  type RootStoreExecutor,
  type StoreContext,
  type StoreDiagnostics,
  type StoreExecutor,
  type StoreExecutorOptions,
  type StoreHealth,
} from './executor'
export { createFrameFlusher, type FrameFlusher, type FrameFlusherOptions } from './frame-flusher'
export {
  type LegacyHandleHolder,
  observeLegacyHandle,
  probeLegacyStatements,
} from './legacy-handle-probe'
export {
  type PostCommitRegistrar,
  PostCommitRegistry,
  PostCommitRunner,
  type PostCommitStep,
} from './post-commit'
export {
  createScheduler,
  type Lease,
  type Scheduler,
  type SchedulerOptions,
  type SchedulerState,
  type WatchdogReport,
} from './scheduler'
export {
  DraftRegistry,
  LeasedState,
  type Revisioned,
  StaleRevisionError,
  StaleVersionError,
  VersionedMutex,
} from './state-models'
export {
  instrumentDriver,
  queryAttributionProbe,
  type StatementObservation,
  type StatementProbe,
  StatementProbeHub,
} from './statement-probe'
