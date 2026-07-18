ALTER TABLE `sessions` ADD `stopped_at` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `stop_reason` text;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_sessions` (
	`id` text PRIMARY KEY,
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
	`durable_label` text NOT NULL,
	`created_at` text NOT NULL,
	`last_active_at` text NOT NULL,
	`name` text,
	`archived` integer DEFAULT 0 NOT NULL,
	`work_state` text,
	`machine_id` text DEFAULT '__local__' NOT NULL,
	`last_output_at` text,
	`last_input_at` text,
	`last_resumed_at` text,
	`spawned_by` text,
	`headless` integer DEFAULT 0 NOT NULL,
	`issue_id` text,
	`read_at` text,
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
	CONSTRAINT "sessions_stop_reason_check" CHECK(stop_reason IS NULL OR stop_reason IN ('self', 'parent', 'forced', 'exited'))
);
--> statement-breakpoint
INSERT INTO `__new_sessions`(`id`, `agent_kind`, `model`, `effort`, `account_id`, `cwd`, `title`, `origin_kind`, `conversation_id`, `resume_kind`, `resume_value`, `status`, `exit_code`, `durable_label`, `created_at`, `last_active_at`, `name`, `archived`, `work_state`, `machine_id`, `last_output_at`, `last_input_at`, `last_resumed_at`, `spawned_by`, `headless`, `issue_id`, `read_at`, `deleted_at`, `deleted_by_issue_id`, `deletion_source`, `workflow_run_id`, `workflow_step_id`, `execution_profile_id`, `name_source`, `ref_issue_id`, `ref_letter`, `ref_draft`, `terminal_cols`, `terminal_rows`, `working_ms_total`) SELECT `id`, `agent_kind`, `model`, `effort`, `account_id`, `cwd`, `title`, `origin_kind`, `conversation_id`, `resume_kind`, `resume_value`, `status`, `exit_code`, `durable_label`, `created_at`, `last_active_at`, `name`, `archived`, `work_state`, `machine_id`, `last_output_at`, `last_input_at`, `last_resumed_at`, `spawned_by`, `headless`, `issue_id`, `read_at`, `deleted_at`, `deleted_by_issue_id`, `deletion_source`, `workflow_run_id`, `workflow_step_id`, `execution_profile_id`, `name_source`, `ref_issue_id`, `ref_letter`, `ref_draft`, `terminal_cols`, `terminal_rows`, `working_ms_total` FROM `sessions`;--> statement-breakpoint
DROP TABLE `sessions`;--> statement-breakpoint
ALTER TABLE `__new_sessions` RENAME TO `sessions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_sessions_deleted_by_issue` ON `sessions` (`deleted_by_issue_id`);--> statement-breakpoint
CREATE INDEX `idx_sessions_deleted_at` ON `sessions` (`deleted_at`);