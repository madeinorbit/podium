/**
 * Durable server-side store. Single writer (the server).
 *
 * SessionStore is the store's COMPOSITION ROOT, nothing more: it opens the
 * database, runs the versioned migration chain (src/migrations/), sequences the
 * per-boot idempotent heals, and constructs the per-aggregate repositories in
 * `./store/` — including the two cross-aggregate late-bound lambdas (issues
 * resolve their stable repo_id via the repos aggregate; a repo-identity upgrade
 * dual-writes onto issues). Callers hold the aggregate repository they need
 * (`store.issues`, `store.sync`, …) — there are no forwarding methods here.
 *
 * Aggregate map:
 *  - sessions (+ pins/snoozes/tab_order/session_drafts) → store/sessions.ts
 *  - issues (+ labels/deps/comments/mail)               → store/issues.ts
 *  - conversations (index/FTS/registry/mirror/transcript index)
 *                                                        → store/conversations.ts
 *  - sync (changes/applied_mutations/queued_messages/upstream_outbox)
 *                                                        → @podium/sync's SyncRepository
 *                                                          (query-only; schema DDL stays
 *                                                          here in src/migrations/)
 *  - auth (client_sessions)                              → store/auth.ts
 *  - superagent (threads/messages)                       → store/superagent.ts
 *  - settings/meta                                       → store/settings.ts
 *  - repos                                               → store/repos.ts
 *  - machines                                            → store/machines.ts
 *  - events/steward (podium_events/steward_state/subscriptions)
 *                                                        → store/events.ts
 *  - notification fact claims                            → store/notification-facts.ts
 *  - automations (automations/automation_runs)           → store/automations.ts
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { stateDir } from '@podium/runtime/config'
import { openDatabase, type SqlDatabase, transaction } from '@podium/runtime/sqlite'
import { SyncRepository } from '@podium/sync'
import { DRIZZLE_MIGRATIONS } from './migrations/drizzle-manifest.generated'
import { runDrizzleMigrations } from './migrations/index'
import { AccountsRepository } from './store/accounts'
import { ApprovalsRepository } from './store/approvals'
import { AuthRepository } from './store/auth'
import { AutomationsRepository } from './store/automations'
import { ConversationsRepository } from './store/conversations'
import { EventsRepository } from './store/events'
import { GrantsRepository } from './store/grants'
import { IssuesRepository } from './store/issues'
import { LocksRepository } from './store/locks'
import { MachinesRepository } from './store/machines'
import { MaintenanceRepository } from './store/maintenance'
import { MessagesRepository } from './store/messages'
import { MessagingTopicsRepository } from './store/messaging-topics'
import { NotificationFactsRepository } from './store/notification-facts'
import { ObservationCheckpointsRepository } from './store/observation-checkpoints'
import { ReadWatermarksRepository } from './store/read-watermarks'
import { normalizeRepoPath, ReposRepository } from './store/repos'
import { SessionsRepository } from './store/sessions'
import { ServerSecretsRepository } from './store/server-secrets'
import { SettingsAuditRepository } from './store/settings-audit'
import { SettingsRepository } from './store/settings'
import { SuperagentRepository } from './store/superagent'
import { TelegramBindingsRepository } from './store/telegram-bindings'
import { UsersRepository } from './store/users'
import { WorkflowsRepository } from './store/workflows'

export type { MessagePrincipalRef } from './store/messages'
export * from './store/types'
export { normalizeRepoPath }

/** Default DB file: podium.db below the selected instance state root. */
export function defaultDbPath(): string {
  return join(stateDir(), 'podium.db')
}

export class SessionStore {
  private readonly db: SqlDatabase
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
  /** Unified agent messaging (#237) [spec:SP-34d7]. */
  readonly messages: MessagesRepository
  /** Recap watermarks (#237) [spec:SP-34d7 read-toolkit tier 3]. */
  readonly readWatermarks: ReadWatermarksRepository
  readonly approvals: ApprovalsRepository
  readonly workflows: WorkflowsRepository
  /** Advisory named lease locks [spec:SP-85d1] — podium lock / merge-lock. */
  readonly locks: LocksRepository
  /** Janitor generation fencing + deterministic command outcomes [spec:SP-c29e]. */
  readonly maintenance: MaintenanceRepository
  /** Scheduled automations + their run history (#470) [spec:SP-17db]. */
  readonly automations: AutomationsRepository
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
  readonly hostMachineId: string

  constructor(
    private readonly path: string = defaultDbPath(),
    hostMachineId: string = randomUUID(),
  ) {
    this.hostMachineId = hostMachineId
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = openDatabase(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA busy_timeout = 5000')
    // node:sqlite enables foreign keys on a fresh connection. Migrations use
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
      console.log(`[podium:server] applied migrations: ${applied.join(', ')}`)
    }
    // Foreign-key enforcement is per-connection in SQLite; restored now that the
    // migrator (which runs table rebuilds with enforcement off) is done.
    this.db.exec('PRAGMA foreign_keys = ON')

    // Compose the per-aggregate repositories. The two cross-aggregate edges are
    // injected as late-bound lambdas: issues resolve their stable repo_id via
    // the repos aggregate, and a repo-identity upgrade dual-writes onto issues.
    this.observationCheckpoints = new ObservationCheckpointsRepository(this.db)
    this.sessions = new SessionsRepository(this.db, (id) => this.observationCheckpoints.purge(id))
    this.issues = new IssuesRepository(this.db, (repoPath) =>
      this.repos.resolveRepoIdForPath(repoPath),
    )
    this.repos = new ReposRepository(
      this.db,
      (repoId, repoPath) => this.issues.assignRepoIdToIssuesUnder(repoId, repoPath),
      this.hostMachineId,
    )
    this.approvals = new ApprovalsRepository(this.db)
    this.conversations = new ConversationsRepository(this.db)
    this.sync = new SyncRepository(this.db)
    this.auth = new AuthRepository(this.db)
    this.superagent = new SuperagentRepository(this.db)
    this.settings = new SettingsRepository(this.db)
    this.secrets = new ServerSecretsRepository(this.db)
    this.settingsAudit = new SettingsAuditRepository(this.db)
    this.accounts = new AccountsRepository(this.db)
    this.machines = new MachinesRepository(this.db)
    this.grants = new GrantsRepository(this.db)
    this.users = new UsersRepository(this.db)
    this.telegramBindings = new TelegramBindingsRepository(this.db)
    this.events = new EventsRepository(this.db)
    this.notificationFacts = new NotificationFactsRepository(this.db)
    this.messages = new MessagesRepository(this.db)
    this.readWatermarks = new ReadWatermarksRepository(this.db)
    this.workflows = new WorkflowsRepository(this.db)
    this.locks = new LocksRepository(this.db)
    this.maintenance = new MaintenanceRepository(this.db)
    this.automations = new AutomationsRepository(this.db)
    this.messagingTopics = new MessagingTopicsRepository(this.db)

    // Per-boot, idempotent runtime steps (environment-conditional FTS objects
    // and data heals) — never schema DDL.
    this.conversations.ensureFts()
    this.conversations.repairSubagentSegmentPaths()
    this.superagent.seedGlobalThread()
    this.repos.importReposJson(this.path, this.hostMachineId)
    this.backfillRepoIds()
    // #474: assign human-facing prefixes to any repos still missing one (heals
    // rows inserted by importReposJson or before the prefix migration).
    this.repos.backfillPrefixes()
    // #140 defense in depth (ported from main's boot migrate): renumber any
    // (repo_id, seq) collisions left by a pre-UNIQUE-index database. Idempotent --
    // no-ops once the DB is clean; runs AFTER the backfill so rows have repo_ids.
    this.issues.renumberCollidingIssueSeqs()
  }

  /** Per-boot heal (idempotent): fill NULL repo_ids on repos and issues, then
   *  self-heal origins for locally readable repos (v8 backfill, #74). */
  private backfillRepoIds(): void {
    this.repos.backfillRepoIds()
    this.issues.backfillNullRepoIds()
    this.repos.healLocalOrigins()
  }

  /** Run `fn` atomically on the shared connection (nesting-safe: BEGIN at depth
   *  0, SAVEPOINT inside an open transaction). Narrow seam for cross-aggregate
   *  atomic writes — the write-seam Ledger binds an entity write and its change
   *  append into one span ([spec:SP-3fe2] #255) — without exposing the db handle. */
  transact<T>(fn: () => T): T {
    return transaction(this.db, fn)
  }

  close(): void {
    this.db.close()
  }

  /**
   * ONE-TIME BOOT UPGRADE — the only place the retired sentinels are still spelled.
   *
   * Installs that predate POD-318 carry a `machines` row literally called `'local'`
   * and sessions/repos/conversations rows on either `'local'` or the `'__local__'`
   * column default. A static SQL migration cannot fix them, because the value they
   * must become — this host's minted UUID — does not exist until the state dir has
   * a `machine.id` file. So the rewrite is code, run once at boot, in one
   * transaction, and it is an UPGRADE WITH A DELETION HORIZON rather than a
   * standing heal: the name says migrate, not heal or adopt, because nothing here
   * is supposed to still be finding work a year from now.
   *
   * IDEMPOTENCE IS BY CONSTRUCTION, not by a flag: every statement is
   * `WHERE machine_id IN ('local','__local__')`, and after the first run nothing
   * matches — there is no writer left in the codebase that can produce either
   * value, which is what the `local-placeholders` audit counter and the brand
   * refusal on `MachineId` together guarantee. A second boot therefore updates
   * zero rows, and so does the millionth.
   *
   * THE RESIDUE CHECK IS THE POINT. After the rewrite, still inside the same
   * transaction, it counts what is left. Non-zero means the rewrite did not run or
   * did not cover a table that grew a machine column — i.e. this boot is about to
   * serve MIXED IDENTITIES, where the fleet says one thing and the rows say
   * another. That fails loudly here instead of quietly stranding rows nobody can
   * see, which is exactly how the placeholder era went wrong.
   *
   * The `machines` row is renamed rather than re-inserted so its credential,
   * owner and grant edges survive the change of id. `INSERT OR IGNORE`-style
   * duplication would have left a second row and split the fleet in half.
   */
  migrateLegacyMachineIdentity(hostMachineId: string): void {
    this.transact(() => {
      // Order matters only for readability — the whole thing is one transaction.
      this.db
        .prepare("UPDATE OR REPLACE machines SET id = ? WHERE id IN ('local', '__local__')")
        .run(hostMachineId)
      for (const table of ['sessions', 'repos', 'conversations']) {
        this.db
          .prepare(
            `UPDATE OR REPLACE ${table} SET machine_id = ? WHERE machine_id IN ('local', '__local__')`,
          )
          .run(hostMachineId)
      }
      const residue = [
        ...['sessions', 'repos', 'conversations'].map(
          (table) =>
            [
              table,
              (
                this.db
                  .prepare(
                    `SELECT COUNT(*) AS c FROM ${table} WHERE machine_id IN ('local', '__local__')`,
                  )
                  .get() as { c: number }
              ).c,
            ] as const,
        ),
        [
          'machines',
          (
            this.db
              .prepare("SELECT COUNT(*) AS c FROM machines WHERE id IN ('local', '__local__')")
              .get() as { c: number }
          ).c,
        ] as const,
      ].filter(([, count]) => count > 0)
      if (residue.length > 0) {
        throw new Error(
          `legacy machine identity survived the boot upgrade (${residue
            .map(([table, count]) => `${table}: ${count}`)
            .join(', ')}) — refusing to serve mixed machine identities`,
        )
      }
    })
  }
}
