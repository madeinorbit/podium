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
 *  - automations (automations/automation_runs)           → store/automations.ts
 */

import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { stateDir } from '@podium/runtime/config'
import { openDatabase, type SqlDatabase, transaction } from '@podium/runtime/sqlite'
import { SyncRepository } from '@podium/sync'
import { runDrizzleMigrations } from './migrations/index'
import { DRIZZLE_MIGRATIONS } from './migrations/drizzle-manifest.generated'
import { AccountsRepository } from './store/accounts'
import { ApprovalsRepository } from './store/approvals'
import { AuthRepository } from './store/auth'
import { AutomationsRepository } from './store/automations'
import { ConversationsRepository } from './store/conversations'
import { EventsRepository } from './store/events'
import { IssuesRepository } from './store/issues'
import { LocksRepository } from './store/locks'
import { MachinesRepository } from './store/machines'
import { MessagingTopicsRepository } from './store/messaging-topics'
import { MessagesRepository } from './store/messages'
import { ReadWatermarksRepository } from './store/read-watermarks'
import { normalizeRepoPath, ReposRepository } from './store/repos'
import { SessionsRepository } from './store/sessions'
import { SettingsRepository } from './store/settings'
import { SuperagentRepository } from './store/superagent'
import { WorkflowsRepository } from './store/workflows'

export type { MessagePrincipalRef } from './store/messages'
export * from './store/types'
export { normalizeRepoPath }

/** Default DB file: $PODIUM_STATE_DIR/podium.db, else ~/.podium/podium.db. */
export function defaultDbPath(): string {
  return join(stateDir(), 'podium.db')
}

export class SessionStore {
  private readonly db: SqlDatabase
  readonly repos: ReposRepository
  readonly sessions: SessionsRepository
  readonly issues: IssuesRepository
  readonly conversations: ConversationsRepository
  readonly sync: SyncRepository
  readonly auth: AuthRepository
  readonly superagent: SuperagentRepository
  readonly settings: SettingsRepository
  /** Managed LLM credentials [spec:SP-6454] — server-held, injected at spawn.
   *  Deliberately NOT in the settings blob, which round-trips to the browser. */
  readonly accounts: AccountsRepository
  readonly machines: MachinesRepository
  readonly events: EventsRepository
  /** Unified agent messaging (#237) [spec:SP-34d7]. */
  readonly messages: MessagesRepository
  /** Recap watermarks (#237) [spec:SP-34d7 read-toolkit tier 3]. */
  readonly readWatermarks: ReadWatermarksRepository
  readonly approvals: ApprovalsRepository
  readonly workflows: WorkflowsRepository
  /** Advisory named lease locks [spec:SP-85d1] — podium lock / merge-lock. */
  readonly locks: LocksRepository
  /** Scheduled automations + their run history (#470) [spec:SP-17db]. */
  readonly automations: AutomationsRepository
  /** Telegram forum-topic ↔ issue thread bindings [spec:SP-5d81]. */
  readonly messagingTopics: MessagingTopicsRepository

  constructor(private readonly path: string = defaultDbPath()) {
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
    this.sessions = new SessionsRepository(this.db)
    this.issues = new IssuesRepository(this.db, (repoPath) =>
      this.repos.resolveRepoIdForPath(repoPath),
    )
    this.repos = new ReposRepository(this.db, (repoId, repoPath) =>
      this.issues.assignRepoIdToIssuesUnder(repoId, repoPath),
    )
    this.approvals = new ApprovalsRepository(this.db)
    this.conversations = new ConversationsRepository(this.db)
    this.sync = new SyncRepository(this.db)
    this.auth = new AuthRepository(this.db)
    this.superagent = new SuperagentRepository(this.db)
    this.settings = new SettingsRepository(this.db)
    this.accounts = new AccountsRepository(this.db)
    this.machines = new MachinesRepository(this.db)
    this.events = new EventsRepository(this.db)
    this.messages = new MessagesRepository(this.db)
    this.readWatermarks = new ReadWatermarksRepository(this.db)
    this.workflows = new WorkflowsRepository(this.db)
    this.locks = new LocksRepository(this.db)
    this.automations = new AutomationsRepository(this.db)
    this.messagingTopics = new MessagingTopicsRepository(this.db)

    // Per-boot, idempotent runtime steps (environment-conditional FTS objects
    // and data heals) — never schema DDL.
    this.conversations.ensureFts()
    this.conversations.repairSubagentSegmentPaths()
    this.superagent.seedGlobalThread()
    this.repos.importReposJson(this.path)
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
   * Rewrite all rows carrying the placeholder `'__local__'` machine_id to the
   * real machineId — the one genuinely CROSS-aggregate write (sessions, repos
   * and conversations all carry machine ids). Idempotent: re-running after
   * adoption is a no-op (no rows will match `__local__` any more).
   */
  adoptLocalRows(machineId: string): void {
    this.sessions.adoptLocalRows(machineId)
    this.repos.adoptLocalRows(machineId)
    this.conversations.adoptLocalRows(machineId)
  }
}
