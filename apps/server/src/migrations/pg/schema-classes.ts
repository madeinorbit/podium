/**
 * THE CLASS OF EVERY TEXT COLUMN, FOR THE POSTGRES TWIN [POD-6978, POD-6958 design 2.2, 2.3].
 *
 * SQLite records no timestamp or JSON type: an ISO timestamp, a JSON document and a
 * name are all `text`. Postgres gets a native type for the first two (operator decision
 * OD5: optimize for Postgres), so the class of each text column is declared here, once,
 * and read by the generator (`scripts/generate-pg-schema.ts`) and the parity test
 * (`schema-parity.test.ts`):
 *
 * | class       | Postgres                                   | Drizzle column                |
 * |-------------|--------------------------------------------|-------------------------------|
 * | `timestamp` | `timestamptz(3)`                           | `isoTimestamp` (`mode: 'string'`) |
 * | `json`      | `json` (never `jsonb`: it reorders keys)    | `jsonText`, or `jsonValue` for a `mode: 'json'` column |
 * | `text`      | `text COLLATE "C"`                         | `textC`                       |
 *
 * EVERY TEXT COLUMN IS LISTED, plain text included. A text column the lists do not name
 * fails the generator and the parity test, so a new column is classified when it is
 * added rather than defaulting to whatever the last person assumed.
 *
 * How the lists were drawn (2026-11-17, at integrate/6951-cloud-hosting 1f3730e269):
 *  - `timestamp`: the 153 `text('…_at')` columns. On a real database every value they
 *    hold is exact `toISOString()` form (counts in `schema-overrides.ts`).
 *  - `json`: the six `mode: 'json'` columns, the `…_json` columns, and the columns
 *    whose every stored value on that database is a JSON object or array and whose
 *    writer is `JSON.stringify` (issues.blocked_by, offers.actions, …), including the
 *    shipping documents, which have no rows there yet but are written and read only as
 *    JSON. A column holding JSON in some rows and plain text in others (meta.value,
 *    user_layout.value, applied_mutations.result, superagent_messages.content) is
 *    `text`: `json` would refuse the plain values.
 *  - `text`: the rest.
 *
 * Misfiling a JSON column as `text` costs only validation; misfiling a text column as
 * `json` makes Postgres refuse its writes. When in doubt, `text`.
 *
 * Keyed by SQL table name; covers the server schema (`../schema.ts`) and the sync
 * package's tables (`packages/sync/src/adapters/sqlite/schema.ts`). The identity tables
 * are not here: the identity package owns both of their schemas.
 */

/** The class of one text column. */
export type TextColumnClass = 'timestamp' | 'json' | 'text'

/** One table's text columns by class, each list space-separated SQL column names. */
export type TableTextClasses = { readonly [K in TextColumnClass]?: string }

export const TEXT_COLUMN_CLASSES: Readonly<Record<string, TableTextClasses>> = {
  account_machine_sends: {
    timestamp: 'sent_at',
    text: 'account_id machine_id workspace_id',
  },
  accounts: {
    text: 'id provider kind credential identity scope owner_user_id ref account_key shared_with workspace_id',
  },
  agent_profiles: {
    timestamp: 'created_at updated_at',
    json: 'candidates_json',
    text: 'id name description machine_id instructions created_by updated_by workspace_id',
  },
  approval_requests: {
    timestamp: 'created_at decided_at',
    json: 'op_json',
    text: 'id machine_id session_id issue_id status actor on_behalf_of result_text workspace_id',
  },
  automation_runs: {
    timestamp: 'fired_at deleted_at',
    text: 'id actor on_behalf_of automation_id session_id outcome detail workspace_id',
  },
  automations: {
    timestamp: 'run_at next_run_at last_run_at created_at deleted_at',
    text: 'id owner_user_id created_by_actor created_by_on_behalf_of name repo_path schedule_kind cron target_session_id agent_kind model effort prompt session_mode workspace_id',
  },
  carried_sign_ins: {
    timestamp: 'expires_at',
    text: 'old_token_hash device_sign_in_id sealed member_id old_label workspace_id',
  },
  checkout_lost: {
    timestamp: 'lost_at',
    text: 'user_id machine_id path workspace_id',
  },
  checkout_reach: {
    timestamp: 'updated_at',
    text: 'user_id machine_id reach workspace_id',
  },
  checkouts: {
    timestamp: 'updated_at removed_at',
    text: 'machine_id path root kind repo_id branch origin_url workspace_id',
  },
  client_sessions: {
    timestamp: 'created_at expires_at last_seen_at',
    text: 'token_hash user_id label session_id device_id device_name platform workspace_id',
  },
  conversation_identities: {
    timestamp: 'created_at',
    text: 'podium_id parent_podium_id workspace_id',
  },
  conversation_segment_incarnations: {
    timestamp: 'created_at retired_at',
    text: 'machine_id native_id device inode workspace_id',
  },
  conversation_segments: {
    timestamp: 'created_at mirrored_at',
    text: 'machine_id native_id provider_id podium_id path linked_by workspace_id',
  },
  conversations: {
    timestamp: 'created_at updated_at',
    text: 'id agent_kind provider_id title name summary project_path resume_kind resume_value machine_id parent_conversation_id workspace_id',
  },
  delivery_receipts: {
    timestamp: 'completed_at',
    text: 'id order_id approved_base_sha approved_head_sha result_commit_sha tested_integration_sha landed_ref_sha destination_sha validation_profile_id validation_result destination workspace_id',
  },
  effects: {
    json: 'input_json result_json',
    text: 'id kind target_kind target_id status error_code error_message stage decision deciders created_by actor workspace_id',
  },
  grant_audiences: {
    text: 'resource_kind resource_id grantee workspace_id',
  },
  grants: {
    timestamp: 'created_at',
    text: 'resource_kind resource_id grantee verb owner visibility actor_kind actor_id on_behalf_of workspace_id',
  },
  issue_comments: {
    timestamp: 'created_at edited_at',
    text: 'id issue_id author body actor on_behalf_of edited_by edited_on_behalf_of workspace_id',
  },
  issue_deps: {
    text: 'from_id to_id type workspace_id',
  },
  issue_git_states: {
    timestamp: 'updated_at',
    json: 'facts_json',
    text: 'issue_id workspace_id',
  },
  issue_labels: {
    text: 'issue_id workspace_id',
  },
  issue_message_user_state: {
    timestamp: 'read_at',
    text: 'user_id issue_message_id workspace_id',
  },
  issue_messages: {
    timestamp: 'created_at claimed_at',
    text: 'id issue_id from_author body actor on_behalf_of status claimed_by workspace_id',
  },
  issue_panel_artifacts: {
    json: 'value',
    text: 'id issue_id path workspace_id',
  },
  issue_panel_deferred: {
    timestamp: 'added_at',
    text: 'id issue_id text workspace_id',
  },
  issue_panel_states: {
    timestamp: 'updated_at',
    text: 'id text workspace_id',
  },
  issue_panel_todos: {
    text: 'id issue_id text workspace_id',
  },
  issue_ref_letters: {
    text: 'issue_id workspace_id',
  },
  issue_text_revisions: {
    timestamp: 'created_at',
    text: 'issue_id field body source actor on_behalf_of workspace_id',
  },
  issue_user_state: {
    timestamp: 'read_at tucked_at joined_at assigned_at',
    text: 'user_id issue_id joined_via assigned_by workspace_id',
  },
  issues: {
    timestamp:
      'due_at closed_at landed_at human_question_asked_at created_at updated_at deleted_at',
    json: 'blocked_by human_question_options human_question_attribution',
    text: 'id owner_user_id visibility created_by_actor created_by_on_behalf_of repo_path repo_id title description brief stage worktree_path branch parent_branch default_agent default_model default_effort machine_id agent_profile_id linear_id linear_identifier linear_url suggested_stage suggested_reason dependency_note pr_url type assignee parent_id acceptance defer_until closed_reason closed_by_user_id landed_sha superseded_by duplicate_of sort_key human_question human_question_asked_by actor on_behalf_of origin audience coordinator_session_id started_by_session workspace_id',
  },
  labels: {
    timestamp: 'created_at',
    text: 'name color description workspace_id',
  },
  lock_waiters: {
    timestamp: 'enqueued_at',
    text: 'repo_id name session_id issue_id label note workspace_id',
  },
  locks: {
    timestamp: 'acquired_at expires_at',
    text: 'repo_id name holder_session_id holder_issue_id holder_label note workspace_id',
  },
  machines: {
    timestamp: 'revoked_at created_at last_seen_at build_reported_at',
    json: 'inventory_json harness_versions_json delivery_caps_json service_assignment_json assignment_evidence_json availability_json service_report_json components_json',
    text: 'superseded_by id name hostname token_hash credential_kind public_key update_channel update_channel_override app_version wire_schema_digest install_kind presence_source workspace_id',
  },
  maintenance_commands: {
    timestamp: 'applied_at',
    json: 'result_json',
    text: 'job_kind run_key workspace_id',
  },
  maintenance_leases: {
    timestamp: 'expires_at updated_at',
    text: 'name generation_id schema_version',
  },
  message_reads: {
    timestamp: 'read_at',
    text: 'message_id session_id workspace_id',
  },
  message_wake_cooldowns: {
    timestamp: 'attempted_at',
    text: 'key workspace_id',
  },
  messages: {
    timestamp:
      'expires_at created_at delivered_at reminded_at read_at injected_at delivery_deferred_at dead_lettered_at notice_dismissed_at retract_requested_at',
    json: 'attachments_json clamped_from harness_ref_json',
    text: 'id thread_id in_reply_to from_kind from_session from_issue actor_kind actor_id on_behalf_of delegation_ref to_kind to_id kind urgency lifecycle body delivery_status delivery_held delivered_to acked_by from_name delivery_deferred_reason fact_key fact_target transcript_item_id transcript_item_cursor workspace_id',
  },
  messaging_issue_topics: {
    timestamp: 'updated_at',
    text: 'issue_id chat_id thread_ref superagent_thread_id workspace_id',
  },
  messaging_session_attachments: {
    timestamp: 'attached_at',
    text: 'chat_id thread_ref user_id session_id relayed_item_id workspace_id',
  },
  meta: {
    text: 'key value',
  },
  native_login_opt_ins: {
    timestamp: 'updated_at',
    text: 'owner_user_id harness fingerprint workspace_id',
  },
  native_login_transfers: {
    text: 'owner_user_id harness fingerprint machine_id outcome at workspace_id',
  },
  notification_facts: {
    timestamp: 'created_at expires_at consumed_at',
    text: 'fact_key target source issue_id workspace_id',
  },
  offers: {
    timestamp: 'created_at',
    json: 'actions artifacts',
    text: 'session_id message workspace_id',
  },
  operations: {
    json: 'payload',
    text: 'id kind exclusion_group state workspace_id',
  },
  pending_interactions: {
    timestamp: 'asked_at expires_at answered_at expired_at',
    json: 'payload_json answer_json',
    text: 'id session_id kind source answerable fingerprint status policy_verdict answered_by delivered_via workspace_id',
  },
  pins: {
    timestamp: 'pinned_at',
    text: 'user_id kind id workspace_id',
  },
  podium_events: {
    json: 'payload',
    text: 'ts kind subject repo_path workspace_id',
  },
  queued_messages: {
    json: 'attachments_json',
    text: 'id session_id text input_origin delivery_owner principal_kind principal_ref delegation_ref actor_kind actor_id on_behalf_of source_message_id delivery workspace_id',
  },
  quota_windows: {
    json: 'trail_json',
    text: 'account_key agent window_key label scope_model plan source owner_user_id workspace_id',
  },
  recap_watermarks: {
    timestamp: 'updated_at',
    text: 'reader session_id watermark workspace_id',
  },
  repo_draft_seq: {
    text: 'repo_id workspace_id',
  },
  repo_prefixes: {
    text: 'repo_id prefix default_parent_branch workspace_id',
  },
  repos: {
    timestamp: 'added_at',
    text: 'machine_id path origin_url repo_name repo_id workspace_id',
  },
  root_integration_receipts: {
    json: 'descendants',
    text: 'root_issue_id approved_head_sha workspace_id',
  },
  runtime_event_checkpoints: {
    timestamp: 'updated_at',
    json: 'cursor_json turn_state_json',
    text: 'session_id workspace_id',
  },
  runtime_event_projection_cursors: {
    timestamp: 'updated_at',
    text: 'projector workspace_id',
  },
  server_secrets: {
    timestamp: 'updated_at',
    text: 'key value',
  },
  session_drafts: {
    timestamp: 'updated_at',
    json: 'history',
    text: 'session_id text origin workspace_id',
  },
  session_observation_checkpoints: {
    timestamp: 'updated_at',
    json: 'checkpoint_json',
    text: 'session_id provider provider_session_id workspace_id',
  },
  session_observation_rebinds: {
    timestamp: 'updated_at',
    text: 'session_id provider from_provider_session_id to_provider_session_id workspace_id',
  },
  session_terminal_candidates: {
    timestamp: 'confirmed_at consumed_at updated_at',
    json: 'proof_json',
    text: 'session_id workspace_id',
  },
  session_user_state: {
    timestamp: 'read_at',
    text: 'user_id session_id workspace_id',
  },
  sessions: {
    timestamp:
      'created_at last_active_at published_last_active_at last_output_at last_input_at last_resumed_at stopped_at oom_killed_at deleted_at',
    json: 'agent_state_json delegation',
    text: 'id owner_user_id agent_kind model effort requested_model requested_effort account_id login_harness cwd title origin_kind conversation_id resume_kind resume_value selected_driver_id requested_driver_id bound_driver_id bound_driver_capabilities agent_color observed_model observed_effort handoff_target_machine_id conversation_binding status spawn_failure durable_label name work_state machine_id spawned_by issue_id stop_reason deleted_by_issue_id deletion_source workflow_run_id workflow_step_id agent_profile_id name_source ref_issue_id ref_letter created_by_actor_kind created_by_actor_id created_by_on_behalf_of desired lifecycle_failure desired_by_user desired_by_agent workspace_id',
  },
  settings_audit_events: {
    timestamp: 'created_at',
    json: 'detail_json redacted_paths',
    text: 'command outcome actor_kind actor_id on_behalf_of workspace_id',
  },
  ship_attempts: {
    timestamp: 'started_at finished_at',
    text: 'id order_id expected_source_base_sha approved_head_sha expected_target_sha machine_id outcome submitted_head_sha tested_integration_sha landed_ref_sha destination_sha validation_profile_id validation_result workspace_id',
  },
  ship_effect_envelopes: {
    timestamp: 'recorded_at',
    json: 'request_json result_json',
    text: 'effect_key train_id attempt_id request_digest workspace_id',
  },
  ship_evidence: {
    timestamp: 'materialized_at',
    text: 'ref custody_digest content_digest source_ref content workspace_id',
  },
  ship_holds: {
    timestamp: 'raised_at resolved_at',
    json: 'actions',
    text: 'id order_id reason_code headline detail evidence_refs resolution workspace_id',
  },
  ship_lane_revisions: {
    timestamp: 'updated_at',
    text: 'lane_key workspace_id',
  },
  ship_order_stack_edges: {
    timestamp: 'recorded_at',
    text: 'upper_order_id lower_order_id upper_approved_head_sha lower_approved_head_sha workspace_id',
  },
  ship_orders: {
    timestamp: 'requested_at state_changed_at',
    json: 'descendant_manifest delivery_depends_on current_integration_receipt validation_profile',
    text: 'id issue_id repo_id repo_path machine_id target_branch destination approved_base_sha approved_head_sha evidence_manifest_ref provider_ref requested_by_actor_kind requested_by_actor_id requested_by_on_behalf_of policy_id validation_profile_digest close_mode state hold_code workspace_id',
  },
  ship_recovery_revision: {
    text: 'workspace_id',
  },
  ship_recovery_work: {
    json: 'payload',
    text: 'key kind order_id workspace_id',
  },
  ship_repair_candidates: {
    timestamp: 'recorded_at',
    text: 'order_id attempt_id context_digest repair_ref candidate_head_sha result_token workspace_id',
  },
  ship_steps: {
    timestamp: 'recorded_at started_at finished_at',
    json: 'input_fence',
    text: 'id order_id attempt_id effect_key idempotency_key kind state outcome summary artifact_ref workspace_id',
  },
  ship_train_active_claims: {
    text: 'train_id order_id attempt_id workspace_id',
  },
  ship_train_manifests: {
    timestamp: 'created_at released_at',
    json: 'canonical_json provider_ref validation_profile',
    text: 'id subset_id canonical_digest repo_id repo_path machine_id lane_key target_branch expected_target_sha destination policy_id validation_profile_digest leader_order_id leader_attempt_id release_reason workspace_id',
  },
  ship_train_members: {
    timestamp: 'released_at',
    json: 'delivery_depends_on',
    text: 'train_id issue_id order_id attempt_id machine_id source_branch approved_base_sha approved_head_sha workspace_id',
  },
  snoozes: {
    timestamp: 'created_at',
    text: 'user_id session_id snoozed_until workspace_id',
  },
  steward_state: {
    text: 'key value workspace_id',
  },
  subscription_deliveries: {
    text: 'subscription_id workspace_id',
  },
  subscriptions: {
    timestamp: 'created_at',
    text: 'id subscriber_kind subscriber_id event source_kind source_ref origin workspace_id',
  },
  superagent_messages: {
    timestamp: 'created_at',
    json: 'tool_calls',
    text: 'owner_user_id role content tool_call_id tool_name thread_id workspace_id',
  },
  superagent_pending_turns: {
    timestamp: 'created_at',
    json: 'payload_json',
    text: 'owner_user_id turn_id thread_id podium_session_id actor on_behalf_of workspace_id',
  },
  superagent_queued_inputs: {
    timestamp: 'created_at',
    json: 'focus_json',
    text: 'owner_user_id input_id thread_id text agent_kind attach_session_id model effort actor on_behalf_of workspace_id',
  },
  superagent_threads: {
    timestamp: 'created_at updated_at last_turn_failure_at',
    text: 'id owner_user_id kind origin_session_id title watermark_item_id watermark_ts repo_path agent_kind podium_session_id harness_session_id terminal_session_id model effort last_turn_failure_message last_turn_failure_user_text workspace_id',
  },
  tab_order: {
    timestamp: 'updated_at',
    json: 'ids',
    text: 'user_id worktree workspace_id',
  },
  telegram_chat_bindings: {
    timestamp: 'bound_at',
    text: 'chat_id user_id actor_kind actor_id on_behalf_of workspace_id',
  },
  transcript_costs: {
    timestamp: 'updated_at',
    json: 'models_json window_models_json',
    text: 'machine_id native_id path harness session_id issue_id workspace_id',
  },
  upstream_outbox: {
    text: 'mutation_id proc input workspace_id',
  },
  user_dock_shell: {
    timestamp: 'updated_at',
    text: 'user_id worktree_key session_id workspace_id',
  },
  user_layout: {
    timestamp: 'updated_at',
    text: 'user_id key value workspace_id',
  },
  user_preferences: {
    timestamp: 'updated_at',
    text: 'user_id key value workspace_id',
  },
  user_read_position: {
    timestamp: 'seen_at updated_at',
    text: 'user_id stream_id workspace_id',
  },
  users: {
    timestamp: 'created_at disabled_at authz_changed_at',
    text: 'id display_name email account_id avatar role workspace_id',
  },
  workflow_bindings: {
    timestamp: 'updated_at',
    text: 'target_kind target_id revision_id updated_by_kind updated_by_id owner_user_id workspace_id',
  },
  workflow_events: {
    timestamp: 'created_at',
    json: 'payload_json',
    text: 'workflow_id run_id kind actor_kind actor_id on_behalf_of workspace_id',
  },
  workflow_revisions: {
    timestamp: 'created_at published_at',
    json: 'steps_json',
    text: 'id workflow_id instructions created_by_kind created_by_id workspace_id',
  },
  workflow_run_steps: {
    timestamp: 'started_at completed_at',
    json: 'agent_profile_json evidence_json observation_json warnings_json',
    text: 'run_id step_id title instructions completion_guidance agent_profile_id status assigned_session_id summary workspace_id',
  },
  workflow_runs: {
    timestamp: 'started_at completed_at',
    text: 'id subject_kind subject_id coordinator_session_id revision_id status supersedes_run_id owner_user_id workspace_id',
  },
  workflows: {
    timestamp: 'archived_at created_at updated_at',
    text: 'id name description scope scope_ref latest_revision_id created_by_kind created_by_id owner_user_id workspace_id',
  },
  applied_mutations: {
    text: 'mutation_id proc result workspace_id',
  },
  changes: {
    json: 'payload',
    text: 'workspace_id entity entity_id op origin_id causation_id mutation_id',
  },
  feed_identity: {
    text: 'feed_id epoch',
  },
  sync_capture: {
    text: 'kind op old_key new_key',
  },
  sync_capture_guard: {},
  sync_feed: {
    text: 'workspace_id feed_id epoch',
  },
  sync_kind: {
    text: 'workspace_id kind',
  },
}

/** The class of `table.column`, or undefined when the lists do not name it. */
export function textColumnClass(table: string, column: string): TextColumnClass | undefined {
  const classes = TEXT_COLUMN_CLASSES[table]
  if (classes === undefined) return undefined
  for (const kind of ['timestamp', 'json', 'text'] as const) {
    if ((classes[kind] ?? '').split(' ').includes(column)) return kind
  }
  return undefined
}

/** Every `table.column` the lists name, with its class (the parity test reads them all). */
export function classifiedTextColumns(): Map<string, TextColumnClass> {
  const all = new Map<string, TextColumnClass>()
  for (const [table, classes] of Object.entries(TEXT_COLUMN_CLASSES)) {
    for (const kind of ['timestamp', 'json', 'text'] as const) {
      for (const column of (classes[kind] ?? '').split(' ').filter(Boolean)) {
        all.set(`${table}.${column}`, kind)
      }
    }
  }
  return all
}
