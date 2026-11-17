/**
 * HOW LONG EVERY TABLE KEEPS ITS ROWS (POD-7035, audit guard 3).
 *
 * The audit found the largest table on the operator's database
 * (`applied_mutations`, 760 MB) pruned only at boot, and a queue (`queued_messages`)
 * whose rows of a parked session never left. Neither was a decision: nobody had
 * been asked what bounds those tables. So every table now answers that question
 * here, and `retention.test.ts` fails for a table that does not, the day it is
 * added:
 *
 *  - `pruned`: a job removes rows past a horizon. `by` names the job and the
 *    horizon. The janitor's retention jobs also report their backlog after each
 *    run and warn when it stops shrinking (guard 4, `@podium/runtime/retention-backlog`).
 *  - `bounded`: the table does not grow with work. Its size follows people,
 *    machines, repositories, settings, or a set of live things (one row per open
 *    session, per held lock), or it is a queue its consumer empties.
 *  - `unbounded`: the table grows with work and nothing removes its rows. That is
 *    allowed only with the reason it is kept, so the next audit reads a decision
 *    and not an accident.
 *
 * A child row a foreign key deletes with its parent (`ON DELETE CASCADE`) is
 * bounded by that parent; it says so.
 */

export type TableRetention =
  | { readonly kind: 'pruned'; readonly by: string }
  | { readonly kind: 'bounded'; readonly by: string }
  | { readonly kind: 'unbounded'; readonly reason: string }

const pruned = (by: string): TableRetention => ({ kind: 'pruned', by })
const bounded = (by: string): TableRetention => ({ kind: 'bounded', by })
const unbounded = (reason: string): TableRetention => ({ kind: 'unbounded', reason })

/** Work history people read back: tasks, their text, their mail. */
const RECORD_OF_WORK =
  'The record of the work itself, which people read back; deleting it is a product decision no one has made.'

export const TABLE_RETENTION: Readonly<Record<string, TableRetention>> = {
  // ---- retention jobs ---------------------------------------------------------
  applied_mutations: pruned(
    "The janitor's applied-mutations-prune, in batches of 100: receipts older than 30 days (APPLIED_MUTATIONS_MAX_AGE_MS, above the 16-day outbox horizon of ADR 3 D11). Large results are stored as a digest.",
  ),
  queued_messages: pruned(
    "Delivery removes a row; the janitor's queued-messages-expiry removes a parked session's rows queued over 14 days ago (QUEUED_MESSAGE_MAX_AGE_MS); a session's removal drops its queue.",
  ),
  maintenance_commands: pruned(
    "The janitor's maintenance-commands-prune: receipts older than 14 days (MAINTENANCE_COMMAND_MAX_AGE_MS), oldest first through idx_maintenance_commands_applied_at.",
  ),
  podium_events: pruned(
    "The janitor's event-log-prune: events older than 14 days, and always the newest 50k rows at most (EVENT_RETENTION_*).",
  ),
  changes: pruned(
    "The janitor's change-log-prune: per tenant, the newest 500k rows and 30 days at most (CHANGE_KEEP_ROWS, CHANGE_MAX_AGE_MS).",
  ),
  effects: pruned(
    "The effect runner's sweep: finished records past their window and soft-deleted tombstones are purged in batches (modules/effects/runner.ts).",
  ),
  sync_capture: bounded(
    'Rows a write captures are drained into the change log in the same transaction: empty between writes.',
  ),
  sync_capture_guard: bounded('One guard row per capture slot; empty between writes.'),
  notification_facts: pruned(
    "Expired facts are deleted (deleteExpiredFacts), and an issue's facts go with it.",
  ),
  quota_windows: pruned('Rolling usage windows; old windows are pruned (pruneWindows).'),
  operations: pruned(
    'Finished operations beyond the newest kept are deleted (modules/operations/store.ts).',
  ),

  // ---- queues and live sets ----------------------------------------------------
  superagent_queued_inputs: bounded('A queue: a row is deleted when its input is consumed.'),
  superagent_pending_turns: bounded('A queue: a row is deleted when its turn starts.'),
  upstream_outbox: bounded(
    'Archived at POD-309: nothing enqueues any more; the parked rows are kept for the operator to read (ADR 5 D8).',
  ),
  locks: bounded('One row per held lock; released locks are deleted.'),
  lock_waiters: bounded(
    'One row per queued waiter; deleted when it acquires, cancels or its session goes.',
  ),
  offers: bounded('At most one live offer per session, removed when cleared.'),
  pending_interactions: unbounded(
    "Every question an agent asked a person, answered ones included: the session's history people read back.",
  ),
  maintenance_leases: bounded("One row per lease name (the janitor's)."),
  steward_state: bounded('A fixed set of steward keys.'),
  runtime_event_projection_cursors: bounded('One cursor per projector.'),
  sync_feed: bounded('One row per tenant.'),
  sync_kind: bounded('One row per synced record kind.'),
  feed_identity: bounded('One row per tenant.'),
  meta: bounded('A fixed set of server keys.'),
  schema_version: bounded('One row: the legacy schema marker.'),
  server_secrets: bounded('A fixed set of server keys, plus one per provider key a person stores.'),

  // ---- people, machines, repositories, settings -----------------------------------
  users: bounded('One row per member.'),
  user_credentials: bounded('One credential per member.'),
  member_invites: bounded('Open invitations, a few per member, which people send by hand.'),
  identity_user: bounded('One row per person with an account.'),
  identity_account: bounded('One row per sign-in method per person.'),
  identity_membership: bounded('One row per member of the workspace.'),
  identity_membership_event: unbounded(
    'The membership audit trail: one row per join, role change or removal, which people make by hand.',
  ),
  identity_invitation: bounded('Invitations people send by hand.'),
  identity_one_time_code: unbounded(
    'One row per sign-in code issued; spent and expired codes are kept. A few per sign-in, which people do by hand.',
  ),
  identity_session: bounded('One row per signed-in device.'),
  identity_verification: unbounded(
    'One row per verification issued, expired ones kept; a few per sign-in, which people do by hand.',
  ),
  identity_workspace_revision: bounded('One revision counter per workspace.'),
  client_sessions: bounded('One row per signed-in browser or app; deleted on sign-out.'),
  carried_sign_ins: bounded('A carry-over record per old sign-in, deleted when used.'),
  grants: bounded('Shares people make by hand; revoked grants are deleted.'),
  grant_audiences: bounded('The audiences of the grants people make by hand.'),
  accounts: bounded('Provider accounts the operator configures by hand.'),
  account_machine_sends: bounded('One row per account per machine it was sent to.'),
  native_login_opt_ins: bounded('One row per person per provider.'),
  native_login_transfers: bounded(
    'One row per person, harness, credential and machine it was moved to.',
  ),
  credentials: bounded(
    'Credentials people add by hand; a removed one stays as a revoked row with its secret deleted.',
  ),
  credential_secrets: bounded(
    "A credential's current sealed secret: a renewal deletes older versions, and the rows go with the credential.",
  ),
  credential_machines: bounded(
    'The machines a person allowed a credential on, by hand; deleted with the credential.',
  ),
  credential_placements: bounded(
    'One row per credential, machine and kind; a removed placement keeps its row, marked removed, and a new placement reuses it. Deleted with the credential.',
  ),
  vault_key: bounded('One row: the wrapped vault data key.'),
  notices: unbounded(
    "One row per notice a person gets (credential events, mentions); resolved notices are kept as the person's inbox history and nothing removes them.",
  ),
  telegram_chat_bindings: bounded('One row per person who bound a chat.'),
  machines: bounded('The fleet: one row per enrolled machine.'),
  repos: bounded('One row per repository checkout per machine.'),
  repo_prefixes: bounded('One row per repository.'),
  repo_draft_seq: bounded('One counter per repository.'),
  checkouts: bounded('One row per checkout on disk; removed with the checkout.'),
  checkout_reach: bounded('Which machines reach each checkout; removed with it.'),
  checkout_lost: bounded('Checkouts reported missing; removed when resolved.'),
  labels: bounded('The label vocabulary, which people create by hand.'),
  workflows: bounded('Workflow definitions people write by hand.'),
  workflow_revisions: bounded('Revisions of the workflows people write by hand.'),
  workflow_bindings: bounded('One binding per workflow target, set by hand.'),
  agent_profiles: bounded('Agent profiles people define by hand.'),
  automations: bounded('Schedules people define by hand.'),
  settings_audit_events: unbounded(
    'The settings audit trail: one row per change a person makes by hand.',
  ),
  user_preferences: bounded('One row per person per preference.'),
  user_layout: bounded('One layout per person.'),
  user_dock_shell: bounded('One row per person.'),
  user_read_position: bounded('One read position per person per stream.'),
  tab_order: bounded('One row per person per worktree they arranged.'),
  recap_watermarks: bounded('One watermark per reader per session.'),
  messaging_issue_topics: bounded('One topic per issue bound to a chat.'),
  messaging_session_attachments: bounded(
    'One attachment per session bound to a chat; deleted when unbound.',
  ),

  // ---- sessions and their per-session state ---------------------------------------
  sessions: unbounded(
    'Every session ever run, live or tombstoned; transcripts, costs and issue history point at it. Only a throwaway session is purged.',
  ),
  session_user_state: bounded("Per person per session; deleted with the session's purge."),
  session_drafts: bounded('At most one draft per session.'),
  pins: bounded('Pins people set by hand.'),
  snoozes: bounded('Snoozes people set by hand; cleared when they end.'),
  session_observation_checkpoints: bounded(
    "One checkpoint per session (4,375 on the operator's database, 17 MB).",
  ),
  session_observation_rebinds: bounded(
    "One row per session (keyed by it), deleted with the session's checkpoint (cascade).",
  ),
  session_terminal_candidates: bounded(
    "One row per session (keyed by it), deleted with the session's checkpoint (cascade).",
  ),
  runtime_event_checkpoints: bounded('One checkpoint per session; deleted with it.'),
  conversations: bounded(
    "One row per agent conversation; a machine's conversations are deleted when it is removed.",
  ),
  conversation_identities: unbounded(
    'One identity per conversation ever seen; transcripts point at it.',
  ),
  conversation_segments: unbounded(
    'The segments of every conversation ever mirrored; transcripts point at them.',
  ),
  conversation_segment_incarnations: unbounded('A few per conversation segment ever mirrored.'),
  transcript_costs: unbounded(
    'One cost row per transcript segment: the usage history people read back.',
  ),
  superagent_threads: unbounded("The superagent's conversation threads, which people read back."),
  superagent_messages: unbounded(
    "The superagent's messages, which people read back; deleted with their thread.",
  ),
  delivery_receipts: unbounded(
    'One receipt per delivered message, which the delivery ledger reads back; grows with messages.',
  ),

  // ---- issues and their per-issue state ---------------------------------------------
  issues: unbounded(RECORD_OF_WORK),
  issue_comments: unbounded(RECORD_OF_WORK),
  issue_text_revisions: unbounded(`${RECORD_OF_WORK} The revisions of an issue's own text.`),
  issue_messages: unbounded(
    `${RECORD_OF_WORK} The issue mailboxes (28.6k rows, 37 MB on the operator's database, since 2026-07).`,
  ),
  issue_deps: bounded('A few edges per issue; deleted with it.'),
  issue_labels: bounded('A few labels per issue; deleted with it.'),
  issue_ref_letters: bounded('A few ref letters per issue; deleted with it.'),
  issue_user_state: bounded('Per person per issue; deleted with it.'),
  issue_message_user_state: bounded('Per person per issue message; deleted with it (cascade).'),
  issue_git_states: bounded('One git state per issue with a worktree.'),
  issue_panel_todos: bounded("One issue's panel todos; removed when an agent removes them."),
  issue_panel_artifacts: bounded(
    "One issue's panel artifacts; removed when an agent removes them.",
  ),
  issue_panel_deferred: bounded("One issue's deferred items; removed when cleared."),
  issue_panel_states: bounded('One state paragraph per issue.'),
  subscriptions: bounded('Subscriptions people and agents set; deleted when cancelled.'),
  subscription_deliveries: unbounded(
    'One row per notification a subscription delivered: the delivery history.',
  ),
  approval_requests: unbounded(
    'One row per approval asked for: the approval history people read back.',
  ),
  root_integration_receipts: unbounded(
    'One receipt per integration of a task branch: the landing history.',
  ),

  // ---- unified messages -------------------------------------------------------------
  messages: unbounded(
    `${RECORD_OF_WORK} The agent mail and its delivery ledger (49.8k rows, 97 MB with indexes on the operator's database); expiry ends delivery, not the row.`,
  ),
  message_reads: unbounded('One read receipt per reader per message: grows with messages.'),
  message_wake_cooldowns: unbounded(
    'One row per wake key ever attempted (keyed, so a key is written once); grows with the sessions and issues woken.',
  ),

  // ---- shipping ---------------------------------------------------------------------
  ship_orders: unbounded('Every ship order: the landing history of each task.'),
  ship_attempts: unbounded('Every attempt of every ship order: the landing history.'),
  ship_steps: unbounded('Every step of every ship attempt: the landing history.'),
  ship_evidence: unbounded('The evidence each landing recorded.'),
  ship_effect_envelopes: unbounded('The proofs each landing step recorded.'),
  ship_order_stack_edges: unbounded('The stacking of every ship order.'),
  ship_lane_revisions: bounded('One revision counter per lane.'),
  ship_recovery_revision: bounded('One revision counter.'),
  ship_recovery_work: bounded('Recovery work in flight; deleted when done.'),
  ship_repair_candidates: unbounded('Repair candidates the landing found, kept with its history.'),
  ship_train_manifests: unbounded('Every train manifest: the landing history.'),
  ship_train_members: unbounded('The members of every train: the landing history.'),
  ship_train_active_claims: bounded('Claims of open trains; deleted when released.'),
  ship_holds: unbounded(
    'Every hold placed on a landing, resolved ones included: the landing history.',
  ),

  // ---- workflows and automations runs ---------------------------------------------------
  workflow_runs: unbounded('Every workflow run: the run history people read back.'),
  workflow_run_steps: unbounded('Every step of every workflow run: the run history.'),
  workflow_events: unbounded('The events of every workflow run: the run history.'),
  automation_runs: unbounded('Every scheduled run: the automation history people read back.'),

  // ---- full-text indexes ------------------------------------------------------------------
  transcript_fts: unbounded(
    "The transcript search index (79 MB of content and 24 MB of index on the operator's database); it follows the mirrored transcripts, which are kept.",
  ),
  conversations_fts: bounded('The conversation search index: one entry per conversation row.'),
}

/**
 * Tables SQLite or drizzle own, and the shadow tables of the full-text indexes
 * above, which follow their index: not this file's to declare.
 */
export const RETENTION_EXEMPT: ReadonlySet<string> = new Set([
  '__drizzle_migrations',
  'sqlite_sequence',
  'sqlite_stat1',
  'sqlite_stat4',
])

/**
 * Declared tables a store creates when it opens, not a migration (the
 * full-text indexes), or that only an old install carries (`schema_version`).
 * A store built by the migrations alone does not hold them, so the test does
 * not ask it to.
 */
export const CREATED_OUTSIDE_MIGRATIONS: ReadonlySet<string> = new Set([
  'schema_version',
  'transcript_fts',
  'conversations_fts',
])

/** The shadow tables an FTS5 table `name` creates. */
export const FTS_SHADOW_SUFFIXES = ['_config', '_content', '_data', '_docsize', '_idx'] as const
