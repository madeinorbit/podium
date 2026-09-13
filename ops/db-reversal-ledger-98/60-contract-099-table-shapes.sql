--
-- REVERSE MIGRATION TO LEDGER 98 -- 99, THE TABLE SHAPES
--
-- Part of ops/db-reversal-ledger-98. Applied by revert-to-ledger-98.sh, which
-- wraps the whole set in ONE transaction: either the database reaches ledger 98
-- or it is left exactly as it was found. Nothing here is a drizzle migration --
-- this repo's migrations are forward-only by design (scripts/audit-expand-only-
-- migrations.ts says so in its header) and there is no `down` concept to use.
-- See 00-preflight.sql for why this is a one-shot script and not a migration.
--

-- Migration 99 rebuilt TWELVE tables. `issues` is done in 20-*.sql; the other
-- eleven are here. Every rebuild is the same shape and none of them loses a
-- column -- the column SET is identical either side, only the ORDER and the
-- DEFAULTs differ:
--
--   * the `DEFAULT 'user:sole'` came off every principal column (that is what 99
--     was for), and SQLite cannot restore a default in place;
--   * the rebuild re-emitted each table in schema.ts order, which MOVED every
--     column that had arrived by ALTER TABLE ADD COLUMN -- seven of them on
--     `sessions` alone -- from the end of the row into the middle.
--
-- Column order is not cosmetic to the shipping binary: `SELECT *` and
-- `INSERT INTO t VALUES (...)` both bind by position. So each table is recreated
-- from the EXACT `sqlite_master.sql` text of the ledger-98 backup and refilled
-- by NAME, which is the only mapping that survives a reordering.
--
-- One index changes with them: 99 re-created `idx_automation_runs_automation`
-- as (automation_id, fired_at) where ledger 98 had (automation_id, fired_at
-- DESC). The ledger-98 spelling comes back below.

CREATE TABLE "__rev_stash_automation_runs" AS SELECT * FROM "automation_runs";

DROP TABLE "automation_runs";

CREATE TABLE automation_runs (
      id            TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
      fired_at      TEXT NOT NULL,
      session_id    TEXT,
      outcome       TEXT NOT NULL
        CHECK (outcome IN ('spawned','missed','skipped_overlap','error')),
      detail        TEXT
    , `actor` text DEFAULT 'system:automation-migration' NOT NULL, `on_behalf_of` text DEFAULT 'user:sole' NOT NULL, `deleted_at` text);

INSERT INTO "automation_runs" ("id", "automation_id", "fired_at", "session_id", "outcome", "detail", "actor", "on_behalf_of", "deleted_at")
SELECT "id", "automation_id", "fired_at", "session_id", "outcome", "detail", "actor", "on_behalf_of", "deleted_at"
FROM "__rev_stash_automation_runs" AS s;

DROP TABLE "__rev_stash_automation_runs";

CREATE INDEX idx_automation_runs_automation
      ON automation_runs(automation_id, fired_at DESC);

CREATE TABLE "__rev_stash_automations" AS SELECT * FROM "automations";

DROP TABLE "automations";

CREATE TABLE automations (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      enabled     INTEGER NOT NULL DEFAULT 0,
      repo_path   TEXT,
      cron        TEXT NOT NULL,
      agent_kind  TEXT NOT NULL,
      model       TEXT NOT NULL DEFAULT 'auto',
      effort      TEXT NOT NULL DEFAULT 'auto',
      prompt      TEXT NOT NULL,
      next_run_at TEXT,
      last_run_at TEXT,
      created_at  TEXT NOT NULL
    , session_mode TEXT NOT NULL DEFAULT 'fresh' CHECK (session_mode IN ('fresh', 'resume')), `schedule_kind` text DEFAULT 'cron' NOT NULL, `run_at` text, `target_session_id` text, `owner_user_id` text DEFAULT 'user:sole' NOT NULL, `created_by_actor` text DEFAULT 'user:sole' NOT NULL, `created_by_on_behalf_of` text DEFAULT 'user:sole' NOT NULL, `deleted_at` text);

INSERT INTO "automations" ("id", "name", "enabled", "repo_path", "cron", "agent_kind", "model", "effort", "prompt", "next_run_at", "last_run_at", "created_at", "session_mode", "schedule_kind", "run_at", "target_session_id", "owner_user_id", "created_by_actor", "created_by_on_behalf_of", "deleted_at")
SELECT "id", "name", "enabled", "repo_path", "cron", "agent_kind", "model", "effort", "prompt", "next_run_at", "last_run_at", "created_at", "session_mode", "schedule_kind", "run_at", "target_session_id", "owner_user_id", "created_by_actor", "created_by_on_behalf_of", "deleted_at"
FROM "__rev_stash_automations" AS s;

DROP TABLE "__rev_stash_automations";

CREATE TABLE "__rev_stash_execution_profiles" AS SELECT * FROM "execution_profiles";

DROP TABLE "execution_profiles";

CREATE TABLE execution_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      account_id TEXT NOT NULL,
      machine_id TEXT,
      harness TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT 'auto',
      effort TEXT NOT NULL DEFAULT 'auto',
      created_by_kind TEXT NOT NULL CHECK (created_by_kind IN ('operator', 'session')),
      created_by_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    , `owner_user_id` text DEFAULT 'user:sole' NOT NULL);

INSERT INTO "execution_profiles" ("id", "name", "account_id", "machine_id", "harness", "model", "effort", "created_by_kind", "created_by_id", "created_at", "updated_at", "owner_user_id")
SELECT "id", "name", "account_id", "machine_id", "harness", "model", "effort", "created_by_kind", "created_by_id", "created_at", "updated_at", "owner_user_id"
FROM "__rev_stash_execution_profiles" AS s;

DROP TABLE "__rev_stash_execution_profiles";

CREATE TABLE "__rev_stash_sessions" AS SELECT * FROM "sessions";

DROP TABLE "sessions";

CREATE TABLE "sessions" (
	`id` text PRIMARY KEY,
	`owner_user_id` text DEFAULT 'user:sole' NOT NULL,
	`agent_kind` text NOT NULL,
	`model` text,
	`effort` text,
	`account_id` text,
	`cwd` text NOT NULL,
	`title` text NOT NULL,
	`origin_kind` text NOT NULL,
	`conversation_id` text,
	`resume_kind` text,
	`resume_value` text,
	`status` text NOT NULL,
	`exit_code` integer,
	`spawn_failure` text,
	`durable_label` text NOT NULL,
	`created_at` text NOT NULL,
	`last_active_at` text NOT NULL,
	`name` text,
	`archived` integer DEFAULT 0 NOT NULL,
	`work_state` text,
	`machine_id` text NOT NULL,
	`last_output_at` text,
	`last_input_at` text,
	`last_resumed_at` text,
	`spawned_by` text,
	`headless` integer DEFAULT 0 NOT NULL,
	`issue_id` text,
	`stopped_at` text,
	`stop_reason` text,
	`deleted_at` text,
	`deleted_by_issue_id` text,
	`deletion_source` text,
	`workflow_run_id` text,
	`workflow_step_id` text,
	`execution_profile_id` text,
	`name_source` text,
	`ref_issue_id` text,
	`ref_letter` text,
	`ref_draft` integer,
	`terminal_cols` integer DEFAULT 80 NOT NULL,
	`terminal_rows` integer DEFAULT 24 NOT NULL,
	`working_ms_total` integer,
	`input_count` integer DEFAULT 0 NOT NULL,
	`output_count` integer DEFAULT 0 NOT NULL,
	`activity_count` integer DEFAULT 0 NOT NULL,
	`created_by_actor_kind` text,
	`created_by_actor_id` text,
	`created_by_on_behalf_of` text, `login_harness` text, `conversation_binding` text, `selected_driver_id` text, `oom_killed_at` text, `requested_model` text, `requested_effort` text, `requested_driver_id` text,
	CONSTRAINT "sessions_stop_reason_check" CHECK(stop_reason IS NULL OR stop_reason IN ('self', 'parent', 'forced', 'exited')),
	CONSTRAINT "sessions_created_by_actor_kind" CHECK(created_by_actor_kind IS NULL OR created_by_actor_kind IN ('user', 'agent', 'machine', 'system')),
	CONSTRAINT "sessions_created_by_system_has_no_human" CHECK(created_by_actor_kind <> 'system' OR created_by_on_behalf_of IS NULL)
);

INSERT INTO "sessions" ("id", "owner_user_id", "agent_kind", "model", "effort", "account_id", "cwd", "title", "origin_kind", "conversation_id", "resume_kind", "resume_value", "status", "exit_code", "spawn_failure", "durable_label", "created_at", "last_active_at", "name", "archived", "work_state", "machine_id", "last_output_at", "last_input_at", "last_resumed_at", "spawned_by", "headless", "issue_id", "stopped_at", "stop_reason", "deleted_at", "deleted_by_issue_id", "deletion_source", "workflow_run_id", "workflow_step_id", "execution_profile_id", "name_source", "ref_issue_id", "ref_letter", "ref_draft", "terminal_cols", "terminal_rows", "working_ms_total", "input_count", "output_count", "activity_count", "created_by_actor_kind", "created_by_actor_id", "created_by_on_behalf_of", "login_harness", "conversation_binding", "selected_driver_id", "oom_killed_at", "requested_model", "requested_effort", "requested_driver_id")
SELECT "id", "owner_user_id", "agent_kind", "model", "effort", "account_id", "cwd", "title", "origin_kind", "conversation_id", "resume_kind", "resume_value", "status", "exit_code", "spawn_failure", "durable_label", "created_at", "last_active_at", "name", "archived", "work_state", "machine_id", "last_output_at", "last_input_at", "last_resumed_at", "spawned_by", "headless", "issue_id", "stopped_at", "stop_reason", "deleted_at", "deleted_by_issue_id", "deletion_source", "workflow_run_id", "workflow_step_id", "execution_profile_id", "name_source", "ref_issue_id", "ref_letter", "ref_draft", "terminal_cols", "terminal_rows", "working_ms_total", "input_count", "output_count", "activity_count", "created_by_actor_kind", "created_by_actor_id", "created_by_on_behalf_of", "login_harness", "conversation_binding", "selected_driver_id", "oom_killed_at", "requested_model", "requested_effort", "requested_driver_id"
FROM "__rev_stash_sessions" AS s;

DROP TABLE "__rev_stash_sessions";

CREATE INDEX `idx_sessions_deleted_at` ON `sessions` (`deleted_at`);

CREATE INDEX `idx_sessions_deleted_by_issue` ON `sessions` (`deleted_by_issue_id`);

CREATE INDEX `idx_sessions_resume_machine` ON `sessions` (`resume_value`,`machine_id`);

CREATE TABLE "__rev_stash_superagent_messages" AS SELECT * FROM "superagent_messages";

DROP TABLE "superagent_messages";

CREATE TABLE superagent_messages (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         role TEXT NOT NULL,
         content TEXT NOT NULL,
         tool_calls TEXT,
         tool_call_id TEXT,
         tool_name TEXT,
         created_at TEXT NOT NULL
       , thread_id TEXT NOT NULL DEFAULT 'global', `owner_user_id` text DEFAULT 'user:sole' NOT NULL);

INSERT INTO "superagent_messages" ("id", "role", "content", "tool_calls", "tool_call_id", "tool_name", "created_at", "thread_id", "owner_user_id")
SELECT "id", "role", "content", "tool_calls", "tool_call_id", "tool_name", "created_at", "thread_id", "owner_user_id"
FROM "__rev_stash_superagent_messages" AS s;

DROP TABLE "__rev_stash_superagent_messages";

CREATE TABLE "__rev_stash_superagent_pending_turns" AS SELECT * FROM "superagent_pending_turns";

DROP TABLE "superagent_pending_turns";

CREATE TABLE superagent_pending_turns (
       turn_id TEXT PRIMARY KEY,
       thread_id TEXT NOT NULL UNIQUE,
       podium_session_id TEXT NOT NULL,
       payload_json TEXT NOT NULL,
       first_turn INTEGER NOT NULL DEFAULT 0,
       created_at TEXT NOT NULL
     , `owner_user_id` text DEFAULT 'user:sole' NOT NULL, `actor` text, `on_behalf_of` text);

INSERT INTO "superagent_pending_turns" ("turn_id", "thread_id", "podium_session_id", "payload_json", "first_turn", "created_at", "owner_user_id", "actor", "on_behalf_of")
SELECT "turn_id", "thread_id", "podium_session_id", "payload_json", "first_turn", "created_at", "owner_user_id", "actor", "on_behalf_of"
FROM "__rev_stash_superagent_pending_turns" AS s;

DROP TABLE "__rev_stash_superagent_pending_turns";

CREATE TABLE "__rev_stash_superagent_queued_inputs" AS SELECT * FROM "superagent_queued_inputs";

DROP TABLE "superagent_queued_inputs";

CREATE TABLE "superagent_queued_inputs" (
	`owner_user_id` text DEFAULT 'user:sole' NOT NULL,
	`input_id` text PRIMARY KEY,
	`thread_id` text NOT NULL,
	`text` text NOT NULL,
	`focus_json` text,
	`created_at` text NOT NULL,
	`actor` text,
	`on_behalf_of` text
, `agent_kind` text, `attach_session_id` text);

INSERT INTO "superagent_queued_inputs" ("owner_user_id", "input_id", "thread_id", "text", "focus_json", "created_at", "actor", "on_behalf_of", "agent_kind", "attach_session_id")
SELECT "owner_user_id", "input_id", "thread_id", "text", "focus_json", "created_at", "actor", "on_behalf_of", "agent_kind", "attach_session_id"
FROM "__rev_stash_superagent_queued_inputs" AS s;

DROP TABLE "__rev_stash_superagent_queued_inputs";

CREATE INDEX `idx_superagent_queued_thread_order` ON `superagent_queued_inputs` (`thread_id`,`created_at`);

CREATE TABLE "__rev_stash_superagent_threads" AS SELECT * FROM "superagent_threads";

DROP TABLE "superagent_threads";

CREATE TABLE superagent_threads (
         id TEXT PRIMARY KEY,
         kind TEXT NOT NULL,
         origin_session_id TEXT,
         title TEXT,
         watermark_item_id TEXT,
         watermark_ts TEXT,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         archived INTEGER NOT NULL DEFAULT 0
       , repo_path TEXT, agent_kind TEXT, podium_session_id TEXT, harness_session_id TEXT, terminal_session_id TEXT, `owner_user_id` text DEFAULT 'user:sole' NOT NULL, `model` text, `effort` text);

INSERT INTO "superagent_threads" ("id", "kind", "origin_session_id", "title", "watermark_item_id", "watermark_ts", "created_at", "updated_at", "archived", "repo_path", "agent_kind", "podium_session_id", "harness_session_id", "terminal_session_id", "owner_user_id", "model", "effort")
SELECT "id", "kind", "origin_session_id", "title", "watermark_item_id", "watermark_ts", "created_at", "updated_at", "archived", "repo_path", "agent_kind", "podium_session_id", "harness_session_id", "terminal_session_id", "owner_user_id", "model", "effort"
FROM "__rev_stash_superagent_threads" AS s;

DROP TABLE "__rev_stash_superagent_threads";

CREATE TABLE "__rev_stash_workflow_bindings" AS SELECT * FROM "workflow_bindings";

DROP TABLE "workflow_bindings";

CREATE TABLE workflow_bindings (
      target_kind TEXT NOT NULL CHECK (target_kind IN ('global', 'repository', 'issue', 'session')),
      target_id TEXT NOT NULL,
      revision_id TEXT NOT NULL REFERENCES workflow_revisions(id) ON DELETE RESTRICT,
      updated_by_kind TEXT NOT NULL CHECK (updated_by_kind IN ('operator', 'session')),
      updated_by_id TEXT,
      updated_at TEXT NOT NULL, `owner_user_id` text DEFAULT 'user:sole' NOT NULL,
      PRIMARY KEY(target_kind, target_id)
    );

INSERT INTO "workflow_bindings" ("target_kind", "target_id", "revision_id", "updated_by_kind", "updated_by_id", "updated_at", "owner_user_id")
SELECT "target_kind", "target_id", "revision_id", "updated_by_kind", "updated_by_id", "updated_at", "owner_user_id"
FROM "__rev_stash_workflow_bindings" AS s;

DROP TABLE "__rev_stash_workflow_bindings";

CREATE TABLE "__rev_stash_workflow_runs" AS SELECT * FROM "workflow_runs";

DROP TABLE "workflow_runs";

CREATE TABLE workflow_runs (
      id TEXT PRIMARY KEY,
      subject_kind TEXT NOT NULL CHECK (subject_kind IN ('issue', 'session')),
      subject_id TEXT NOT NULL,
      coordinator_session_id TEXT NOT NULL,
      revision_id TEXT NOT NULL REFERENCES workflow_revisions(id) ON DELETE RESTRICT,
      status TEXT NOT NULL CHECK (status IN ('active', 'blocked', 'complete', 'superseded')),
      supersedes_run_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT
    , `owner_user_id` text DEFAULT 'user:sole' NOT NULL);

INSERT INTO "workflow_runs" ("id", "subject_kind", "subject_id", "coordinator_session_id", "revision_id", "status", "supersedes_run_id", "started_at", "completed_at", "owner_user_id")
SELECT "id", "subject_kind", "subject_id", "coordinator_session_id", "revision_id", "status", "supersedes_run_id", "started_at", "completed_at", "owner_user_id"
FROM "__rev_stash_workflow_runs" AS s;

DROP TABLE "__rev_stash_workflow_runs";

CREATE INDEX workflow_runs_coordinator ON workflow_runs(coordinator_session_id, started_at DESC);

CREATE UNIQUE INDEX workflow_runs_one_live_subject
      ON workflow_runs(subject_kind, subject_id)
      WHERE status IN ('active', 'blocked');

CREATE TABLE "__rev_stash_workflows" AS SELECT * FROM "workflows";

DROP TABLE "workflows";

CREATE TABLE workflows (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      scope TEXT NOT NULL CHECK (scope IN ('global', 'repository', 'task')),
      scope_ref TEXT,
      latest_revision_id TEXT,
      archived_at TEXT,
      created_by_kind TEXT NOT NULL CHECK (created_by_kind IN ('operator', 'session')),
      created_by_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    , `owner_user_id` text DEFAULT 'user:sole' NOT NULL);

INSERT INTO "workflows" ("id", "name", "description", "scope", "scope_ref", "latest_revision_id", "archived_at", "created_by_kind", "created_by_id", "created_at", "updated_at", "owner_user_id")
SELECT "id", "name", "description", "scope", "scope_ref", "latest_revision_id", "archived_at", "created_by_kind", "created_by_id", "created_at", "updated_at", "owner_user_id"
FROM "__rev_stash_workflows" AS s;

DROP TABLE "__rev_stash_workflows";

CREATE UNIQUE INDEX workflows_scope_name_active
      ON workflows(scope, COALESCE(scope_ref, ''), name) WHERE archived_at IS NULL;
