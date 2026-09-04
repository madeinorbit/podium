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
import { type SqlDatabase, transaction } from '@podium/runtime/sqlite'
import { runSynchronousSpan } from './store/executor/synchronous-span'
import { SyncRepository } from '@podium/sync'
import { isFeatureEnabled } from './features'
import { backupDatabase } from './migrations/backup'
import { DRIZZLE_MIGRATIONS } from './migrations/drizzle-manifest.generated'
import { latestAppliedMigration, runDrizzleMigrations } from './migrations/index'
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
import { createBunStoreExecutor, type QueryClient, type RootStoreExecutor } from './store/executor'
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
   * compiler then names anything still on it. Nothing has moved through the
   * scheduler yet: `close()` below still closes the connection directly, because
   * routing the lifecycle through the executor makes it asynchronous and that
   * belongs to Stage B, not to a binding change.
   */
  private readonly executor: RootStoreExecutor<QueryClient>
  /** The synchronous query capability, handed to converted repositories. */
  private readonly queries: NonNullable<RootStoreExecutor<QueryClient>['syncQueries']>
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
  readonly searchIndexEnabled: boolean

  constructor(
    private readonly path: string = defaultDbPath(),
    hostMachineId: MachineId = asMachineId(randomUUID()),
    /** Verifier seam (POD-3068) — injected so a test never spawns a real child. */
    snapshotVerifierDeps: SnapshotVerifierDeps = {},
  ) {
    // The value crosses into its id space HERE, once: it arrives as the bytes of a
    // state-dir file (or a fresh mint) and leaves as the machine identity every row,
    // route and grant in this process is keyed by.
    this.hostMachineId = asMachineId(hostMachineId)
    this.snapshotVerifier = new SnapshotVerifier(path, snapshotVerifierDeps)
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    // `openStoreDatabase` is `openDatabase` everywhere except under a test runner
    // that installed the pre-migrated fixture (see store-database.ts). The migration
    // chain below still runs either way — on a pre-migrated database it simply finds
    // nothing pending, which is exactly what a second boot of a real install does.
    this.db = openStoreDatabase(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA busy_timeout = 5000')
    // The driver enables foreign keys on a fresh connection. Migrations use
    // SQLite's table-rebuild pattern (create/copy/drop/rename), where dropping a
    // parent with enforcement on would cascade-delete child rows. The chain owns
    // this window; enforcement is restored immediately after it succeeds.
    this.db.exec('PRAGMA foreign_keys = OFF')
    // Schema migration [spec:SP-4428]. drizzle-kit AUTHORS migrations; this boot
    // APPLIES them with drizzle-orm's own bun:sqlite migrator, on THIS connection
    // (so the foreign_keys = OFF window covers it). Schema DDL lives ONLY in
    // src/migrations/. A fresh file is built by the baseline; an existing drizzle
    // database advances by any pending migrations.
    const applied = runDrizzleMigrations(this.db, DRIZZLE_MIGRATIONS, {
      dbPath: path === ':memory:' ? undefined : path,
    })
    // Say what the schema actually did — a silently-skipped migration (#472)
    // survived for so long precisely because it was invisible.
    if (applied.length > 0) {
      log.info('applied migrations', { applied })
    }
    // Foreign-key enforcement is per-connection in SQLite; restored now that the
    // migrator (which runs table rebuilds with enforcement off) is done.
    this.db.exec('PRAGMA foreign_keys = ON')

    // The executor the whole repository set is bound to. It is built AFTER the
    // migration chain for the same reason the repositories are: the connection
    // it wraps has to be the migrated one. No `openReader`, so a committed-view
    // read from inside a body refuses rather than deadlocking — nothing asks for
    // one yet, and a second connection to `:memory:` would be a second database.
    this.executor = createBunStoreExecutor({ database: this.db })

    /**
     * The synchronous query capability, resolved ONCE here [spec rule 27b]. A
     * converted repository takes THIS OBJECT in the constructor slot its
     * `SqlDatabase` occupied — `{ db, transact }` together, because they are one
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
    const sync = this.executor.syncQueries
    if (!sync) {
      throw new Error(
        'SessionStore: the synchronous query capability is absent — the handle is not ' +
          'bun-backed, so converted repositories cannot be constructed (POD-3221 rule 27b).',
      )
    }
    this.queries = sync

    // Compose the per-aggregate repositories. The three cross-aggregate edges are
    // injected as late-bound lambdas, bound WITHIN the set being built: sessions
    // purge observation checkpoints, issues resolve their stable repo_id via the
    // repos aggregate, and a repo-identity upgrade dual-writes onto issues.
    this.observationCheckpoints = new ObservationCheckpointsRepository(this.queries)
    this.sessions = new SessionsRepository(this.executor, (id) =>
      this.observationCheckpoints.purge(id),
    )
    this.issues = new IssuesRepository(this.queries, (repoPath) =>
      this.repos.resolveRepoIdForPath(repoPath),
    )
    this.repos = new ReposRepository(
      this.executor,
      (repoId, repoPath) => this.issues.assignRepoIdToIssuesUnder(repoId, repoPath),
      this.hostMachineId,
      this.tableWrites,
    )
    this.approvals = new ApprovalsRepository(this.executor)
    this.interactions = new InteractionsRepository(this.queries)
    this.conversations = new ConversationsRepository(this.executor, this.hostMachineId)
    // `SyncRepository` lives in `@podium/sync` and cannot import this executor,
    // so it takes the narrow port the PACKAGE declares and this object satisfies
    // structurally — `SyncStoreExecutor`, the same inversion `syncServerTables`
    // uses one line's worth of reasoning away (POD-3338, spec §6 rule 20). It is
    // still an UNCONVERTED repository: it reads `legacy` through the port and
    // stays on `STAGE_A_UNCONVERTED` until its own conversion wave.
    this.sync = new SyncRepository(this.executor, syncServerTables)
    this.auth = new AuthRepository(this.executor)
    this.superagent = new SuperagentRepository(this.executor)
    this.settings = new SettingsRepository(this.executor)
    this.layout = new UserLayoutRepository(this.executor)
    this.readPositions = new UserReadPositionRepository(this.executor)
    this.secrets = new ServerSecretsRepository(this.executor)
    this.settingsAudit = new SettingsAuditRepository(this.executor)
    this.accounts = new AccountsRepository(this.executor)
    this.machines = new MachinesRepository(this.queries)
    this.grants = new GrantsRepository(this.executor)
    this.users = new UsersRepository(this.executor)
    this.telegramBindings = new TelegramBindingsRepository(this.executor)
    this.events = new EventsRepository(this.queries)
    this.notificationFacts = new NotificationFactsRepository(this.executor)
    this.quotaHistory = new QuotaHistoryRepository(this.executor)
    this.transcriptCosts = new TranscriptCostsRepository(this.executor)
    this.messages = new MessagesRepository(this.executor)
    this.readWatermarks = new ReadWatermarksRepository(this.executor)
    this.workflows = new WorkflowsRepository(this.executor)
    this.locks = new LocksRepository(this.queries)
    this.maintenance = new MaintenanceRepository(this.queries)
    this.automations = new AutomationsRepository(this.queries)
    this.shipping = new ShippingRepository(this.executor)
    this.operations = new OperationStore(this.executor)
    this.messagingTopics = new MessagingTopicsRepository(this.executor)

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
    this.refuseLegacyIdentities()
    // Search is one switch (PDM-25): the `command-palette` flag that shows Cmd+K
    // also decides whether this boot carries a full-text index at all. Read ONCE,
    // here — flipping the toggle takes effect at the next boot, so nothing has to
    // rebuild an index underneath a running process. `settings` is constructed
    // above, so a config-forced value is honoured on the very first boot.
    this.searchIndexEnabled = isFeatureEnabled('command-palette', this.settings.getSettings())
    this.conversations.ensureFts(this.searchIndexEnabled)
    this.superagent.seedGlobalThread()
    // #140 defense in depth (ported from main's boot migrate): renumber any
    // (repo_id, seq) collisions left by a pre-UNIQUE-index database. Idempotent --
    // no-ops once the DB is clean; runs AFTER the backfill so rows have repo_ids.
    this.issues.renumberCollidingIssueSeqs()
    // POD-1926: references left behind by a hard purge of an empty draft. Neither
    // `sessions.issue_id` nor `issue_ref_letters.issue_id` declares a foreign key,
    // so before the purge learned to scrub them a deleted draft left a session row
    // (and a letter counter) naming an issue that no longer exists. Runs HERE, in
    // the facade constructor, for the same reason the identity refusals do:
    // ahead of every reader, so no in-memory `Session` can be holding the stale
    // pointer when it is cleared.
    this.healDanglingIssueReferences()
  }

  /** Per-boot heal (idempotent): clear session pointers and letter counters whose
   *  issue was hard-purged. Reports only when it actually found something. */
  private healDanglingIssueReferences(): void {
    const sessions = this.sessions.detachDanglingIssueReferences()
    const letters = this.issues.pruneOrphanRefLetters()
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
  private refuseLegacyIdentities(): void {
    const sentinels = this.machines.legacyMachineSentinelSites()
    if (sentinels.length > 0) {
      throw new Error(
        `retired machine sentinels (${RETIRED_MACHINE_SENTINELS.join(', ')}) are still stored ` +
          `in ${sentinels.join(', ')} — this database predates POD-318 and no shipped ` +
          'Podium can serve it; restore a backup taken after the upgrade',
      )
    }
    const { repoIdsMissing, prefixesMissing } = this.repos.legacyRepoResidue()
    const issuesMissing = this.issues.issuesMissingRepoId()
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
  schemaVersionForTransfer(): string {
    const name = latestAppliedMigration(this.db)
    if (name === undefined) throw new Error('database migration identity is unavailable')
    return name
  }

  /** Force SQLite WAL contents into the portable database before a transfer snapshot. */
  checkpointForTransfer(): void {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  }

  /**
   * Durable recovery point made by the update operation immediately before the
   * coordinator restart can boot a binary with newer migrations.
   */
  snapshotBeforeUpdate(fromVersion: string, targetVersion: string): string | undefined {
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
    const staged = this.snapshotBeforeUpdate(fromVersion, targetVersion)
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
      expectedSchemaVersion = this.schemaVersionForTransfer()
    } catch {
      // A store with no migration identity still gets a quick_check proof; the
      // schema comparison is the part that is skipped, not the verification.
    }
    return this.snapshotVerifier.verify(staged, expectedSchemaVersion)
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

  /** Reject new SQLite writes while the target is being promoted. */
  beginTransferFence(): void {
    if (this.transferFenceHeld) throw new Error('transfer fence is already held')
    this.db.exec('PRAGMA query_only = ON')
    this.transferFenceHeld = true
  }

  /** Reopen SQLite writes after a confirmed pre-promotion abort. */
  endTransferFence(): void {
    if (!this.transferFenceHeld) return
    this.db.exec('PRAGMA query_only = OFF')
    this.transferFenceHeld = false
  }

  /** Run `fn` atomically on the shared connection (nesting-safe: BEGIN at depth
   *  0, SAVEPOINT inside an open transaction). Narrow seam for cross-aggregate
   *  atomic writes — the write-seam Ledger binds an entity write and its change
   *  append into one span ([spec:SP-3fe2] #255) — without exposing the db handle.
   *
   *  The span also carries a POST-COMMIT SCOPE [POD-3260, spec section 6 rule 17],
   *  so a body can register work through postCommit() and have it run after the
   *  OUTERMOST commit rather than inside the transaction. The scope is opened
   *  OUTSIDE transaction(), which is what makes the drain run after COMMIT rather
   *  than after the callback returns. runSynchronousSpan is an instrument: at the
   *  flip the executor's own runner takes the drain over and this wrapper goes,
   *  filed as POD-3327. */
  transact<T>(fn: () => T): T {
    return runSynchronousSpan(() => transaction(this.db, fn))
  }

  close(): void {
    this.snapshotVerifier.close()
    this.db.close()
  }
}
