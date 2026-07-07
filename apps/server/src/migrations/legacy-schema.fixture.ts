/**
 * sqlite_master DDL of a database built by the LEGACY SessionStore.migrate()
 * path (captured from the last commit where migrate() still owned the DDL,
 * immediately before the schema moved into numbered migrations). Used by
 * convergence.test.ts to prove that migrating an existing database yields a
 * byte-identical schema to building a fresh one through the migration chain.
 *
 * Environment-conditional objects (conversations_fts/transcript_fts shadow
 * tables and their triggers) are excluded: they are created by the per-boot
 * ensureFts step on BOTH paths, so they converge by construction.
 *
 * Do not regenerate — this is a historical snapshot.
 */
export const LEGACY_SCHEMA_SQL: string[] = [
  "CREATE TABLE schema_version (\n       version INTEGER PRIMARY KEY,\n       name TEXT NOT NULL,\n       applied_at TEXT NOT NULL\n     )",
  "CREATE TABLE repos (\n         machine_id TEXT NOT NULL DEFAULT '__local__',\n         path TEXT NOT NULL,\n         origin_url TEXT,\n         repo_name TEXT,\n         repo_id TEXT,\n         added_at TEXT NOT NULL,\n         PRIMARY KEY (machine_id, path)\n       )",
  "CREATE TABLE pins (\n         kind TEXT NOT NULL,\n         id TEXT NOT NULL,\n         pinned_at TEXT NOT NULL,\n         PRIMARY KEY (kind, id)\n       )",
  "CREATE TABLE snoozes (\n         session_id TEXT PRIMARY KEY,\n         snoozed_until TEXT,\n         created_at TEXT NOT NULL\n       )",
  "CREATE TABLE sessions (\n         id TEXT PRIMARY KEY,\n         agent_kind TEXT NOT NULL,\n         cwd TEXT NOT NULL,\n         title TEXT NOT NULL,\n         name TEXT,\n         origin_kind TEXT NOT NULL,\n         conversation_id TEXT,\n         resume_kind TEXT,\n         resume_value TEXT,\n         status TEXT NOT NULL,\n         exit_code INTEGER,\n         durable_label TEXT NOT NULL,\n         created_at TEXT NOT NULL,\n         last_active_at TEXT NOT NULL,\n         archived INTEGER NOT NULL DEFAULT 0,\n         work_state TEXT,\n         last_output_at TEXT,\n         last_input_at TEXT,\n         last_resumed_at TEXT,\n         spawned_by TEXT,\n         headless INTEGER NOT NULL DEFAULT 0,\n         issue_id TEXT,\n         read_at TEXT\n       , machine_id TEXT NOT NULL DEFAULT '__local__')",
  "CREATE TABLE tab_order (\n         worktree TEXT PRIMARY KEY,\n         ids TEXT NOT NULL,\n         updated_at TEXT NOT NULL\n       )",
  "CREATE TABLE session_drafts (\n         session_id TEXT PRIMARY KEY,\n         text TEXT NOT NULL,\n         updated_at TEXT NOT NULL\n       )",
  "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  "CREATE TABLE changes (\n         seq        INTEGER PRIMARY KEY AUTOINCREMENT,\n         entity     TEXT NOT NULL,\n         entity_id  TEXT NOT NULL,\n         op         TEXT NOT NULL,\n         payload    TEXT,\n         event_time INTEGER NOT NULL\n       )",
  "CREATE INDEX changes_entity ON changes(entity, entity_id, seq)",
  "CREATE TABLE applied_mutations (\n         mutation_id TEXT PRIMARY KEY,\n         proc        TEXT NOT NULL,\n         result      TEXT NOT NULL,\n         applied_at  INTEGER NOT NULL\n       )",
  "CREATE TABLE queued_messages (\n         id         TEXT PRIMARY KEY,\n         session_id TEXT NOT NULL,\n         text       TEXT NOT NULL,\n         queued_at  INTEGER NOT NULL,\n         attempts   INTEGER NOT NULL DEFAULT 0\n       )",
  "CREATE INDEX queued_messages_session ON queued_messages(session_id, queued_at)",
  "CREATE TABLE upstream_outbox (\n         mutation_id TEXT PRIMARY KEY,\n         proc        TEXT NOT NULL,\n         input       TEXT NOT NULL,\n         queued_at   INTEGER NOT NULL,\n         attempts    INTEGER NOT NULL DEFAULT 0\n       )",
  "CREATE TABLE conversation_identities (\n         podium_id        TEXT PRIMARY KEY,\n         parent_podium_id TEXT,\n         created_at       TEXT NOT NULL\n       )",
  "CREATE TABLE conversation_segments (\n         machine_id  TEXT NOT NULL,\n         native_id   TEXT NOT NULL,\n         provider_id TEXT NOT NULL,\n         podium_id   TEXT NOT NULL,\n         path        TEXT,\n         seq_in_conv INTEGER NOT NULL,\n         linked_by   TEXT NOT NULL,\n         created_at  TEXT NOT NULL,\n         mirrored_bytes INTEGER NOT NULL DEFAULT 0,\n         mirrored_at TEXT,\n         indexed_bytes INTEGER NOT NULL DEFAULT 0,\n         reported_bytes INTEGER,\n         PRIMARY KEY (machine_id, native_id)\n       )",
  "CREATE INDEX conversation_segments_podium ON conversation_segments(podium_id, seq_in_conv)",
  "CREATE TABLE client_sessions (\n         token_hash TEXT PRIMARY KEY,\n         created_at TEXT NOT NULL,\n         expires_at TEXT NOT NULL\n       )",
  "CREATE TABLE conversations (\n         id TEXT PRIMARY KEY,\n         agent_kind TEXT NOT NULL,\n         provider_id TEXT NOT NULL,\n         title TEXT,\n         name TEXT,\n         summary TEXT,\n         project_path TEXT,\n         resume_kind TEXT,\n         resume_value TEXT,\n         created_at TEXT,\n         updated_at TEXT,\n         message_count INTEGER,\n         parent_conversation_id TEXT\n       , machine_id TEXT NOT NULL DEFAULT '__local__')",
  "CREATE INDEX idx_conversations_updated_at ON conversations(updated_at)",
  "CREATE INDEX idx_conversations_project_path ON conversations(project_path)",
  "CREATE TABLE superagent_messages (\n         id INTEGER PRIMARY KEY AUTOINCREMENT,\n         role TEXT NOT NULL,\n         content TEXT NOT NULL,\n         tool_calls TEXT,\n         tool_call_id TEXT,\n         tool_name TEXT,\n         created_at TEXT NOT NULL\n       , thread_id TEXT NOT NULL DEFAULT 'global')",
  "CREATE TABLE superagent_threads (\n         id TEXT PRIMARY KEY,\n         kind TEXT NOT NULL,\n         origin_session_id TEXT,\n         title TEXT,\n         watermark_item_id TEXT,\n         watermark_ts TEXT,\n         created_at TEXT NOT NULL,\n         updated_at TEXT NOT NULL,\n         archived INTEGER NOT NULL DEFAULT 0\n       , repo_path TEXT, agent_kind TEXT, podium_session_id TEXT, harness_session_id TEXT, terminal_session_id TEXT)",
  "CREATE TABLE issues (\n         id TEXT PRIMARY KEY,\n         repo_path TEXT NOT NULL,\n         repo_id TEXT,\n         seq INTEGER NOT NULL,\n         title TEXT NOT NULL,\n         description TEXT NOT NULL DEFAULT '',\n         stage TEXT NOT NULL,\n         worktree_path TEXT,\n         branch TEXT,\n         parent_branch TEXT NOT NULL DEFAULT 'main',\n         default_agent TEXT NOT NULL,\n         default_model TEXT NOT NULL DEFAULT 'auto',\n         default_effort TEXT NOT NULL DEFAULT 'auto',\n         machine_id TEXT,\n         linear_id TEXT,\n         linear_identifier TEXT,\n         linear_url TEXT,\n         activity_notes TEXT,\n         notes_updated_at TEXT,\n         suggested_stage TEXT,\n         suggested_reason TEXT,\n         blocked_by TEXT NOT NULL DEFAULT '[]',\n         dependency_note TEXT,\n         pr_url TEXT,\n         priority INTEGER NOT NULL DEFAULT 2,\n         type TEXT NOT NULL DEFAULT 'task',\n         assignee TEXT,\n         parent_id TEXT,\n         design TEXT,\n         acceptance TEXT,\n         notes TEXT,\n         due_at TEXT,\n         defer_until TEXT,\n         closed_reason TEXT,\n         superseded_by TEXT,\n         duplicate_of TEXT,\n         pinned INTEGER NOT NULL DEFAULT 0,\n         estimate_min INTEGER,\n         needs_human INTEGER NOT NULL DEFAULT 0,\n         human_question TEXT,\n         panel TEXT,\n         created_at TEXT NOT NULL,\n         updated_at TEXT NOT NULL,\n         archived INTEGER NOT NULL DEFAULT 0,\n         origin TEXT NOT NULL DEFAULT 'human',\n         draft INTEGER NOT NULL DEFAULT 0,\n         read_at TEXT\n       )",
  "CREATE INDEX idx_issues_repo ON issues(repo_path)",
  "CREATE TABLE issue_labels (\n         issue_id TEXT NOT NULL,\n         label    TEXT NOT NULL,\n         PRIMARY KEY (issue_id, label)\n       )",
  "CREATE INDEX idx_issue_labels_label ON issue_labels(label)",
  "CREATE TABLE issue_deps (\n         from_id TEXT NOT NULL,\n         to_id   TEXT NOT NULL,\n         type    TEXT NOT NULL DEFAULT 'blocks',\n         PRIMARY KEY (from_id, to_id, type)\n       )",
  "CREATE INDEX idx_issue_deps_from ON issue_deps(from_id)",
  "CREATE INDEX idx_issue_deps_to ON issue_deps(to_id)",
  "CREATE TABLE issue_comments (\n         id         TEXT PRIMARY KEY,\n         issue_id   TEXT NOT NULL,\n         author     TEXT NOT NULL,\n         body       TEXT NOT NULL,\n         created_at TEXT NOT NULL\n       )",
  "CREATE INDEX idx_issue_comments_issue ON issue_comments(issue_id)",
  "CREATE TABLE issue_messages (\n         id          TEXT PRIMARY KEY,\n         issue_id    TEXT NOT NULL,\n         from_author TEXT NOT NULL,\n         body        TEXT NOT NULL,\n         created_at  TEXT NOT NULL,\n         status      TEXT NOT NULL DEFAULT 'unread',\n         claimed_by  TEXT,\n         read_at     TEXT,\n         claimed_at  TEXT\n       )",
  "CREATE INDEX idx_issue_messages_issue ON issue_messages(issue_id)",
  "CREATE TABLE podium_events (\n         id        INTEGER PRIMARY KEY AUTOINCREMENT,\n         ts        TEXT NOT NULL,\n         kind      TEXT NOT NULL,\n         subject   TEXT NOT NULL,\n         repo_path TEXT,\n         payload   TEXT NOT NULL DEFAULT '{}'\n       )",
  "CREATE INDEX idx_podium_events_kind ON podium_events(kind)",
  "CREATE TABLE steward_state (\n         key   TEXT PRIMARY KEY,\n         value TEXT NOT NULL\n       )",
  "CREATE TABLE subscriptions (\n         id              TEXT PRIMARY KEY,\n         subscriber_kind TEXT NOT NULL,\n         subscriber_id   TEXT NOT NULL,\n         event           TEXT NOT NULL,\n         source_kind     TEXT NOT NULL,\n         source_ref      TEXT NOT NULL,\n         deliver_nudge   INTEGER NOT NULL DEFAULT 1,\n         deliver_notify  INTEGER NOT NULL DEFAULT 0,\n         origin          TEXT NOT NULL DEFAULT 'custom',\n         enabled         INTEGER NOT NULL DEFAULT 1,\n         created_at      TEXT NOT NULL\n       )",
  "CREATE INDEX idx_subscriptions_subscriber ON subscriptions(subscriber_id)",
  "CREATE TABLE subscription_deliveries (\n         subscription_id TEXT NOT NULL,\n         event_id        INTEGER NOT NULL,\n         PRIMARY KEY (subscription_id, event_id)\n       )",
  "CREATE TABLE machines (\n             id TEXT PRIMARY KEY,\n             name TEXT NOT NULL,\n             hostname TEXT NOT NULL,\n             token_hash TEXT NOT NULL,\n             created_at TEXT NOT NULL,\n             last_seen_at TEXT NOT NULL\n           )",
]
