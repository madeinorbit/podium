-- SESSION ATTRIBUTION IS A PAIR (POD-1516, ADR 9 D5 A3 / docs/multi-user-readiness.md §3.1.3)
--
-- `sessions` recorded WHO in two places and neither was the pair: `owner_user_id`
-- (which human the session BELONGS to) and the freeform `spawned_by` tag (which
-- carries at most the ACTOR half, and often only its role — `user`, `agent`).
-- Neither answers "which agent did this, and for which human", so a session row
-- could not be attributed at all and the sidebar had nothing to render.
--
-- THREE COLUMNS, NOT TWO. `actor_kind` + `actor_id` rather than one collapsed
-- tag, matching the spelling `settings_audit_events`, `telegram_chat_bindings`,
-- `messages` and `queued_messages` already use. A single `session:<id>`-style
-- string is what `spawned_by` is, and POD-360 measured its cost: seven call
-- sites rebuild the template literal to compare and five of them gate
-- authorization on the match.
--
-- ADDITIVE AND NULLABLE ON ALL THREE, WITH NO BACKFILL — deliberately, and this
-- is the load-bearing choice. Every session row written before these columns
-- existed genuinely has no recorded pair. Backfilling `owner_user_id` into
-- `created_by_actor_id` would put a name against a write that name may not have
-- made: `owner_user_id` says who a session belongs to, which under ADR 9 D5 A4
-- is the on-behalf-of human EVEN WHEN AN AGENT ACTED — so the backfill would
-- assert "a human did it" for exactly the agent-created rows the pair exists to
-- distinguish. Deriving from `spawned_by` fails the same way from the other end:
-- it has no human half at all. A gap in an audit trail beats a lie in one, and
-- NULL is readable as "from before the pair existed".
--
-- Not `NOT NULL DEFAULT ''`: an empty string compares equal to itself, so
-- "unknown" and "deliberately none" would stop being distinguishable the moment
-- anything grouped by these columns. That is the same reasoning the
-- `workflow_events` attribution-pair migration recorded, and it applies
-- unchanged here.
--
-- THE CHECKS ARE THE SHAPE, ENFORCED. `actor_kind` is closed over ADR 9 D1's
-- four principal kinds — a fifth is a D1 amendment, not a convenience — and a
-- `system` principal has no human by construction (D8 S5) and may never be
-- assigned one. Both mirror `settings_audit_events` exactly.
--
-- SQLite cannot add a CHECK to an existing table with ALTER, so the constraints
-- are written as a table rebuild. The INSERT ... SELECT carries EVERY existing
-- column through explicitly — the fault that has destroyed data twice in this
-- repo's history is a generated rebuild whose SELECT silently omits a column.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_sessions` (
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
	`created_by_on_behalf_of` text,
	CONSTRAINT "sessions_stop_reason_check" CHECK(stop_reason IS NULL OR stop_reason IN ('self', 'parent', 'forced', 'exited')),
	CONSTRAINT "sessions_created_by_actor_kind" CHECK(created_by_actor_kind IS NULL OR created_by_actor_kind IN ('user', 'agent', 'machine', 'system')),
	CONSTRAINT "sessions_created_by_system_has_no_human" CHECK(created_by_actor_kind <> 'system' OR created_by_on_behalf_of IS NULL)
);
--> statement-breakpoint
INSERT INTO `__new_sessions`(`id`, `owner_user_id`, `agent_kind`, `model`, `effort`, `account_id`, `cwd`, `title`, `origin_kind`, `conversation_id`, `resume_kind`, `resume_value`, `status`, `exit_code`, `spawn_failure`, `durable_label`, `created_at`, `last_active_at`, `name`, `archived`, `work_state`, `machine_id`, `last_output_at`, `last_input_at`, `last_resumed_at`, `spawned_by`, `headless`, `issue_id`, `stopped_at`, `stop_reason`, `deleted_at`, `deleted_by_issue_id`, `deletion_source`, `workflow_run_id`, `workflow_step_id`, `execution_profile_id`, `name_source`, `ref_issue_id`, `ref_letter`, `ref_draft`, `terminal_cols`, `terminal_rows`, `working_ms_total`, `input_count`, `output_count`, `activity_count`) SELECT `id`, `owner_user_id`, `agent_kind`, `model`, `effort`, `account_id`, `cwd`, `title`, `origin_kind`, `conversation_id`, `resume_kind`, `resume_value`, `status`, `exit_code`, `spawn_failure`, `durable_label`, `created_at`, `last_active_at`, `name`, `archived`, `work_state`, `machine_id`, `last_output_at`, `last_input_at`, `last_resumed_at`, `spawned_by`, `headless`, `issue_id`, `stopped_at`, `stop_reason`, `deleted_at`, `deleted_by_issue_id`, `deletion_source`, `workflow_run_id`, `workflow_step_id`, `execution_profile_id`, `name_source`, `ref_issue_id`, `ref_letter`, `ref_draft`, `terminal_cols`, `terminal_rows`, `working_ms_total`, `input_count`, `output_count`, `activity_count` FROM `sessions`;--> statement-breakpoint
DROP TABLE `sessions`;--> statement-breakpoint
ALTER TABLE `__new_sessions` RENAME TO `sessions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_sessions_deleted_by_issue` ON `sessions` (`deleted_by_issue_id`);--> statement-breakpoint
CREATE INDEX `idx_sessions_deleted_at` ON `sessions` (`deleted_at`);
