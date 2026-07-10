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
 */

import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { openDatabase, type SqlDatabase, transaction } from '@podium/runtime/sqlite'
import { SyncRepository } from '@podium/sync'
import { MIGRATIONS, runMigrations } from './migrations/index'
import { AuthRepository } from './store/auth'
import { ConversationsRepository } from './store/conversations'
import { EventsRepository } from './store/events'
import { IssuesRepository } from './store/issues'
import { MachinesRepository } from './store/machines'
import { normalizeRepoPath, ReposRepository } from './store/repos'
import { SessionsRepository } from './store/sessions'
import { SettingsRepository } from './store/settings'
import { SuperagentRepository } from './store/superagent'

export * from './store/types'
export { normalizeRepoPath }

/** Default DB file: $PODIUM_STATE_DIR/podium.db, else ~/.podium/podium.db. */
export function defaultDbPath(): string {
  const base = process.env.PODIUM_STATE_DIR ?? join(process.env.HOME || homedir(), '.podium')
  return join(base, 'podium.db')
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
  readonly machines: MachinesRepository
  readonly events: EventsRepository

  constructor(private readonly path: string = defaultDbPath()) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = openDatabase(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA busy_timeout = 5000')
    // The versioned migration chain owns the schema (stamps schema_version and
    // refuses to open a DB newer than the code). Schema DDL lives ONLY in
    // src/migrations/.
    runMigrations(this.db, MIGRATIONS)
    // Foreign-key enforcement is PER-CONNECTION in SQLite and deliberately
    // enabled only AFTER the migration chain: table rebuilds (the standard
    // 12-step ALTER, e.g. migration 006) must run without FK enforcement, and
    // a PRAGMA inside the runner's transaction would be a no-op anyway.
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
    this.conversations = new ConversationsRepository(this.db)
    this.sync = new SyncRepository(this.db)
    this.auth = new AuthRepository(this.db)
    this.superagent = new SuperagentRepository(this.db)
    this.settings = new SettingsRepository(this.db)
    this.machines = new MachinesRepository(this.db)
    this.events = new EventsRepository(this.db)

    // Per-boot, idempotent runtime steps (environment-conditional FTS objects
    // and data heals) — never schema DDL.
    this.conversations.ensureFts()
    this.conversations.repairSubagentSegmentPaths()
    this.superagent.seedGlobalThread()
    this.repos.importReposJson(this.path)
    this.backfillRepoIds()
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
