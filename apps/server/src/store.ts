/**
 * Durable server-side store. Single writer (the server).
 *
 * SessionStore is the store's COMPOSITION ROOT, nothing more: it opens the
 * database, runs the versioned migration chain (src/migrations/), sequences the
 * per-boot identity refusals and idempotent heals, and constructs the
 * per-aggregate repositories in `./store/` — including the two cross-aggregate
 * late-bound lambdas (issues resolve their stable repo_id via the repos
 * aggregate; re-identifying a repo dual-writes onto its issues). Callers hold
 * the aggregate repository they need
 * (`store.issues`, `store.sync`, …) — there are no forwarding methods here.
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
 *  - auth (client_sessions)                              → store/auth.ts
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
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createLogger } from '@podium/logger'
import { asMachineId, type MachineId } from '@podium/model'
import { stateDir } from '@podium/runtime/config'
import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { SyncRepository } from '@podium/sync'
import { isFeatureEnabled } from './features'
import { backupDatabase } from './migrations/backup'
import { latestAppliedMigration } from './migrations/index'
import {
  checkpointStore,
  configureStoreConnection,
  migrateStoreConnection,
  setStoreTransferFence,
} from './migrations/store-lifecycle'
import {
  type SnapshotVerification,
  SnapshotVerifier,
  type SnapshotVerifierDeps,
} from './migrations/snapshot-verifier'
import { syncServerTables } from './migrations/sync-server-tables'
import { OperationStore } from './modules/operations/store'
import { AccountsRepository } from './store/accounts'
import { ApprovalsRepository } from './store/approvals'
import { AuthRepository } from './store/auth'
import { AutomationsRepository } from './store/automations'
import { ConversationsRepository } from './store/conversations'
import { EventsRepository } from './store/events'
import {
  createBunStoreExecutor,
  type QueryClient,
  type RootStoreExecutor,
  type WatchdogOptions,
} from './store/executor'
import { GrantsRepository } from './store/grants'
import { InteractionsRepository } from './store/interactions'
import { IssuesRepository } from './store/issues'
import { LocksRepository } from './store/locks'
import { MachinesRepository, RETIRED_MACHINE_SENTINELS } from './store/machines'
import { MaintenanceRepository } from './store/maintenance'
import { MessagesRepository } from './store/messages'
import { MessagingTopicsRepository } from './store/messaging-topics'
import { NotificationFactsRepository } from './store/notification-facts'
import { ObservationCheckpointsRepository } from './store/observation-checkpoints'
import { QuotaHistoryRepository } from './store/quota-history'
import { ReadWatermarksRepository } from './store/read-watermarks'
import { normalizeRepoPath, ReposRepository } from './store/repos'
import { ServerSecretsRepository } from './store/server-secrets'
import { SessionsRepository } from './store/sessions'
import { SettingsRepository } from './store/settings'
import { SettingsAuditRepository } from './store/settings-audit'
import { ShippingRepository } from './store/shipping'
import { SuperagentRepository } from './store/superagent'
import { TableWrites } from './store/table-writes'
import { TelegramBindingsRepository } from './store/telegram-bindings'
import { TranscriptCostsRepository } from './store/transcript-costs'
import { UserLayoutRepository } from './store/user-layout'
import { UserReadPositionRepository } from './store/user-read-position'
import { UsersRepository } from './store/users'
import { WorkflowsRepository } from './store/workflows'
import { openStoreDatabase } from './store-database'

const log = createLogger('server:store')

export type { MessagePrincipalRef } from './store/messages'
export * from './store/types'
export { normalizeRepoPath }

/** Default DB file: podium.db below the selected instance state root. */
export function defaultDbPath(): string {
  return join(stateDir(), 'podium.db')
}

export class SessionStore {
  private readonly db: SqlDatabase
  /**
   * WHAT THE REPOSITORY SET IS BOUND TO [POD-3254, spec §3.1].
   *
   * Every repository below takes this object rather than the connection, so that
   * converting one to the query layer is a change to that repository's own file
   * and to nothing here — which is the whole reason this edit is made once, up
   * front, instead of thirty-eight times during the conversion waves.
   *
   * An unconverted repository reads `executor.legacy`, the same connection this
   * store opened; POD-3267 deletes that field at the end of Stage A, and the
   * compiler then names anything still on it. Lifecycle operations and close
   * now use the same scheduler as repository work.
   */
  private readonly executor: RootStoreExecutor<QueryClient>
  /** The synchronous query capability, handed to converted repositories. */
  private readonly queries: RootStoreExecutor<QueryClient>['queries']
  /**
   * The store's per-table write announcement (POD-3247).
   *
   * Raised by write paths that do not go through the repository owning a cached
   * read of that table. It has NO caller in the tree today: the one it was built
   * for — the boot machine-identity upgrade, which wrote `repos` on the raw handle
   * with SQL built from `sqlite_master` — was retired at POD-3246. The writer went;
   * the shape did not. Every statement the async query layer runs through an
   * executor is one, and a repository holding a cached read subscribes here rather
   * than being named by each writer in turn. See `store/table-writes.ts`.
   */
  readonly tableWrites = new TableWrites()
  /** Worker-backed recovery-snapshot proofs (POD-3068) — see `migrations/snapshot-verifier.ts`. */
  private readonly snapshotVerifier: SnapshotVerifier
  readonly repos: ReposRepository
  readonly sessions: SessionsRepository
  /** Durable causal observer generations and accepted checkpoints [spec:SP-cdb2]. */
  readonly observationCheckpoints: ObservationCheckpointsRepository
  readonly issues: IssuesRepository
  readonly conversations: ConversationsRepository
  readonly sync: SyncRepository
  readonly auth: AuthRepository
  readonly superagent: SuperagentRepository
  readonly settings: SettingsRepository
  /** Sidebar/tab layout rows keyed `(user_id, key)` (POD-1350) — the shell chrome
   *  that follows a person across devices. Device-local route/selection/geometry
   *  stay in client ui-state. */
  readonly layout: UserLayoutRepository
  /** Event-stream read positions keyed `(user_id, stream_id)` (POD-1380) — how far
   *  a person has read the issue-event log, on every device they use. */
  readonly readPositions: UserReadPositionRepository
  /** Server-owned secrets (ADR 1 D6) — the keyed store POD-419 lifted them into,
   *  out of the settings blob that round-trips to the browser. Same reasoning as
   *  `accounts` below, now applied to the material that was left behind. */
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
  readonly approvals: ApprovalsRepository
  /** Blocking asks (POD-2020, spec §4) — durable so a stuck session is enumerable. */
  readonly interactions: InteractionsRepository
  readonly workflows: WorkflowsRepository
  /** Advisory named lease locks [spec:SP-85d1] — podium lock / merge-lock. */
  readonly locks: LocksRepository
  /** Janitor generation fencing + deterministic command outcomes [spec:SP-c29e]. */
  readonly maintenance: MaintenanceRepository
  /** Scheduled automations + their run history (#470) [spec:SP-17db]. */
  readonly automations: AutomationsRepository
  /** Normalized, restart-safe Shipping aggregate family. */
  readonly shipping: ShippingRepository
  /** Durable long-running operations (POD-2097) — updates now, server moves later. */
  readonly operations: OperationStore
  /** Telegram forum-topic ↔ issue thread bindings [spec:SP-5d81]. */
  readonly messagingTopics: MessagingTopicsRepository

  /**
   * The id of the machine this store's rows are written on — `<stateDir>/machine.id`,
   * read by the composition root and handed down (`readOrCreateLocalMachineId`).
   *
   * It is a CONSTRUCTOR ARGUMENT rather than a file read here because the store must
   * not decide who it is: the server, the split daemon and the CLI all read the same
   * file, and a second reader is a second opinion waiting to happen.
   *
   * The default MINTS one instead of falling back to a constant. An unconfigured
   * store — a test fixture, a script — is genuinely a fresh host with no prior rows,
   * and saying so with a real UUID keeps the "an id is minted material or nothing"
   * rule true everywhere. The old `'__local__'` default said the opposite: that
   * unattributed rows are a legitimate durable state.
   */
  readonly hostMachineId: MachineId

  /**
   * Whether this boot has a full-text search index — the resolved
   * `command-palette` flag (PDM-25). Readers that must NOT offer a search the
   * index cannot back (the superagent's `search_conversations`/`search_all`)
   * ask this rather than re-resolving the flag, so they can never disagree with
   * what the constructor actually built.
   */
  private searchIndexEnabledValue = false

  get searchIndexEnabled(): boolean {
    return this.searchIndexEnabledValue
  }

  static async open(
    path: string = defaultDbPath(),
    hostMachineId: MachineId = asMachineId(randomUUID()),
    snapshotVerifierDeps: SnapshotVerifierDeps = {},
    watchdog: WatchdogOptions = {
      report: (report) => log.warn('transaction lease exceeded idle budget', { ...report }),
      onReportFailure: (error) =>
        log.error('transaction watchdog sink failed', { error: String(error) }),
    },
  ): Promise<SessionStore> {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    let database = await openStoreDatabase(path)
    let executor = createBunStoreExecutor({
      database,
      startOpen: true,
      watchdog,
      effectSink: (error, label) =>
        log.error('shutdown or post-commit effect failed', { label, error: String(error) }),
    })
    try {
      const applied = await executor.exclusive(async () => migrateStoreConnection(database, path))
      if (applied.length > 0) log.info('applied migrations', { applied })
      if (path !== ':memory:') {
        // Migration owns its connection, including the OFF/ON bracket. Runtime
        // begins on a fresh connection with enforcement enabled. An in-memory
        // database transfers the migrated handle: reopening would lose it.
        await executor.close()
        database = openDatabase(path)
        executor = createBunStoreExecutor({
          database,
          startOpen: true,
          watchdog,
          effectSink: (error, label) =>
            log.error('shutdown or post-commit effect failed', { label, error: String(error) }),
        })
        await executor.exclusive(async () => configureStoreConnection(database))
      }
      const store = new SessionStore(path, hostMachineId, snapshotVerifierDeps, database, executor)
      await store.initialize()
      return store
    } catch (error) {
      await executor.close()
      throw error
    }
  }

  private constructor(
    private readonly path: string,
    hostMachineId: MachineId,
    snapshotVerifierDeps: SnapshotVerifierDeps,
    database: SqlDatabase,
    executor: RootStoreExecutor<QueryClient>,
  ) {
    // The value crosses into its id space HERE, once: it arrives as the bytes of a
    // state-dir file (or a fresh mint) and leaves as the machine identity every row,
    // route and grant in this process is keyed by.
    this.hostMachineId = asMachineId(hostMachineId)
    this.snapshotVerifier = new SnapshotVerifier(path, snapshotVerifierDeps)
    this.db = database
    this.executor = executor

    /**
     * The synchronous query capability, resolved ONCE here [spec rule 27b]. A
     * converted repository takes THIS OBJECT in the constructor slot its
     * `SqlDatabase` occupied — `{ rootDb, createOrJoinTransaction }` together,
     * because they are one
     * capability — so it carries no branch for a case its own constructor cannot
     * produce and no repository names the executor at all.
     *
     * B1 fills this same field from the ASYNCHRONOUS pair. The construction sites
     * below do not change and the repositories' query bodies do not change; only
     * their signatures gain `async` and their calls gain `await`.
     *
     * Absent only on a non-bun handle. Every path that builds a SessionStore is
     * bun-backed; the restore path builds its own executor and does not come here.
     */
    this.queries = this.executor.queries

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
      async (repoPath) => await this.repos.resolveRepoIdForPath(repoPath),
    )
    this.repos = new ReposRepository(
      this.queries,
      async (repoId, repoPath) => await this.issues.assignRepoIdToIssuesUnder(repoId, repoPath),
      this.hostMachineId,
      this.tableWrites,
    )
    this.approvals = new ApprovalsRepository(this.queries)
    this.interactions = new InteractionsRepository(this.queries)
    this.conversations = new ConversationsRepository(this.queries, this.hostMachineId)
    // `SyncRepository` lives in `@podium/sync` and cannot import this seam, so it
    // takes the narrow port the PACKAGE declares and `this.queries` satisfies
    // structurally — `StoreQueries`, the same inversion `syncServerTables` uses one
    // line's worth of reasoning away (POD-3338, spec §6 rule 20). Converted at
    // POD-3416, so the argument is the same capability object every line above
    // and below passes; the seam's undefined-check is the one asserted above,
    // once, for the whole set (spec §6 rule 27b).
    this.sync = new SyncRepository(this.queries, syncServerTables)
    this.auth = new AuthRepository(this.queries)
    this.superagent = new SuperagentRepository(this.queries)
    this.settings = new SettingsRepository(this.queries)
    this.layout = new UserLayoutRepository(this.queries)
    this.readPositions = new UserReadPositionRepository(this.queries)
    this.secrets = new ServerSecretsRepository(this.queries)
    this.settingsAudit = new SettingsAuditRepository(this.queries)
    this.accounts = new AccountsRepository(this.queries)
    this.machines = new MachinesRepository(this.queries)
    this.grants = new GrantsRepository(this.queries)
    this.users = new UsersRepository(this.queries)
    this.telegramBindings = new TelegramBindingsRepository(this.queries)
    this.events = new EventsRepository(this.queries)
    this.notificationFacts = new NotificationFactsRepository(this.queries)
    this.quotaHistory = new QuotaHistoryRepository(this.queries)
    this.transcriptCosts = new TranscriptCostsRepository(this.queries)
    this.messages = new MessagesRepository(this.queries)
    this.readWatermarks = new ReadWatermarksRepository(this.queries)
    this.workflows = new WorkflowsRepository(this.queries)
    this.locks = new LocksRepository(this.queries)
    this.maintenance = new MaintenanceRepository(this.queries)
    this.automations = new AutomationsRepository(this.queries)
    this.shipping = new ShippingRepository(this.queries)
    this.operations = new OperationStore(this.queries)
    this.messagingTopics = new MessagingTopicsRepository(this.queries)
  }

  private async initialize(): Promise<void> {
    // Per-boot runtime steps (environment-conditional FTS objects, the identity
    // refusals and the remaining data heals) — never schema DDL.
    //
    // THE IDENTITY REFUSALS RUN FIRST, ahead of every reader in the process. The
    // one-time rewrites they replaced ran here for a reason that outlived them
    // (POD-318): it is not just that nothing may WRITE a pre-upgrade row, nothing
    // may READ one either. `SessionRegistry` loads the sessions map in its
    // constructor, before the composition root can call `ensureHostMachine`. A
    // check that ran there would let live Session objects be built on rows the
    // process is about to declare unservable.
    // Search is one switch (PDM-25): the `command-palette` flag that shows Cmd+K
    // also decides whether this boot carries a full-text index at all. Read ONCE,
    // here — flipping the toggle takes effect at the next boot, so nothing has to
    // rebuild an index underneath a running process. `settings` is constructed
    // above, so a config-forced value is honoured on the very first boot.
    // #140 defense in depth (ported from main's boot migrate): renumber any
    // (repo_id, seq) collisions left by a pre-UNIQUE-index database. Idempotent --
    // no-ops once the DB is clean; runs AFTER the backfill so rows have repo_ids.
    // POD-1926: references left behind by a hard purge of an empty draft. Neither
    // `sessions.issue_id` nor `issue_ref_letters.issue_id` declares a foreign key,
    // so before the purge learned to scrub them a deleted draft left a session row
    // (and a letter counter) naming an issue that no longer exists. Runs HERE, in
    // the facade constructor, for the same reason the identity refusals do:
    // ahead of every reader, so no in-memory `Session` can be holding the stale
    // pointer when it is cleared.
    await this.refuseLegacyIdentities()
    await this.backfillLegacyWorktreeMachines()
    this.searchIndexEnabledValue = isFeatureEnabled(
      'command-palette',
      await this.settings.getSettings(),
    )
    await this.conversations.ensureFts(this.searchIndexEnabledValue)
    await this.superagent.seedGlobalThread()
    await this.issues.renumberCollidingIssueSeqs()
    await this.healDanglingIssueReferences()
  }

  /**
   * THE ONE-TIME BOOT UPGRADE POD-3246 COULD NOT RETIRE (POD-3359).
   *
   * The other three went because every database had already crossed the build
   * that carried them. This one had not. It shipped on 2026-08-23 (3416b5cec),
   * three days after the only stable release v0.1.0 (79c588880, 2026-08-20), and
   * no stable tag contains it — `git tag --contains` names only `dev` and the two
   * `v0.1.1-edge` builds. The operator's minimum supported upgrade version is
   * v0.1.0, so a database may arrive here having never run it, and the drizzle
   * adoption build is inside v0.1.0, so nothing upstream refuses that database
   * first.
   *
   * It runs AFTER `refuseLegacyIdentities` deliberately: that refusal is what now
   * guarantees the precondition the deleted version got from the legacy-machine
   * rewrite it used to follow — a database still holding a retired sentinel never
   * reaches this line, so no stored id can be misread as a remote machine.
   *
   * Idempotent: it only ever writes rows whose `machine_id` is NULL, so a second
   * boot moves nothing.
   */
  private async backfillLegacyWorktreeMachines(): Promise<void> {
    const { backfilled, skipped } = await this.issues.backfillLegacyWorktreeMachineIds(
      this.hostMachineId,
    )
    if (backfilled > 0 || skipped > 0) {
      console.warn(
        `[podium:store] pinned ${backfilled} legacy worktree issue(s) to ${this.hostMachineId}; ` +
          `left ${skipped} for manual recovery (a session on another machine contradicts this host)`,
      )
    }
  }

  /** Per-boot heal (idempotent): clear session pointers and letter counters whose
   *  issue was hard-purged. Reports only when it actually found something. */
  private async healDanglingIssueReferences(): Promise<void> {
    const sessions = await this.sessions.detachDanglingIssueReferences()
    const letters = await this.issues.pruneOrphanRefLetters()
    if (sessions > 0 || letters > 0) {
      console.warn(
        `[podium:store] boot heal detached ${sessions} session(s) and dropped ` +
          `${letters} ref-letter counter(s) pointing at deleted issues`,
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
      console.warn(
        `[podium:store] ${prefixesMissing} repo(s) have no human-facing prefix; refs for them ` +
          'resolve once the repo is re-registered',
      )
    }
  }

  /** The exact newest migration identity the transfer target will verify. */
  async schemaVersionForTransfer(): Promise<string> {
    return await this.executor.exclusive(async () => {
      const name = latestAppliedMigration(this.db)
      if (name === undefined) throw new Error('database migration identity is unavailable')
      return name
    })
  }

  /** Force SQLite WAL contents into the portable database before a transfer snapshot. */
  async checkpointForTransfer(): Promise<void> {
    await this.executor.exclusive(async (session) => {
      await checkpointStore(session)
    })
  }

  /**
   * Durable recovery point made by the update operation immediately before the
   * coordinator restart can boot a binary with newer migrations.
   */
  async snapshotBeforeUpdate(
    fromVersion: string,
    targetVersion: string,
  ): Promise<string | undefined> {
    return await this.executor.exclusive(async () =>
      this.stageUpdateSnapshot(fromVersion, targetVersion),
    )
  }

  private stageUpdateSnapshot(fromVersion: string, targetVersion: string): string | undefined {
    if (this.path === ':memory:') return undefined
    const safe = (version: string): string => version.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80)
    const snapshot = backupDatabase(
      this.db,
      this.path,
      `update-${safe(fromVersion)}-to-${safe(targetVersion)}`,
      undefined,
      undefined,
      () => this.snapshotVerifier.verifiedFallbackPath(),
    )
    // Staged, not proved. The record is published before anything can await the
    // proof so a crash in between is legible as "staged and never verified".
    if (snapshot) this.snapshotVerifier.recordStaged(snapshot, randomUUID())
    return snapshot
  }

  /**
   * Stage a snapshot behind the database fence and PROVE it in a child process.
   *
   * The only caller is the update operation's server-replacement step, which may
   * legitimately wait: awaiting this Promise leaves the event loop free, so
   * health and read requests continue while the verifier scans (POD-3068).
   */
  async verifiedSnapshotBeforeUpdate(
    fromVersion: string,
    targetVersion: string,
  ): Promise<SnapshotVerification> {
    const staged = await this.snapshotBeforeUpdate(fromVersion, targetVersion)
    if (!staged) {
      return {
        ok: false,
        code: 'no-snapshotable-file',
        detail: 'the database has no snapshotable file',
        durationMs: 0,
      }
    }
    let expectedSchemaVersion: string | undefined
    try {
      expectedSchemaVersion = await this.schemaVersionForTransfer()
    } catch {
      // A store with no migration identity still gets a quick_check proof; the
      // schema comparison is the part that is skipped, not the verification.
    }
    return await this.executor.exclusive(async () =>
      this.snapshotVerifier.verify(staged, expectedSchemaVersion),
    )
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
    if (this.path === ':memory:') return undefined
    return this.snapshotVerifier.verifiedFallbackPath()
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
    if (this.path === ':memory:') return false
    return this.snapshotVerifier.discoverAndQueue()
  }

  private transferFenceHeld = false

  /** In-process fence only: mint-session remains a separate writer until E.5. */
  async beginTransferFence(): Promise<void> {
    await this.executor.exclusive(async (session) => {
      if (this.transferFenceHeld) throw new Error('transfer fence is already held')
      await setStoreTransferFence(session, true)
      this.transferFenceHeld = true
    })
  }

  /** Reopen SQLite writes after a confirmed pre-promotion abort. */
  async endTransferFence(): Promise<void> {
    await this.executor.exclusive(async (session) => {
      if (!this.transferFenceHeld) return
      await setStoreTransferFence(session, false)
      this.transferFenceHeld = false
    })
  }

  /** Run `fn` atomically on the shared connection (nesting-safe: BEGIN at depth
   *  0, SAVEPOINT inside an open transaction). Narrow seam for cross-aggregate
   *  atomic writes — the write-seam Ledger binds an entity write and its change
   *  append into one span ([spec:SP-3fe2] #255) — without exposing the db handle.
   *
   *  The executor owns the transaction scope and drains registered post-commit
   *  work after the outermost commit. Nested registrations are discarded on
   *  rollback or merged into the parent on savepoint release. */
  async transact<T>(fn: () => T | Promise<T>): Promise<T> {
    return await this.executor.transact(async () => fn())
  }

  async close(persist?: () => Promise<void>): Promise<void> {
    const verifierClosed = this.snapshotVerifier.close()
    await this.executor.close(async () => {
      try {
        await persist?.()
      } finally {
        await verifierClosed
      }
    })
  }
}
