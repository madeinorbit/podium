import { bootStage } from './boot-timing'
/**
 * Durable server-side store. Single writer (the server).
 *
 * The store's COMPOSITION ROOT, nothing more, in two halves [POD-6959 design
 * 2.4, "The store splits in two"]:
 *
 *  - StoreDatabase opens the database, runs the versioned migration chain
 *    (src/migrations/) and the boot imports, owns the executor and the
 *    lifecycle, sets up search and the change capture, holds the global
 *    repositories, and provisions workspaces and opens their stores.
 *  - SessionStore is ONE WORKSPACE's repositories over that database: it
 *    sequences the workspace's identity refusals and idempotent heals, and
 *    constructs the per-aggregate repositories in `./store/`, each bound to the
 *    workspace — including the two cross-aggregate late-bound lambdas (issues
 *    resolve their stable repo_id via the repos aggregate; re-identifying a repo
 *    dual-writes onto its issues). Callers hold the aggregate repository they
 *    need (`store.issues`, `store.sync`, …); the only forwarding methods are the
 *    database's lifecycle, so a caller holding a store keeps working.
 *
 * Both classes live in this file because each needs the other at run time: a
 * database opens its boot workspace's store, and `SessionStore.open` opens a
 * database. Two modules would be a runtime import cycle, which the server's
 * composition graph refuses (`scripts/server-composition-graph.ts`).
 *
 * Aggregate map:
 *  - sessions (+ pins/snoozes/tab_order/session_drafts) → store/sessions.ts
 *  - issues (+ labels/deps/comments/mail)               → store/issues.ts
 *  - conversations (index/FTS/registry/mirror/transcript index)
 *                                                        → store/conversations.ts + store/conversations/
 *  - sync (changes/applied_mutations/queued_messages/upstream_outbox)
 *                                                        → @podium/sync's SyncRepository
 *                                                          (query-only; schema DDL stays
 *                                                          here in src/migrations/)
 *  - superagent (threads/messages)                       → store/superagent.ts
 *  - settings/meta                                       → store/settings.ts
 *  - layout (user_layout — sidebar/tab chrome, POD-1350)  → store/user-layout.ts
 *  - feed cursors (user_read_position — read positions, POD-1380)
 *                                                        → store/user-read-position.ts
 *  - repos                                               → store/repos.ts
 *  - machines                                            → store/machines.ts
 *  - events/steward (podium_events/steward_state/subscriptions)
 *                                                        → store/events.ts
 *  - notification fact claims                            → store/notification-facts.ts
 *  - automations (automations/automation_runs)           → store/automations.ts
 *  - shipping (orders/attempts/steps/holds/receipts)     → store/shipping.ts
 *  - operations (durable long-running lifecycle work)   → modules/operations/store.ts
 *    (the one aggregate whose repository lives beside its engine rather than in
 *    ./store/, because the operations framework ships as one module and the
 *    table is meaningless without the state machine that writes it)
 */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { IdentityDatabase, PgDb, SqliteDb } from '@podium/identity'
import { createLogger } from '@podium/logger'
import { asMachineId, type MachineId, type WorkspaceId } from '@podium/model'
import { stateDir } from '@podium/runtime/config'
import type { SqlDatabase } from '@podium/runtime/sqlite'
import type { UpdateSigningKey } from '@podium/runtime/update-signing-key'
import { SyncRepository } from '@podium/sync'
import { isFeatureEnabled } from './features'
import type { BackupPreflight } from './migrations/backup'
import type { SnapshotVerifierDeps } from './migrations/snapshot-verifier'
import {
  openStoreLifecycle,
  PLANNER_STATISTICS_INTERVAL_MS,
  type StoreLifecycle,
} from './migrations/store-lifecycle'
import { syncServerTables } from './migrations/sync-server-tables'
import { OperationStore } from './modules/operations/store'
import { UpdateRecoveryStore } from './modules/updates/recovery-store'
import { SELF_HOSTED_WORKSPACE_ID } from './self-hosted-workspace'
import { AccountsRepository } from './store/accounts'
import { AgentProfilesRepository } from './store/agent-profiles'
import { ArtifactUploadsRepository } from './store/artifact-uploads'
import { AutomationsRepository } from './store/automations'
import { CheckoutsRepository } from './store/checkouts'
import { ConversationsRepository } from './store/conversations'
import { provisionWorkspaceFeed } from './store/database'
import { EffectsRepository } from './store/effects'
import { EventsRepository } from './store/events'
import type { QueryClient, StoreRefusal, WatchdogOptions } from './store/executor'
import { dialectOf } from './store/executor/dialect-prepared'
import {
  type RootStoreExecutor,
  type StoreContext,
  workspaceContext,
} from './store/executor/executor'
import {
  type GlobalQueries,
  type LegacyWorkspaceQueries,
  legacyWorkspaceQueries,
} from './store/executor/sync-drizzle'
import { GrantsRepository } from './store/grants'
import { IdentityUpgradeRepository } from './store/identity-upgrade'
import { InteractionsRepository } from './store/interactions'
import { IssuesRepository } from './store/issues'
import { JanitorReadsRepository } from './store/janitor-reads'
import { LocksRepository } from './store/locks'
import { MachinesRepository, RETIRED_MACHINE_SENTINELS } from './store/machines'
import { MaintenanceRepository } from './store/maintenance'
import { MessagesRepository } from './store/messages'
import { MessagingSessionAttachmentsRepository } from './store/messaging-session-attachments'
import { MessagingTopicsRepository } from './store/messaging-topics'
import { NotificationFactsRepository } from './store/notification-facts'
import { ObservationCheckpointsRepository } from './store/observation-checkpoints'
import { PendingUploadsRepository } from './store/pending-uploads'
import { QuotaHistoryRepository } from './store/quota-history'
import { ReadWatermarksRepository } from './store/read-watermarks'
import { normalizeRepoPath, ReposRepository } from './store/repos'
import { ServerSecretsRepository } from './store/server-secrets'
import { SessionsRepository } from './store/sessions'
import { SettingsRepository } from './store/settings'
import { SettingsAuditRepository } from './store/settings-audit'
import { ShippingRepository } from './store/shipping'
import { SignInCarryOverRepository } from './store/sign-in-carry-over'
import { SuperagentRepository } from './store/superagent'
import { TableWrites } from './store/table-writes'
import { TelegramBindingsRepository } from './store/telegram-bindings'
import { TranscriptCostsRepository } from './store/transcript-costs'
import { UserDockShellRepository, UserLayoutRepository } from './store/user-layout'
import { UserReadPositionRepository } from './store/user-read-position'
import { UsersRepository } from './store/users'
import { WorkflowsRepository } from './store/workflows'
import { storeEngineFor } from './store-database'

const log = createLogger('server:store')

export type { MessagePrincipalRef } from './store/messages'
export * from './store/types'
export { normalizeRepoPath }

/** Default DB file: podium.db below the selected instance state root. */
export function defaultDbPath(): string {
  return join(stateDir(), 'podium.db')
}

/**
 * The environment variable naming a Postgres store (POD-6994): a `postgres://` URL.
 * Unset, the server's store is the state directory's SQLite file.
 */
export const DATABASE_URL_ENV = 'PODIUM_DATABASE_URL'
/**
 * Set to `1` to let a Postgres store apply pending migrations at boot (local
 * development). Without it the server only checks the ledger, because on hosted
 * migrating is a deploy step (`podium server migrate`, POD-6958 design 2.7).
 */
export const DATABASE_MIGRATE_AT_BOOT_ENV = 'PODIUM_DATABASE_MIGRATE_AT_BOOT'

/**
 * Where the server's store is, which names its engine: {@link DATABASE_URL_ENV}
 * when set, else {@link defaultDbPath}. A value that is not a Postgres URL is
 * refused rather than opened as a file named after it.
 *
 * THE ENVIRONMENT ONLY. The URL carries the database credential, and credentials
 * come from the environment, never from `config.json` (the rule file storage keeps
 * for its keys). A config key that tries to name the database (`database`,
 * `databaseUrl`, …) is refused at boot rather than ignored, so a misplaced setting
 * cannot leave the server quietly serving the wrong store. The URL is never logged.
 */
export function storeLocation(
  env: Record<string, string | undefined> = process.env,
  config: object = {},
): string {
  const misplaced = Object.keys(config).filter((key) => key.toLowerCase().startsWith('database'))
  if (misplaced.length > 0) {
    throw new Error(
      `config.json sets ${misplaced.join(', ')}: the store's database is named by the ` +
        `${DATABASE_URL_ENV} environment variable only, because its URL carries a credential. ` +
        'Remove the key and set the variable instead.',
    )
  }
  const url = env[DATABASE_URL_ENV]?.trim()
  if (!url) return defaultDbPath()
  if (storeEngineFor(url) !== 'pg') {
    throw new Error(`${DATABASE_URL_ENV} must be a postgres:// or postgresql:// URL`)
  }
  return url
}

/** Whether {@link DATABASE_MIGRATE_AT_BOOT_ENV} asks a Postgres store to migrate at boot. */
export function storeMigratesAtBoot(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[DATABASE_MIGRATE_AT_BOOT_ENV]?.trim() === '1'
}

/** What {@link StoreDatabase.open} takes beyond the path and the host machine. */
export type StoreDatabaseOptions = SnapshotVerifierDeps & {
  queryOnly?: boolean
  /**
   * `whenLogAttaches` is a test store's (`openTestStore`): no change is
   * captured until a change log attaches to the store
   * ({@link StoreDatabase.attachChangeLog}), so a fixture that seeds rows
   * with no log in the test has nothing to drain. Production captures
   * from the end of the boot (POD-6920).
   */
  changeCapture?: 'atBoot' | 'whenLogAttaches'
  /**
   * THE WORKSPACE THE BOOT OPENS. Its repositories run the per-boot identity
   * refusals and repairs, its settings decide whether this boot carries a
   * full-text index, and the imports that predate workspaces (the enrollment
   * ledger) write into it. A self-hosted install passes
   * `SELF_HOSTED_WORKSPACE_ID`; nothing here chooses one.
   */
  bootWorkspace: WorkspaceId
  /**
   * POSTGRES ONLY: apply pending migrations at boot (tests and local development).
   * Without it a Postgres store checks the migration ledger and refuses a database
   * that is behind this build, because on hosted migrating is a deploy step
   * (`podium server migrate`, POD-6958 design 2.7). A SQLite store always migrates.
   */
  migrateAtBoot?: boolean
  /**
   * POSTGRES ONLY: the connection pool's size (the driver's default otherwise). A test
   * store opens a small one: a test file may hold many stores at once.
   */
  poolSize?: number
}

/**
 * A workspace's store was opened before the workspace was provisioned: it has no
 * `sync_feed` row, which a Postgres store locks at every write of the workspace
 * (POD-6959 contract C4), so the store's first boot step was refused. Provisioning
 * creates the row (`StoreDatabase.provisionWorkspace`) and, on hosted, the workspace's
 * first rows (its first member among them; POD-6964, POD-6965).
 */
export class WorkspaceNotProvisionedError extends Error {
  constructor(
    readonly workspaceId: WorkspaceId,
    cause: unknown,
  ) {
    super(
      `workspace ${workspaceId} is not provisioned: it has no sync_feed row. Provision it ` +
        '(StoreDatabase.provisionWorkspace) before opening its store.',
      { cause },
    )
    this.name = 'WorkspaceNotProvisionedError'
  }
}

/** Whether `error` (or an error it wraps) is the driver's refusal of a missing feed row. */
function causedByMissingFeedRow(error: unknown): boolean {
  for (let at: unknown = error, depth = 0; at instanceof Error && depth < 8; depth++) {
    if (at.name === 'WorkspaceFeedRowMissingError') return true
    at = at.cause
  }
  return false
}

/**
 * ONE DATABASE [POD-6959 design 2.4, "The store splits in two"].
 *
 * Owns what there is one of per database: the executor, the migrations and the
 * boot imports, the lifecycle (transfer, snapshots, planner statistics, close),
 * search setup, the change-capture install, the global repositories, and the
 * workspaces' stores. A workspace's repositories are {@link SessionStore}s,
 * made by {@link StoreDatabase.workspace} and kept for the database's life.
 */
export class StoreDatabase {
  /**
   * The base query capability: the store's one drizzle instance with the global
   * context. Global repositories take it; each workspace's queries are made
   * from it ({@link legacyWorkspaceQueries}), so every workspace shares its
   * prepared statements.
   */
  readonly queries: GlobalQueries
  /**
   * The store's per-table write announcement (POD-3247). One per database: a
   * repository holding a cached read of a table subscribes here whichever
   * workspace's store it belongs to. See `store/table-writes.ts`.
   */
  readonly tableWrites = new TableWrites()
  /** See {@link StoreLifecycle.legacyIdentityStorage}. */
  get legacyIdentityStorage(): boolean {
    return this.lifecycle.legacyIdentityStorage
  }
  /** See {@link SessionStore.hostMachineId}; one per process, so one per database. */
  readonly hostMachineId: MachineId
  private readonly publicationIdleSubscriptions = new Set<() => void>()
  /** Each workspace's store, made once: a workspace's repositories hold its caches. */
  private readonly workspaces = new Map<WorkspaceId, Promise<SessionStore>>()
  private closing: Promise<void> | undefined

  /**
   * Whether this boot has a full-text search index — the resolved
   * `command-palette` flag (PDM-25) of the boot workspace. Readers that must NOT
   * offer a search the index cannot back (the superagent's
   * `search_conversations`/`search_all`) ask this rather than re-resolving the
   * flag, so they can never disagree with what the boot actually built.
   */
  private searchIndexEnabledValue = false

  get searchIndexEnabled(): boolean {
    return this.searchIndexEnabledValue
  }

  static async open(
    location: string,
    hostMachineId: MachineId,
    options: StoreDatabaseOptions,
    watchdog: WatchdogOptions = {
      report: (report) => log.warn('transaction lease exceeded idle budget', { ...report }),
      onReportFailure: (error) => log.error('transaction watchdog sink failed', { err: error }),
    },
  ): Promise<StoreDatabase> {
    /**
     * The executor's report sinks, defined ONCE for every engine and for both of a
     * SQLite file's connections (migration, then runtime): a connection that logged
     * differently from another would be a diagnostic gap nobody notices until it
     * matters.
     *
     * Every one hands the logger `err` rather than a string. The logger walks
     * `err.cause` recursively with stacks (packages/logger/src/record.ts), so a
     * store refusal wrapped by Drizzle reaches the log WITH the refusal that
     * explains it — which is exactly what `String(error)` threw away (POD-3802 §2).
     */
    const sinks = {
      watchdog,
      effectSink: (error: unknown, label: string) =>
        log.error('shutdown or post-commit effect failed', { label, err: error }),
      /**
       * One line per refused statement, at the source [POD-3805]. The refusal is
       * already a rejection the caller sees; what was missing is a server-side
       * record naming the lane, the frame and the SITE that opened the span, so a
       * wedged queue is one grep rather than a day of guessing.
       */
      onRefusal: (refusal: StoreRefusal) =>
        log.error('store executor refused a statement', {
          label: refusal.label,
          ...(refusal.frameId === undefined ? {} : { frameId: refusal.frameId }),
          ...(refusal.lane === undefined ? {} : { lane: refusal.lane }),
          // The stacks go in their own fields: the logger serializes `err` to
          // name/message/stack/cause and would drop anything else on the error.
          ...(refusal.openedAt === undefined ? {} : { openedAt: refusal.openedAt }),
          ...(refusal.nestedOpenedAt === undefined
            ? {}
            : { nestedOpenedAt: refusal.nestedOpenedAt }),
          err: refusal.error,
        }),
    }
    // THE ENGINE IS CHOSEN HERE, ONCE, FROM THE LOCATION [POD-6979, POD-6994]: a
    // postgres:// URL is a Postgres store, anything else a SQLite file. The
    // store-lifecycle port is the engine's; nothing below asks again.
    const lifecycle = await openStoreLifecycle(location, {
      queryOnly: options.queryOnly === true,
      bootWorkspace: options.bootWorkspace,
      sinks,
      snapshotVerifier: options,
      ...(options.migrateAtBoot === undefined ? {} : { migrateAtBoot: options.migrateAtBoot }),
      ...(options.poolSize === undefined ? {} : { poolSize: options.poolSize }),
      stage: bootStage,
    })
    const executor = lifecycle.executor
    try {
      if (lifecycle.applied.length > 0)
        log.info('applied migrations', { applied: lifecycle.applied })
      const store = new StoreDatabase(location, hostMachineId, lifecycle)
      const backfillStarted = performance.now()
      await store.boot(options.bootWorkspace, options.queryOnly === true)
      bootStage('backfill', backfillStarted)
      // DERIVED CHANGE CAPTURE (POD-6920): from here every write of a row a
      // synced record reads is captured, and a transaction that does not drain
      // its capture into the log cannot commit.
      if (!options.queryOnly && options.changeCapture !== 'whenLogAttaches') {
        const captureStarted = performance.now()
        await store.attachChangeLog()
        bootStage('change capture', captureStarted)
      }
      // After the migrations and the boot repairs, so the statistics describe
      // the tables as the server will read them. An in-memory store is a test
      // fixture whose tables are empty; statistics would describe nothing.
      if (lifecycle.keepsPlannerStatistics) {
        const statisticsStarted = performance.now()
        await store.refreshPlannerStatistics('open')
        bootStage('planner statistics', statisticsStarted)
        store.startPlannerStatistics()
      }
      // Last, once nothing left in the boot builds an index (see the function).
      await lifecycle.serveTraffic()
      return store
    } catch (error) {
      await executor.close()
      throw error
    }
  }

  private constructor(
    /**
     * Where the database is, which names its engine: a SQLite file path or a Postgres
     * URL. What a sync worker or the janitor opens its own read session on. Never logged:
     * a URL carries its credential.
     */
    readonly location: string,
    hostMachineId: MachineId,
    /** The engine's lifecycle steps, and the executor every repository runs on. */
    private readonly lifecycle: StoreLifecycle,
  ) {
    // The value crosses into its id space HERE, once: it arrives as the bytes of a
    // state-dir file (or a fresh mint) and leaves as the machine identity every row,
    // route and grant in this process is keyed by.
    this.hostMachineId = asMachineId(hostMachineId)
    this.executor = lifecycle.executor
    this.db = lifecycle.connection
    this.queries = lifecycle.executor.queries
  }

  /**
   * WHAT EVERY REPOSITORY IS BOUND TO [POD-3254, spec §3.1]: the executor's
   * query capability, through {@link queries} or a workspace's queries made
   * from it. Lifecycle operations and close use the same scheduler as
   * repository work.
   */
  private readonly executor: RootStoreExecutor<QueryClient>

  /**
   * The connection, for the tests that read rows under the repositories and the
   * statement probe: the SQLite handle, or on Postgres a key that refuses use as one
   * (`StoreLifecycle.connection`).
   */
  readonly db: SqlDatabase

  /**
   * The boot's per-database steps around the boot workspace's own: provision it,
   * run its identity refusals and repairs, and decide search from its settings.
   * The order inside is the order the single store always had: search is set up
   * after the repairs and before the global thread is seeded.
   */
  private async boot(bootWorkspace: WorkspaceId, queryOnly: boolean): Promise<void> {
    // A self-hosted install's row exists from the upgrade (contract C4); this
    // makes it so for any boot workspace. A store that cannot be written
    // provisions nothing.
    if (!queryOnly) await this.provisionWorkspace(bootWorkspace)
    const store = new SessionStore(this, bootWorkspace)
    this.workspaces.set(bootWorkspace, Promise.resolve(store))
    await store.refuseAndRepair()
    // Search is one switch (PDM-25): the `command-palette` flag that shows Cmd+K
    // also decides whether this boot carries a full-text index at all. Read ONCE,
    // here — flipping the toggle takes effect at the next boot, so nothing has to
    // rebuild an index underneath a running process. `settings` is initialized
    // by the repairs above, so a config-forced value is honoured on the very
    // first boot.
    this.searchIndexEnabledValue = isFeatureEnabled(
      'command-palette',
      await store.settings.getSettings(),
    )
    await store.conversations.ensureFts(this.searchIndexEnabledValue)
    await store.seed()
  }

  /**
   * Create `workspaceId`'s provisioning row (`store/database.ts`), in the global
   * context. Idempotent: a provisioned workspace keeps its row.
   */
  async provisionWorkspace(workspaceId: WorkspaceId): Promise<void> {
    await this.queries.createOrJoinTransaction(async () => {
      await provisionWorkspaceFeed(this.queries.db).run({
        workspaceId,
        feedId: randomUUID(),
        epoch: randomUUID(),
        mintedAt: Date.now(),
      })
    })
  }

  /**
   * `workspaceId`'s store: its repositories over this database, made on the
   * first call and the same object on every later one. The first call runs the
   * workspace's boot steps (the settings snapshot, the identity refusals and
   * repairs, the global thread). It provisions nothing: a workspace is
   * provisioned by whoever creates it ({@link provisionWorkspace}).
   *
   * NO SQLITE SEARCH HERE, ON PURPOSE (POD-7022's note, decided in POD-7024). Only
   * the boot workspace opens the FTS5 index (`ensureFts` in the boot above).
   * FTS5 is the SQLite engine's search, and a SQLite database is a self-hosted
   * install with one workspace; a hosted workspace runs on Postgres, whose search
   * is the engine task's (POD-6958). A further workspace opened here on a SQLite
   * database searches with the LIKE fallback (`ftsAvailable` stays false), and
   * its rows are never keyed into, or taken from, the self-hosted workspace's
   * search keys (`store/conversations/transcript-index.ts`).
   */
  async workspace(workspaceId: WorkspaceId): Promise<SessionStore> {
    const open = this.workspaces.get(workspaceId)
    if (open !== undefined) return await open
    const opening = (async () => {
      const store = new SessionStore(this, workspaceId)
      try {
        await store.refuseAndRepair()
        await store.seed()
      } catch (error) {
        // A workspace nobody provisioned has no feed row, and a Postgres store refuses
        // its first transaction there (contract C4). Say that, not the statement it hit.
        if (causedByMissingFeedRow(error))
          throw new WorkspaceNotProvisionedError(workspaceId, error)
        throw error
      }
      return store
    })()
    this.workspaces.set(workspaceId, opening)
    // A workspace that failed to open is not kept: the next call tries again.
    opening.catch(() => {
      if (this.workspaces.get(workspaceId) === opening) this.workspaces.delete(workspaceId)
    })
    return await opening
  }

  /** The exact newest migration identity the transfer target will verify. */
  async schemaVersionForTransfer(): Promise<string> {
    return await this.lifecycle.schemaVersionForTransfer()
  }

  /** Force SQLite WAL contents into the portable database before a transfer snapshot. */
  async checkpointForTransfer(): Promise<void> {
    await this.lifecycle.checkpointForTransfer()
  }

  /**
   * Can this disk hold the pre-migration backup the successor takes at boot?
   *
   * THE OLD SERVER'S HALF OF THE ONE RECOVERY POINT (POD-6255). The update used
   * to stage its own `VACUUM INTO` copy here and prove it in a child process —
   * 50 to 160 seconds on a multi-gigabyte database, all of it shown as
   * "downloading" — only for the new server to copy the database again before
   * migrating. The boot backup (`backupDatabase`) is the recovery point now: it
   * is taken with no other writer, so a file copy is consistent and exact. What
   * the old server still owes is the early refusal: asking the same free-space
   * question here keeps a full disk from stopping the update AFTER the old
   * server has gone. A `stat` and a `statfs`; nothing is opened or written.
   */
  preflightUpdateBackup(): BackupPreflight {
    return this.lifecycle.preflightUpdateBackup()
  }

  /**
   * Newest VERIFIED recovery point, read from metadata and a `stat` only.
   *
   * Deliberately inert: this is called from update planning, which is a request
   * path, and reached even by a machine-only plan that will never take a
   * snapshot. It opens nothing, waits for nothing, writes nothing and STARTS
   * NOTHING — an earlier revision queued a background verifier from here, which
   * quietly reintroduced "planning an unrelated update spawns a disk scan".
   * `undefined` means nothing is proved right now, which is an honest answer.
   *
   * {@link discoverDatabaseSnapshots} is what changes that, at boot.
   */
  latestDatabaseSnapshot(): string | undefined {
    return this.lifecycle.latestDatabaseSnapshot()
  }

  /**
   * Boot/maintenance hook: reconcile the verification catalogue with the
   * snapshots actually on disk and queue at most one background verifier.
   *
   * This is the ONLY caller allowed to start a verifier without an operation
   * asking for one, and it is where 0.1.0 compatibility lives: an installation
   * upgrading into the verifier has retained `<db>.backup-v*` files and no
   * catalogue, and boot migrations stage snapshots without publishing records.
   * Returns whether a background verification was started.
   */
  discoverDatabaseSnapshots(): boolean {
    return this.lifecycle.discoverDatabaseSnapshots()
  }

  /** The installation's update signing key, read or (when `allowCreate`) minted. */
  async updateSigningKey(opts: { allowCreate: boolean }): Promise<UpdateSigningKey> {
    return await this.lifecycle.updateSigningKey(opts)
  }

  private transferFenceHeld = false

  /** Synchronous write guard for activity callbacks sharing this connection. */
  get transferFenceActive(): boolean {
    return this.transferFenceHeld
  }

  /** In-process fence only: mint-session remains a separate writer until E.5. */
  async beginTransferFence(): Promise<void> {
    await this.executor.exclusive(async (session) => {
      if (this.transferFenceHeld) throw new Error('transfer fence is already held')
      await this.lifecycle.setTransferFence(session, true)
      this.transferFenceHeld = true
    })
  }

  /** Reopen SQLite writes after a confirmed pre-promotion abort. */
  async endTransferFence(): Promise<void> {
    await this.executor.exclusive(async (session) => {
      if (!this.transferFenceHeld) return
      await this.lifecycle.setTransferFence(session, false)
      this.transferFenceHeld = false
    })
  }

  /** The change capture's installation, once started (POD-6920). */
  private changeLogAttached: Promise<void> | undefined

  /**
   * DERIVED CHANGE CAPTURE (POD-6920): from here every write of a row a
   * synced record reads is captured, and a transaction that does not drain
   * its capture into the log cannot commit. The boot does this for every
   * server store; a test store does it when its test wires a change log over
   * the store (`SessionRegistry.create`, `logStoreRecords`). Idempotent: a
   * second call waits for the first. The triggers are the database's, so this
   * covers every workspace.
   */
  async attachChangeLog(): Promise<void> {
    this.changeLogAttached ??= this.lifecycle.attachChangeCapture()
    await this.changeLogAttached
  }

  /** Apply retirement DDL only after the local import committed its receipt. */
  async retireImportedIdentityStorage(): Promise<void> {
    await this.lifecycle.retireImportedIdentityStorage()
  }

  /**
   * Run `fn` atomically as `context`'s transaction: a root transaction opened
   * with it, or a savepoint of the open one when `context` may join it
   * (`assertJoinable`). What {@link SessionStore.transact} runs on.
   */
  async transactFor<T>(context: StoreContext, fn: () => T | Promise<T>): Promise<T> {
    return await this.executor.transact(async () => fn(), context)
  }

  /** An external effect after the caller's commit: on the open span, or at once
   *  when none is open, retained, isolated and waited for by {@link close}
   *  either way [POD-6226]. */
  effect(step: () => void | Promise<void>, label: string): void {
    this.executor.effect(step, label)
  }

  /** Subscribe to publication idle; release explicitly or when this database closes. */
  onPublicationIdle(listener: () => void): () => void {
    const stop = this.executor.scheduler.onIdle(listener)
    const unsubscribe = () => {
      if (!this.publicationIdleSubscriptions.delete(unsubscribe)) return
      stop()
    }
    this.publicationIdleSubscriptions.add(unsubscribe)
    return unsubscribe
  }

  private plannerStatisticsTimer: ReturnType<typeof setInterval> | undefined

  /**
   * Refresh the planner's statistics on the exclusive lane (see
   * `refreshPlannerStatistics`). Refused from inside a transaction scope:
   * `exclusive()` throws there rather than run it inside the transaction.
   */
  async refreshPlannerStatistics(when: 'open' | 'periodic'): Promise<void> {
    await this.lifecycle.refreshPlannerStatistics(when)
  }

  /** Refresh the statistics every `intervalMs` until the database closes. Restarts a running timer. */
  startPlannerStatistics(intervalMs: number = PLANNER_STATISTICS_INTERVAL_MS): void {
    if (this.plannerStatisticsTimer !== undefined) clearInterval(this.plannerStatisticsTimer)
    this.plannerStatisticsTimer = setInterval(() => {
      this.refreshPlannerStatistics('periodic').catch((error: unknown) =>
        log.warn('planner statistics refresh failed', { err: error }),
      )
    }, intervalMs)
    this.plannerStatisticsTimer.unref?.()
  }

  /**
   * Close the database, and with it every workspace's store. The first call
   * closes; a later one (another workspace's store closing the same database)
   * waits for it.
   */
  async close(persist?: () => Promise<void>): Promise<void> {
    this.closing ??= this.closeOnce(persist)
    await this.closing
  }

  private async closeOnce(persist?: () => Promise<void>): Promise<void> {
    if (this.plannerStatisticsTimer !== undefined) clearInterval(this.plannerStatisticsTimer)
    this.plannerStatisticsTimer = undefined
    // Abort the detached verifier first, then await its child inside close so a
    // scan cannot outlive the database (rule 67). This is persist ordering, not
    // exclusive-lane membership — the proof never held exclusive.
    for (const unsubscribe of this.publicationIdleSubscriptions) unsubscribe()
    // Grouped event appends still waiting for their transaction are written,
    // not dropped with the connection (POD-6233), in every workspace.
    const opened = await Promise.allSettled(this.workspaces.values())
    for (const result of opened) {
      if (result.status === 'fulfilled') await result.value.events.settleGroupedAppends()
    }
    const verifierClosed = this.lifecycle.closeSnapshots()
    await this.executor.close(async () => {
      try {
        await persist?.()
      } finally {
        await verifierClosed
      }
    })
  }
}

/**
 * ONE WORKSPACE'S REPOSITORIES over a {@link StoreDatabase} [POD-6959 design
 * 2.4]. Made by `database.workspace(id)`; callers hold the aggregate repository
 * they need (`store.issues`, `store.sync`, …).
 *
 * Every repository here is handed this workspace's queries: a transaction it
 * opens is for this workspace, and joins only this workspace's work. Until a
 * repository's scoping task lands (POD-7015 to POD-7023) its statements still
 * run unbound on the legacy `rootDb` ({@link LegacyWorkspaceQueries}).
 *
 * The lifecycle methods below are the database's, forwarded so a caller holding
 * the store keeps working; on a self-hosted install there is one workspace, so
 * closing its store closes the database.
 */
export class SessionStore {
  /** The database these repositories run over. */
  readonly database: StoreDatabase
  /** The workspace every repository here is bound to. */
  readonly workspaceId: WorkspaceId
  /** The connection, for the tests that read rows under the repositories. */
  protected readonly db: SqlDatabase
  /** This workspace's queries; every repository below takes them. */
  private readonly queries: LegacyWorkspaceQueries
  /** The context of this workspace's transactions. */
  private readonly context: StoreContext
  readonly repos: ReposRepository
  /** Each machine's checkouts, as its scans reported them (POD-6644). */
  readonly checkouts: CheckoutsRepository
  readonly sessions: SessionsRepository
  /** Durable causal observer generations and accepted checkpoints [spec:SP-cdb2]. */
  readonly observationCheckpoints: ObservationCheckpointsRepository
  readonly issues: IssuesRepository
  readonly conversations: ConversationsRepository
  /** The workspace's change log, feed and kind generations: bound to this workspace. */
  readonly sync: SyncRepository
  readonly identityUpgrade: IdentityUpgradeRepository
  readonly superagent: SuperagentRepository
  readonly settings: SettingsRepository
  /** Sidebar/tab layout rows keyed `(user_id, key)` (POD-1350) — the shell chrome
   *  that follows a person across devices. Device-local route/selection/geometry
   *  stay in client ui-state. */
  readonly layout: UserLayoutRepository
  /** Server-owned dock-shell mapping keyed `(user_id, worktree_key)` (POD-4436) —
   *  which shell belongs to a worktree, so the same dock shell opens on every
   *  device. Device-local `podium.dockShells` remains as a cache; the server wins. */
  readonly dockShells: UserDockShellRepository
  /** Event-stream read positions keyed `(user_id, stream_id)` (POD-1380) — how far
   *  a person has read the issue-event log, on every device they use. */
  readonly readPositions: UserReadPositionRepository
  /**
   * Server-owned secrets (ADR 1 D6): this workspace's own (`workspace_secrets`),
   * and the install's (`server_secrets`, `meta`) through global definitions
   * (POD-7013).
   */
  readonly secrets: ServerSecretsRepository
  /** The settings family's append-only audit trail (POD-421, ADR 9 D5 A3) — who
   *  changed which setting, and who was refused. Server-only and projected into
   *  nothing; see `store/settings-audit.ts` for why that is load-bearing. */
  readonly settingsAudit: SettingsAuditRepository
  /** Managed LLM credentials [spec:SP-6454] — server-held, injected at spawn.
   *  Deliberately NOT in the settings blob, which round-trips to the browser. */
  readonly accounts: AccountsRepository
  readonly machines: MachinesRepository
  /** The `(entityRef, granteeUserId, verb)` grant edges (POD-1079, ADR 9 D2) —
   *  read live at every access decision, never cached into a rights snapshot. */
  readonly grants: GrantsRepository
  /** User accounts (POD-1075's table, POD-1079's first reader) — the instance
   *  role a command contract's `roleFloor` is compared against. */
  readonly users: UsersRepository
  /** Old sign-ins from before shared sign-in, and their carry records (POD-6751). */
  readonly signInCarryOver: SignInCarryOverRepository
  /** `(chatId -> UserId)` bindings (POD-1080, ADR 3 Amendment 1 D22) — the ONLY
   *  thing an inbound Telegram message may be resolved against. An unbound chat
   *  gets no principal and is refused; it never falls back to an operator. */
  readonly telegramBindings: TelegramBindingsRepository
  readonly events: EventsRepository
  /** Cross-producer notification deduplication [spec:SP-ba61]. */
  readonly notificationFacts: NotificationFactsRepository
  /** One row per run of a plan quota window (POD-1571) — the only place Podium
   *  keeps a quota number after the live read that produced it goes stale. */
  readonly quotaHistory: QuotaHistoryRepository
  /** One row per transcript the usage harvest has read (POD-1858) — what a task
   *  cost, after the harvest's 7-day window has rolled past the work. */
  readonly transcriptCosts: TranscriptCostsRepository
  /** Unified agent messaging (#237) [spec:SP-34d7]. */
  readonly messages: MessagesRepository
  /** Recap watermarks (#237) [spec:SP-34d7 read-toolkit tier 3]. */
  readonly readWatermarks: ReadWatermarksRepository
  /** Blocking asks (POD-2020, spec §4) — durable so a stuck session is enumerable. */
  readonly interactions: InteractionsRepository
  readonly workflows: WorkflowsRepository
  readonly agentProfiles: AgentProfilesRepository
  /** Advisory named lease locks [spec:SP-85d1] — podium lock / merge-lock. */
  readonly locks: LocksRepository
  /** CLI bundle uploads in progress (POD-6963 design 2.4): their state; the bytes are blobs. */
  readonly artifactUploads: ArtifactUploadsRepository
  /** Files picked in a composer (POD-6963 design 2.5): their records; the bytes are blobs. */
  readonly pendingUploads: PendingUploadsRepository
  /**
   * Janitor generation fencing + deterministic command outcomes [spec:SP-c29e].
   * A workspace repository: its command ledger (`maintenance_commands`) is
   * workspace data, and the install-wide lease (`maintenance_leases`) is an
   * install table a workspace transaction may write.
   */
  readonly maintenance: MaintenanceRepository
  /**
   * The facts the janitor observes (POD-6993). The janitor's worker builds its
   * own over a read session per scan (`janitor-database.ts`); the store's set
   * holds one so the server reads the same facts the janitor does, and the
   * query audits plan its definitions with every other repository's.
   */
  readonly janitorReads: JanitorReadsRepository
  /** Scheduled automations + their run history (#470) [spec:SP-17db]. */
  readonly automations: AutomationsRepository
  /** One-shot effects as data (ADR 12 D5 E2, POD-6357). */
  readonly effects: EffectsRepository
  /** Normalized, restart-safe Shipping aggregate family. */
  readonly shipping: ShippingRepository
  /** Durable long-running operations (POD-2097) — updates now, server moves later. */
  readonly updateRecovery: UpdateRecoveryStore
  readonly operations: OperationStore
  /** Telegram forum-topic ↔ issue thread bindings [spec:SP-5d81]. */
  readonly messagingTopics: MessagingTopicsRepository
  /** Telegram conversation ↔ directly attached session (POD-6212). */
  readonly messagingSessionAttachments: MessagingSessionAttachmentsRepository

  /**
   * Open a database and return its boot workspace's store: the one-call form
   * for a single-workspace process (a script, a test, a tool). The workspace is
   * `options.workspace`, or the self-hosted install's when absent. The server
   * composition opens the {@link StoreDatabase} itself (`server.ts`).
   */
  static async open(
    path: string = defaultDbPath(),
    hostMachineId: MachineId = asMachineId(randomUUID()),
    options: Omit<StoreDatabaseOptions, 'bootWorkspace'> & { workspace?: WorkspaceId } = {},
    watchdog?: WatchdogOptions,
  ): Promise<SessionStore> {
    const { workspace = SELF_HOSTED_WORKSPACE_ID, ...rest } = options
    const database = await StoreDatabase.open(
      path,
      hostMachineId,
      { ...rest, bootWorkspace: workspace },
      watchdog,
    )
    return await database.workspace(workspace)
  }

  /** Made by {@link StoreDatabase.workspace} only. */
  constructor(database: StoreDatabase, workspaceId: WorkspaceId) {
    this.database = database
    this.workspaceId = workspaceId
    this.db = database.db
    // ONE OBJECT PER WORKSPACE: a workspace definition's bound view is cached
    // per handle, so the handle is made once here, never per call.
    this.queries = legacyWorkspaceQueries(database.queries, workspaceId)
    this.context = workspaceContext(workspaceId)
    this.secrets = new ServerSecretsRepository(this.queries)

    // Compose the per-aggregate repositories. The three cross-aggregate edges are
    // injected as late-bound lambdas, bound WITHIN the set being built: sessions
    // purge observation checkpoints, issues resolve their stable repo_id via the
    // repos aggregate, and a repo-identity upgrade dual-writes onto issues.
    this.observationCheckpoints = new ObservationCheckpointsRepository(this.queries)
    this.sessions = new SessionsRepository(
      this.queries,
      async (id) => await this.observationCheckpoints.purge(id),
    )
    this.issues = new IssuesRepository(
      this.queries,
      async (repoPath, machineId) => await this.repos.resolveIssueRepoId(repoPath, machineId),
    )
    this.repos = new ReposRepository(
      this.queries,
      async (repoId, repoPath) => await this.issues.assignRepoIdToIssuesUnder(repoId, repoPath),
      database.tableWrites,
    )
    this.checkouts = new CheckoutsRepository(this.queries)
    this.interactions = new InteractionsRepository(this.queries)
    this.conversations = new ConversationsRepository(this.queries)
    // `SyncRepository` lives in `@podium/sync` and cannot import this seam, so it
    // takes the narrow port the PACKAGE declares and `this.queries` satisfies
    // structurally (POD-3338, spec §6 rule 20). It is bound to this workspace:
    // its feed, change log and kind generations are this workspace's.
    this.sync = new SyncRepository(this.queries, syncServerTables, workspaceId)
    this.identityUpgrade = new IdentityUpgradeRepository(this.queries, {
      legacyStorage: database.legacyIdentityStorage,
    })
    this.superagent = new SuperagentRepository(this.queries)
    this.settings = new SettingsRepository(this.queries)
    this.layout = new UserLayoutRepository(this.queries)
    this.dockShells = new UserDockShellRepository(this.queries)
    this.readPositions = new UserReadPositionRepository(this.queries)
    this.settingsAudit = new SettingsAuditRepository(this.queries)
    this.accounts = new AccountsRepository(this.queries)
    this.grants = new GrantsRepository(this.queries)
    this.machines = new MachinesRepository(
      this.queries,
      this.grants,
      this.grants.machineRecordWrites,
    )
    this.signInCarryOver = new SignInCarryOverRepository(this.queries)
    this.users = new UsersRepository(this.queries, this.machines, this.grants, this.signInCarryOver)
    this.users.setMemberCreated(
      async (userId) => await this.superagent.seedMemberGlobalThread(userId),
    )
    this.telegramBindings = new TelegramBindingsRepository(this.queries)
    this.events = new EventsRepository(this.queries)
    this.notificationFacts = new NotificationFactsRepository(this.queries)
    this.quotaHistory = new QuotaHistoryRepository(this.queries)
    this.transcriptCosts = new TranscriptCostsRepository(this.queries)
    this.messages = new MessagesRepository(this.queries)
    this.readWatermarks = new ReadWatermarksRepository(this.queries)
    this.workflows = new WorkflowsRepository(this.queries)
    this.agentProfiles = new AgentProfilesRepository(this.queries)
    this.locks = new LocksRepository(this.queries)
    this.artifactUploads = new ArtifactUploadsRepository(this.queries)
    this.pendingUploads = new PendingUploadsRepository(this.queries)
    this.maintenance = new MaintenanceRepository(this.queries)
    this.janitorReads = new JanitorReadsRepository(this.queries)
    this.automations = new AutomationsRepository(this.queries)
    this.effects = new EffectsRepository(this.queries)
    this.shipping = new ShippingRepository(this.queries)
    this.updateRecovery = new UpdateRecoveryStore(this.queries, this.grants.machineRecordWrites)
    this.operations = new OperationStore(this.queries)
    this.messagingTopics = new MessagingTopicsRepository(this.queries)
    this.messagingSessionAttachments = new MessagingSessionAttachmentsRepository(this.queries)
  }

  /**
   * The workspace's first boot steps, ahead of every reader of its rows: the
   * settings snapshot, then the identity refusals and the remaining data heals
   * — never schema DDL.
   *
   * THE IDENTITY REFUSALS RUN FIRST, ahead of every reader in the process. The
   * one-time rewrites they replaced ran here for a reason that outlived them
   * (POD-318): it is not just that nothing may WRITE a pre-upgrade row, nothing
   * may READ one either. `SessionRegistry` loads the sessions map in its
   * constructor, before the composition root can call `ensureHostMachine`. A
   * check that ran there would let live Session objects be built on rows the
   * process is about to declare unservable.
   *
   * #140 defense in depth (ported from main's boot migrate): renumber any
   * (repo_id, seq) collisions left by a pre-UNIQUE-index database. Idempotent --
   * no-ops once the DB is clean; runs AFTER the backfill so rows have repo_ids.
   * POD-1926: references left behind by a hard purge of an empty draft. Neither
   * `sessions.issue_id` nor `issue_ref_letters.issue_id` declares a foreign key,
   * so before the purge learned to scrub them a deleted draft left a session row
   * (and a letter counter) naming an issue that no longer exists. Runs HERE, at
   * the workspace's first open, for the same reason the identity refusals do:
   * ahead of every reader, so no in-memory `Session` can be holding the stale
   * pointer when it is cleared.
   */
  async refuseAndRepair(): Promise<void> {
    await this.settings.initializeSnapshot()
    await this.refuseLegacyIdentities()
    await this.backfillLegacyWorktreeMachines()
  }

  /**
   * The workspace's seeded rows: its global superagent thread. UNIQUE(repo_id,
   * seq) is installed by the schema migrations. Historical dangling references
   * are repaired once by sync-without-boot-reconcile, which also invalidates
   * their synced records with generation changes.
   */
  async seed(): Promise<void> {
    await this.superagent.seedGlobalThread()
  }

  /** Run-once historical migration; no receipt until the host is enrolled. */
  private async backfillLegacyWorktreeMachines(): Promise<void> {
    const result = await this.issues.backfillLegacyWorktreeMachineIds(this.hostMachineId)
    if (result && (result.backfilled > 0 || result.skipped > 0)) {
      log.warn(
        `pinned ${result.backfilled} legacy worktree issue(s) to ${result.hostMachineId}; ` +
          `left ${result.skipped} for manual recovery (a session on another machine contradicts this host)`,
      )
    }
  }

  /**
   * THE TWO IDENTITY REFUSALS THIS DATABASE MUST PASS BEFORE ANYTHING READS IT.
   *
   * Both are the residue halves of one-time boot upgrades that were retired once
   * their deletion horizon passed (POD-3246). The rewrites are gone; the reads
   * that told them whether they had worked are not, because what they answer is
   * not "did the rewrite run" but "is this database servable at all".
   *
   *   - A RETIRED MACHINE SENTINEL (POD-318) means rows naming a machine that
   *     does not exist while the fleet answers to a minted UUID. Serving that is
   *     how the placeholder era stranded people's sessions.
   *   - A MISSING repo_id (POD-1360) means issues that belong to no repo, since
   *     `repo_id` is what they are bucketed and numbered by.
   *
   * Both refuse the boot rather than warning, and both name what they found, so
   * an operator gets a database to restore instead of a week of wrong answers.
   * A MISSING PREFIX only warns, on the same grading as before: it costs a repo
   * its human-facing refs until the next `addRepo` repairs it, and refusing to
   * boot over it would trade a cosmetic defect for an outage.
   */
  private async refuseLegacyIdentities(): Promise<void> {
    const sentinels = await this.machines.legacyMachineSentinelSites()
    if (sentinels.length > 0) {
      throw new Error(
        `retired machine sentinels (${RETIRED_MACHINE_SENTINELS.join(', ')}) are still stored ` +
          `in ${sentinels.join(', ')} — this database predates POD-318 and no shipped ` +
          'Podium can serve it; restore a backup taken after the upgrade',
      )
    }
    const { repoIdsMissing, prefixesMissing } = await this.repos.legacyRepoResidue()
    const issuesMissing = await this.issues.issuesMissingRepoId()
    if (repoIdsMissing > 0 || issuesMissing > 0) {
      throw new Error(
        `legacy repo identity is unfilled (repos: ${repoIdsMissing}, issues: ${issuesMissing}) — ` +
          'this database predates POD-1360 and no shipped Podium can serve it; refusing to ' +
          'serve rows that belong to no repo',
      )
    }
    if (prefixesMissing > 0) {
      log.warn(
        `${prefixesMissing} repo(s) have no human-facing prefix; refs for them ` +
          'resolve once the repo is re-registered',
      )
    }
  }

  /**
   * The id of the machine this store's rows are written on — `<stateDir>/machine.id`,
   * read by the composition root and handed down (`readOrCreateLocalMachineId`).
   *
   * It is an OPEN ARGUMENT rather than a file read here because the store must
   * not decide who it is: the server, the split daemon and the CLI all read the same
   * file, and a second reader is a second opinion waiting to happen.
   *
   * The default MINTS one instead of falling back to a constant. An unconfigured
   * store — a test fixture, a script — is genuinely a fresh host with no prior rows,
   * and saying so with a real UUID keeps the "an id is minted material or nothing"
   * rule true everywhere. The old `'__local__'` default said the opposite: that
   * unattributed rows are a legitimate durable state.
   */
  get hostMachineId(): MachineId {
    return this.database.hostMachineId
  }

  /** The database's per-table write announcement ({@link StoreDatabase.tableWrites}). */
  get tableWrites(): TableWrites {
    return this.database.tableWrites
  }

  /** See {@link StoreDatabase.searchIndexEnabled}. */
  get searchIndexEnabled(): boolean {
    return this.database.searchIndexEnabled
  }

  /** Run `fn` atomically on the shared connection (nesting-safe: BEGIN at depth
   *  0, SAVEPOINT inside an open transaction), as THIS WORKSPACE's transaction.
   *  Narrow seam for cross-aggregate atomic writes — the write-seam Ledger binds
   *  an entity write and its change append into one span ([spec:SP-3fe2] #255) —
   *  without exposing the db handle.
   *
   *  The executor owns the transaction scope and drains registered post-commit
   *  work after the outermost commit. Nested registrations are discarded on
   *  rollback or merged into the parent on savepoint release. Opened inside
   *  another workspace's transaction it is refused. */
  async transact<T>(fn: () => T | Promise<T>): Promise<T> {
    return await this.database.transactFor(this.context, fn)
  }

  /**
   * The database port of the identity package (people and sign-in
   * specification, section 2.2): the store's one drizzle instance and this
   * workspace's transaction runner. Library statements, the package's statements
   * and the server's own repository writes therefore join one transaction of
   * this workspace and roll back together.
   */
  identityDatabase(): IdentityDatabase {
    const { rootDb, createOrJoinTransaction } = this.queries
    // The drizzle instance is the engine's own (POD-6979): the package writes each
    // statement for both dialects and picks by the one named here.
    if (dialectOf(rootDb) === 'pg') {
      const db = rootDb as unknown as PgDb
      return {
        dialect: 'pg',
        db,
        transaction: (fn) => createOrJoinTransaction(async () => await fn(db)),
      }
    }
    const db = rootDb as unknown as SqliteDb
    return {
      dialect: 'sqlite',
      db,
      transaction: (fn) => createOrJoinTransaction(async () => await fn(db)),
    }
  }

  // ---- the database's lifecycle, forwarded (see the class comment) ----

  async schemaVersionForTransfer(): Promise<string> {
    return await this.database.schemaVersionForTransfer()
  }

  async checkpointForTransfer(): Promise<void> {
    await this.database.checkpointForTransfer()
  }

  preflightUpdateBackup(): BackupPreflight {
    return this.database.preflightUpdateBackup()
  }

  latestDatabaseSnapshot(): string | undefined {
    return this.database.latestDatabaseSnapshot()
  }

  discoverDatabaseSnapshots(): boolean {
    return this.database.discoverDatabaseSnapshots()
  }

  get transferFenceActive(): boolean {
    return this.database.transferFenceActive
  }

  async beginTransferFence(): Promise<void> {
    await this.database.beginTransferFence()
  }

  async endTransferFence(): Promise<void> {
    await this.database.endTransferFence()
  }

  async attachChangeLog(): Promise<void> {
    await this.database.attachChangeLog()
  }

  async retireImportedIdentityStorage(): Promise<void> {
    await this.database.retireImportedIdentityStorage()
  }

  effect(step: () => void | Promise<void>, label: string): void {
    this.database.effect(step, label)
  }

  onPublicationIdle(listener: () => void): () => void {
    return this.database.onPublicationIdle(listener)
  }

  async refreshPlannerStatistics(when: 'open' | 'periodic'): Promise<void> {
    await this.database.refreshPlannerStatistics(when)
  }

  startPlannerStatistics(intervalMs?: number): void {
    this.database.startPlannerStatistics(intervalMs)
  }

  /** Close the database (and with it every workspace's store over it). */
  async close(persist?: () => Promise<void>): Promise<void> {
    await this.database.close(persist)
  }
}
