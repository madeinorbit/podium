/**
 * Migration 002 — the full core schema, converted from the legacy
 * `SessionStore.migrate()` idempotent DDL (Phase 1 of the architecture
 * redesign).
 *
 * Written DEFENSIVELY on purpose: every statement is `IF NOT EXISTS` /
 * `PRAGMA table_info`-guarded, exactly like the legacy code it replaces, so
 * BOTH entry paths converge on the same schema:
 *
 *  - a FRESH database (schema_version 0/1, no tables) is built entirely here;
 *  - an EXISTING database built by the legacy migrate() (stamped baseline 1)
 *    no-ops through the CREATEs and only fills whatever guards detect missing
 *    (including truly ancient pre-rename schemas: tmux_label → durable_label,
 *    the repos (path)→(machine_id, path) re-key, additive issue columns …).
 *
 * convergence.test.ts pins byte-identical sqlite_master output for the two
 * paths. NOTE the DDL strings must stay byte-identical to the legacy ones —
 * do not reformat them. The environment-conditional FTS objects
 * (conversations_fts / transcript_fts + triggers) are NOT schema-versioned:
 * they are (re)ensured per boot by the conversations repository, because
 * their existence depends on the runtime SQLite having FTS5.
 *
 * Data heals that legacy migrate() ran on every boot (issue-dep backfill,
 * repos.json import, repo_id backfill, subagent-path repair, the global
 * superagent thread seed) stay per-boot steps in the repositories — they are
 * idempotent data operations, not schema.
 */

import type { SqlDatabase } from '@podium/core/sqlite'

export function up(db: SqlDatabase): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS repos (
         machine_id TEXT NOT NULL DEFAULT '__local__',
         path TEXT NOT NULL,
         origin_url TEXT,
         repo_name TEXT,
         repo_id TEXT,
         added_at TEXT NOT NULL,
         PRIMARY KEY (machine_id, path)
       )`,
  )
  db.exec(
    `CREATE TABLE IF NOT EXISTS pins (
         kind TEXT NOT NULL,
         id TEXT NOT NULL,
         pinned_at TEXT NOT NULL,
         PRIMARY KEY (kind, id)
       )`,
  )
  db.exec(
    `CREATE TABLE IF NOT EXISTS snoozes (
         session_id TEXT PRIMARY KEY,
         snoozed_until TEXT,
         created_at TEXT NOT NULL
       )`,
  )
  db.exec(
    `CREATE TABLE IF NOT EXISTS sessions (
         id TEXT PRIMARY KEY,
         agent_kind TEXT NOT NULL,
         cwd TEXT NOT NULL,
         title TEXT NOT NULL,
         name TEXT,
         origin_kind TEXT NOT NULL,
         conversation_id TEXT,
         resume_kind TEXT,
         resume_value TEXT,
         status TEXT NOT NULL,
         exit_code INTEGER,
         durable_label TEXT NOT NULL,
         created_at TEXT NOT NULL,
         last_active_at TEXT NOT NULL,
         archived INTEGER NOT NULL DEFAULT 0,
         work_state TEXT,
         last_output_at TEXT,
         last_input_at TEXT,
         last_resumed_at TEXT,
         spawned_by TEXT,
         headless INTEGER NOT NULL DEFAULT 0,
         issue_id TEXT,
         read_at TEXT
       )`,
  )
  // Additive column for headless harness sessions (concierge unification).
  // Fresh DBs get it from the CREATE above; live DBs gain it in place.
  if (
    !(db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).some(
      (c) => c.name === 'headless',
    )
  ) {
    db.exec('ALTER TABLE sessions ADD COLUMN headless INTEGER NOT NULL DEFAULT 0')
  }
  // Additive explicit issue attachment (issue-as-workspace). Structural guard.
  if (
    !(db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).some(
      (c) => c.name === 'issue_id',
    )
  ) {
    db.exec('ALTER TABLE sessions ADD COLUMN issue_id TEXT')
  }
  // Additive email-style read state (issue #124). Structural guard; legacy rows read
  // NULL (never opened) and behave as unread until first marked read.
  if (
    !(db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).some(
      (c) => c.name === 'read_at',
    )
  ) {
    db.exec('ALTER TABLE sessions ADD COLUMN read_at TEXT')
  }
  db.exec(
    `CREATE TABLE IF NOT EXISTS tab_order (
         worktree TEXT PRIMARY KEY,
         ids TEXT NOT NULL,
         updated_at TEXT NOT NULL
       )`,
  )
  db.exec(
    `CREATE TABLE IF NOT EXISTS session_drafts (
         session_id TEXT PRIMARY KEY,
         text TEXT NOT NULL,
         updated_at TEXT NOT NULL
       )`,
  )
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  // Metadata oplog (docs/spec/oplog-read-path.md). AUTOINCREMENT is deliberate:
  // seq must stay monotonic across restarts even if the whole table was pruned
  // (a plain INTEGER PRIMARY KEY would reuse max(rowid)+1 and rewind cursors).
  // payload is the entity's WIRE-shape JSON (NULL for removes) — the oplog speaks
  // protocol, so replaying it needs no join back to entity tables.
  db.exec(
    `CREATE TABLE IF NOT EXISTS changes (
         seq        INTEGER PRIMARY KEY AUTOINCREMENT,
         entity     TEXT NOT NULL,
         entity_id  TEXT NOT NULL,
         op         TEXT NOT NULL,
         payload    TEXT,
         event_time INTEGER NOT NULL
       )`,
  )
  db.exec('CREATE INDEX IF NOT EXISTS changes_entity ON changes(entity, entity_id, seq)')
  // Outbox write path (docs/spec/outbox-write-path.md). applied_mutations makes
  // replayed writes no-ops (the stored result is returned instead of re-running);
  // queued_messages is the durable per-session send queue that replaced the
  // in-memory sendTextWhenReady timer (survives restarts, never drops silently).
  db.exec(
    `CREATE TABLE IF NOT EXISTS applied_mutations (
         mutation_id TEXT PRIMARY KEY,
         proc        TEXT NOT NULL,
         result      TEXT NOT NULL,
         applied_at  INTEGER NOT NULL
       )`,
  )
  db.exec(
    `CREATE TABLE IF NOT EXISTS queued_messages (
         id         TEXT PRIMARY KEY,
         session_id TEXT NOT NULL,
         text       TEXT NOT NULL,
         queued_at  INTEGER NOT NULL,
         attempts   INTEGER NOT NULL DEFAULT 0
       )`,
  )
  db.exec(
    'CREATE INDEX IF NOT EXISTS queued_messages_session ON queued_messages(session_id, queued_at)',
  )
  // Node⇄hub issue write forwarding (docs/spec/node-hub-issues.md §2.2): the
  // durable outbox of issue mutations targeting viaHub issues, replayed to the
  // hub's tRPC with each entry's mutation_id (hub-side applied_mutations makes
  // the replays idempotent). mutation_id PK doubles as the enqueue dedupe.
  db.exec(
    `CREATE TABLE IF NOT EXISTS upstream_outbox (
         mutation_id TEXT PRIMARY KEY,
         proc        TEXT NOT NULL,
         input       TEXT NOT NULL,
         queued_at   INTEGER NOT NULL,
         attempts    INTEGER NOT NULL DEFAULT 0
       )`,
  )
  // Conversation registry (docs/spec/conversation-registry.md §3.1): identity is
  // Podium-generated and immutable; native session ids / file paths are EVIDENCE
  // attached as segments. A resume that rolls into a new native file adds a
  // segment to the same identity instead of becoming a brand-new conversation.
  db.exec(
    `CREATE TABLE IF NOT EXISTS conversation_identities (
         podium_id        TEXT PRIMARY KEY,
         parent_podium_id TEXT,
         created_at       TEXT NOT NULL
       )`,
  )
  db.exec(
    `CREATE TABLE IF NOT EXISTS conversation_segments (
         machine_id  TEXT NOT NULL,
         native_id   TEXT NOT NULL,
         provider_id TEXT NOT NULL,
         podium_id   TEXT NOT NULL,
         path        TEXT,
         seq_in_conv INTEGER NOT NULL,
         linked_by   TEXT NOT NULL,
         created_at  TEXT NOT NULL,
         mirrored_bytes INTEGER NOT NULL DEFAULT 0,
         mirrored_at TEXT,
         indexed_bytes INTEGER NOT NULL DEFAULT 0,
         reported_bytes INTEGER,
         PRIMARY KEY (machine_id, native_id)
       )`,
  )
  // Mirror-cursor columns (docs/spec/transcript-mirror.md §2.2) and the FTS-index
  // cursor (docs/spec/search-v1.md §2.3) — ALTER for DBs created by earlier
  // registry versions (the CREATE above no-ops there).
  {
    const segCols = new Set(
      (db.prepare('PRAGMA table_info(conversation_segments)').all() as { name: string }[]).map(
        (c) => c.name,
      ),
    )
    if (!segCols.has('mirrored_bytes'))
      db.exec(
        'ALTER TABLE conversation_segments ADD COLUMN mirrored_bytes INTEGER NOT NULL DEFAULT 0',
      )
    if (!segCols.has('mirrored_at'))
      db.exec('ALTER TABLE conversation_segments ADD COLUMN mirrored_at TEXT')
    if (!segCols.has('indexed_bytes'))
      db.exec(
        'ALTER TABLE conversation_segments ADD COLUMN indexed_bytes INTEGER NOT NULL DEFAULT 0',
      )
    // Dirty-driven mirror (transcript-mirror spec §2.3 "Dirty-driven"): the
    // daemon-reported transcript file size, NULLable on purpose — NULL marks a
    // pre-upgrade row that must count as dirty ONCE so the fleet converges.
    if (!segCols.has('reported_bytes'))
      db.exec('ALTER TABLE conversation_segments ADD COLUMN reported_bytes INTEGER')
  }
  db.exec(
    'CREATE INDEX IF NOT EXISTS conversation_segments_podium ON conversation_segments(podium_id, seq_in_conv)',
  )
  // Persistent human-client login sessions (web/desktop UI). We store only the SHA-256
  // of the cookie token, never the token itself, so a DB read can't mint a valid cookie.
  // Persisted (not in-memory) so a server redeploy doesn't force every device to re-login.
  db.exec(
    `CREATE TABLE IF NOT EXISTS client_sessions (
         token_hash TEXT PRIMARY KEY,
         created_at TEXT NOT NULL,
         expires_at TEXT NOT NULL
       )`,
  )
  db.exec(
    `CREATE TABLE IF NOT EXISTS conversations (
         id TEXT PRIMARY KEY,
         agent_kind TEXT NOT NULL,
         provider_id TEXT NOT NULL,
         title TEXT,
         name TEXT,
         summary TEXT,
         project_path TEXT,
         resume_kind TEXT,
         resume_value TEXT,
         created_at TEXT,
         updated_at TEXT,
         message_count INTEGER,
         parent_conversation_id TEXT
       )`,
  )
  // v: parent_conversation_id added so the resume picker can exclude subagent
  // (sidechain) conversations — only top-level sessions are resumable targets.
  // ALTER for pre-existing DBs (CREATE above no-ops there).
  if (
    !(db.prepare('PRAGMA table_info(conversations)').all() as { name: string }[]).some(
      (c) => c.name === 'parent_conversation_id',
    )
  ) {
    db.exec('ALTER TABLE conversations ADD COLUMN parent_conversation_id TEXT')
  }
  // Indices for the two hot conversation queries (audit P1-6): the empty-query
  // browse orders by updated_at, and the project filter / LIKE-fallback search
  // filter by project_path — both were full table scans + filesorts before.
  db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations(updated_at)')
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_conversations_project_path ON conversations(project_path)',
  )
  db.exec(
    `CREATE TABLE IF NOT EXISTS superagent_messages (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         role TEXT NOT NULL,
         content TEXT NOT NULL,
         tool_calls TEXT,
         tool_call_id TEXT,
         tool_name TEXT,
         created_at TEXT NOT NULL
       )`,
  )
  db.exec(
    `CREATE TABLE IF NOT EXISTS superagent_threads (
         id TEXT PRIMARY KEY,
         kind TEXT NOT NULL,
         origin_session_id TEXT,
         title TEXT,
         watermark_item_id TEXT,
         watermark_ts TEXT,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         archived INTEGER NOT NULL DEFAULT 0
       )`,
  )
  // Scope pre-existing (single-thread) messages under 'global' via the column default.
  const saCols = db.prepare('PRAGMA table_info(superagent_messages)').all() as {
    name: string
  }[]
  if (!saCols.some((c) => c.name === 'thread_id')) {
    db.exec("ALTER TABLE superagent_messages ADD COLUMN thread_id TEXT NOT NULL DEFAULT 'global'")
  }
  // Additive column for per-repo concierge threads (issue #64).
  const satCols = db.prepare('PRAGMA table_info(superagent_threads)').all() as {
    name: string
  }[]
  if (!satCols.some((c) => c.name === 'repo_path')) {
    db.exec('ALTER TABLE superagent_threads ADD COLUMN repo_path TEXT')
  }
  // Additive headless-session binding columns (concierge unification): the
  // harness agent frozen onto the thread at its first headless turn, the
  // Podium headless session rendering it, the harness's own resume id, and
  // the PTY session id while "open in terminal" holds the one-writer lock.
  for (const col of ['agent_kind', 'podium_session_id', 'harness_session_id', 'terminal_session_id']) {
    if (!satCols.some((c) => c.name === col)) {
      db.exec(`ALTER TABLE superagent_threads ADD COLUMN ${col} TEXT`)
    }
  }
  db.exec(
    `CREATE TABLE IF NOT EXISTS issues (
         id TEXT PRIMARY KEY,
         repo_path TEXT NOT NULL,
         repo_id TEXT,
         seq INTEGER NOT NULL,
         title TEXT NOT NULL,
         description TEXT NOT NULL DEFAULT '',
         stage TEXT NOT NULL,
         worktree_path TEXT,
         branch TEXT,
         parent_branch TEXT NOT NULL DEFAULT 'main',
         default_agent TEXT NOT NULL,
         default_model TEXT NOT NULL DEFAULT 'auto',
         default_effort TEXT NOT NULL DEFAULT 'auto',
         machine_id TEXT,
         linear_id TEXT,
         linear_identifier TEXT,
         linear_url TEXT,
         activity_notes TEXT,
         notes_updated_at TEXT,
         suggested_stage TEXT,
         suggested_reason TEXT,
         blocked_by TEXT NOT NULL DEFAULT '[]',
         dependency_note TEXT,
         pr_url TEXT,
         priority INTEGER NOT NULL DEFAULT 2,
         type TEXT NOT NULL DEFAULT 'task',
         assignee TEXT,
         parent_id TEXT,
         design TEXT,
         acceptance TEXT,
         notes TEXT,
         due_at TEXT,
         defer_until TEXT,
         closed_reason TEXT,
         superseded_by TEXT,
         duplicate_of TEXT,
         pinned INTEGER NOT NULL DEFAULT 0,
         estimate_min INTEGER,
         needs_human INTEGER NOT NULL DEFAULT 0,
         human_question TEXT,
         panel TEXT,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         archived INTEGER NOT NULL DEFAULT 0,
         origin TEXT NOT NULL DEFAULT 'human',
         draft INTEGER NOT NULL DEFAULT 0,
         read_at TEXT
       )`,
  )
  db.exec('CREATE INDEX IF NOT EXISTS idx_issues_repo ON issues(repo_path)')
  // Additive rich-tracker columns (structural guard — no version marker bump). Fresh
  // DBs already have them from the CREATE above; live DBs gain them in place.
  const issueCols = new Set(
    (db.prepare('PRAGMA table_info(issues)').all() as { name: string }[]).map((c) => c.name),
  )
  const addIssueCol = (name: string, ddl: string): void => {
    if (!issueCols.has(name)) db.exec(`ALTER TABLE issues ADD COLUMN ${ddl}`)
  }
  addIssueCol('repo_id', 'repo_id TEXT')
  addIssueCol('default_model', "default_model TEXT NOT NULL DEFAULT 'auto'")
  addIssueCol('default_effort', "default_effort TEXT NOT NULL DEFAULT 'auto'")
  addIssueCol('machine_id', 'machine_id TEXT')
  addIssueCol('priority', 'priority INTEGER NOT NULL DEFAULT 2')
  addIssueCol('type', "type TEXT NOT NULL DEFAULT 'task'")
  addIssueCol('assignee', 'assignee TEXT')
  addIssueCol('parent_id', 'parent_id TEXT')
  addIssueCol('design', 'design TEXT')
  addIssueCol('acceptance', 'acceptance TEXT')
  addIssueCol('notes', 'notes TEXT')
  addIssueCol('due_at', 'due_at TEXT')
  addIssueCol('defer_until', 'defer_until TEXT')
  addIssueCol('closed_reason', 'closed_reason TEXT')
  addIssueCol('superseded_by', 'superseded_by TEXT')
  addIssueCol('duplicate_of', 'duplicate_of TEXT')
  addIssueCol('pinned', 'pinned INTEGER NOT NULL DEFAULT 0')
  addIssueCol('estimate_min', 'estimate_min INTEGER')
  addIssueCol('needs_human', 'needs_human INTEGER NOT NULL DEFAULT 0')
  addIssueCol('human_question', 'human_question TEXT')
  addIssueCol('panel', 'panel TEXT')
  addIssueCol('origin', "origin TEXT NOT NULL DEFAULT 'human'")
  addIssueCol('draft', 'draft INTEGER NOT NULL DEFAULT 0')
  // Email-style read state (issue #124): nullable ISO timestamp, null = never opened.
  addIssueCol('read_at', 'read_at TEXT')
  db.exec(
    `CREATE TABLE IF NOT EXISTS issue_labels (
         issue_id TEXT NOT NULL,
         label    TEXT NOT NULL,
         PRIMARY KEY (issue_id, label)
       )`,
  )
  db.exec('CREATE INDEX IF NOT EXISTS idx_issue_labels_label ON issue_labels(label)')
  db.exec(
    `CREATE TABLE IF NOT EXISTS issue_deps (
         from_id TEXT NOT NULL,
         to_id   TEXT NOT NULL,
         type    TEXT NOT NULL DEFAULT 'blocks',
         PRIMARY KEY (from_id, to_id, type)
       )`,
  )
  db.exec('CREATE INDEX IF NOT EXISTS idx_issue_deps_from ON issue_deps(from_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_issue_deps_to ON issue_deps(to_id)')
  db.exec(
    `CREATE TABLE IF NOT EXISTS issue_comments (
         id         TEXT PRIMARY KEY,
         issue_id   TEXT NOT NULL,
         author     TEXT NOT NULL,
         body       TEXT NOT NULL,
         created_at TEXT NOT NULL
       )`,
  )
  db.exec('CREATE INDEX IF NOT EXISTS idx_issue_comments_issue ON issue_comments(issue_id)')
  // Agent mail (issue #103): messages addressed to an ISSUE, not a session.
  db.exec(
    `CREATE TABLE IF NOT EXISTS issue_messages (
         id          TEXT PRIMARY KEY,
         issue_id    TEXT NOT NULL,
         from_author TEXT NOT NULL,
         body        TEXT NOT NULL,
         created_at  TEXT NOT NULL,
         status      TEXT NOT NULL DEFAULT 'unread',
         claimed_by  TEXT,
         read_at     TEXT,
         claimed_at  TEXT
       )`,
  )
  db.exec('CREATE INDEX IF NOT EXISTS idx_issue_messages_issue ON issue_messages(issue_id)')
  // Durable orchestrator event log — append-only, cursor = the AUTOINCREMENT id.
  db.exec(
    `CREATE TABLE IF NOT EXISTS podium_events (
         id        INTEGER PRIMARY KEY AUTOINCREMENT,
         ts        TEXT NOT NULL,
         kind      TEXT NOT NULL,
         subject   TEXT NOT NULL,
         repo_path TEXT,
         payload   TEXT NOT NULL DEFAULT '{}'
       )`,
  )
  db.exec('CREATE INDEX IF NOT EXISTS idx_podium_events_kind ON podium_events(kind)')
  // Steward bookkeeping (event-log cursor etc.) — a tiny KV kept separate from
  // `meta` so orchestrator state never collides with the settings blob's keys.
  db.exec(
    `CREATE TABLE IF NOT EXISTS steward_state (
         key   TEXT PRIMARY KEY,
         value TEXT NOT NULL
       )`,
  )
  // Durable event subscriptions (event-subscriptions design, Phase B): an agent
  // (or the seeded defaults) subscribes a subscriber to an event whose source
  // resolves to the event's subject. The steward matches enabled rows on every
  // poll and delivers per deliver_nudge/deliver_notify.
  db.exec(
    `CREATE TABLE IF NOT EXISTS subscriptions (
         id              TEXT PRIMARY KEY,
         subscriber_kind TEXT NOT NULL,
         subscriber_id   TEXT NOT NULL,
         event           TEXT NOT NULL,
         source_kind     TEXT NOT NULL,
         source_ref      TEXT NOT NULL,
         deliver_nudge   INTEGER NOT NULL DEFAULT 1,
         deliver_notify  INTEGER NOT NULL DEFAULT 0,
         origin          TEXT NOT NULL DEFAULT 'custom',
         enabled         INTEGER NOT NULL DEFAULT 1,
         created_at      TEXT NOT NULL
       )`,
  )
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_subscriptions_subscriber ON subscriptions(subscriber_id)',
  )
  // Idempotent, replay-safe delivery ledger: one row per (subscription, event)
  // actually delivered. markDelivered's INSERT OR IGNORE is the dedup — a
  // cursor-rewind replay re-matches but never re-delivers.
  db.exec(
    `CREATE TABLE IF NOT EXISTS subscription_deliveries (
         subscription_id TEXT NOT NULL,
         event_id        INTEGER NOT NULL,
         PRIMARY KEY (subscription_id, event_id)
       )`,
  )
  // v1 -> v2: tmux_label -> durable_label (the label now names an abduco OR tmux
  // session; see the durable-backend selection in the daemon). For a pre-rename db
  // the CREATE above no-ops, so the old column is still there — rename it in place.
  const cols = db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]
  if (cols.some((c) => c.name === 'tmux_label')) {
    db.exec('ALTER TABLE sessions RENAME COLUMN tmux_label TO durable_label')
  }
  // v2 -> v3: session curation columns (user name, archive flag, kanban state).
  // Fresh DBs get them from the CREATE above; pre-v3 tables gain them in place.
  const colNames = new Set(cols.map((c) => c.name))
  if (!colNames.has('name')) db.exec('ALTER TABLE sessions ADD COLUMN name TEXT')
  if (!colNames.has('archived'))
    db.exec('ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0')
  if (!colNames.has('work_state')) db.exec('ALTER TABLE sessions ADD COLUMN work_state TEXT')
  // Additive activity-timestamp columns (no version-gate bump): durable hibernation
  // signals; old rows read NULL and behave as before until first live activity.
  // Structural guard (column-presence), no version marker change.
  if (!colNames.has('last_output_at'))
    db.exec('ALTER TABLE sessions ADD COLUMN last_output_at TEXT')
  if (!colNames.has('last_input_at')) db.exec('ALTER TABLE sessions ADD COLUMN last_input_at TEXT')
  if (!colNames.has('last_resumed_at'))
    db.exec('ALTER TABLE sessions ADD COLUMN last_resumed_at TEXT')
  // Additive provenance column (issue #60): WHO created the session. Legacy rows
  // read NULL (creator unknown). Structural guard, no version marker change.
  if (!colNames.has('spawned_by')) db.exec('ALTER TABLE sessions ADD COLUMN spawned_by TEXT')
  // v3 -> v4: per-session composer drafts (issue #34). A brand-new standalone
  // table created by the CREATE IF NOT EXISTS above — pre-v4 DBs gain it with no
  // ALTER, so the bump is just the recorded version marker.
  // v4 -> v5: machines table + machine attribution on sessions, conversations, repos.
  // The whole migration runs inside the runner's transaction, so a mid-rebuild crash
  // leaves the DB fully pre-v5 and the next boot retries cleanly.
  // The guard (`needsMachineMigration`) is STRUCTURAL — it inspects the actual
  // schema (machines table + machine_id columns) rather than the version marker —
  // so it is correct regardless of how the version number was previously bumped.
  const sessionCols = new Set(
    (db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map((c) => c.name),
  )
  const convCols = new Set(
    (db.prepare('PRAGMA table_info(conversations)').all() as { name: string }[]).map((c) => c.name),
  )
  // repos re-key: (path) PRIMARY KEY -> (machine_id, path) + origin_url.
  // Guard: only rebuild if the old single-column schema exists (no machine_id column).
  const repoCols = new Set(
    (db.prepare('PRAGMA table_info(repos)').all() as { name: string }[]).map((c) => c.name),
  )
  const needsMachineMigration =
    !db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='machines'").get() ||
    !sessionCols.has('machine_id') ||
    !convCols.has('machine_id') ||
    !repoCols.has('machine_id')
  if (needsMachineMigration) {
    // The machines table is safe to CREATE IF NOT EXISTS on every boot.
    db.exec(
      `CREATE TABLE IF NOT EXISTS machines (
             id TEXT PRIMARY KEY,
             name TEXT NOT NULL,
             hostname TEXT NOT NULL,
             token_hash TEXT NOT NULL,
             created_at TEXT NOT NULL,
             last_seen_at TEXT NOT NULL
           )`,
    )
    if (!sessionCols.has('machine_id')) {
      db.exec("ALTER TABLE sessions ADD COLUMN machine_id TEXT NOT NULL DEFAULT '__local__'")
    }
    if (!convCols.has('machine_id')) {
      db.exec("ALTER TABLE conversations ADD COLUMN machine_id TEXT NOT NULL DEFAULT '__local__'")
    }
    if (!repoCols.has('machine_id')) {
      db.exec(
        `CREATE TABLE repos_v5 (
               machine_id TEXT NOT NULL DEFAULT '__local__',
               path TEXT NOT NULL,
               origin_url TEXT,
               repo_name TEXT,
               added_at TEXT NOT NULL,
               PRIMARY KEY (machine_id, path)
             )`,
      )
      db.exec(
        "INSERT INTO repos_v5 (machine_id, path, added_at) SELECT '__local__', path, added_at FROM repos",
      )
      db.exec('DROP TABLE repos')
      db.exec('ALTER TABLE repos_v5 RENAME TO repos')
    }
  }
  // v7 -> v8: stable repo identity (#74). Structural guard: repos.repo_id may be
  // missing either on a pre-v8 DB or right after the machine-migration rebuild
  // above (repos_v5 is created without it), so re-inspect the actual schema here.
  const repoColsV8 = new Set(
    (db.prepare('PRAGMA table_info(repos)').all() as { name: string }[]).map((c) => c.name),
  )
  if (!repoColsV8.has('repo_id')) db.exec('ALTER TABLE repos ADD COLUMN repo_id TEXT')
  // Legacy at-a-glance coherence marker (meta.schema_version = 9): nothing reads
  // it any more (the schema_version TABLE is authoritative), but keep it written
  // so the two build paths stay data-identical and an older inspector still sees
  // a sane value.
  const v = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
    | { value: string }
    | undefined
  if (!v || Number(v.value) < 9)
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', '9')
}
