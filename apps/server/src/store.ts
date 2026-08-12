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
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createLogger } from '@podium/logger'
import { asMachineId, type MachineId } from '@podium/model'
import { stateDir } from '@podium/runtime/config'
import { type SqlDatabase, transaction } from '@podium/runtime/sqlite'
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
import { ServerSecretsRepository } from './store/server-secrets'
import { SessionsRepository } from './store/sessions'
import { SettingsRepository } from './store/settings'
import { SettingsAuditRepository } from './store/settings-audit'
import { SuperagentRepository } from './store/superagent'
import { TelegramBindingsRepository } from './store/telegram-bindings'
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
  readonly hostMachineId: MachineId

  constructor(
    private readonly path: string = defaultDbPath(),
    hostMachineId: MachineId = asMachineId(randomUUID()),
  ) {
    // The value crosses into its id space HERE, once: it arrives as the bytes of a
    // state-dir file (or a fresh mint) and leaves as the machine identity every row,
    // route and grant in this process is keyed by.
    this.hostMachineId = asMachineId(hostMachineId)
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    // `openStoreDatabase` is `openDatabase` everywhere except under a test runner
    // that installed the pre-migrated fixture (see store-database.ts). The migration
    // chain below still runs either way — on a pre-migrated database it simply finds
    // nothing pending, which is exactly what a second boot of a real install does.
    this.db = openStoreDatabase(path)
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
      log.info('applied migrations', { applied })
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
    this.conversations = new ConversationsRepository(this.db, this.hostMachineId)
    this.sync = new SyncRepository(this.db)
    this.auth = new AuthRepository(this.db)
    this.superagent = new SuperagentRepository(this.db)
    this.settings = new SettingsRepository(this.db)
    this.layout = new UserLayoutRepository(this.db)
    this.readPositions = new UserReadPositionRepository(this.db)
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

    // Per-boot runtime steps (environment-conditional FTS objects, one-time
    // upgrades and the two remaining data heals) — never schema DDL.
    //
    // THE MACHINE-IDENTITY UPGRADE RUNS FIRST, ahead of every reader in the process
    // (POD-318). It is not just that nothing may WRITE a pre-upgrade row: nothing may
    // READ one either. `SessionRegistry` loads the sessions map in its constructor,
    // and the composition root constructs it before it can call `ensureHostMachine`
    // — so an upgrade that ran there would leave live Session objects remembering a
    // sentinel while the rows underneath them had moved. Sequencing it here makes
    // "no reader ever sees a legacy machine id" true by construction instead of by
    // call-order discipline.
    this.migrateLegacyMachineIdentity(this.hostMachineId)
    this.conversations.ensureFts()
    this.superagent.seedGlobalThread()
    // The legacy repos.json import is the ONE writer left that can still hand the
    // repo-identity upgrade work — its rows land with a NULL repo_id and no prefix —
    // so the upgrade is told what it imported rather than trusting boot order to put
    // the import first forever (POD-1360).
    const importedRepos = this.repos.importReposJson(this.path, this.hostMachineId)
    this.upgradeLegacyRepoIdentityOnce(importedRepos > 0)
    // #140 defense in depth (ported from main's boot migrate): renumber any
    // (repo_id, seq) collisions left by a pre-UNIQUE-index database. Idempotent --
    // no-ops once the DB is clean; runs AFTER the backfill so rows have repo_ids.
    this.issues.renumberCollidingIssueSeqs()
    // POD-1926: references left behind by a hard purge of an empty draft. Neither
    // `sessions.issue_id` nor `issue_ref_letters.issue_id` declares a foreign key,
    // so before the purge learned to scrub them a deleted draft left a session row
    // (and a letter counter) naming an issue that no longer exists. Runs HERE, in
    // the facade constructor, for the same reason the machine-identity upgrade
    // does: ahead of every reader, so no in-memory `Session` can be holding the
    // stale pointer when it is cleared.
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

  /** `meta` key marking the repo-identity upgrade as spent for this database. */
  private static readonly REPO_IDENTITY_UPGRADE_KEY = 'repo-identity-upgrade'

  /**
   * Spend {@link migrateLegacyRepoIdentity} at most ONCE per database.
   *
   * THE BOUND IS A PERSISTED MARKER RATHER THAN IDEMPOTENCE-BY-CONSTRUCTION, and the
   * difference from the machine-identity upgrade above is worth stating. That one can
   * prove its own completion: after it runs, `WHERE machine_id IN ('local','__local__')`
   * matches nothing and no writer can produce either value again. One third of THIS
   * upgrade cannot make the same claim — a repo with no git remote, or one belonging to
   * another machine, is legitimately `origin_url IS NULL` forever, so the predicate that
   * selected its work never empties. That is precisely how it survived as a standing
   * heal: a step whose search never finishes looks, from the inside, exactly like a step
   * that still has work to do. The marker says what the row shape cannot — this database
   * has been past this code — and the fact that the marker is written in the SAME
   * transaction as the rewrite is what keeps a crash mid-upgrade from spending it.
   *
   * `legacyRowsJustImported` IS THE ONE OVERRIDE, and it exists so the bound is a
   * property of the code rather than of boot order. A spent marker means "no row here
   * needs this" — true for every writer in the process except `importReposJson`, which
   * inserts NULL-repo_id rows from a file. Today it runs on the line above, before the
   * marker can be consulted, so the override never fires; the day someone moves it, or
   * calls it a second time on a database that has emptied its repos table, the upgrade
   * still covers those rows instead of leaving them permanently unidentified.
   */
  private upgradeLegacyRepoIdentityOnce(legacyRowsJustImported = false): void {
    const marker = this.db
      .prepare('SELECT value FROM meta WHERE key = ?')
      .get(SessionStore.REPO_IDENTITY_UPGRADE_KEY) as { value?: unknown } | undefined
    const spent = typeof marker?.value === 'string' && marker.value.length > 0
    if (spent && !legacyRowsJustImported) return
    this.transact(() => {
      this.migrateLegacyRepoIdentity()
      this.db
        .prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
        .run(SessionStore.REPO_IDENTITY_UPGRADE_KEY, new Date().toISOString())
    })
  }

  /**
   * ONE-TIME REPO-IDENTITY UPGRADE (POD-1360) — pre-v8 repo and issue rows brought up
   * to the identity every reader in this process assumes: a repo_id on every repo and
   * every issue, an origin recorded for repos this host can actually read, and a
   * human-facing prefix per logical repo (#474, #74).
   *
   * IT REPLACES FOUR STANDING BOOT HEALS — `repos.backfillRepoIds`,
   * `issues.backfillNullRepoIds`, `repos.healLocalOrigins`, `repos.backfillPrefixes` —
   * and the change is the WORD, not just the schedule. "Heal" says the damage recurs;
   * nothing here recurs. `addRepo` derives an id, reads the origin and ensures a prefix
   * before it inserts, and `upsertIssue` resolves a repo_id, so the only writer that can
   * still hand this work is `importReposJson` — the legacy repos.json import that runs
   * immediately before it, once. An upgrade with a deletion horizon, on the same terms
   * as {@link migrateLegacyMachineIdentity}: nothing here should still be finding work
   * a year from now, and `upgradeLegacyRepoIdentityOnce` makes that structural.
   *
   * THE RESIDUE CHECK IS A SECOND READ of the database, not a restatement of what was
   * just written, and the two halves of it are graded differently ON PURPOSE:
   *
   *   - A MISSING repo_id FAILS THE BOOT. It is not a cosmetic gap — `repo_id` is what
   *     issues are bucketed and numbered by, so serving a NULL one means serving rows
   *     that belong to no repo, and the derivation cannot fail, so a survivor means the
   *     rewrite did not run at all. Loud here beats silent for a week.
   *   - A MISSING PREFIX ONLY WARNS. It costs a repo its human-facing refs until the
   *     next `addRepo`, which repairs it — real, but not identity corruption, and
   *     refusing to boot over it would trade a cosmetic defect for an outage.
   *
   * ORIGINS ARE DELIBERATELY UNCHECKED: originless is a legitimate resting state (see
   * `migrateLegacyRepoRows`), so an origin residue check could never reach zero.
   *
   * Public rather than private because it is the unit the tests drive directly — the
   * once-gate is a separate decision and is tested as one.
   */
  migrateLegacyRepoIdentity(): void {
    this.transact(() => {
      this.repos.migrateLegacyRepoRows()
      this.issues.migrateLegacyIssueRepoIds()
      const { repoIdsMissing, prefixesMissing } = this.repos.legacyRepoResidue()
      const issuesMissing = this.issues.issuesMissingRepoId()
      if (repoIdsMissing > 0 || issuesMissing > 0) {
        throw new Error(
          `legacy repo identity survived the boot upgrade (repos: ${repoIdsMissing}, ` +
            `issues: ${issuesMissing}) — refusing to serve rows that belong to no repo`,
        )
      }
      if (prefixesMissing > 0) {
        console.warn(
          `[podium:store] repo-identity upgrade left ${prefixesMissing} repo(s) without a ` +
            'human-facing prefix; refs for them resolve once the repo is re-registered',
        )
      }
    })
  }

  /** The exact newest migration identity the transfer target will verify. */
  schemaVersionForTransfer(): string {
    const row = this.db
      .prepare('SELECT name FROM __drizzle_migrations ORDER BY name DESC LIMIT 1')
      .get() as { name?: unknown } | undefined
    if (!row || typeof row.name !== 'string' || row.name.length === 0) {
      throw new Error('database migration identity is unavailable')
    }
    return row.name
  }

  /** Force SQLite WAL contents into the portable database before a transfer snapshot. */
  checkpointForTransfer(): void {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
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
   * and rows all over the schema pointing at it, or at the `'__local__'` column
   * default three tables used to have. A static SQL migration cannot fix them,
   * because the value they must become — this host's minted UUID — does not exist
   * until the state dir has a `machine.id` file. So the rewrite is code, run once at
   * boot, in one transaction, and it is an UPGRADE WITH A DELETION HORIZON rather
   * than a standing heal: the name says migrate, not heal or adopt, because nothing
   * here is supposed to still be finding work a year from now.
   *
   * THE TABLE LIST IS READ FROM THE DATABASE, not written out here, and that is
   * load-bearing. A hand-written list of "sessions, repos, conversations" is what
   * the placeholder era actually shipped, and it was already wrong: `issues`,
   * `conversation_segments`, `approval_requests` and `execution_profiles` all carry
   * a `machine_id` too — an issue pinned to the machine the UI called `local` is
   * ordinary user data. Asking sqlite which tables have the column means a table
   * that grows one tomorrow is covered by construction instead of being remembered.
   *
   * IDEMPOTENCE IS BY CONSTRUCTION, not by a flag: every statement is
   * `WHERE … IN ('local','__local__')`, and after the first run nothing matches —
   * there is no writer left in the codebase that can produce either value, which is
   * what the `local-placeholders` audit counter and the brand refusal on `MachineId`
   * together guarantee. A second boot updates zero rows, and so does the millionth.
   *
   * THE RESIDUE CHECK IS THE POINT, and it is deliberately a SECOND READ of the
   * database rather than a restatement of what was just written: it re-discovers the
   * columns and counts what is left. Non-zero means this boot is about to serve
   * MIXED IDENTITIES — the fleet answering to a UUID while rows still name a
   * sentinel — which is precisely how the placeholder era stranded people's
   * sessions. It fails loudly here instead of quietly.
   *
   * The `machines` row is RENAMED rather than re-inserted so its credential, owner
   * and grant edges survive the change of id; a fresh insert would have left a
   * second row and split the fleet in half.
   */
  migrateLegacyMachineIdentity(hostMachineId: MachineId): void {
    const LEGACY = ["'local'", "'__local__'"].join(', ')
    /** Every `(table, column)` in THIS database that holds a machine id. */
    const machineColumns = (): { table: string; column: string }[] => {
      const tables = this.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[]
      const found: { table: string; column: string }[] = []
      for (const { name } of tables) {
        const columns = this.db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[]
        if (name === 'machines') {
          if (columns.some((c) => c.name === 'id')) found.push({ table: name, column: 'id' })
          continue
        }
        if (columns.some((c) => c.name === 'machine_id'))
          found.push({ table: name, column: 'machine_id' })
      }
      return found
    }
    this.transact(() => {
      for (const { table, column } of machineColumns()) {
        // OR REPLACE: a row already carrying the host id on the same primary key
        // wins, rather than aborting the whole upgrade on a unique constraint.
        this.db
          .prepare(
            `UPDATE OR REPLACE "${table}" SET "${column}" = ? WHERE "${column}" IN (${LEGACY})`,
          )
          .run(hostMachineId)
      }
      const residue = machineColumns()
        .map(({ table, column }) => ({
          table,
          count: (
            this.db
              .prepare(`SELECT COUNT(*) AS c FROM "${table}" WHERE "${column}" IN (${LEGACY})`)
              .get() as { c: number }
          ).c,
        }))
        .filter(({ count }) => count > 0)
      if (residue.length > 0) {
        throw new Error(
          `legacy machine identity survived the boot upgrade (${residue
            .map(({ table, count }) => `${table}: ${count}`)
            .join(', ')}) — refusing to serve mixed machine identities`,
        )
      }
    })
    // This rewrote `repos.machine_id` on the raw handle, with SQL built from
    // sqlite_master — so the repos aggregate's held read cannot have seen it
    // (POD-1638). Tell it directly, or the next `listRepos()` answers with the
    // pre-upgrade machine id.
    this.repos.invalidate()
  }
}
