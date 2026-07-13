import type { SqlDatabase } from '@podium/runtime/sqlite'

/** Instruction-first, immutable agent workflows (#285). */
export function up(db: SqlDatabase): void {
  db.exec(`
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
    );
    CREATE UNIQUE INDEX workflows_scope_name_active
      ON workflows(scope, COALESCE(scope_ref, ''), name) WHERE archived_at IS NULL;

    CREATE TABLE workflow_revisions (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
      version INTEGER NOT NULL CHECK (version > 0),
      instructions TEXT NOT NULL,
      steps_json TEXT NOT NULL DEFAULT '[]',
      created_by_kind TEXT NOT NULL CHECK (created_by_kind IN ('operator', 'session')),
      created_by_id TEXT,
      created_at TEXT NOT NULL,
      published_at TEXT,
      UNIQUE(workflow_id, version)
    );
    CREATE INDEX workflow_revisions_workflow ON workflow_revisions(workflow_id, version DESC);

    CREATE TABLE workflow_bindings (
      target_kind TEXT NOT NULL CHECK (target_kind IN ('global', 'repository', 'issue', 'session')),
      target_id TEXT NOT NULL,
      revision_id TEXT NOT NULL REFERENCES workflow_revisions(id) ON DELETE RESTRICT,
      updated_by_kind TEXT NOT NULL CHECK (updated_by_kind IN ('operator', 'session')),
      updated_by_id TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(target_kind, target_id)
    );

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
    );

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
    );
    CREATE UNIQUE INDEX workflow_runs_one_live_subject
      ON workflow_runs(subject_kind, subject_id)
      WHERE status IN ('active', 'blocked');
    CREATE INDEX workflow_runs_coordinator ON workflow_runs(coordinator_session_id, started_at DESC);

    CREATE TABLE workflow_run_steps (
      run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
      step_id TEXT NOT NULL,
      position INTEGER NOT NULL CHECK (position >= 0),
      title TEXT NOT NULL,
      instructions TEXT NOT NULL DEFAULT '',
      completion_guidance TEXT NOT NULL DEFAULT '',
      execution_profile_id TEXT,
      execution_profile_json TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'blocked', 'complete', 'skipped')),
      assigned_session_id TEXT,
      attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt > 0),
      summary TEXT NOT NULL DEFAULT '',
      evidence_json TEXT NOT NULL DEFAULT '{}',
      observation_json TEXT,
      warnings_json TEXT NOT NULL DEFAULT '[]',
      started_at TEXT,
      completed_at TEXT,
      PRIMARY KEY(run_id, step_id),
      UNIQUE(run_id, position)
    );
    CREATE INDEX workflow_run_steps_assignee
      ON workflow_run_steps(assigned_session_id, status);

    CREATE TABLE workflow_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_id TEXT,
      run_id TEXT,
      kind TEXT NOT NULL,
      actor_kind TEXT NOT NULL CHECK (actor_kind IN ('operator', 'session')),
      actor_id TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX workflow_events_workflow ON workflow_events(workflow_id, id);
    CREATE INDEX workflow_events_run ON workflow_events(run_id, id);
  `)
}
