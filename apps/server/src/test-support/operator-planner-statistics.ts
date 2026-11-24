/**
 * THE OPERATOR'S PLANNER STATISTICS [POD-7034]: every `sqlite_stat1` row of the
 * operator's production database, numbers only (table, index, row estimates;
 * no data). The query-plan audit plans every statement under them, because
 * SQLite plans by these numbers and they differ from both its defaults and any
 * model of a large database: ANALYZE counts each NULL as its own value, so a
 * mostly-NULL column such as `deleted_at` reads as a few rows per key, and an
 * unpinned `deleted_at IS NULL` seek looks selective while it walks every live
 * row (POD-7027 findings 2 and 3).
 *
 * REFRESH AT EACH RELEASE, from the operator's database, read-only:
 *
 *   sqlite3 -readonly <podium.db> -json \
 *     'SELECT tbl, idx, stat FROM sqlite_stat1 ORDER BY tbl, idx'
 *
 * and replace the rows below (one `[tbl, idx, stat]` per row, `idx` null for a
 * table without an index). Rows naming an index the schema no longer has are
 * skipped when applied.
 *
 * Four rows are not as captured: POD-7034 replaced the full indexes
 * `idx_effects_deleted`, `idx_issues_deleted_at`, `idx_sessions_deleted_at`
 * and `idx_issues_parent` (captured as `46241 10`, `7351 18`, `6941 4` and
 * `7351 15`) with partial ones over the non-NULL rows, `idx_effects_tombstones`,
 * `idx_issues_tombstones`, `idx_sessions_tombstones` and `idx_issues_children`.
 * Their rows are what ANALYZE gives those on the same data, from index-only
 * counts of the non-NULL keys.
 *
 * One row is modelled, not captured: `idx_issues_started_by` (POD-7431) came
 * after the capture. It is partial over the issues that name a starter
 * session; its row assumes a third of the 7351 issues do, a few to a session
 * (POD-7582, so `issueProjection.startedBy` is planned under numbers of the
 * operator's shape rather than SQLite's default). The next refresh replaces it.
 */
export const OPERATOR_STATISTICS_CAPTURED_AT = '2026-11-16'

export const OPERATOR_PLANNER_STATISTICS: readonly (readonly [
  table: string,
  index: string | null,
  stat: string,
])[] = [
  ['applied_mutations', 'idx_applied_mutations_applied_at', '82431 1'],
  ['applied_mutations', 'sqlite_autoindex_applied_mutations_1', '82431 1'],
  ['changes', 'changes_entity', '72973 1001 501 2 1'],
  ['changes', 'changes_event_time', '72973 1001 2 1'],
  ['changes', 'sqlite_autoindex_changes_1', '72973 1001 1'],
  ['conversation_identities', 'sqlite_autoindex_conversation_identities_1', '9957 1'],
  ['conversation_segment_incarnations', 'conversation_segment_incarnations_native', '4784 201 2 1'],
  [
    'conversation_segment_incarnations',
    'sqlite_autoindex_conversation_segment_incarnations_1',
    '4784 201 2 1',
  ],
  ['conversation_segments', 'conversation_segments_path', '10023 4'],
  ['conversation_segments', 'conversation_segments_podium', '10023 1 1'],
  ['conversation_segments', 'sqlite_autoindex_conversation_segments_1', '10023 167 1'],
  ['conversations', 'idx_conversations_project_path', '3727 5'],
  ['conversations', 'idx_conversations_top_level_updated', '3229 1 1'],
  ['conversations', 'idx_conversations_updated_at', '3727 1'],
  ['conversations', 'sqlite_autoindex_conversations_1', '3727 1'],
  ['conversations_fts_docsize', null, '3032'],
  ['effects', 'idx_effects_awaiting', '0 0 0'],
  ['effects', 'idx_effects_tombstones', '9236 5'],
  ['effects', 'idx_effects_kind_target', '46241 334 251 6 1'],
  ['effects', 'idx_effects_status_deadline', '46241 334 1'],
  ['effects', 'idx_effects_status_finished', '46241 334 1'],
  ['effects', 'idx_effects_target', '46241 1001 11 1'],
  ['effects', 'idx_effects_unpublished', '0 0'],
  ['effects', 'sqlite_autoindex_effects_1', '46241 1'],
  ['issue_comments', 'idx_issue_comments_issue_time', '14363 3 1 1'],
  ['issue_comments', 'sqlite_autoindex_issue_comments_1', '14363 1'],
  ['issue_deps', 'idx_issue_deps_from', '5253 2'],
  ['issue_deps', 'idx_issue_deps_to_from', '5253 3 1 1'],
  ['issue_deps', 'sqlite_autoindex_issue_deps_1', '5253 2 1 1'],
  ['issue_labels', 'idx_issue_labels_label_id', '1134 53'],
  ['issue_labels', 'sqlite_autoindex_issue_labels_1', '1134 1 1'],
  ['issue_message_user_state', 'sqlite_autoindex_issue_message_user_state_1', '20103 1001 1'],
  ['issue_messages', 'idx_issue_messages_issue_time', '22973 7 1 1'],
  ['issue_messages', 'sqlite_autoindex_issue_messages_1', '22973 1'],
  ['issue_panel_artifacts', 'idx_issue_panel_artifacts_order', '9049 3 1 1'],
  ['issue_panel_artifacts', 'idx_issue_panel_artifacts_path', '9049 3 1'],
  ['issue_panel_artifacts', 'sqlite_autoindex_issue_panel_artifacts_1', '9049 1'],
  ['issue_panel_deferred', 'idx_issue_panel_deferred_order', '1010 3 1 1'],
  ['issue_panel_deferred', 'sqlite_autoindex_issue_panel_deferred_1', '1010 1'],
  ['issue_panel_states', 'sqlite_autoindex_issue_panel_states_1', '3926 1'],
  ['issue_panel_todos', 'idx_issue_panel_todos_order', '8215 4 1 1'],
  ['issue_panel_todos', 'sqlite_autoindex_issue_panel_todos_1', '8215 1'],
  ['issue_ref_letters', 'sqlite_autoindex_issue_ref_letters_1', '3671 1'],
  ['issue_text_revisions', 'idx_issue_text_revisions_issue_field', '1000 3 2 1'],
  ['issue_user_state', 'idx_issue_user_state_issue', '1645 1'],
  ['issue_user_state', 'sqlite_autoindex_issue_user_state_1', '1645 1001 1'],
  ['issues', 'idx_issues_agent_profile', '0 0'],
  ['issues', 'idx_issues_closed_projection', '7351 1 1 1 1'],
  ['issues', 'idx_issues_tombstones', '65 1'],
  ['issues', 'idx_issues_duplicate_of', '142 2'],
  ['issues', 'idx_issues_children', '5638 8'],
  ['issues', 'idx_issues_started_by', '2450 3'],
  ['issues', 'idx_issues_repo', '7351 53'],
  ['issues', 'idx_issues_repo_id_seq', '7351 251 1'],
  ['issues', 'idx_issues_seq', '7351 5 1 1'],
  ['issues', 'idx_issues_superseded_by', '44 2'],
  ['issues', 'idx_issues_worktree', '460 1'],
  ['issues', 'idx_issues_worktree_folded', '460 1'],
  ['issues', 'sqlite_autoindex_issues_1', '7351 1'],
  ['maintenance_commands', 'sqlite_autoindex_maintenance_commands_1', '218969 1001 1'],
  ['message_reads', 'idx_message_reads_session', '46308 14'],
  ['message_reads', 'sqlite_autoindex_message_reads_1', '46308 2 1'],
  ['messages', 'idx_messages_delivered_to_time', '40395 18 1 1'],
  ['messages', 'idx_messages_delivery_expiry_explicit', '40395 334 334 1'],
  ['messages', 'idx_messages_delivery_expiry_implicit', '40395 334 251 251 1 1'],
  ['messages', 'idx_messages_delivery_order', '40395 334 1 1'],
  ['messages', 'idx_messages_from_issue', '36075 10 1 1'],
  ['messages', 'idx_messages_from_session_time', '40395 16 1 1'],
  ['messages', 'idx_messages_open_chat', '12 1'],
  ['messages', 'idx_messages_recipient_delivery', '40395 667 7 6 1 1'],
  ['messages', 'idx_messages_recipient_time', '40395 667 7 1 1'],
  ['messages', 'idx_messages_reply', '8486 1 1'],
  ['messages', 'idx_messages_thread', '40395 2'],
  ['messages', 'sqlite_autoindex_messages_1', '40395 1'],
  ['podium_events', 'idx_podium_events_kind', '48226 91'],
  ['podium_events', 'idx_podium_events_kind_subject_id', '48226 91 13 1'],
  ['podium_events', 'idx_podium_events_kind_subject_ts', '48226 91 13 1'],
  ['podium_events', 'idx_podium_events_repo', '48226 223'],
  ['podium_events', 'idx_podium_events_subject', '48226 101'],
  ['queued_messages', 'queued_messages_session', '2358 7 1'],
  ['queued_messages', 'sqlite_autoindex_queued_messages_1', '2358 1'],
  ['runtime_event_checkpoints', 'sqlite_autoindex_runtime_event_checkpoints_1', '1485 1'],
  [
    'session_observation_checkpoints',
    'sqlite_autoindex_session_observation_checkpoints_1',
    '3822 1',
  ],
  ['session_observation_rebinds', 'sqlite_autoindex_session_observation_rebinds_1', '1968 1'],
  ['session_terminal_candidates', 'sqlite_autoindex_session_terminal_candidates_1', '1633 1'],
  ['session_user_state', 'idx_session_user_state_session', '1689 1'],
  ['session_user_state', 'sqlite_autoindex_session_user_state_1', '1689 1001 1'],
  ['sessions', 'idx_sessions_cwd', '6941 3'],
  ['sessions', 'idx_sessions_cwd_folded', '6941 4'],
  ['sessions', 'idx_sessions_tombstones', '409 1'],
  ['sessions', 'idx_sessions_deleted_by_issue', '6941 17'],
  ['sessions', 'idx_sessions_headless', '9 9'],
  ['sessions', 'idx_sessions_issue', '6941 7'],
  ['sessions', 'idx_sessions_lifecycle_pending', '0 0'],
  ['sessions', 'idx_sessions_machine', '6941 167'],
  ['sessions', 'idx_sessions_pending_activity', '0 0 0'],
  ['sessions', 'idx_sessions_ref_draft', '6941 4'],
  ['sessions', 'idx_sessions_ref_issue', '6112 2'],
  ['sessions', 'idx_sessions_refless_issue', '0 0'],
  ['sessions', 'idx_sessions_refless_place', '89 45 9'],
  ['sessions', 'idx_sessions_resume_machine', '6941 3 2'],
  ['sessions', 'idx_sessions_spawned_by', '6941 15'],
  ['sessions', 'idx_sessions_status', '6941 501'],
  ['sessions', 'sqlite_autoindex_sessions_1', '6941 1'],
  ['subscription_deliveries', 'sqlite_autoindex_subscription_deliveries_1', '8795 24 1'],
  ['transcript_costs', 'idx_transcript_costs_issue', '2714 2'],
  ['transcript_costs', 'idx_transcript_costs_session', '2714 2'],
  ['transcript_costs', 'sqlite_autoindex_transcript_costs_1', '2714 334 1'],
  ['transcript_fts_content', null, '94887'],
  ['transcript_fts_data', null, '5951'],
  ['transcript_fts_docsize', null, '94887'],
  ['transcript_fts_idx', 'transcript_fts_idx', '3000 80 1'],
  ['workflow_run_steps', 'sqlite_autoindex_workflow_run_steps_1', '1820 7 1'],
  ['workflow_run_steps', 'sqlite_autoindex_workflow_run_steps_2', '1820 7 1'],
  ['workflow_run_steps', 'workflow_run_steps_assignee', '1820 15 14'],
]
