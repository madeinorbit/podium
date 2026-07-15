CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      kind TEXT NOT NULL,
      credential TEXT NOT NULL,
      identity TEXT NOT NULL DEFAULT '',
      scope TEXT NOT NULL DEFAULT 'role',
      created_at INTEGER NOT NULL
    );
--> statement-breakpoint
CREATE TABLE applied_mutations (
         mutation_id TEXT PRIMARY KEY,
         proc        TEXT NOT NULL,
         result      TEXT NOT NULL,
         applied_at  INTEGER NOT NULL
       );
--> statement-breakpoint
CREATE TABLE approval_requests (
      id TEXT PRIMARY KEY,
      machine_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      issue_id TEXT,
      op_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','denied','executing','succeeded','failed')),
      created_at TEXT NOT NULL,
      decided_at TEXT,
      result_text TEXT
    );
--> statement-breakpoint
CREATE TABLE automation_runs (
      id            TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
      fired_at      TEXT NOT NULL,
      session_id    TEXT,
      outcome       TEXT NOT NULL
        CHECK (outcome IN ('spawned','missed','skipped_overlap','error')),
      detail        TEXT
    );
--> statement-breakpoint
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
    , session_mode TEXT NOT NULL DEFAULT 'fresh' CHECK (session_mode IN ('fresh', 'resume')));
--> statement-breakpoint
CREATE TABLE changes (
         seq        INTEGER PRIMARY KEY AUTOINCREMENT,
         entity     TEXT NOT NULL,
         entity_id  TEXT NOT NULL,
         op         TEXT NOT NULL,
         payload    TEXT,
         event_time INTEGER NOT NULL
       );
--> statement-breakpoint
CREATE TABLE client_sessions (
         token_hash TEXT PRIMARY KEY,
         created_at TEXT NOT NULL,
         expires_at TEXT NOT NULL
       );
--> statement-breakpoint
CREATE TABLE conversation_identities (
         podium_id        TEXT PRIMARY KEY,
         parent_podium_id TEXT,
         created_at       TEXT NOT NULL
       );
--> statement-breakpoint
CREATE TABLE conversation_segments (
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
       );
--> statement-breakpoint
CREATE TABLE conversations (
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
       , machine_id TEXT NOT NULL DEFAULT '__local__');
--> statement-breakpoint
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
--> statement-breakpoint
CREATE TABLE "issue_comments" (
         id         TEXT PRIMARY KEY,
         issue_id   TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
         author     TEXT NOT NULL,
         body       TEXT NOT NULL,
         created_at TEXT NOT NULL
       );
--> statement-breakpoint
CREATE TABLE "issue_deps" (
         from_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
         to_id   TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
         type    TEXT NOT NULL DEFAULT 'blocks',
         PRIMARY KEY (from_id, to_id, type)
       );
--> statement-breakpoint
CREATE TABLE "issue_labels" (
         issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
         label    TEXT NOT NULL,
         PRIMARY KEY (issue_id, label)
       );
--> statement-breakpoint
CREATE TABLE "issue_messages" (
         id          TEXT PRIMARY KEY,
         issue_id    TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
         from_author TEXT NOT NULL,
         body        TEXT NOT NULL,
         created_at  TEXT NOT NULL,
         status      TEXT NOT NULL DEFAULT 'unread',
         claimed_by  TEXT,
         read_at     TEXT,
         claimed_at  TEXT
       );
--> statement-breakpoint
CREATE TABLE issue_ref_letters (
      issue_id TEXT PRIMARY KEY,
      next_index INTEGER NOT NULL
    );
--> statement-breakpoint
CREATE TABLE "issues" (
      id TEXT PRIMARY KEY,
      repo_path TEXT NOT NULL,
      repo_id TEXT,
      seq INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      stage TEXT NOT NULL
        CHECK (stage IN ('backlog', 'planning', 'in_progress', 'review', 'verifying', 'done')),
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
      priority INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 4),
      type TEXT NOT NULL DEFAULT 'task'
        CHECK (type IN ('task', 'bug', 'feature', 'chore', 'epic', 'decision', 'spike', 'story', 'milestone', 'automation')),
      assignee TEXT,
      parent_id TEXT REFERENCES "issues"(id) ON DELETE SET NULL,
      design TEXT,
      acceptance TEXT,
      notes TEXT,
      due_at TEXT,
      defer_until TEXT,
      closed_reason TEXT,
      superseded_by TEXT REFERENCES "issues"(id) ON DELETE SET NULL,
      duplicate_of TEXT REFERENCES "issues"(id) ON DELETE SET NULL,
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
      read_at TEXT,
      audience TEXT NOT NULL DEFAULT 'human',
      deleted_at TEXT
    );
--> statement-breakpoint
CREATE TABLE lock_waiters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id TEXT NOT NULL,
      name TEXT NOT NULL,
      session_id TEXT NOT NULL,
      issue_id TEXT,
      label TEXT NOT NULL,
      enqueued_at TEXT NOT NULL,
      UNIQUE (repo_id, name, session_id)
    );
--> statement-breakpoint
CREATE TABLE locks (
      repo_id TEXT NOT NULL,
      name TEXT NOT NULL,
      holder_session_id TEXT,
      holder_issue_id TEXT,
      holder_label TEXT NOT NULL,
      note TEXT,
      acquired_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      PRIMARY KEY (repo_id, name)
    );
--> statement-breakpoint
CREATE TABLE machines (
             id TEXT PRIMARY KEY,
             name TEXT NOT NULL,
             hostname TEXT NOT NULL,
             token_hash TEXT NOT NULL,
             created_at TEXT NOT NULL,
             last_seen_at TEXT NOT NULL
           , inventory_json TEXT);
--> statement-breakpoint
CREATE TABLE messages (
      id           TEXT PRIMARY KEY,
      thread_id    TEXT NOT NULL,
      in_reply_to  TEXT,
      from_kind    TEXT NOT NULL
        CHECK (from_kind IN ('operator','superagent','agent','system')),
      from_session TEXT,
      from_issue   TEXT,
      to_kind      TEXT NOT NULL
        CHECK (to_kind IN ('issue','session','operator')),
      to_id        TEXT,
      kind         TEXT NOT NULL DEFAULT 'message'
        CHECK (kind IN ('message','ack','notification','question')),
      urgency      TEXT NOT NULL DEFAULT 'fyi'
        CHECK (urgency IN ('fyi','next-turn','interrupt')),
      lifecycle    TEXT NOT NULL DEFAULT 'wait'
        CHECK (lifecycle IN ('wait','wake')),
      body         TEXT NOT NULL,
      expires_at   TEXT,
      created_at   TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued','delivered','expired','cancelled')),
      delivered_at TEXT,
      delivered_to TEXT,
      acked_by     TEXT
    , hop INTEGER NOT NULL DEFAULT 0, clamped_from TEXT, reminded_at TEXT, from_name TEXT);
--> statement-breakpoint
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE pins (
         kind TEXT NOT NULL,
         id TEXT NOT NULL,
         pinned_at TEXT NOT NULL,
         PRIMARY KEY (kind, id)
       );
--> statement-breakpoint
CREATE TABLE podium_events (
         id        INTEGER PRIMARY KEY AUTOINCREMENT,
         ts        TEXT NOT NULL,
         kind      TEXT NOT NULL,
         subject   TEXT NOT NULL,
         repo_path TEXT,
         payload   TEXT NOT NULL DEFAULT '{}'
       );
--> statement-breakpoint
CREATE TABLE queued_messages (
         id         TEXT PRIMARY KEY,
         session_id TEXT NOT NULL,
         text       TEXT NOT NULL,
         queued_at  INTEGER NOT NULL,
         attempts   INTEGER NOT NULL DEFAULT 0
       );
--> statement-breakpoint
CREATE TABLE recap_watermarks (
      reader     TEXT NOT NULL,
      session_id TEXT NOT NULL,
      watermark  TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (reader, session_id)
    );
--> statement-breakpoint
CREATE TABLE repo_draft_seq (
      repo_id TEXT PRIMARY KEY,
      next_seq INTEGER NOT NULL
    );
--> statement-breakpoint
CREATE TABLE repo_prefixes (
      repo_id TEXT PRIMARY KEY,
      prefix TEXT NOT NULL UNIQUE
    );
--> statement-breakpoint
CREATE TABLE repos (
         machine_id TEXT NOT NULL DEFAULT '__local__',
         path TEXT NOT NULL,
         origin_url TEXT,
         repo_name TEXT,
         repo_id TEXT,
         added_at TEXT NOT NULL,
         PRIMARY KEY (machine_id, path)
       );
--> statement-breakpoint
CREATE TABLE session_drafts (
         session_id TEXT PRIMARY KEY,
         text TEXT NOT NULL,
         updated_at TEXT NOT NULL
       );
--> statement-breakpoint
CREATE TABLE sessions (
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
       , machine_id TEXT NOT NULL DEFAULT '__local__', deleted_at TEXT, deleted_by_issue_id TEXT, deletion_source TEXT, workflow_run_id TEXT, workflow_step_id TEXT, execution_profile_id TEXT, name_source TEXT, ref_issue_id TEXT, ref_letter TEXT, ref_draft INTEGER, terminal_cols INTEGER NOT NULL DEFAULT 80, terminal_rows INTEGER NOT NULL DEFAULT 24);
--> statement-breakpoint
CREATE TABLE snoozes (
         session_id TEXT PRIMARY KEY,
         snoozed_until TEXT,
         created_at TEXT NOT NULL
       );
--> statement-breakpoint
CREATE TABLE steward_state (
         key   TEXT PRIMARY KEY,
         value TEXT NOT NULL
       );
--> statement-breakpoint
CREATE TABLE subscription_deliveries (
         subscription_id TEXT NOT NULL,
         event_id        INTEGER NOT NULL,
         PRIMARY KEY (subscription_id, event_id)
       );
--> statement-breakpoint
CREATE TABLE subscriptions (
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
       );
--> statement-breakpoint
CREATE TABLE superagent_messages (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         role TEXT NOT NULL,
         content TEXT NOT NULL,
         tool_calls TEXT,
         tool_call_id TEXT,
         tool_name TEXT,
         created_at TEXT NOT NULL
       , thread_id TEXT NOT NULL DEFAULT 'global');
--> statement-breakpoint
CREATE TABLE superagent_pending_turns (
       turn_id TEXT PRIMARY KEY,
       thread_id TEXT NOT NULL UNIQUE,
       podium_session_id TEXT NOT NULL,
       payload_json TEXT NOT NULL,
       first_turn INTEGER NOT NULL DEFAULT 0,
       created_at TEXT NOT NULL
     );
--> statement-breakpoint
CREATE TABLE superagent_queued_inputs (
       input_id TEXT PRIMARY KEY,
       thread_id TEXT NOT NULL UNIQUE,
       text TEXT NOT NULL,
       focus_json TEXT,
       created_at TEXT NOT NULL
     );
--> statement-breakpoint
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
       , repo_path TEXT, agent_kind TEXT, podium_session_id TEXT, harness_session_id TEXT, terminal_session_id TEXT);
--> statement-breakpoint
CREATE TABLE tab_order (
         worktree TEXT PRIMARY KEY,
         ids TEXT NOT NULL,
         updated_at TEXT NOT NULL
       );
--> statement-breakpoint
CREATE TABLE upstream_outbox (
         mutation_id TEXT PRIMARY KEY,
         proc        TEXT NOT NULL,
         input       TEXT NOT NULL,
         queued_at   INTEGER NOT NULL,
         attempts    INTEGER NOT NULL DEFAULT 0
       );
--> statement-breakpoint
CREATE TABLE workflow_bindings (
      target_kind TEXT NOT NULL CHECK (target_kind IN ('global', 'repository', 'issue', 'session')),
      target_id TEXT NOT NULL,
      revision_id TEXT NOT NULL REFERENCES workflow_revisions(id) ON DELETE RESTRICT,
      updated_by_kind TEXT NOT NULL CHECK (updated_by_kind IN ('operator', 'session')),
      updated_by_id TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(target_kind, target_id)
    );
--> statement-breakpoint
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
--> statement-breakpoint
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
--> statement-breakpoint
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
--> statement-breakpoint
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
--> statement-breakpoint
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
--> statement-breakpoint
CREATE INDEX changes_entity ON changes(entity, entity_id, seq);
--> statement-breakpoint
CREATE INDEX conversation_segments_podium ON conversation_segments(podium_id, seq_in_conv);
--> statement-breakpoint
CREATE INDEX idx_approval_requests_status
      ON approval_requests(status, created_at);
--> statement-breakpoint
CREATE INDEX idx_automation_runs_automation
      ON automation_runs(automation_id, fired_at DESC);
--> statement-breakpoint
CREATE INDEX idx_conversations_project_path ON conversations(project_path);
--> statement-breakpoint
CREATE INDEX idx_conversations_updated_at ON conversations(updated_at);
--> statement-breakpoint
CREATE INDEX idx_issue_comments_issue ON issue_comments(issue_id);
--> statement-breakpoint
CREATE INDEX idx_issue_deps_from ON issue_deps(from_id);
--> statement-breakpoint
CREATE INDEX idx_issue_deps_to ON issue_deps(to_id);
--> statement-breakpoint
CREATE INDEX idx_issue_labels_label ON issue_labels(label);
--> statement-breakpoint
CREATE INDEX idx_issue_messages_issue ON issue_messages(issue_id);
--> statement-breakpoint
CREATE INDEX idx_issues_deleted_at ON issues(deleted_at);
--> statement-breakpoint
CREATE INDEX idx_issues_parent ON issues(parent_id);
--> statement-breakpoint
CREATE INDEX idx_issues_repo ON issues(repo_path);
--> statement-breakpoint
CREATE UNIQUE INDEX idx_issues_repo_id_seq ON issues(repo_id, seq);
--> statement-breakpoint
CREATE INDEX idx_lock_waiters_lock ON lock_waiters(repo_id, name, id);
--> statement-breakpoint
CREATE INDEX idx_lock_waiters_session ON lock_waiters(session_id);
--> statement-breakpoint
CREATE INDEX idx_locks_expires ON locks(expires_at);
--> statement-breakpoint
CREATE INDEX idx_locks_holder_session ON locks(holder_session_id);
--> statement-breakpoint
CREATE INDEX idx_messages_delivered_to ON messages(delivered_to);
--> statement-breakpoint
CREATE INDEX idx_messages_recipient ON messages(to_kind, to_id, status);
--> statement-breakpoint
CREATE INDEX idx_messages_thread ON messages(thread_id);
--> statement-breakpoint
CREATE INDEX idx_podium_events_kind ON podium_events(kind);
--> statement-breakpoint
CREATE INDEX idx_podium_events_repo ON podium_events(repo_path);
--> statement-breakpoint
CREATE INDEX idx_sessions_deleted_at ON sessions(deleted_at);
--> statement-breakpoint
CREATE INDEX idx_sessions_deleted_by_issue ON sessions(deleted_by_issue_id);
--> statement-breakpoint
CREATE INDEX idx_subscriptions_subscriber ON subscriptions(subscriber_id);
--> statement-breakpoint
CREATE INDEX queued_messages_session ON queued_messages(session_id, queued_at);
--> statement-breakpoint
CREATE INDEX workflow_events_run ON workflow_events(run_id, id);
--> statement-breakpoint
CREATE INDEX workflow_events_workflow ON workflow_events(workflow_id, id);
--> statement-breakpoint
CREATE INDEX workflow_revisions_workflow ON workflow_revisions(workflow_id, version DESC);
--> statement-breakpoint
CREATE INDEX workflow_run_steps_assignee
      ON workflow_run_steps(assigned_session_id, status);
--> statement-breakpoint
CREATE INDEX workflow_runs_coordinator ON workflow_runs(coordinator_session_id, started_at DESC);
--> statement-breakpoint
CREATE UNIQUE INDEX workflow_runs_one_live_subject
      ON workflow_runs(subject_kind, subject_id)
      WHERE status IN ('active', 'blocked');
--> statement-breakpoint
CREATE UNIQUE INDEX workflows_scope_name_active
      ON workflows(scope, COALESCE(scope_ref, ''), name) WHERE archived_at IS NULL;
